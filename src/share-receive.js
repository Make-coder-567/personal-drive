    (function () {
      var s = new URLSearchParams(location.search).get('s');
      if (s) {
        try {
          var raw = decodeURIComponent(escape(atob(s)));
          if (raw.charAt(0) === '{') {
            // 多分片分享：公开下载，无需登录
            window.__SHARE_PAYLOAD__ = JSON.parse(raw);
            document.addEventListener('DOMContentLoaded', function () {
              var bootScreen = document.getElementById('boot-screen');
              if (bootScreen) bootScreen.remove();
              var lv = document.getElementById('login-view');
              var av = document.getElementById('app-view');
              var rv = document.getElementById('recipient-view');
              if (lv) lv.classList.add('hidden');
              if (av) av.classList.add('hidden');
              if (rv) rv.classList.remove('hidden');
              renderRecipient(window.__SHARE_PAYLOAD__);
            });
            return;
          }
          location.replace(raw); // 旧版单对象链接
          return;
        } catch (e) { /* 无效 token，继续加载应用 */ }
      }
    })();

    // ---------- 公开接收页（不依赖 cloud-sdk，直接拉取签名 URL） ----------
    var rcCancel = false;
    var RC_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    var RC_LIMIT = RC_MOBILE ? 300 * 1024 * 1024 : 1.5 * 1024 * 1024 * 1024;
    function rcFmtSize(bytes) {
      if (bytes == null) return '';
      var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = 0;
      while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
      return (i === 0 ? bytes : bytes.toFixed(1)) + ' ' + u[i];
    }
    function rcFmtEta(sec) {
      if (sec == null || !isFinite(sec) || sec <= 0) return '计算中';
      if (sec < 1) return '即将完成';
      if (sec >= 86400) return '剩余超过 1 天';
      if (sec < 60) return '剩余约 ' + Math.ceil(sec) + ' 秒';
      if (sec < 3600) {
        var m = Math.floor(sec / 60), s = Math.round(sec % 60);
        return '剩余约 ' + m + ' 分' + (s > 0 ? ' ' + s + ' 秒' : '');
      }
      var h = Math.floor(sec / 3600), mm = Math.round((sec % 3600) / 60);
      return '剩余约 ' + h + ' 小时' + (mm > 0 ? ' ' + mm + ' 分' : '');
    }
    function rcEtaTracker(total) {
      var started = Date.now(), lastT = 0, lastBytes = 0, ema = 0, samples = 0;
      return function (written) {
        var now = Date.now();
        if (!lastT) { lastT = now; lastBytes = written; return { speed: 0, eta: null }; }
        var dt = (now - lastT) / 1000;
        if (dt < 0.2) return { speed: ema, eta: null };
        var inst = Math.max(0, (written - lastBytes) / dt);
        ema = samples === 0 ? inst : (ema * 0.7 + inst * 0.3);
        samples += 1;
        lastT = now; lastBytes = written;
        var remain = Math.max(0, total - written);
        var stable = samples >= 2 && (now - started) >= 2000 && ema > 0 && remain > 0;
        return { speed: ema, eta: stable ? remain / ema : null };
      };
    }
    // 单对象直链：加 download 参数，让浏览器按附件下载（移动端交给原生下载管理器）
    function rcDirectUrl(url, name) {
      try {
        var u = new URL(url, location.origin);
        if (!u.searchParams.has('download')) u.searchParams.set('download', name || '1');
        return u.toString();
      } catch (e) { return url; }
    }
    // 原生端优先落盘：JS 层只传分片 URL 描述，不持有整文件字节；失败/不支持时回退原 Web 路径
    async function rcNativeSave(fileObj, name) {
      var nf = window.NativeFs;
      if (!nf || typeof nf.pickSavePath !== 'function' || typeof nf.saveParts !== 'function') return false;
      if (fileObj.__nativeAttempted) return false;
      fileObj.__nativeAttempted = true;
      var parts = (fileObj.parts || []).map(function (p) {
        return typeof p === 'string' ? { url: p } : p;
      });
      if (!parts.length) return false;
      var target;
      try {
        target = await nf.pickSavePath({ suggestedName: String(name || fileObj.name || 'download').split('/').pop() });
      } catch (e) {
        if (e && e.code === 'E_NATIVEFS_CANCEL') { rcSetMsg('已取消'); return true; }
        return false;
      }
      if (!target || target.canceled) { rcSetMsg('已取消'); return true; }
      var taskId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + Math.random().toString(36).slice(2));
      var startedAt = Date.now();
      try {
        await nf.saveParts({
          target: target,
          parts: parts,
          totalSize: fileObj.size || 0,
          taskId: taskId,
          onProgress: function (written, total) {
            var sp = written / Math.max(0.001, (Date.now() - startedAt) / 1000) / 1048576;
            rcSetMsg('已写入 ' + rcFmtSize(written) + ' / ' + rcFmtSize(total || fileObj.size) + ' · ' + sp.toFixed(1) + ' MB/s');
          },
        });
        rcSetMsg('已保存到原生位置 ✓');
        return true;
      } catch (e) {
        if (e && (e.code === 'E_NATIVEFS_CANCEL' || e.name === 'AbortError')) { rcSetMsg('已取消'); return true; }
        return false;
      }
    }
    // Service Worker 流式下载：把多分片拼成一个普通下载响应，手机原生下载管理器直接落盘
    async function rcServiceWorkerDownload(fileObj) {
      if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持 Service Worker');
      if (!window.isSecureContext) throw new Error('需要 HTTPS 环境');
      if (await rcNativeSave(fileObj, fileObj.name)) return true;
      var swq = window.__ASSET_CODE__ ? ('&sharecode=' + encodeURIComponent(window.__ASSET_CODE__)) : '';
      var swUrl = window.RuntimeConfig.getSwUrl();
      var swScope = new URL(swUrl, location.href).pathname.replace(/\/[^/]*$/, '/') || '/';
      var swSep = swUrl.indexOf('?') >= 0 ? '&' : '?';
      var reg = await navigator.serviceWorker.register(swUrl + swSep + 'v=20261020r' + swq, { scope: swScope });
      await navigator.serviceWorker.ready;
      var target = navigator.serviceWorker.controller || reg.active;
      if (!target) throw new Error('Service Worker 未就绪，请刷新页面后重试');
      var token = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + Math.random().toString(36).slice(2));
      await new Promise(function (resolve, reject) {
        var ch = new MessageChannel();
        var timer = setTimeout(function () { reject(new Error('Service Worker 响应超时')); }, 4000);
        ch.port1.onmessage = function (e) {
          clearTimeout(timer);
          if (e.data && e.data.ok) resolve(); else reject(new Error('Service Worker 未确认任务'));
        };
        target.postMessage({ type: 'set-download', token: token, file: { name: fileObj.name, size: fileObj.size, parts: fileObj.parts }, downloadPrefix: window.RuntimeConfig.getDownloadPrefix() }, [ch.port2]);
      });
      var a = document.createElement('a');
      a.href = window.RuntimeConfig.getDownloadPrefix() + token;
      a.download = String(fileObj.name || 'download').split('/').pop();
      document.body.appendChild(a); a.click(); a.remove();
    }
    async function rcDownloadSmart(fileObj, name) {
      if (await rcNativeSave(fileObj, name)) return;
      if (fileObj.parts && fileObj.parts.length > 1 && 'serviceWorker' in navigator && window.isSecureContext) {
        try {
          await rcServiceWorkerDownload(fileObj);
          rcSetMsg('已交给浏览器原生下载，请在下载列表/通知栏查看。');
          return;
        } catch (e) { /* 回退到 JS 路径 */ }
      }
      await rcSaveFile(fileObj, name);
    }
    async function rcSaveFile(fileObj, suggestedName) {
      if (!fileObj.__nativeAttempted && await rcNativeSave(fileObj, suggestedName)) return;
      var total = fileObj.parts.length;
      var etaTrack = rcEtaTracker(fileObj.size);
      var startedAt = Date.now();
      if (window.showSaveFilePicker) {
        var handle = await window.showSaveFilePicker({ suggestedName: suggestedName });
        var writable = await handle.createWritable();
        var CONC = 6;               // 并行下载分片，缩短总时长，尽量在签名有效期内完成
        var nextFetch = 0, nextWrite = 0, written = 0;
        var buffers = new Map();
        var failed = null;
        var worker = async function () {
          while (true) {
            if (failed || rcCancel) return;
            var i = nextFetch++;
            if (i >= total) return;
            try {
              if (rcCancel) throw new Error('已取消');
              var resp = await fetch(fileObj.parts[i]);
              if (!resp.ok) {
                var extra = resp.status === 401 ? '：签名链接已过期，请让分享者用更长有效期重新生成，或把文件拆分后分享' : '';
                throw new Error('分片 ' + i + ' 下载失败 (' + resp.status + ')' + extra);
              }
              buffers.set(i, new Uint8Array(await resp.arrayBuffer()));
            } catch (e) { failed = e; return; }
          }
        };
        var workers = [];
        for (var w = 0; w < Math.min(CONC, total); w++) workers.push(worker());
        try {
          while (nextWrite < total) {
            if (rcCancel) throw new Error('已取消');
            if (failed) throw failed;
            if (!buffers.has(nextWrite)) { await new Promise(function (r) { setTimeout(r, 40); }); continue; }
            var buf = buffers.get(nextWrite); buffers.delete(nextWrite);
            await writable.write(buf);
            written += buf.length;
            var er = etaTrack(written);
            var sp = (er.speed > 0 ? er.speed : written / Math.max(0.001, (Date.now() - startedAt) / 1000)) / 1048576;
            rcSetMsg('已写入 ' + rcFmtSize(written) + ' / ' + rcFmtSize(fileObj.size) + ' · ' + sp.toFixed(1) + ' MB/s · ' + rcFmtEta(er.eta));
            nextWrite++;
          }
          await Promise.all(workers);
          await writable.close();
        } catch (e) {
          try { await writable.close(); } catch (e2) { /* ignore */ }
          throw e;
        }
      } else {
        if (fileObj.size > RC_LIMIT) throw new Error('当前浏览器不支持流式落盘，单次上限约 ' + rcFmtSize(RC_LIMIT) + '；请点「高速下载（原生）」，或改用 Chrome/Edge');
        var chunks = [];
        var got = 0;
        for (var j = 0; j < total; j++) {
          if (rcCancel) throw new Error('已取消');
          var r2 = await fetch(fileObj.parts[j]);
          if (!r2.ok) {
            var extra2 = r2.status === 401 ? '：签名链接已过期，请让分享者重新生成更长有效期的链接' : '';
            throw new Error('分片 ' + j + ' 下载失败 (' + r2.status + ')' + extra2);
          }
          var ab = await r2.arrayBuffer();
          chunks.push(ab);
          got += ab.byteLength;
          var er2 = etaTrack(got);
          var sp2 = (er2.speed > 0 ? er2.speed : got / Math.max(0.001, (Date.now() - startedAt) / 1000)) / 1048576;
          rcSetMsg('已下载 ' + rcFmtSize(got) + ' / ' + rcFmtSize(fileObj.size) + ' · ' + sp2.toFixed(1) + ' MB/s · ' + rcFmtEta(er2.eta));
        }
        var blob = new Blob(chunks);
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = suggestedName; a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      }
    }
    async function rcSaveZip(folderName, files) {
      var mod = await import('https://cdn.jsdelivr.net/npm/client-zip@2/+esm');
      var downloadZip = mod.downloadZip;
      var inputs = files.map(function (f) {
        return {
          name: f.name,
          size: f.size,
          input: (async function* () {
            for (var i = 0; i < f.parts.length; i++) {
              if (rcCancel) throw new Error('已取消');
              var r = await fetch(f.parts[i]);
              if (!r.ok) throw new Error('分片 ' + i + ' 下载失败 (' + r.status + ')');
              var reader = r.body.getReader();
              while (true) { if (rcCancel) throw new Error('已取消'); var d = await reader.read(); if (d.done) break; yield d.value; }
            }
          })(),
        };
      });
      var response = downloadZip(inputs);
      if (window.showSaveFilePicker) {
        var handle = await window.showSaveFilePicker({ suggestedName: folderName + '.zip' });
        var w = await handle.createWritable();
        try {
          await response.body.pipeTo(w);
        } catch (e) {
          try { await w.close(); } catch (e2) { /* ignore */ }
          throw e;
        }
      } else {
        var blob = await response.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = folderName + '.zip'; a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      }
    }
    function rcSetMsg(t) { document.getElementById('rc-msg').textContent = t; }
    function rcClearList() { var box = document.getElementById('rc-files'); if (box) box.innerHTML = ''; }
    function rcShowSingle(payload) {
      document.getElementById('rc-name').textContent = payload.name;
      document.getElementById('rc-size').textContent = '大小：' + rcFmtSize(payload.size) + ' · 共 ' + payload.parts.length + ' 个分片';
      var dl = document.getElementById('rc-download');
      dl.classList.remove('hidden');
      var sw = document.getElementById('rc-sw');
      var base = String(payload.name || 'download').split('/').pop();
      if (payload.parts.length === 1) {
        // 单对象：直接走原生直链，手机也能下载大文件
        dl.textContent = '下载文件（原生直链）';
        dl.onclick = function () {
          rcNativeSave(payload, base).then(function (done) {
            if (done) return;
            var a = document.createElement('a');
            a.href = rcDirectUrl(payload.parts[0], base);
            a.download = base;
            document.body.appendChild(a); a.click(); a.remove();
          });
        };
        sw.classList.add('hidden');
      } else {
        dl.textContent = '下载文件（兼容模式）';
        var running = false;
        dl.onclick = async function () {
          if (running) { rcCancel = true; rcSetMsg('正在取消…'); return; }
          running = true; rcCancel = false; dl.disabled = false; dl.textContent = '取消下载'; rcSetMsg('下载中…');
          try { await rcSaveFile(payload, payload.name); rcSetMsg('下载完成 ✓'); }
          catch (e) { rcSetMsg(rcCancel ? '已取消' : ((e && e.name === 'AbortError') ? '已取消选择' : ('下载失败：' + (e.message || e)))); }
          running = false; rcCancel = false; dl.textContent = '下载文件（兼容模式）'; dl.disabled = false;
        };
        if ('serviceWorker' in navigator && window.isSecureContext) {
          sw.classList.remove('hidden');
          sw.textContent = '高速下载（原生）';
          sw.onclick = async function () {
            sw.disabled = true; rcSetMsg('正在准备原生下载…');
            try { await rcServiceWorkerDownload(payload); rcSetMsg('已交给浏览器原生下载，请在下载列表/通知栏查看。'); }
            catch (e) { rcSetMsg('原生下载失败：' + (e.message || e)); }
            sw.disabled = false;
          };
        } else {
          sw.classList.add('hidden');
        }
      }
      document.getElementById('rc-zip').classList.add('hidden');
      rcClearList();
    }
    function rcShowFolder(manifest) {
      var files = manifest.files || [];
      if (files.length === 1) { rcShowSingle({ name: files[0].name, size: files[0].size, parts: files[0].parts }); return; }
      var total = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      document.getElementById('rc-name').textContent = manifest.name || '文件夹';
      document.getElementById('rc-size').textContent = '共 ' + files.length + ' 个文件，' + rcFmtSize(total);
      var dl = document.getElementById('rc-download'); dl.classList.add('hidden');
      document.getElementById('rc-sw').classList.add('hidden');
      var zip = document.getElementById('rc-zip'); zip.classList.remove('hidden'); zip.disabled = false;
      var zrunning = false;
      zip.onclick = async function () {
        if (zrunning) { rcCancel = true; rcSetMsg('正在取消…'); return; }
        zrunning = true; rcCancel = false; zip.disabled = false; zip.textContent = '取消打包'; rcSetMsg('打包下载中（建议用 Chrome/Edge）…');
        try { await rcSaveZip(manifest.name || 'folder', files); rcSetMsg('打包下载完成 ✓'); }
        catch (e) { rcSetMsg(rcCancel ? '已取消' : ((e && e.name === 'AbortError') ? '已取消选择' : ('打包下载失败：' + (e.message || e)))); }
        zrunning = false; rcCancel = false; zip.textContent = '下载全部（ZIP）'; zip.disabled = false;
      };
      var box = document.getElementById('rc-files'); box.innerHTML = '';
      files.forEach(function (f) {
        var row = document.createElement('div'); row.className = 'rc-row';
        var nm = document.createElement('span'); nm.className = 'rc-fname'; nm.textContent = f.name;
        var sz = document.createElement('span'); sz.className = 'rc-fsize'; sz.textContent = rcFmtSize(f.size);
        var b = document.createElement('button'); b.className = 'btn small'; b.textContent = '下载';
        if (f.parts.length > 1 && 'serviceWorker' in navigator && window.isSecureContext) {
          b.textContent = '高速下载';
          b.onclick = async function () {
            b.disabled = true; rcSetMsg('正在准备原生下载：' + f.name);
            try { await rcServiceWorkerDownload(f); rcSetMsg('已交给浏览器原生下载：' + f.name); }
            catch (e) { rcSetMsg('原生下载失败：' + (e.message || e)); }
            b.disabled = false;
          };
        } else {
          var running = false;
          b.onclick = async function () {
            if (running) { rcCancel = true; rcSetMsg('正在取消…'); return; }
            running = true; rcCancel = false; b.disabled = false; b.textContent = '取消'; rcSetMsg('下载中：' + f.name);
            try { await rcSaveFile(f, f.name.split('/').pop()); rcSetMsg('下载完成 ✓'); }
            catch (e) { rcSetMsg(rcCancel ? '已取消' : ((e && e.name === 'AbortError') ? '已取消选择' : ('下载失败：' + (e.message || e)))); }
            running = false; rcCancel = false; b.textContent = '下载'; b.disabled = false;
          };
        }
        row.appendChild(nm); row.appendChild(sz); row.appendChild(b);
        box.appendChild(row);
      });
    }
    async function renderRecipient(payload) {
      if (payload && payload.type === 'manifest' && payload.url) {
        rcSetMsg('正在读取分享清单…');
        try {
          var r = await fetch(payload.url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var manifest = await r.json();
          rcSetMsg('');
          rcShowFolder(manifest);
        } catch (e) { rcSetMsg('读取分享清单失败：' + (e.message || e)); }
        return;
      }
      if (payload && payload.type === 'folder') { rcShowFolder(payload); return; }
      rcShowSingle(payload);
    }
