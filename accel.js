/* 个人云盘 · 网页版加速器 accel.js
 * 目标：在不改变原有上传/下载/分享/校验流程的前提下，新增一套「极速传输引擎」。
 * 一致性保证：
 *   1) 认证与权限：完全复用 app.js 的 cloud / session，所有路径仍由 cloud.storage.userPath(session.user.id, ...) 生成；
 *   2) 数据一致性：分片仍写到 users/<uid>/files/<id>/part_i，文件记录仍写入同一份 meta 并调用同一个 saveMeta()；
 *   3) 直连下载优先使用已确认存在的批量签名能力，失败自动回退到 SDK 下载。
 * 依赖：accel.js 作为普通 classic script 在 app.js 之后加载，通过 window.__driveBridge 访问内部能力。
 */
(function () {
  'use strict';
  if (!window.WorkBuddyCloud || !window.__driveBridge) {
    console.warn('[accel] 桥接未就绪，加速器未加载');
    return;
  }

  var bridge = window.__driveBridge;
  var MB = 1024 * 1024;
  var LS_CFG = 'drive_accel_cfg_v3';   // v3：降低默认并发（弱网更稳），旧配置不再沿用
  var LS_LEDGER = 'drive_accel_ledger';
  var LS_SPEED = 'drive_accel_speed_bps'; // 最近一次实测的上传速度(B/s)，用于给出可信 ETA
  var ACCEL_VERSION = 'v2026-11-18-upload2';
  // 后端是否接受裸 body(ArrayBuffer)。默认为 false：SDK 正常走 FormData(multipart)，
  // 网关若不认裸 body 可能「既不成功也不报错」导致首片永久挂起（表现为 0 B / 计算中）。
  // 只有在「开始测速」里用短超时实测成功、且确实更快时才打开。
  var rawUploadSupported = false;
  var CANCEL = { cancelled: true }; // 取消哨兵

  function cloud() { return bridge.cloud(); }
  function ses() { return bridge.session(); }
  function fmt(b) { return bridge.fmtSize(b); }
  function eta(sec) { return bridge.fmtEta(sec); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function log() { try { console.log.apply(console, ['[accel]'].concat([].slice.call(arguments))); } catch (e) {} }
  function baseName(name) { return String(name || 'download').split('/').pop().split('\\').pop() || 'download'; }
  function loadSpeedBps() { try { var v = Number(localStorage.getItem(LS_SPEED)); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; } }
  function saveSpeedBps(v) { try { localStorage.setItem(LS_SPEED, String(Math.round(v))); } catch (e) {} }
  // 慢网自动选择小分片：目标是让「首批在途总量 ≈ 8MB」，这样即使 1MB/s 也能在约 8 秒内出首片，
  // 进度不再长时间停 0。快网 / 已缓存速度较高时维持用户配置，不擅自改动。
  function smartChunkMB(configuredMB, conc, speedBps) {
    if (!(speedBps > 0) || speedBps >= 6 * MB) return configuredMB; // 无测速数据或不慢，用配置值
    var targetBytes = Math.min(8 * MB, Math.max(1 * MB, speedBps * 8)); // 约 8 秒的在途量
    var mb = Math.round(targetBytes / MB / Math.max(1, conc));
    return Math.max(1, Math.min(configuredMB, mb)); // 只会变小，不会变大
  }
  function humanEta(sec) { return eta(sec); }

  // ---------- 配置 ----------
  var PRESETS = {
    standard: { chunkMB: 4, uploadConc: 6, downloadConc: 6, fileConc: 1, retries: 4, timeoutMs: 60000, direct: true, adaptive: true, autoResume: true, label: '标准' },
    // 稳健优先：过高并发(16×4=64 连接)在慢网/网关会触发连接重置(Failed to fetch)。
    // 极速改为 8 并发 / 2 文件；真实瓶颈是上行带宽，并发再高也不更快，只增故障率。
    turbo: { chunkMB: 4, uploadConc: 8, downloadConc: 8, fileConc: 2, retries: 5, timeoutMs: 60000, direct: true, adaptive: true, autoResume: true, label: '极速' },
    lite: { chunkMB: 2, uploadConc: 3, downloadConc: 3, fileConc: 1, retries: 4, timeoutMs: 60000, direct: false, adaptive: false, autoResume: true, label: '省流' },
  };
  var DEFAULT_CFG = Object.assign({}, PRESETS.turbo, { mode: 'turbo' });
  var cfg = loadCfg();
  function loadCfg() {
    var c = Object.assign({}, DEFAULT_CFG);
    try {
      var raw = localStorage.getItem(LS_CFG);
      if (raw) {
        var o = JSON.parse(raw);
        Object.keys(DEFAULT_CFG).forEach(function (k) {
          if (o[k] !== undefined && typeof o[k] === typeof DEFAULT_CFG[k]) c[k] = o[k];
        });
      }
    } catch (e) {}
    return normalizeCfg(c);
  }
  function normalizeCfg(c) {
    c.chunkMB = clamp(Math.round(Number(c.chunkMB) || 8), 1, 32);
    c.uploadConc = clamp(Math.round(Number(c.uploadConc) || 6), 1, 16);
    c.downloadConc = clamp(Math.round(Number(c.downloadConc) || 6), 1, 16);
    c.fileConc = clamp(Math.round(Number(c.fileConc) || 2), 1, 6);
    c.retries = clamp(Math.round(Number(c.retries) || 3), 0, 8);
    c.timeoutMs = clamp(Math.round(Number(c.timeoutMs) || 20000), 5000, 120000);
    c.direct = !!c.direct; c.adaptive = !!c.adaptive; c.autoResume = !!c.autoResume;
    return c;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function saveCfg() { try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {} }

  // ---------- 上传进度台账（跨刷新保留稳定 id，便于续传） ----------
  function loadLedger() { try { return JSON.parse(localStorage.getItem(LS_LEDGER) || '{}') || {}; } catch (e) { return {}; } }
  function writeLedger(l) { try { localStorage.setItem(LS_LEDGER, JSON.stringify(l)); } catch (e) {} }
  var ledger = loadLedger();
  function fingerprint(file, label) { return (label || file.name) + ':' + file.size + ':' + (file.lastModified || 0); }

  // ---------- 任务队列 ----------
  var queue = [];
  var seq = 0;
  function newTask(kind, name, size, payload) {
    return {
      id: 'a' + (Date.now().toString(36)) + (seq++),
      kind: kind, name: name, size: size || 0,
      status: 'queued', loaded: 0, speed: 0, etaSec: null,
      error: '', startedAt: 0, finishedAt: 0,
      ctrl: makeAimd(kind === 'upload' ? cfg.uploadConc : cfg.downloadConc, 2, 12, 6),
      etaTrack: bridge.makeEtaTracker(size || 0),
      cancelFlag: false, paused: false, aborters: [], activeParts: 0,
      payload: payload || {},
      el: null,
    };
  }

  function makeAimd(start, min, max, step) {
    var value = start, streak = 0, cooldownUntil = 0;
    return {
      get value() { return value; },
      get cooldownUntil() { return cooldownUntil; },
      success: function () { streak++; if (streak >= step) { streak = 0; if (value < max) value++; } },
      failure: function (e) {
        var m = String((e && (e.message || e.code)) || e);
        if (/403|429|too many|rate|timeout|超时|Failed to fetch|network|abort/i.test(m)) {
          value = Math.max(min, Math.floor(value / 2));
          streak = 0; cooldownUntil = Date.now() + 1200;
        }
      },
    };
  }

  function isPermanent(e) {
    var m = String((e && (e.message || e.code)) || e);
    return /quota|forbidden|unauthor|invalid|413|payload too large|not found/i.test(m);
  }
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var t = setTimeout(function () { if (!settled) { settled = true; reject(new Error((label || '操作') + '超时')); } }, ms);
      Promise.resolve(promise).then(
        function (v) { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
        function (e) { if (!settled) { settled = true; clearTimeout(t); reject(e); } }
      );
    });
  }
  async function withRetry(fn, task, label) {
    var last = null;
    for (var attempt = 0; attempt <= cfg.retries; attempt++) {
      if (task.cancelFlag) throw CANCEL;
      try { return await fn(attempt); }
      catch (e) {
        if (e === CANCEL || task.cancelFlag) throw CANCEL;
        if (isPermanent(e)) throw e;
        last = e;
        var backoff = Math.min(4000, 350 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        await sleep(backoff);
      }
    }
    throw last || new Error(label + '失败（多次重试）');
  }

  // 受限并发池：支持暂停 / 取消 / 自适应并发 / 分片级重试。
  // 弱网下「Failed to fetch」常是瞬时连接重置，不该让整单失败：这里把失败分片退回队尾重试，
  // 每次退避并借 AIMD 自动降并发；只有该分片耗尽重试次数才判定整单失败。
  function accelPool(items, task, getConc, worker, itemRetries) {
    return new Promise(function (resolve, reject) {
      var maxRetry = itemRetries == null ? 3 : itemRetries;
      // 保留原始下标 i：下载 worker 用它作为分片缓冲键，重试必须写回同一位置
      var pending = items.map(function (it, i) { return { v: it, i: i, tries: 0 }; });
      var next = 0, active = 0, failed = null, done = false;
      function finish() {
        if (done) return;
        if (failed && active === 0) { done = true; reject(failed); }
        else if (!failed && next >= pending.length && active === 0) { done = true; resolve(); }
      }
      function pumpLocal() {
        if (done) return;
        if (task.cancelFlag) { failed = failed || CANCEL; finish(); return; }
        if (task.paused) { setTimeout(pumpLocal, 120); return; }
        if (cfg.adaptive) {
          var wait = task.ctrl.cooldownUntil - Date.now();
          if (wait > 0) { setTimeout(pumpLocal, Math.min(wait, 200)); return; }
        }
        while (!failed && !task.paused && !task.cancelFlag && active < getConc() && next < pending.length) {
          var job = pending[next++]; active++;
          Promise.resolve().then(function () { return worker(job.v, job.i); }).then(
            function () { active--; task.ctrl.success(); pumpLocal(); },
            function (e) {
              active--;
              if (e === CANCEL || task.cancelFlag) { failed = failed || CANCEL; pumpLocal(); return; }
              task.ctrl.failure(e);
              job.tries++;
              if (job.tries <= maxRetry) {
                pending.push(job); // 退回队尾重试
                log('分片瞬时失败，重试', job.tries + '/' + maxRetry, (e && e.message) || e);
                setTimeout(pumpLocal, 500 * job.tries);
              } else {
                failed = failed || e;
              }
              pumpLocal();
            }
          );
        }
        finish();
      }
      pumpLocal();
    });
  }

  function bumpProgress(task, bytes) {
    task.loaded = Math.min(task.size || Infinity, task.loaded + Math.max(0, bytes));
    var measured = loadSpeedBps();
    var secs = Math.max(0.001, (Date.now() - Math.max(1, task.startedAt)) / 1000);
    // 只用「累计字节 / 累计时间」求平均速度：并发分片几乎同时落地时，
    // EMA 的 0.2s 短窗口会把瞬间到达的 16MB 误算成 60MB/s，故不再采用。
    var avg = task.loaded / secs;
    var sp = avg;
    // 用测速结果做上限保护：平均值也不该在慢网下离实测速度数量级偏离
    if (measured > 0) sp = Math.min(sp, measured * 1.8);
    if (!(sp > 0)) sp = measured;
    task.speed = sp;
    var remain = Math.max(0, (task.size || 0) - task.loaded);
    task.etaSec = (sp > 0 && remain > 0) ? remain / sp : null;
    updateTaskRow(task);
  }

  // ---------- 上传引擎 ----------
  // SDK 关键行为：传入 Blob 会被包成 FormData(multipart)，每个分片都有 multipart 头开销与序列化成本；
  // 传入 ArrayBuffer 则直接作为裸 body 发送(content-type 头)，省掉该开销。
  // 上传是过应用网关的(签名上传同样走网关)，多连接并发 + 降低每分片 CPU/封装开销才是有效杠杆。
  // 关键：每条上传都必须有超时。网关偶发「请求挂着不返回」时，超时会让 withRetry 重试，
  // 而不是让分片永久停留在 0 字节 / 计算中。
  function checkUploadResult(r) {
    if (!r || !r.error) return;
    var m = String((r.error.message || '') + ' ' + (r.error.code || ''));
    if (/ALREADY_EXISTS|already exists/i.test(m)) return; // 幂等
    throw r.error;
  }
  async function uploadPartFast(path, blob, task) {
    if (task.cancelFlag) throw CANCEL;
    if (rawUploadSupported) {
      try {
        var ab = await blob.arrayBuffer();
        // 裸传用较短探测超时：挂起即判定后端不接受，永久回退
        var probeMs = Math.min(cfg.timeoutMs, 12000);
        var r = await withTimeout(cloud().storage.upload(path, ab, { contentType: 'application/octet-stream' }), probeMs, '裸传');
        checkUploadResult(r);
        return; // 裸传成功
      } catch (e) {
        if (e === CANCEL || task.cancelFlag) throw CANCEL;
        var em = String((e && (e.message || e.code)) || e);
        if (/ALREADY_EXISTS|already exists/i.test(em)) return;
        if (/超时|timeout/i.test(em)) {
          log('裸传超时，判定网关不支持，永久回退 FormData');
          rawUploadSupported = false;
        } else if (/400|415|invalid|malformed|multipart|bad request|unsupported media/i.test(em)) {
          log('后端拒绝裸 body，永久回退 FormData', em);
          rawUploadSupported = false;
        } else {
          throw e; // 网络/限流类错误交给外层 withRetry
        }
      }
    }
    // 标准路径：Blob → SDK 包成 FormData（与原应用一致，网关确定支持）
    var r2 = await withTimeout(
      cloud().storage.upload(path, blob, { contentType: 'application/octet-stream' }),
      cfg.timeoutMs, '分片上传'
    );
    checkUploadResult(r2);
  }

  async function runUpload(task) {
    var p = task.payload;
    var file = p.file;
    var s = ses();
    if (!s || !s.user) throw new Error('登录已失效，请退出后重新登录');
    // 续传必须沿用该任务最初的分片大小，否则 part_i 会与实际字节范围错位导致文件损坏。
    var useChunkMB = p.chunkMB || cfg.chunkMB;
    var chunkSize = useChunkMB * MB;
    var count = Math.max(1, Math.ceil(file.size / chunkSize));
    var uid = p.id || bridge.uid();
    var partsKey = 'users/' + s.user.id + '/files/' + uid + '/';
    var prefix = partsKey;

    // 已完成（同目录同名同大小）则跳过，与原流程一致
    if (bridge.meta().files.some(function (x) { return x.folder_id === p.folderId && x.name === file.name && x.size === file.size; })) {
      task.loaded = task.size; bumpProgress(task, 0); task.note = '已存在，跳过';
      return;
    }

    var doneSet = new Set();
    if (cfg.autoResume) {
      try { doneSet = new Set(await bridge.listKeys(prefix)); } catch (e) { /* 忽略 */ }
    }
    var pending = [];
    var resumed = 0;
    for (var i = 0; i < count; i++) {
      if (doneSet.has(partsKey + 'part_' + i)) {
        resumed += Math.min((i + 1) * chunkSize, file.size) - i * chunkSize;
      } else pending.push(i);
    }
    if (resumed > 0) { task.loaded = resumed; bumpProgress(task, 0); log('续传', file.name, fmt(resumed)); }

    await accelPool(pending, task, function () { return cfg.adaptive ? task.ctrl.value : cfg.uploadConc; }, async function (idx) {
      var start = idx * chunkSize, end = Math.min(start + chunkSize, file.size);
      var blob = file.slice(start, end);
      var path = cloud().storage.userPath(s.user.id, 'files/' + uid + '/part_' + idx);
      task.activeParts++; updateTaskRow(task);
      try {
        await withRetry(async function () { await uploadPartFast(path, blob, task); }, task, '分片 ' + idx);
      } finally {
        task.activeParts = Math.max(0, task.activeParts - 1);
      }
      bumpProgress(task, end - start);
    });

    if (task.cancelFlag) throw CANCEL;

    // 数据一致性：与原 uploadChunked 写入完全相同 schema 的记录
    bridge.meta().files.push({
      id: uid, name: file.name, folder_id: p.folderId,
      objectKey: 'files/' + uid, size: file.size,
      mime_type: file.type || 'application/octet-stream',
      chunked: true, chunkCount: count,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await bridge.saveMeta();
    delete ledger[p.fp]; writeLedger(ledger);
    // 与原有流程一致：保存后直接用内存 meta 渲染，不重新 loadMeta
    bridge.setCurrentFolder(p.startFolder);
    if (p.rootFolderId) bridge.setCurrentFolder(p.rootFolderId);
    bridge.render();
  }

  // ---------- 下载引擎 ----------
  function concatBytes(chunks, total) {
    var out = new Uint8Array(total), off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }
  async function readStreamAll(stream, task) {
    var reader = stream.getReader(); var parts = []; var total = 0;
    while (true) {
      var d = await reader.read();
      if (d.done) break;
      parts.push(d.value); total += d.value.length;
    }
    return concatBytes(parts, total);
  }
  async function getDownloadSources(task, paths) {
    if (cfg.direct && typeof bridge.createSignedUrlsBatch === 'function') {
      try {
        var urls = await withTimeout(bridge.createSignedUrlsBatch(paths, 3600), 60000, '批量签名');
        if (urls && urls.length === paths.length && urls.every(function (u) { return /^https?:/i.test(u); })) {
          log('直连下载已启用', task.name);
          return urls.map(function (u) { return { url: u }; });
        }
      } catch (e) { log('直连签名失败，回退 SDK 下载', (e && e.message) || e); }
    }
    return paths.map(function (p) { return { path: p }; });
  }
  async function fetchPart(src, task) {
    if (task.cancelFlag) throw CANCEL;
    var ctrl = new AbortController();
    task.aborters.push(ctrl);
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, cfg.timeoutMs);
    try {
      if (src.url) {
        var r = await fetch(src.url, { cache: 'no-store', signal: ctrl.signal });
        if (!r.ok) throw new Error('分片下载失败 (' + r.status + ')');
        return new Uint8Array(await r.arrayBuffer());
      }
      var res = await withTimeout(cloud().storage.download(src.path), cfg.timeoutMs, '分片下载');
      var st = null;
      try { st = await bridge.getStream(res); } catch (e) {}
      if (st) return await readStreamAll(st, task);
      var b = await bridge.getBlob(res);
      if (!b) throw new Error('空分片数据');
      return new Uint8Array(await b.arrayBuffer());
    } finally {
      clearTimeout(timer);
      var k = task.aborters.indexOf(ctrl); if (k >= 0) task.aborters.splice(k, 1);
    }
  }

  // 桌面：File System Access API 边下边写（并行拉取、按序写盘，内存可控）
  async function downloadToDisk(task, sources) {
    var handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: baseName(task.name) }); }
    catch (e) { if (e && e.name === 'AbortError') throw CANCEL; throw e; }
    var writable = await handle.createWritable();
    var buffers = new Map();
    var nextWrite = 0;
    try {
      await accelPool(sources, task, function () { return cfg.adaptive ? task.ctrl.value : cfg.downloadConc; }, async function (src, i) {
        if (task.cancelFlag) throw CANCEL;
        var bytes = null;
        await withRetry(async function () {
          if (task.cancelFlag) throw CANCEL;
          bytes = await fetchPart(src, task);
        }, task, '分片 ' + i);
        buffers.set(i, bytes);
        while (buffers.has(nextWrite)) {
          var b = buffers.get(nextWrite); buffers.delete(nextWrite);
          await writable.write(b);
          bumpProgress(task, b.length);
          nextWrite++;
        }
      });
      await writable.close();
    } catch (e) {
      try { await writable.close(); } catch (e2) {}
      throw e;
    }
  }

  // Service Worker 原生下载：把多分片拼成普通响应交给手机原生下载管理器（与分享页 sw.js 完全一致）
  async function downloadViaSW(task, sources) {
    if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持 Service Worker');
    if (!window.isSecureContext) throw new Error('原生下载需要 HTTPS 环境');
    if (!sources.every(function (x) { return x.url; })) throw new Error('原生下载需要直连地址');
    var code = bridge.siteCode() || '';
    var q = code ? ('&sharecode=' + encodeURIComponent(code)) : '';
    var reg = await navigator.serviceWorker.register('/sw.js?v=20261020r' + q, { scope: '/' });
    await navigator.serviceWorker.ready;
    var target = navigator.serviceWorker.controller || reg.active;
    if (!target) throw new Error('Service Worker 未就绪，请刷新后重试');
    var token = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + Math.random().toString(36).slice(2));
    await new Promise(function (resolve, reject) {
      var ch = new MessageChannel();
      var timer = setTimeout(function () { reject(new Error('Service Worker 响应超时')); }, 4000);
      ch.port1.onmessage = function (e) {
        clearTimeout(timer);
        if (e.data && e.data.ok) resolve(); else reject(new Error('Service Worker 未确认任务'));
      };
      target.postMessage({ type: 'set-download', token: token, file: { name: task.name, size: task.size, parts: sources.map(function (s) { return s.url; }) } }, [ch.port2]);
    });
    var a = document.createElement('a');
    a.href = '/__dl__/' + token;
    a.download = baseName(task.name);
    document.body.appendChild(a); a.click(); a.remove();
    task.note = '已交给浏览器原生下载，请在下载列表/通知栏查看';
  }

  // 兼容回退：内存拼 Blob 后触发 <a download>
  async function downloadToBlob(task, sources) {
    var results = new Array(sources.length);
    await accelPool(sources, task, function () { return cfg.adaptive ? task.ctrl.value : cfg.downloadConc; }, async function (src, i) {
      await withRetry(async function () {
        if (task.cancelFlag) throw CANCEL;
        results[i] = await fetchPart(src, task);
        bumpProgress(task, results[i].length);
      }, task, '分片 ' + i);
    });
    var blob = new Blob(results, { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = baseName(task.name); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  // 原生端落盘入口：仅传分片 URL 描述，原生宿主自行流式下载写盘；失败回退原 Web 路径
  async function downloadViaNativeFs(task, sources) {
    var nf = window.NativeFs;
    if (!nf || typeof nf.pickSavePath !== 'function' || typeof nf.saveParts !== 'function') {
      throw new Error('原生文件系统不可用');
    }
    var target = await nf.pickSavePath({ suggestedName: baseName(task.name) });
    if (!target || target.canceled) throw CANCEL;
    var taskId = bridge.uid ? bridge.uid() : (String(Date.now()) + Math.random().toString(36).slice(2));
    var lastWritten = 0;
    await nf.saveParts({
      target: target,
      parts: sources.map(function (src) { return { url: src.url }; }),
      totalSize: task.size,
      taskId: taskId,
      onProgress: function (written) {
        bumpProgress(task, Math.max(0, Number(written) - lastWritten));
        lastWritten = Number(written) || 0;
      },
    });
    task.note = '已保存到原生位置';
  }

  async function runDownload(task) {
    var s = ses();
    if (!s || !s.user) throw new Error('登录已失效，请退出后重新登录');
    var f = task.payload.file;
    var paths = bridge.partPaths(f);
    task.size = f.size || task.size;
    task.etaTrack = bridge.makeEtaTracker(task.size);
    var sources = await getDownloadSources(task, paths);

    // 原生端优先：只有拿到直链时才能交给宿主下载，否则沿用 SDK 下载路径
    if (window.NativeFs && typeof window.NativeFs.saveParts === 'function' && sources.length &&
        sources.every(function (src) { return !!src.url; })) {
      try { await downloadViaNativeFs(task, sources); return; }
      catch (e) {
        if (e === CANCEL || task.cancelFlag || (e && e.code === 'E_NATIVEFS_CANCEL')) throw CANCEL;
        log('原生落盘失败，回退原下载路径', (e && e.message) || e);
      }
    }

    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    if (window.showSaveFilePicker) {
      await downloadToDisk(task, sources);
    } else if (isMobile && 'serviceWorker' in navigator && window.isSecureContext && sources.every(function (x) { return x.url; })) {
      try { await downloadViaSW(task, sources); task.loaded = task.size; bumpProgress(task, 0); }
      catch (e) { log('原生下载失败，回退 Blob', (e && e.message) || e); await downloadToBlob(task, sources); }
    } else {
      var canNative = 'serviceWorker' in navigator && window.isSecureContext;
      if (task.size > 1.5 * 1024 * MB && !canNative) {
        throw new Error('文件超过 1.5GB 且浏览器不支持流式落盘，请用 Chrome/Edge 打开');
      }
      if (task.size > 800 * MB && !canNative && !cfg.direct) {
        throw new Error('大文件在移动端需开启「直连下载」以交给原生下载管理器，请在 ⚙ 设置中开启');
      }
      await downloadToBlob(task, sources);
    }
  }

  // ---------- 调度 ----------
  function pump() {
    var running = queue.filter(function (t) { return t.status === 'running'; }).length;
    while (running < cfg.fileConc) {
      var t = queue.find(function (x) { return x.status === 'queued'; });
      if (!t) break;
      t.status = 'running';
      running++;
      runTask(t);
    }
  }
  async function runTask(task) {
    task.startedAt = Date.now(); task.error = '';
    renderDock();
    try {
      if (task.kind === 'upload') await runUpload(task); else await runDownload(task);
      if (task.cancelFlag) task.status = 'canceled';
      else { task.status = 'done'; task.loaded = task.size; }
    } catch (e) {
      if (e === CANCEL || task.cancelFlag) task.status = 'canceled';
      else { task.status = 'error'; task.error = String((e && (e.message || e.code)) || e); }
    }
    task.finishedAt = Date.now();
    if (task.removeAfter) {
      var ri = queue.indexOf(task);
      if (ri >= 0) queue.splice(ri, 1);
    }
    renderDock();
    pump();
  }

  // ---------- 对外 API ----------
  var Accel = {
    version: ACCEL_VERSION,
    onAppReady: function () {
      var btn = document.getElementById('btn-accel');
      if (btn) btn.style.display = ses() ? '' : 'none';
    },
    addUploadTasks: function (fileList, targetFolderId) {
      if (!ses()) { alert('请先登录'); return 0; }
      var items = (fileList || []).map(function (x) {
        if (x && x.file) return { file: x.file, path: x.path ? String(x.path).replace(/\\/g, '/') : null };
        return { file: x, path: (x && (x.webkitRelativePath || x.relativePath)) ? String(x.webkitRelativePath || x.relativePath).replace(/\\/g, '/') : null };
      }).filter(function (x) { return x.file && typeof x.file.size === 'number'; });
      if (!items.length) { alert('没有读取到任何文件'); return 0; }
      // 目标目录由调用方显式指定：null=根目录，字符串=文件夹 id；未指定则沿用当前目录
      var startFolder = (arguments.length > 1 && arguments[1] !== undefined)
        ? arguments[1] : bridge.currentFolder();
      var measured = loadSpeedBps();
      var tasks = [];
      items.forEach(function (it) {
        var targetFolder = startFolder, label = it.file.name, rootFolderId = null;
        if (it.path) {
          var seg = it.path.split('/').filter(Boolean);
          rootFolderId = seg.length > 1 ? ensureAccelFolder(seg.slice(0, -1), startFolder) : null;
          targetFolder = ensureAccelFolder(seg.slice(0, -1), startFolder);
          label = it.path;
        }
        var fp = fingerprint(it.file, label);
        var id = (ledger[fp] && ledger[fp].id) || bridge.uid();
        // 续传沿用原分片大小；新文件根据实测速度智能选小分片，避免慢网首批等待过久。
        var chunkMB = (ledger[fp] && ledger[fp].chunkMB) || smartChunkMB(cfg.chunkMB, cfg.uploadConc, measured);
        ledger[fp] = { id: id, name: it.file.name, size: it.file.size, chunkMB: chunkMB, ts: Date.now() };
        var t = newTask('upload', label, it.file.size, {
          file: it.file, path: it.path, folderId: targetFolder, startFolder: startFolder,
          rootFolderId: rootFolderId, id: id, fp: fp, chunkMB: chunkMB,
        });
        tasks.push(t);
      });
      writeLedger(ledger);
      bridge.saveMeta();
      tasks.forEach(function (t) { queue.push(t); });
      renderDock(); showDock(); pump();
      log('加入上传队列', tasks.length, '个文件');
      return tasks.length;
    },
    addDownloadTask: function (f) {
      if (!ses()) { alert('请先登录'); return; }
      if (!f) return;
      var t = newTask('download', f.name, f.size, { file: f });
      queue.push(t); renderDock(); showDock(); pump();
      log('加入下载队列', f.name);
    },
    addFolderDownloadTasks: function (folder) {
      if (!ses()) { alert('请先登录'); return; }
      if (!folder || typeof bridge.collectFolderFiles !== 'function') return;
      var items = bridge.collectFolderFiles(folder.id, folder.name);
      if (!items.length) { alert('该文件夹为空。'); return; }
      items.forEach(function (it) {
        var f = it.file;
        var t = newTask('download', it.relPath || f.name, f.size, { file: f });
        queue.push(t);
      });
      renderDock(); showDock(); pump();
      log('加入文件夹下载队列', folder.name, items.length, '个文件');
    },
    retryTask: function (id) {
      var t = queue.find(function (x) { return x.id === id; });
      if (!t || t.status !== 'error') return;
      t.status = 'queued'; t.cancelFlag = false; t.paused = false; t.error = '';
      t.loaded = 0; t.ctrl = makeAimd(t.kind === 'upload' ? cfg.uploadConc : cfg.downloadConc, 2, 12, 6);
      t.etaTrack = bridge.makeEtaTracker(t.size);
      t.aborters.forEach(function (c) { try { c.abort(); } catch (e) {} }); t.aborters = [];
      renderDock(); pump();
    },
    cancelTask: function (id) {
      var t = queue.find(function (x) { return x.id === id; });
      if (!t) return;
      t.cancelFlag = true; t.paused = false;
      t.aborters.forEach(function (c) { try { c.abort(); } catch (e) {} });
      updateTaskRow(t);
    },
    togglePause: function (id) {
      var t = queue.find(function (x) { return x.id === id; });
      if (!t || (t.status !== 'running' && t.status !== 'queued')) return;
      t.paused = !t.paused;
      updateTaskRow(t);
    },
    removeTask: function (id) {
      var i = queue.findIndex(function (x) { return x.id === id; });
      if (i < 0) return;
      var t = queue[i];
      if (t.status === 'running' || t.status === 'queued') {
        t.cancelFlag = true; t.removeAfter = true;
        t.aborters.forEach(function (c) { try { c.abort(); } catch (e) {} });
        updateTaskRow(t);
        return;
      }
      queue.splice(i, 1); renderDock();
    },
    openConfig: openConfig,
    showDock: showDock,
  };
  window.Accel = Accel;

  function ensureAccelFolder(parts, parentId) {
    var pid = parentId;
    parts.forEach(function (name) {
      if (!name) return;
      var found = bridge.meta().folders.find(function (f) { return f.name === name && f.parent_id === pid; });
      if (!found) {
        found = { id: bridge.uid(), name: name, parent_id: pid, created_at: new Date().toISOString() };
        bridge.meta().folders.push(found);
      }
      pid = found.id;
    });
    return pid;
  }

  // ---------- UI ----------
  function installUI() {
    if (document.getElementById('accel-dock')) return;
    var userBox = document.querySelector('.topbar .user');
    if (userBox && !document.getElementById('btn-accel')) {
      var b = document.createElement('button');
      b.id = 'btn-accel'; b.className = 'btn ghost accel-entry';
      b.textContent = '⚡ 加速器'; b.onclick = showDock;
      var anchor = document.getElementById('btn-settings') || document.getElementById('btn-logout');
      userBox.insertBefore(b, anchor);
    }
    var actions = document.querySelector('.toolbar .actions');
    if (actions && !document.getElementById('btn-accel-upload')) {
      var pendingTarget; // undefined=未指定，null=根目录，字符串=文件夹 id
      var ub = document.createElement('button');
      ub.id = 'btn-accel-upload'; ub.className = 'btn accel-upload-btn';
      ub.textContent = '⚡ 加速上传';
      ub.onclick = function () {
        var api = window.__driveBridge;
        if (!api || typeof api.pickUploadFolder !== 'function') {
          pendingTarget = undefined;
          document.getElementById('accel-file-input').click();
          return;
        }
        api.pickUploadFolder(bridge.currentFolder(), '选择上传路径').then(function (id) {
          if (id === undefined) return; // 取消
          pendingTarget = id;
          document.getElementById('accel-file-input').click();
        });
      };
      actions.appendChild(ub);
      var inp = document.createElement('input');
      inp.id = 'accel-file-input'; inp.type = 'file'; inp.multiple = true; inp.className = 'hidden';
      inp.onchange = function (e) {
        var target = pendingTarget;
        pendingTarget = undefined;
        Accel.addUploadTasks([].slice.call(e.target.files), target);
        e.target.value = '';
      };
      actions.appendChild(inp);
    }

    var dock = document.createElement('div');
    dock.id = 'accel-dock'; dock.className = 'accel-dock hidden';
    dock.innerHTML =
      '<div class="ac-head">' +
        '<div class="ac-title">⚡ 加速器 <span class="ac-ver">' + ACCEL_VERSION + '</span></div>' +
        '<div class="ac-head-actions">' +
          '<span id="ac-speed" class="ac-speed">0 B/s</span>' +
          '<button class="ac-ico" id="ac-config" title="传输设置">⚙</button>' +
          '<button class="ac-ico" id="ac-clear" title="清除已完成">✕</button>' +
          '<button class="ac-ico" id="ac-hide" title="收起">—</button>' +
        '</div>' +
      '</div>' +
      '<div id="ac-list" class="ac-list"></div>' +
      '<div class="ac-foot" id="ac-foot">直连加速 · 分片并发 · 失败重试 · 断点续传</div>';
    document.body.appendChild(dock);

    document.getElementById('ac-config').onclick = openConfig;
    document.getElementById('ac-hide').onclick = function () { dock.classList.add('hidden'); };
    document.getElementById('ac-clear').onclick = function () {
      queue = queue.filter(function (t) { return t.status === 'running' || t.status === 'queued' || t.status === 'paused'; });
      renderDock();
    };
    document.getElementById('accel-file-input') && null;
    buildConfigModal();
    setInterval(function () {
      if (!document.getElementById('accel-dock').classList.contains('hidden')) {
        updateAggregateSpeed();
        queue.forEach(function (t) { if (t.status === 'running') updateTaskRow(t); }); // 刷新在途/等待秒数
      }
    }, 600);
    renderDock();
    Accel.onAppReady();
  }

  function showDock() {
    if (!ses()) { alert('请先登录'); return; }
    installUI();
    document.getElementById('accel-dock').classList.remove('hidden');
    renderDock();
  }

  function statusText(t) {
    if (t.note && t.status === 'done') return t.note;
    if (t.paused && (t.status === 'running' || t.status === 'queued')) return '已暂停';
    if (t.status === 'queued') return '排队中';
    if (t.status === 'paused') return '已暂停';
    if (t.status === 'running') {
      var measured = loadSpeedBps();
      // 首片未完成时没有真实进度：用「在途字节估算 + 实测速度」给出可信反馈，不再显示误导性的计算中。
      if (t.loaded === 0) {
        var mChunk = (t.payload.chunkMB || cfg.chunkMB) * MB;
        var inflightBytes = t.activeParts * mChunk;
        var waitSec = Math.max(0, Math.round((Date.now() - t.startedAt) / 1000));
        if (inflightBytes > 0) {
          var estEta = measured > 0 ? (t.size - inflightBytes) / measured : null;
          return '发送中 ≈' + fmt(Math.min(inflightBytes, t.size)) + ' / ' + fmt(t.size) +
            ' · 在途 ' + t.activeParts + ' 片' + (measured > 0 ? ' · 约 ' + (measured / MB).toFixed(1) + ' MB/s · ' + eta(estEta) : '') +
            '（首片约 ' + Math.ceil(mChunk / (measured || 1)) + 's）';
        }
        return '排队发送中…（' + waitSec + 's）';
      }
      var sp = t.speed > 0 ? t.speed : measured;
      var base = fmt(t.loaded) + ' / ' + fmt(t.size) + ' · ' + (sp / MB).toFixed(1) + ' MB/s · ' + eta(t.etaSec);
      if (t.activeParts > 0) base += ' · 在途 ' + t.activeParts;
      return base;
    }
    if (t.status === 'done') return '完成 · ' + fmt(t.size);
    if (t.status === 'error') return '失败：' + t.error;
    if (t.status === 'canceled') return '已取消' + (t.loaded > 0 ? '（已保留部分数据）' : '');
    return t.status;
  }

  function makeTaskRow(t) {
    var el = document.createElement('div');
    el.className = 'ac-task ac-' + t.status;
    var pct = t.size > 0 ? Math.min(100, (t.loaded / t.size) * 100) : (t.status === 'done' ? 100 : 0);
    el.innerHTML =
      '<div class="ac-row-head">' +
        '<span class="ac-kind ' + (t.kind === 'upload' ? 'up' : 'down') + '">' + (t.kind === 'upload' ? '↑' : '↓') + '</span>' +
        '<span class="ac-name" title="' + bridge.esc(t.name) + '">' + bridge.esc(t.name) + '</span>' +
        '<span class="ac-acts"></span>' +
      '</div>' +
      '<div class="ac-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="ac-status"></div>';
    var acts = el.querySelector('.ac-acts');
    if (t.status === 'error') addAct(acts, '重试', function () { Accel.retryTask(t.id); });
    if (t.status === 'running' || t.status === 'queued') addAct(acts, t.paused ? '继续' : '暂停', function () { Accel.togglePause(t.id); });
    if (t.status === 'running' || t.status === 'queued' || t.status === 'paused' || t.status === 'error') addAct(acts, '取消', function () { Accel.cancelTask(t.id); });
    addAct(acts, '移除', function () { Accel.removeTask(t.id); }, true);
    el.querySelector('.ac-status').textContent = statusText(t);
    t.el = el;
    return el;
  }
  function addAct(parent, label, fn, ghost) {
    var b = document.createElement('button');
    b.className = 'ac-act' + (ghost ? ' ghost' : '');
    b.textContent = label; b.onclick = fn;
    parent.appendChild(b);
  }
  function updateTaskRow(t) {
    if (!t.el || !t.el.parentNode) return;
    var pct = t.size > 0 ? Math.min(100, (t.loaded / t.size) * 100) : (t.status === 'done' ? 100 : 0);
    var bar = t.el.querySelector('.ac-bar > i'); if (bar) bar.style.width = pct + '%';
    var st = t.el.querySelector('.ac-status'); if (st) st.textContent = statusText(t);
    if (t.status === 'done' || t.status === 'error' || t.status === 'canceled') t.el.className = 'ac-task ac-' + t.status;
  }
  function renderDock() {
    var list = document.getElementById('ac-list'); if (!list) return;
    list.innerHTML = '';
    if (!queue.length) {
      var e = document.createElement('div'); e.className = 'ac-empty';
      e.textContent = '暂无传输任务。点「⚡ 加速上传」或在文件卡片点「⚡ 加速下载」。';
      list.appendChild(e); return;
    }
    queue.slice().reverse().forEach(function (t) { list.appendChild(makeTaskRow(t)); });
    updateAggregateSpeed();
  }
  function updateAggregateSpeed() {
    var el = document.getElementById('ac-speed'); if (!el) return;
    var speed = queue.reduce(function (s, t) { return s + (t.status === 'running' && !t.paused ? t.speed : 0); }, 0);
    el.textContent = (speed / MB).toFixed(1) + ' MB/s';
    var foot = document.getElementById('ac-foot');
    if (foot) {
      var m = loadSpeedBps();
      foot.textContent = m > 0
        ? ('实测上行 ' + (m / MB).toFixed(1) + ' MB/s · 100MB 约 ' + Math.round(100 / (m / MB)) + 's · 大文件已自动用小分片')
        : '直连加速 · 分片并发 · 失败重试 · 断点续传（⚙ 里可测速）';
    }
  }

  // ---------- 网络测速：对比「普通通道」与「加速通道」的真实吞吐 ----------
  // 普通通道模拟原应用：Blob(FormData) + 低并发(6)；加速通道：高并发 + （若网关支持）裸 body。
  // 两者都走同一个网关，因此差距来自「并发 + 封装开销」，而非换了一条网络链路。
  async function runSpeedTest() {
    var btn = document.getElementById('acfg-speed');
    var out = document.getElementById('acfg-speed-msg');
    if (!btn || !out) return;
    var s = ses();
    if (!s || !s.user) { out.textContent = '请先登录'; return; }
    // 有传输在跑时测速会互相抢带宽并拖到超时——提示用户先暂停/等完成
    var busy = queue.filter(function (t) { return t.status === 'running' && !t.paused; }).length;
    if (busy > 0) { out.textContent = '有 ' + busy + ' 个传输正在进行，请暂停或等其完成再测速（否则会互相抢带宽导致超时）'; return; }
    btn.disabled = true; out.textContent = '测试普通通道…';

    var PART = 4 * MB, N = 8;                 // 8 × 4MB = 32MB
    var cached = loadSpeedBps();
    // 动态超时：按已测速度估算传完 32MB 的时间，留足余量，最少 45 秒
    var testTimeout = cached > 0 ? Math.max(45000, (N * PART / cached) * 3 * 1000) : 90000;
    var filler = new Uint8Array(PART);
    for (var q = 0; q < PART; q++) filler[q] = q & 255;
    var stamp = Date.now();
    var base = 'users/' + s.user.id + '/.probe/speed_' + stamp + '_';

    async function measure(tag, useRaw, conc) {
      var paths = [];
      for (var i = 0; i < N; i++) paths.push(base + tag + '_' + i + '.bin');
      var t0 = Date.now();
      var fail = null;
      await accelPool(paths, { cancelFlag: false, paused: false, ctrl: makeAimd(conc, 1, 24, 99) }, function () { return conc; }, async function (path, i) {
        if (fail) return;
        try {
          var blob = new Blob([filler], { type: 'application/octet-stream' });
          if (useRaw) {
            var ab = await blob.arrayBuffer();
            var r = await withTimeout(cloud().storage.upload(path, ab, { contentType: 'application/octet-stream' }), 12000, '裸传');
            checkUploadResult(r);
          } else {
            var r2 = await withTimeout(cloud().storage.upload(path, blob, { contentType: 'application/octet-stream' }), testTimeout, '普通上传');
            checkUploadResult(r2);
          }
        } catch (e) { fail = fail || e; }
      });
      // 尽力清理测试数据
      try { await cloud().storage.remove(paths); } catch (e) {}
      if (fail) throw fail;
      var secs = Math.max(0.001, (Date.now() - t0) / 1000);
      return (N * PART) / secs / MB;
    }

    try {
      var normal = await measure('n', false, 6);
      out.textContent = '普通 ' + normal.toFixed(1) + ' MB/s · 测加速…';
      var fastConc = Math.max(8, cfg.uploadConc);
      var fast = null, rawWorks = false;
      try { fast = await measure('f', true, fastConc); rawWorks = true; }
      catch (e) { log('测速：裸传不可用', (e && e.message) || e); rawUploadSupported = false; }
      if (fast === null) {
        // 裸传失败：用「高并发 + FormData」作为加速通道再测一次
        fast = await measure('h', false, fastConc);
        saveSpeedBps(Math.max(normal, fast) * MB);
        out.textContent = '普通 ' + normal.toFixed(1) + ' · 加速(高并发) ' + fast.toFixed(1) + ' MB/s（' + (normal > 0 ? (fast / normal).toFixed(2) : '0') + '×）· 裸传不可用，已关闭';
      } else {
        var ratio = normal > 0 ? (fast / normal) : 0;
        // 只有实测确实更快才开启裸传，避免网关超时导致大文件卡死
        rawUploadSupported = ratio >= 1.05;
        var verdict = ratio >= 1.3 ? '加速有效' : (ratio >= 1.08 ? '略有提升' : '两者接近');
        saveSpeedBps(Math.max(normal, fast) * MB); // 缓存，后续上传给出可信 ETA / 自动小分片
        out.textContent = '普通 ' + normal.toFixed(1) + ' · 加速 ' + fast.toFixed(1) + ' MB/s（' + ratio.toFixed(2) + '×，' + verdict + '）· 裸传:' + (rawUploadSupported ? '已开启' : '未启用(无收益)');
      }
    } catch (e) {
      out.textContent = '测速失败：' + String((e && (e.message || e.code)) || e);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 设置弹窗 ----------
  var configBuilt = false;
  function buildConfigModal() {
    if (configBuilt || document.getElementById('accel-config-modal')) return;
    configBuilt = true;
    var m = document.createElement('div');
    m.id = 'accel-config-modal'; m.className = 'modal hidden';
    m.innerHTML =
      '<div class="modal-box ac-modal-box">' +
        '<div class="modal-head"><span>⚡ 加速器传输设置</span><button class="btn ghost small" id="acfg-close">关闭</button></div>' +
        '<div class="modal-body">' +
          '<p class="hint">分片越大、并发越高通常越快，但过高可能被网关限流。极速模式已内置自适应并发（遇限流自动降速）。所有设置立即生效并保存在本机。</p>' +
          '<div class="acfg-grid">' +
            '<label>传输模式<select id="acfg-mode"><option value="standard">标准（稳）</option><option value="turbo">极速（推荐）</option><option value="lite">省流（弱网）</option><option value="custom">自定义</option></select></label>' +
            '<label>分片大小<select id="acfg-chunk"><option value="1">1 MB</option><option value="2">2 MB</option><option value="4">4 MB</option><option value="8">8 MB</option><option value="16">16 MB</option><option value="32">32 MB</option></select></label>' +
            '<label>上传并发<input id="acfg-uc" type="number" min="1" max="24" /></label>' +
            '<label>下载并发<input id="acfg-dc" type="number" min="1" max="24" /></label>' +
            '<label>同时文件数<input id="acfg-fc" type="number" min="1" max="6" /></label>' +
            '<label>单分片重试<input id="acfg-rt" type="number" min="0" max="8" /></label>' +
            '<label>超时（秒）<input id="acfg-to" type="number" min="5" max="120" /></label>' +
          '</div>' +
          '<div class="acfg-checks">' +
            '<label><input id="acfg-direct" type="checkbox" /> 直连对象存储下载（签名地址，更快）</label>' +
            '<label><input id="acfg-adaptive" type="checkbox" /> 自适应并发（AIMD 限速保护）</label>' +
            '<label><input id="acfg-resume" type="checkbox" /> 断点续传（复用已传分片）</label>' +
          '</div>' +
          '<div class="acfg-speed">' +
            '<div class="hint">网络测速：向你的私有目录上传一小批测试数据（约 32MB，测完自动清理），对比普通通道与加速通道的实际速度。</div>' +
            '<button class="btn" id="acfg-speed">开始测速</button> <span id="acfg-speed-msg" class="ac-speed-result"></span>' +
          '</div>' +
          '<p class="hint" id="acfg-msg"></p>' +
          '<div class="acfg-actions"><button class="btn primary" id="acfg-save">保存设置</button><button class="btn" id="acfg-reset">恢复默认</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    ['mode', 'chunk', 'uc', 'dc', 'fc', 'rt', 'to', 'direct', 'adaptive', 'resume'].forEach(function (k) {
      var el = document.getElementById('acfg-' + k);
      if (el) el.onchange = function () { if (el.id === 'acfg-mode') applyPresetToForm(); else markCustom(); };
    });
    document.getElementById('acfg-close').onclick = function () { m.classList.add('hidden'); };
    document.getElementById('acfg-save').onclick = saveConfigFromForm;
    document.getElementById('acfg-speed').onclick = runSpeedTest;
    document.getElementById('acfg-reset').onclick = function () {
      cfg = Object.assign({}, DEFAULT_CFG); normalizeCfg(cfg); saveCfg(); fillConfigForm();
      document.getElementById('acfg-msg').textContent = '已恢复默认（极速）。';
    };
  }
  function fillConfigForm() {
    var mode = document.getElementById('acfg-mode'); if (!mode) return;
    mode.value = cfg.mode || 'custom';
    document.getElementById('acfg-chunk').value = String(cfg.chunkMB);
    document.getElementById('acfg-uc').value = String(cfg.uploadConc);
    document.getElementById('acfg-dc').value = String(cfg.downloadConc);
    document.getElementById('acfg-fc').value = String(cfg.fileConc);
    document.getElementById('acfg-rt').value = String(cfg.retries);
    document.getElementById('acfg-to').value = String(Math.round(cfg.timeoutMs / 1000));
    document.getElementById('acfg-direct').checked = cfg.direct;
    document.getElementById('acfg-adaptive').checked = cfg.adaptive;
    document.getElementById('acfg-resume').checked = cfg.autoResume;
  }
  function applyPresetToForm() {
    var sel = document.getElementById('acfg-mode').value;
    if (!PRESETS[sel]) return;
    var p = PRESETS[sel];
    document.getElementById('acfg-chunk').value = String(p.chunkMB);
    document.getElementById('acfg-uc').value = String(p.uploadConc);
    document.getElementById('acfg-dc').value = String(p.downloadConc);
    document.getElementById('acfg-fc').value = String(p.fileConc);
    document.getElementById('acfg-rt').value = String(p.retries);
    document.getElementById('acfg-to').value = String(Math.round(p.timeoutMs / 1000));
    document.getElementById('acfg-direct').checked = p.direct;
    document.getElementById('acfg-adaptive').checked = p.adaptive;
    document.getElementById('acfg-resume').checked = p.autoResume;
  }
  function markCustom() {
    var m = document.getElementById('acfg-mode'); if (m) m.value = 'custom';
  }
  function saveConfigFromForm() {
    var mode = document.getElementById('acfg-mode').value;
    cfg.mode = PRESETS[mode] ? mode : 'custom';
    cfg.chunkMB = Number(document.getElementById('acfg-chunk').value);
    cfg.uploadConc = Number(document.getElementById('acfg-uc').value);
    cfg.downloadConc = Number(document.getElementById('acfg-dc').value);
    cfg.fileConc = Number(document.getElementById('acfg-fc').value);
    cfg.retries = Number(document.getElementById('acfg-rt').value);
    cfg.timeoutMs = Number(document.getElementById('acfg-to').value) * 1000;
    cfg.direct = document.getElementById('acfg-direct').checked;
    cfg.adaptive = document.getElementById('acfg-adaptive').checked;
    cfg.autoResume = document.getElementById('acfg-resume').checked;
    normalizeCfg(cfg); saveCfg();
    // 运行中的任务：同步更新当前并发控制器上限
    queue.forEach(function (t) {
      var base = t.kind === 'upload' ? cfg.uploadConc : cfg.downloadConc;
      t.ctrl = makeAimd(base, 2, 12, 6);
    });
    var msg = document.getElementById('acfg-msg');
    msg.textContent = '已保存：分片 ' + cfg.chunkMB + 'MB · 上传并发 ' + cfg.uploadConc + ' · 下载并发 ' + cfg.downloadConc + ' · 同时 ' + cfg.fileConc + ' 个文件。新任务立即生效。';
  }
  function openConfig() {
    installUI(); buildConfigModal(); fillConfigForm();
    document.getElementById('accel-config-modal').classList.remove('hidden');
  }

  // ---------- 启动 ----------
  function boot() {
    installUI();
    // 登陆状态可能在 boot 之后才确定，enterApp 会再次调用 onAppReady
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
