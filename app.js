/* 个人云盘 —— 基于 WorkBuddy cloud-service 的前端应用
 * 模块：Auth(Email+密码) + Storage(文件/元数据)
 * 元数据以 JSON 存于用户私有存储路径；所有文件均按 100MB 分片存储（统一策略，无大小阈值）。
 */
if (!window.WorkBuddyCloud) {
  if (!new URLSearchParams(location.search).get('s')) {
    document.body.insertAdjacentHTML('afterbegin', '<div style="padding:24px;font-size:14px;line-height:1.8">加载云端组件失败：请检查网络后刷新；微信内可点右上角「在浏览器打开」。</div>');
  }
  throw new Error('WorkBuddyCloud SDK 未加载');
}
const publicConfig = {
  endpoint: "https://personal-drive-52476.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_Iu0SO5ZWbqML8CbU1Hz35W_zm8xsq02TBIxI1HqAunOT1J5ZILym1qb",
};

const cloud = WorkBuddyCloud.createWorkBuddyCloud(publicConfig);

// 平台站点访问码（部署链接 ?sharecode=...）：分享链接必须带上，接收方才能公开打开
const DEFAULT_SITE_CODE = 'PBCKY4YAA5';
let SITE_CODE = DEFAULT_SITE_CODE;
try {
  const sp = new URLSearchParams(location.search);
  const fromUrl = sp.get('sharecode');
  if (fromUrl) { SITE_CODE = fromUrl; localStorage.setItem('drive_sharecode', fromUrl); }
  else { const saved = localStorage.getItem('drive_sharecode'); if (saved) SITE_CODE = saved; }
} catch (e) { /* localStorage 不可用时用默认值 */ }

// 上传参数（可在“设置”里调整，持久化到 localStorage）
function numLS(k, def) { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : def; }
let CHUNK_MB = Math.max(1, Math.min(64, numLS('drive_chunk_mb', 8)));
let UPLOAD_CONC = Math.max(1, Math.min(16, numLS('drive_upload_conc', 6)));
let CHUNK_SIZE = CHUNK_MB * 1024 * 1024;    // 分片大小（默认 8MB；越大越快，但可能被网关拒绝）
let UPLOAD_CTRL = makeCtrl(UPLOAD_CONC, 2, Math.max(12, UPLOAD_CONC), 10);
let DOWNLOAD_CTRL = makeCtrl(6, 2, 12, 8);
const DOWNLOAD_CONC_START = 6;
const APP_VERSION = 'v2026-11-19-forgot';  // 版本号：显示在标签页标题，用于确认是否加载到最新代码
const PREVIEW_MAX = 50 * 1024 * 1024;      // 预览仅支持 <50MB
const SHARE_TTL = 3600;                    // 签名链接最长 1 小时

// ---------- 状态 ----------
let session = null;
let meta = { folders: [], files: [] };
let currentFolderId = null;
const pendingOtp = { email: null, verificationId: null, isExistingUser: false };
const resetCtx = { email: null, mode: null, updateUser: null, verificationId: null, isExistingUser: false };

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);
function uid() { return crypto.randomUUID(); }
function fmtSize(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : b.toFixed(1)) + ' ' + u[i];
}
// 预计剩余时间：速度用 EMA 平滑；样本不足或速度未稳定时返回“计算中”
function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '计算中';
  if (sec < 1) return '即将完成';
  if (sec >= 86400) return '剩余超过 1 天';
  if (sec < 60) return '剩余约 ' + Math.ceil(sec) + ' 秒';
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return '剩余约 ' + m + ' 分' + (s > 0 ? ' ' + s + ' 秒' : '');
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return '剩余约 ' + h + ' 小时' + (m > 0 ? ' ' + m + ' 分' : '');
}
function makeEtaTracker(total) {
  const started = Date.now();
  let lastT = 0, lastBytes = 0, ema = 0, samples = 0;
  return function (written) {
    const now = Date.now();
    if (!lastT) { lastT = now; lastBytes = written; return { speed: 0, eta: null }; }
    const dt = (now - lastT) / 1000;
    if (dt < 0.2) return { speed: ema, eta: null };
    const inst = Math.max(0, (written - lastBytes) / dt);
    ema = samples === 0 ? inst : (ema * 0.7 + inst * 0.3);
    samples += 1;
    lastT = now; lastBytes = written;
    const remain = Math.max(0, total - written);
    const stable = samples >= 2 && (now - started) >= 2000 && ema > 0 && remain > 0;
    return { speed: ema, eta: stable ? remain / ema : null };
  };
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function b64encodeUrl(s) { return btoa(unescape(encodeURIComponent(s))); }

// 兼容 SDK 返回形态（download 可能返回 Blob 或 {data}）
async function getBlob(result) {
  if (!result) return null;
  if (result instanceof Blob) return result;
  if (result.data instanceof Blob) return result.data;
  if (result.data && result.data.data instanceof Blob) return result.data.data;
  return result.data || null;
}
async function getStream(result) {
  let o = result;
  if (result && result.data && (result.data.asStream || result.data.body)) o = result.data;
  if (o && typeof o.asStream === 'function') return o.asStream();
  if (o && o.body && typeof o.body.getReader === 'function') return o.body;
  return null;
}
// 列出前缀下的完整对象键。CloudBase 单次 list 上限 1000，这里自动分页取全。
// 返回形态可能是数组、{data:[...]}、{Contents:[{Key:...}]} 等，键名可能是完整键/相对用户根/相对前缀。
async function listKeys(prefix, paginate) {
  if (paginate === undefined) paginate = true;
  const pickArray = (x, depth) => {
    if (!x || depth > 5) return null;
    if (Array.isArray(x)) return x;
    if (typeof x !== 'object') return null;
    const cands = [x.data, x.Contents, x.contents, x.objects, x.items, x.files, x.results, x.keys, x.list, x.records, x.entries, x.children];
    for (const c of cands) { if (Array.isArray(c)) return c; }
    for (const c of cands) { const a = pickArray(c, depth + 1); if (a) return a; }
    return null;
  };
  const base = 'users/' + session.user.id + '/';
  const rel = prefix.indexOf(base) === 0 ? prefix.slice(base.length) : prefix;
  const normalize = (o) => {
    let name = typeof o === 'string'
      ? o
      : (o.Key || o.key || o.name || o.objectName || o.object_name || o.fullPath || o.path || o.id || '');
    if (!name) return '';
    if (name.charAt(0) === '/') name = name.slice(1);
    if (name.indexOf(base) === 0) return name;
    if (name.indexOf('users/') === 0) return name;
    if (rel && name.indexOf(rel) === 0) return base + name;
    return prefix + name;
  };
  const PAGE = 1000;
  const out = []; const seen = new Set();
  for (let offset = 0; offset < 500000; offset += PAGE) {
    let arr = [];
    try {
      const r = await cloud.storage.list(prefix, { limit: PAGE, offset });
      arr = pickArray(r, 0) || pickArray(r && r.data, 0) || [];
      if (!arr.length && offset === 0) {
        const shape = (x) => x == null ? String(x) : (Array.isArray(x) ? 'array[' + x.length + ']' : 'object{' + Object.keys(x).slice(0, 10).join(',') + '}');
        console.warn('[list] 前缀', prefix, '未解析到对象; r=', shape(r), ' r.data=', shape(r && r.data));
      }
    } catch (e) { break; }
    if (!arr.length) break;
    let added = 0;
    for (const o of arr) {
      const k = normalize(o);
      if (k && !seen.has(k)) { seen.add(k); out.push(k); added += 1; }
    }
    if (!added) break; // offset 不支持或已到末尾
    if (!paginate) break; // 只取第一页（用于诊断，减少请求量）
    if (arr.length < PAGE) break;
  }
  return out;
}

// 分片上传：
// ① 分片键内容由“文件字节范围”唯一确定，若返回“已存在”，说明此前已正确写入，直接视为成功（不依赖覆盖/删除）。
// ② 对网络类失败（Failed to fetch / 超时 / 5xx）自动退避重试，提升大文件在弱网下的成功率；配额/权限类错误快速失败。
async function uploadPart(path, blob, sig) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (sig && sig.cancelled) throw new Error('已取消');
    try {
      const r = await cloud.storage.upload(path, blob, { contentType: 'application/octet-stream' });
      if (r && r.error) {
        const m = (r.error.message || '') + ' ' + (r.error.code || '');
        if (/ALREADY_EXISTS|already exists/i.test(m)) return; // 已存在即成功
        if (/quota|403|forbidden|unauthor|invalid|413|payload too large|not found/i.test(m)) throw r.error; // 永久错误
        lastErr = r.error;
      } else {
        return; // 成功
      }
    } catch (e) {
      const m = ((e && (e.message || e.code)) || '') + '';
      if (/ALREADY_EXISTS|already exists/i.test(m)) return; // 已存在即成功
      if (/quota|403|forbidden|unauthor|invalid|413|payload too large|not found/i.test(m)) throw e; // 永久错误
      lastErr = e;
    }
    // 网络类失败：退避后重试
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
  throw lastErr || new Error('分片上传失败（多次重试）');
}

// 受限并发执行（避免一次性发太多请求触发限流）
async function mapPool(items, concurrency, worker) {
  const runners = []; let idx = 0; let failed = null;
  const n = Math.min(concurrency, items.length);
  for (let k = 0; k < n; k++) {
    runners.push((async () => {
      while (idx < items.length && !failed) {
        const cur = idx++;
        try { await worker(items[cur], cur); }
        catch (e) { failed = failed || e; } // 记录首个错误并停止拉取新任务
      }
    })());
  }
  await Promise.all(runners); // 等待在途任务全部结束，避免失败后仍在后台堆积请求
  if (failed) throw failed;
}

// ---------- 自适应并发（AIMD）：成功累积后缓慢提速，遇限流/超时/网络错误则减半并短暂冷却 ----------
function makeCtrl(start, min, max, step) {
  let value = start, streak = 0, cooldownUntil = 0;
  return {
    get value() { return value; },
    get cooldownUntil() { return cooldownUntil; },
    success() { streak += 1; if (streak >= step) { streak = 0; if (value < max) value += 1; } },
    failure(e) {
      const m = String((e && (e.message || e.code)) || e);
      if (/403|429|too many|rate|timeout|超时|Failed to fetch|network|abort/i.test(m)) {
        value = Math.max(min, Math.floor(value / 2));
        streak = 0;
        cooldownUntil = Date.now() + 1500;
      }
    },
  };
}
// 动态并发池：并发数由 ctrl.value 实时决定；首个错误后停止派发，等在途任务结束后抛出。
async function adaptivePool(items, ctrl, worker) {
  return new Promise((resolve, reject) => {
    let next = 0, active = 0, failed = null, settled = false;
    const finish = () => {
      if (settled) return;
      if (failed && active === 0) { settled = true; reject(failed); return; }
      if (!failed && next >= items.length && active === 0) { settled = true; resolve(); }
    };
    const pump = () => {
      if (settled) return;
      if (failed) { finish(); return; }
      const wait = ctrl.cooldownUntil - Date.now();
      if (wait > 0) { setTimeout(pump, Math.min(wait, 1000)); return; }
      while (!failed && active < ctrl.value && next < items.length) {
        const idx = next++;
        active += 1;
        Promise.resolve()
          .then(() => worker(items[idx], idx))
          .then(() => { active -= 1; ctrl.success(); pump(); })
          .catch((e) => { active -= 1; ctrl.failure(e); failed = failed || e; pump(); });
      }
      finish();
    };
    pump();
  });
}

// ---------- 鉴权 ----------
async function init() {
  const { data } = await cloud.auth.getSession();
  if (data && data.user) { session = data; enterApp(); }
  else showLogin();
}
function showLogin() {
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
  if ($('forgot-form')) { $('forgot-form').classList.add('hidden'); $('login-form').classList.remove('hidden'); $('tab-login').classList.add('active'); }
}

function enterApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('user-email').textContent = session.user.email || session.user.id;
  document.title = '个人云盘 ' + APP_VERSION; // 标签页标题带版本号，便于确认是否最新代码
  // 动态注入“诊断”按钮（即使 HTML 被缓存、缺少该按钮也能出现）
  const userBox = document.querySelector('.topbar .user');
  if (userBox && !document.getElementById('btn-tasks')) {
    const tb = document.createElement('button');
    tb.id = 'btn-tasks'; tb.className = 'btn ghost'; tb.textContent = '任务';
    tb.onclick = () => $('tasks').classList.remove('hidden');
    userBox.insertBefore(tb, document.getElementById('btn-domain') || document.getElementById('btn-settings') || document.getElementById('btn-logout'));
  }
  if (userBox && document.getElementById('help-modal') && !document.getElementById('btn-help')) {
    const hb = document.createElement('button');
    hb.id = 'btn-help'; hb.className = 'btn ghost'; hb.textContent = '帮助';
    hb.onclick = openHelp;
    userBox.insertBefore(hb, document.getElementById('btn-logout'));
  }
  if (userBox && document.getElementById('domain-modal') && !document.getElementById('btn-domain')) {
    const db = document.createElement('button');
    db.id = 'btn-domain'; db.className = 'btn ghost'; db.textContent = '域名';
    db.onclick = openDomainModal;
    userBox.insertBefore(db, document.getElementById('btn-settings') || document.getElementById('btn-logout'));
  }
  if (userBox && !document.getElementById('btn-settings')) {
    const sb = document.createElement('button');
    sb.id = 'btn-settings'; sb.className = 'btn ghost'; sb.textContent = '设置';
    sb.onclick = openUploadSettings;
    userBox.insertBefore(sb, document.getElementById('btn-logout'));
  }
  if (userBox && !document.getElementById('btn-diag')) {
    const b = document.createElement('button');
    b.id = 'btn-diag'; b.className = 'btn ghost'; b.textContent = '诊断';
    b.onclick = runDiag;
    userBox.insertBefore(b, document.getElementById('btn-logout'));
  }
  // 动态补充“校验文件夹”按钮与目录输入（即使 HTML 被缓存也能用）
  const actions = document.querySelector('.toolbar .actions');
  if (actions && !document.getElementById('btn-check-folder')) {
    const cb = document.createElement('button');
    cb.id = 'btn-check-folder'; cb.className = 'btn'; cb.textContent = '校验文件夹';
    const inp = document.createElement('input');
    inp.id = 'check-input'; inp.type = 'file'; inp.multiple = true; inp.className = 'hidden';
    inp.setAttribute('webkitdirectory', ''); inp.setAttribute('directory', '');
    inp.onchange = async (e) => { const files = [...e.target.files]; e.target.value = ''; await runFolderCheck(files); };
    cb.onclick = () => inp.click();
    const anchor = document.getElementById('btn-upload-folder');
    if (anchor) actions.insertBefore(cb, anchor); else actions.appendChild(cb);
    actions.appendChild(inp);
  }
  console.log('[auth] 用户:', session.user.email || '(无邮箱)', 'id:', session.user.id, '版本:', APP_VERSION);
  cloud.auth.onAuthStateChange((event, s) => { if (event === 'SIGNED_OUT') { session = null; showLogin(); } });
  loadMeta().then(render);
  maybeShowHelp();
  if (window.Accel && typeof window.Accel.onAppReady === 'function') { try { window.Accel.onAppReady(); } catch (e) {} }
}

async function doLogin() {
  const msg = $('li-msg'); msg.textContent = '';
  const email = $('li-email').value.trim(), password = $('li-password').value;
  if (!email || !password) { msg.textContent = '请输入邮箱和密码'; return; }
  const { error } = await cloud.auth.signInWithPassword({ email, password });
  if (error) { msg.textContent = error.message || '登录失败'; return; }
  const { data } = await cloud.auth.getSession();
  if (data) { session = data; enterApp(); }
}

async function sendSignupCode() {
  const msg = $('su-msg'); msg.textContent = '';
  const email = $('su-email').value.trim();
  if (!email) { msg.textContent = '请输入邮箱'; return; }
  const r = await cloud.auth.sendOtp({ email });
  if (r.error) { msg.textContent = r.error.message || '发送失败'; return; }
  pendingOtp.email = email;
  pendingOtp.verificationId = r.data.verificationId;
  pendingOtp.isExistingUser = r.data.isExistingUser;
  msg.style.color = '#2f6fed';
  msg.textContent = '验证码已发送，请查收邮箱';
  msg.style.color = '';
}
async function doSignup() {
  const msg = $('su-msg'); msg.textContent = '';
  const email = $('su-email').value.trim();
  const token = $('su-code').value.trim();
  const password = $('su-password').value;
  if (!pendingOtp.verificationId) { msg.textContent = '请先获取验证码'; return; }
  if (!token || !password) { msg.textContent = '请输入验证码和密码'; return; }
  const r = await cloud.auth.verifyOtp({
    email: pendingOtp.email,
    verificationId: pendingOtp.verificationId,
    isExistingUser: pendingOtp.isExistingUser,
    token, password,
  });
  if (r.error) { msg.textContent = r.error.message || '创建失败'; return; }
  pendingOtp.email = null; pendingOtp.verificationId = null;
  const { data } = await cloud.auth.getSession();
  if (data) { session = data; enterApp(); }
}
async function doLogout() {
  await cloud.auth.signOut();
  session = null; showLogin();
}

// ---------- 忘记密码：邮箱验证码重置 / 免密登录 ----------
function showForgot() {
  $('login-form').classList.add('hidden');
  $('signup-form').classList.add('hidden');
  $('forgot-form').classList.remove('hidden');
  $('tab-login').classList.remove('active');
  $('tab-signup').classList.remove('active');
  $('li-msg').textContent = '';
  $('fp-msg').textContent = '';
}
function showLoginForm() {
  $('forgot-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
  $('tab-login').classList.add('active');
  $('li-msg').textContent = '';
  $('fp-msg').textContent = '';
}
async function fpSendCode() {
  const msg = $('fp-msg'); msg.textContent = '';
  const email = $('fp-email').value.trim();
  if (!email) { msg.textContent = '请输入注册邮箱'; return; }
  if (typeof cloud.auth.resetPasswordForEmail === 'function') {
    // 正规重置：发送 PASSWORD_RESET 验证码，返回 updateUser 用于设置新密码
    const r = await cloud.auth.resetPasswordForEmail(email);
    if (r.error) { msg.textContent = r.error.message || '发送失败，请确认邮箱是否已注册'; return; }
    resetCtx.email = email;
    resetCtx.mode = 'reset';
    resetCtx.updateUser = r.data && r.data.updateUser;
  } else {
    // 兜底：SDK 未暴露重置接口时，用登录验证码让老用户免密登录
    const r = await cloud.auth.sendOtp({ email });
    if (r.error) { msg.textContent = r.error.message || '发送失败，请确认邮箱是否已注册'; return; }
    resetCtx.email = email;
    resetCtx.mode = 'otp';
    resetCtx.verificationId = r.data.verificationId;
    resetCtx.isExistingUser = r.data.isExistingUser;
  }
  $('fp-send').textContent = '已发送，请查收';
  msg.style.color = '#2f6fed';
  msg.textContent = '验证码已发送，请查收邮箱（若未收到请检查垃圾邮件）';
}
async function fpSubmit() {
  const msg = $('fp-msg'); msg.textContent = '';
  const code = $('fp-code').value.trim();
  const password = $('fp-password').value;
  if (!resetCtx.email) { msg.textContent = '请先获取验证码'; return; }
  if (!code) { msg.textContent = '请输入验证码'; return; }
  if (!password) { msg.textContent = '请设置新密码'; return; }
  let result;
  if (resetCtx.mode === 'reset' && typeof resetCtx.updateUser === 'function') {
    result = await resetCtx.updateUser({ nonce: code, password });
  } else {
    result = await cloud.auth.verifyOtp({
      email: resetCtx.email,
      verificationId: resetCtx.verificationId,
      isExistingUser: resetCtx.isExistingUser,
      token: code, password,
    });
  }
  if (result && result.error) { msg.textContent = result.error.message || '重置失败，请检查验证码'; return; }
  const { data } = await cloud.auth.getSession();
  if (data) {
    resetCtx.email = null; resetCtx.updateUser = null;
    $('fp-password').value = ''; $('fp-code').value = '';
    session = data; enterApp();
  } else {
    msg.textContent = '验证成功，请返回登录页用新密码登录';
  }
}

// ---------- 元数据（版本化：每次写新键，绝不覆盖，加载时取最新版本） ----------
function metaPrefix() { return 'users/' + session.user.id + '/meta/'; }
function metaLegacyPath() { return cloud.storage.userPath(session.user.id, 'meta/index.json'); }
function metaKeyLS() { return 'drive_meta_key_' + session.user.id; }
async function loadMeta() {
  const cands = []; // 收集候选元数据，最终取版本号最大（其次文件数最多）的一份
  const push = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (!Array.isArray(obj.files) && !Array.isArray(obj.folders)) return;
    cands.push(obj);
  };
  // A) 本设备记录的最新版本键
  try {
    const k = localStorage.getItem(metaKeyLS());
    if (k) {
      const r = await cloud.storage.download(k);
      const blob = await getBlob(r);
      if (blob) push(JSON.parse(await blob.text()));
    }
  } catch (e) { /* ignore */ }
  // B) 列出 meta/ 下版本号最大的文件
  try {
    const keys = await listKeys(metaPrefix());
    let best = null; let bestVer = -1;
    for (const k of keys) {
      const file = k.split('/').pop() || '';
      let ver = -1;
      const mm = file.match(/^m_(\d+)/);
      if (mm) ver = parseInt(mm[1], 10);
      else if (file === 'index.json') ver = 0;
      else continue;
      if (ver > bestVer) { bestVer = ver; best = k; }
      else if (ver === bestVer && best && k > best) { best = k; }
    }
    if (best) {
      try {
        const r = await cloud.storage.download(best);
        const blob = await getBlob(r);
        if (blob) { push(JSON.parse(await blob.text())); try { localStorage.setItem(metaKeyLS(), best); } catch (e) {} }
      } catch (e) { /* 该键不可用则忽略 */ }
    }
  } catch (e) { /* list 失败则忽略 */ }
  // C) 旧版 index.json
  try {
    const r = await cloud.storage.download(metaLegacyPath());
    const blob = await getBlob(r);
    if (blob) push(JSON.parse(await blob.text()));
  } catch (e) { /* ignore */ }

  // 选择最优候选：
  // ① 空元数据绝不能覆盖有数据的元数据（否则空版本一旦写入会自我强化，导致“文件消失”）；
  // ② 在非空候选中，版本号大者优先（尊重删除/更新），其次条目多者。
  const richness = (m) => (Array.isArray(m.files) ? m.files.length : 0) + (Array.isArray(m.folders) ? m.folders.length : 0);
  const nonEmpty = cands.filter((m) => richness(m) > 0);
  const pool = nonEmpty.length ? nonEmpty : cands;
  let bestMeta = null; let bestVer = -1; let bestRich = -1;
  for (const m of pool) {
    const ver = Number(m.__ver) || 0;
    const rich = richness(m);
    if (ver > bestVer || (ver === bestVer && rich > bestRich)) { bestVer = ver; bestRich = rich; bestMeta = m; }
  }
  const maxVer = cands.reduce((mx, m) => Math.max(mx, Number(m.__ver) || 0), 0);
  meta = bestMeta || { folders: [], files: [], uploads: {} };
  if (!meta.folders) meta.folders = [];
  if (!meta.files) meta.files = [];
  if (!meta.uploads) meta.uploads = {};
  // 关键：把版本号抬到所有候选的最大值，保证下一次保存能“盖过”那些空的旧版本
  meta.__ver = Math.max(maxVer, Number(meta.__ver) || 0);
  console.log('[meta] 候选数:', cands.length, '采用版本:', meta.__ver, '文件数:', meta.files.length);
}
async function saveMeta() {
  meta.__ver = (meta.__ver || 0) + 1; // 每次保存单调递增，用于加载时选最新
  const blob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
  const fixed = metaLegacyPath();
  // 1) 用 update(PUT) 覆盖固定 index.json —— PUT 通常是覆盖语义，不受 STORAGE_KEY_ALREADY_EXISTS 限制
  try {
    const r = await cloud.storage.update(fixed, blob, { contentType: 'application/json' });
    if (!(r && r.error)) { try { localStorage.setItem(metaKeyLS(), fixed); } catch (e) {} return; }
  } catch (e) { /* update 不可用，继续 */ }
  // 2) 首次创建固定 index.json
  try {
    const r = await cloud.storage.upload(fixed, blob, { contentType: 'application/json' });
    if (!(r && r.error)) { try { localStorage.setItem(metaKeyLS(), fixed); } catch (e) {} return; }
  } catch (e) { /* 可能已存在但 update 不可用，继续 */ }
  // 3) 兜底：写入版本化新键（永不冲突）
  const ver = String(meta.__ver).padStart(9, '0');
  const key = cloud.storage.userPath(session.user.id, 'meta/m_' + ver + '_' + Date.now() + '.json');
  const r3 = await cloud.storage.upload(key, blob, { contentType: 'application/json' });
  if (r3 && r3.error) throw r3.error;
  try { localStorage.setItem(metaKeyLS(), key); } catch (e) {}
}

// ---------- 文件/文件夹路径 ----------
function filePath(file, i) {
  const base = file.objectKey;
  return cloud.storage.userPath(session.user.id, i == null ? base : base + '/part_' + i);
}
function partPaths(file) {
  if (!file.chunked) return [cloud.storage.userPath(session.user.id, file.objectKey)];
  const paths = [];
  for (let i = 0; i < file.chunkCount; i++) paths.push(filePath(file, i));
  return paths;
}

// ---------- 渲染 ----------
function folderPathChain(id) {
  const chain = [];
  let cur = id;
  while (cur) {
    const f = meta.folders.find((x) => x.id === cur);
    if (!f) break;
    chain.unshift(f); cur = f.parent_id;
  }
  return chain;
}
function render() {
  // 面包屑
  const bc = $('breadcrumb'); bc.innerHTML = '';
  const chain = folderPathChain(currentFolderId);
  const root = document.createElement('span');
  root.className = 'crumb' + (currentFolderId == null ? ' current' : '');
  root.textContent = '根目录';
  if (currentFolderId == null) bc.appendChild(root);
  else { root.onclick = () => { currentFolderId = null; render(); }; bc.appendChild(root); }
  chain.forEach((f, idx) => {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = ' / '; bc.appendChild(sep);
    const c = document.createElement('span');
    const isLast = idx === chain.length - 1;
    c.className = 'crumb' + (isLast ? ' current' : '');
    c.textContent = f.name;
    if (!isLast) c.onclick = () => { currentFolderId = f.id; render(); };
    bc.appendChild(c);
  });

  // 条目
  const box = $('entries'); box.innerHTML = '';
  const folders = meta.folders.filter((f) => f.parent_id === currentFolderId);
  const files = meta.files.filter((f) => f.folder_id === currentFolderId);
  folders.forEach((f) => box.appendChild(renderFolder(f)));
  files.forEach((f) => box.appendChild(renderFile(f)));
  if (!folders.length && !files.length) {
    const e = document.createElement('div'); e.style.color = 'var(--muted)'; e.style.padding = '12px 0';
    e.textContent = '此目录为空，拖拽或点击“上传文件”、“新建文件夹”开始。'; box.appendChild(e);
  }
}
function renderFolder(f) {
  const d = document.createElement('div'); d.className = 'entry folder';
  d.dataset.folderId = f.id;
  d.innerHTML = `<div class="name">📁 ${esc(f.name)}</div>
    <div class="meta">文件夹</div>
    <div class="row-actions">
      <button class="btn accel-btn" data-a="accel">⚡ 加速</button>
      <button class="btn" data-a="download">下载</button>
      <button class="btn" data-a="share">分享</button>
      <button class="btn" data-a="move">移动</button>
      <button class="btn ghost" data-a="delete">删除</button>
    </div>`;
  d.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; currentFolderId = f.id; render(); };
  const accelFBtn = d.querySelector('[data-a="accel"]');
  if (accelFBtn) accelFBtn.onclick = (e) => { e.stopPropagation(); accelDownload(f); };
  d.querySelector('[data-a="download"]').onclick = (e) => { e.stopPropagation(); downloadFolder(f); };
  d.querySelector('[data-a="share"]').onclick = (e) => { e.stopPropagation(); shareFolder(f); };
  d.querySelector('[data-a="move"]').onclick = (e) => { e.stopPropagation(); openMoveDialog(f, true); };
  d.querySelector('[data-a="delete"]').onclick = (e) => { e.stopPropagation(); deleteFolder(f); };
  return d;
}
function renderFile(f) {
  const d = document.createElement('div'); d.className = 'entry';
  const previewable = f.size < PREVIEW_MAX;
  d.innerHTML = `<div class="name">📄 ${esc(f.name)}</div>
    <div class="meta">${fmtSize(f.size)} · ${esc(f.mime_type || '未知')}</div>
    <div class="row-actions">
      ${previewable ? '<button class="btn" data-a="preview">预览</button>' : ''}
      <button class="btn accel-btn" data-a="accel">⚡ 加速</button>
      <button class="btn" data-a="download">下载</button>
      <button class="btn" data-a="share">分享</button>
      <button class="btn" data-a="move">移动</button>
      <button class="btn ghost" data-a="delete">删除</button>
    </div>`;
  const accelBtn = d.querySelector('[data-a="accel"]');
  if (accelBtn) accelBtn.onclick = () => accelDownload(f);
  d.querySelector('[data-a="download"]').onclick = () => downloadFile(f);
  d.querySelector('[data-a="delete"]').onclick = () => deleteFile(f);
  if (previewable) d.querySelector('[data-a="preview"]').onclick = () => previewFile(f);
  d.querySelector('[data-a="share"]').onclick = () => shareFile(f);
  d.querySelector('[data-a="move"]').onclick = () => openMoveDialog(f, false);
  return d;
}

// ---------- 目录树辅助（上传文件夹时按相对路径重建） ----------
function findFolder(name, parentId) { return meta.folders.find((f) => f.name === name && f.parent_id === parentId); }
function ensureFolderPath(parts, parentId) {
  let pid = parentId;
  for (const name of parts) {
    if (!name) continue;
    let f = findFolder(name, pid);
    if (!f) { f = { id: uid(), name, parent_id: pid, created_at: new Date().toISOString() }; meta.folders.push(f); }
    pid = f.id;
  }
  return pid;
}

// ---------- 文件夹操作 ----------
async function createFolder() {
  const name = prompt('文件夹名称：');
  if (!name) return;
  meta.folders.push({ id: uid(), name: name.trim(), parent_id: currentFolderId, created_at: new Date().toISOString() });
  await saveMeta(); render();
}
async function deleteFolder(f) {
  if (!confirm(`删除文件夹“${f.name}”及其全部内容？此操作不可恢复。`)) return;
  try {
    const toDelete = []; const stack = [f.id];
    while (stack.length) {
      const id = stack.pop();
      meta.folders.filter((x) => x.parent_id === id).forEach((c) => stack.push(c.id));
      meta.files.filter((x) => x.folder_id === id).forEach((file) => toDelete.push(file));
    }
    for (const file of toDelete) await removeFileObjects(file);
    const delIds = new Set(); const st2 = [f.id];
    while (st2.length) { const id = st2.pop(); delIds.add(id); meta.folders.filter((x) => x.parent_id === id).forEach((c) => st2.push(c.id)); }
    meta.folders = meta.folders.filter((x) => !delIds.has(x.id));
    meta.files = meta.files.filter((x) => !toDelete.includes(x));
    await saveMeta(); render();
  } catch (e) {
    alert('删除文件夹失败：' + (e.message || e));
  }
}

// ---------- 移动（文件 / 文件夹）----------
// 设计说明：文件实体按 UUID 存于 files/<id>，物理位置与目录无关；目录关系完全由
// meta.folders[].parent_id 与 meta.files[].folder_id 表达。因此“移动”只改元数据：
// 不搬对象、不重传、跨层级天然支持；面包屑/列表/路径都从 meta 实时派生，自动一致。
let moveCtx = null; // { item, isFolder, targetId: null=根目录, selected: 是否已选 }

function itemParentId(item, isFolder) { return isFolder ? item.parent_id : item.folder_id; }
function itemLocationText(item, isFolder) {
  const pid = itemParentId(item, isFolder);
  return pid ? (folderFullPath(pid) || '(未命名目录)') : '根目录';
}
// 目标目录：null 表示根目录；否则必须是当前用户 meta 中存在的文件夹
function resolveMoveTarget(targetId) {
  if (targetId == null || targetId === '') return { ok: true, folder: null };
  const folder = meta.folders.find((x) => x.id === targetId);
  return folder ? { ok: true, folder } : { ok: false, reason: '目标文件夹不存在或不属于当前账号，请刷新后重试' };
}
// 文件夹自身 + 全部后代（禁止把文件夹移动到自己/子目录，并防御脏数据成环）
function folderSubtreeIds(folderId) {
  const ids = new Set();
  if (!folderId) return ids;
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    meta.folders.filter((x) => x.parent_id === id).forEach((x) => stack.push(x.id));
  }
  return ids;
}
/**
 * 移动前置校验，返回 { ok, reason, target, from }。
 * 权限：元数据按用户隔离（users/<uid>/meta），登录态有效且源/目标均能在当前
 *       meta 中找到，即视为当前用户拥有；其它账号的条目不会出现在这里。
 * 有效性：根目录合法；文件夹目标必须存在且其祖先链完整、无环。
 * 冲突：目标目录下同名文件/文件夹一律拒绝——绝不静默覆盖或合并。
 */
function validateMove(item, isFolder, targetId) {
  if (!session || !session.user) return { ok: false, reason: '登录状态已失效，请重新登录后再移动' };
  if (!item) return { ok: false, reason: '未选择要移动的项目' };
  const live = (isFolder ? meta.folders : meta.files).find((x) => x.id === item.id);
  if (!live) return { ok: false, reason: '原项目已不存在（可能已在其它设备删除），请刷新后重试' };

  const t = resolveMoveTarget(targetId);
  if (!t.ok) return t;
  const targetKey = t.folder ? t.folder.id : null;
  const fromKey = itemParentId(live, isFolder) || null;
  if (fromKey === targetKey) return { ok: false, reason: '该项目已经在所选目录中，无需移动' };

  if (isFolder && folderSubtreeIds(live.id).has(targetKey)) {
    return { ok: false, reason: '不能把文件夹移动到它自己或其子文件夹中' };
  }
  // 目标祖先链完整性（防御元数据异常）
  const seen = new Set();
  let cur = targetKey;
  while (cur) {
    if (seen.has(cur)) return { ok: false, reason: '目标目录的层级关系异常，请刷新后重试' };
    seen.add(cur);
    const f = meta.folders.find((x) => x.id === cur);
    if (!f) return { ok: false, reason: '目标目录的上级不存在，请刷新后重试' };
    cur = f.parent_id;
  }

  const name = live.name;
  const clashFolder = meta.folders.find((f) => f.parent_id === targetKey && f.name === name && f.id !== live.id);
  const clashFile = meta.files.find((f) => f.folder_id === targetKey && f.name === name && f.id !== live.id);
  if (clashFolder || clashFile) {
    return { ok: false, reason: `目标目录中已存在同名${clashFolder ? '文件夹' : '文件'}「${name}」，请先改名或另选目录（不会覆盖）` };
  }
  return { ok: true, target: t.folder, from: fromKey };
}

function openMoveDialog(item, isFolder) {
  if (!$('move-modal')) { alert('页面版本过旧，请按 Ctrl+Shift+R 硬刷新后再使用移动功能'); return; }
  const live = (isFolder ? meta.folders : meta.files).find((x) => x.id === item.id);
  if (!live) { alert('该项目已不存在，请刷新后重试'); return; }
  moveCtx = { item: live, isFolder, targetId: null, selected: false };
  $('move-source').textContent = (isFolder ? '📁 ' : '📄 ') + live.name + '　（当前位置：' + itemLocationText(live, isFolder) + '）';
  $('move-status').textContent = '请选择目标文件夹';
  $('move-status').className = 'msg';
  $('move-confirm').disabled = true;
  $('move-confirm').textContent = '确认移动';
  renderMoveTree();
  $('move-modal').classList.remove('hidden');
}
function closeMoveDialog() { $('move-modal').classList.add('hidden'); moveCtx = null; }

// 通用目录树渲染：根目录 + 全部文件夹。
// selectedId: undefined=无选中，null=根目录，字符串=文件夹 id
// blockedIds: 不可选的文件夹 id 集合；onBlocked: 点击不可选项时的回调
function renderFolderTreeInto(box, opts) {
  const { selectedId, blockedIds, onPick, onBlocked } = opts;
  const blocked = blockedIds || new Set();
  box.innerHTML = '';
  const makeNode = (id, name, depth) => {
    const row = document.createElement('div');
    const isBlocked = blocked.has(id);
    const isSelected = selectedId !== undefined && (selectedId || null) === (id || null);
    row.className = 'move-node' + (isSelected ? ' selected' : '');
    row.style.paddingLeft = (10 + depth * 18) + 'px';
    row.dataset.fid = id == null ? '' : id;
    row.innerHTML = `<span class="move-node-ico">📁</span><span class="move-node-name">${esc(name)}</span>` +
      (isBlocked ? '<span class="move-node-tag">不可选</span>' : '');
    row.onclick = () => {
      if (isBlocked) { if (onBlocked) onBlocked(); return; }
      onPick(id || null);
    };
    box.appendChild(row);
  };
  makeNode(null, '根目录', 0);
  const walk = (parentId, depth) => {
    meta.folders.filter((f) => f.parent_id === parentId)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
      .forEach((f) => { makeNode(f.id, f.name, depth); walk(f.id, depth + 1); });
  };
  walk(null, 1);
}

// 移动弹窗的树形目标选择器（自身及子目录灰显不可选）
function renderMoveTree() {
  if (!moveCtx) return;
  renderFolderTreeInto($('move-tree'), {
    selectedId: moveCtx.selected ? moveCtx.targetId : undefined,
    blockedIds: moveCtx.isFolder ? folderSubtreeIds(moveCtx.item.id) : new Set(),
    onPick: (id) => { moveCtx.targetId = id; moveCtx.selected = true; refreshMoveDecision(); },
    onBlocked: () => {
      $('move-status').textContent = '不能把文件夹移动到它自己或其子文件夹中';
      $('move-status').className = 'msg error';
    },
  });
  refreshMoveDecision();
}
// 选中态 + 校验结果同步到提示条与确认按钮
function refreshMoveDecision() {
  if (!moveCtx) return;
  const box = $('move-tree');
  const key = moveCtx.targetId || '';
  box.querySelectorAll('.move-node').forEach((n) => n.classList.toggle('selected', n.dataset.fid === key));
  const st = $('move-status');
  if (!moveCtx.selected) {
    $('move-target').textContent = '—';
    st.textContent = '请选择目标文件夹';
    st.className = 'msg';
    $('move-confirm').disabled = true;
    return;
  }
  $('move-target').textContent = moveCtx.targetId == null
    ? '根目录'
    : (folderFullPath(moveCtx.targetId) || '（未命名目录）');
  const v = validateMove(moveCtx.item, moveCtx.isFolder, moveCtx.targetId);
  st.textContent = v.ok ? '校验通过：可以移动' : v.reason;
  st.className = 'msg ' + (v.ok ? 'ok' : 'error');
  $('move-confirm').disabled = !v.ok;
}
async function performMove() {
  if (!moveCtx || !moveCtx.selected) return;
  const { item, isFolder, targetId } = moveCtx;
  const v = validateMove(item, isFolder, targetId); // 执行前二次校验，防止期间数据变化
  if (!v.ok) {
    $('move-status').textContent = v.reason;
    $('move-status').className = 'msg error';
    return;
  }
  const list = isFolder ? meta.folders : meta.files;
  const live = list.find((x) => x.id === item.id);
  const key = isFolder ? 'parent_id' : 'folder_id';
  const prevParent = live[key];
  const prevUpdated = live.updated_at;
  live[key] = targetId || null;
  live.updated_at = new Date().toISOString();
  const targetName = targetId == null ? '根目录' : (folderFullPath(targetId) || '（未命名目录）');
  const confirmBtn = $('move-confirm');
  confirmBtn.disabled = true; confirmBtn.textContent = '移动中…';
  try {
    await saveMeta();
    closeMoveDialog();
    render(); // 列表、面包屑、路径均由 meta 派生，保存成功后自动一致
    showToast(`已将「${live.name}」移动到 ${targetName}`);
  } catch (e) {
    // 保存失败必须回滚内存，避免界面显示与云端数据不一致
    live[key] = prevParent;
    if (prevUpdated === undefined) delete live.updated_at; else live.updated_at = prevUpdated;
    render();
    const st = $('move-status');
    st.textContent = '移动失败，已恢复原位置：' + ((e && (e.message || e)) || e);
    st.className = 'msg error';
  } finally {
    confirmBtn.textContent = '确认移动';
    confirmBtn.disabled = false;
  }
}

let toastTimer = null;
function showToast(text) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- 上传目标目录选择 ----------
// 返回 Promise：undefined=用户取消；null=根目录；字符串=文件夹 id。
// 用 undefined 表示取消，避免与“根目录 null”混淆。
let uploadPickResolve = null;
let uploadPickId = undefined;
let pendingUploadTarget; // undefined=未指定（沿用当前目录），null=根目录，字符串=文件夹 id
function pickUploadFolder(defaultId, confirmLabel) {
  return new Promise((resolve) => {
    if (!$('upload-target-modal')) { resolve(undefined); return; }
    if (uploadPickResolve) closeUploadPick(undefined); // 上一次未结束则先按取消处理
    uploadPickResolve = resolve;
    uploadPickId = (defaultId === undefined ? null : defaultId);
    $('upload-pick-confirm').textContent = confirmLabel || '选择上传路径';
    $('upload-tree').innerHTML = ''; // 强制按当前选中态重建
    refreshUploadPick();
    $('upload-target-modal').classList.remove('hidden');
  });
}
function closeUploadPick(result) {
  $('upload-target-modal').classList.add('hidden');
  const r = uploadPickResolve;
  uploadPickResolve = null;
  uploadPickId = undefined;
  if (r) r(result);
}
function refreshUploadPick() {
  const st = $('upload-pick-status'), btn = $('upload-pick-confirm'), tree = $('upload-tree');
  if (!st || !btn || !tree) return;
  if (uploadPickId === undefined) {
    $('upload-pick-target').textContent = '—';
    st.textContent = '请选择目标文件夹';
    st.className = 'msg';
    btn.disabled = true;
  } else {
    const path = uploadPickId == null ? '根目录' : (folderFullPath(uploadPickId) || '（未命名目录）');
    $('upload-pick-target').textContent = path;
    const v = resolveMoveTarget(uploadPickId); // 防御目标在打开弹窗期间被删
    if (!v.ok) {
      st.textContent = v.reason;
      st.className = 'msg error';
      btn.disabled = true;
    } else {
      st.textContent = '文件将上传到这里：' + path;
      st.className = 'msg ok';
      btn.disabled = false;
    }
  }
  if (!tree.children.length) {
    renderFolderTreeInto(tree, {
      selectedId: uploadPickId,
      onPick: (id) => { uploadPickId = id; refreshUploadPick(); },
    });
  } else {
    const key = uploadPickId === undefined ? '__none__' : (uploadPickId || '');
    tree.querySelectorAll('.move-node').forEach((n) => n.classList.toggle('selected', n.dataset.fid === key));
  }
}

// ---------- 文件上传 ----------
function ensureTasks() { $('tasks').classList.remove('hidden'); }
function addTask(name, onCancel) {
  const el = document.createElement('div'); el.className = 'task';
  el.innerHTML = `<div class="tname"><span class="tlabel">${esc(name)}</span>${onCancel ? '<button class="btn ghost small tcancel">取消</button>' : ''}</div>
    <div class="tbar"><i></i></div><div class="tstatus">准备中…</div>`;
  if (onCancel) {
    const b = el.querySelector('.tcancel');
    if (b) b.onclick = () => { b.disabled = true; b.textContent = '取消中…'; try { onCancel(); } catch (e) { /* ignore */ } };
  }
  $('task-list').prepend(el);
  return el;
}
// targetFolderId: null=根目录，字符串=文件夹 id，undefined=沿用当前目录（兼容旧调用）
async function uploadFiles(fileList, targetFolderId) {
  ensureTasks();
  // 兼容两种入参：File[] 或 {file, path}[]。path 为相对路径（含根文件夹名），用于重建目录树。
  const items = fileList.map((x) => {
    if (x && x.file) return { file: x.file, path: x.path ? String(x.path).replace(/\\/g, '/') : null };
    return { file: x, path: (x && (x.webkitRelativePath || x.relativePath)) ? String(x.webkitRelativePath || x.relativePath).replace(/\\/g, '/') : null };
  });
  if (!items.length) { alert('没有读取到任何文件，请确认所选文件夹内有文件。'); return; }
  console.log('[upload] 选中文件数:', items.length, '首个路径:', items[0] && items[0].path);
  const startFolder = (targetFolderId === undefined) ? currentFolderId : targetFolderId;
  console.log('[upload] 目标目录:', startFolder == null ? '根目录' : startFolder, '文件数:', items.length, '首个路径:', items[0] && items[0].path);
  // P0-3：大文件批量上传前，自动探测网关允许的最大分片（无手动设置时；结果缓存 7 天）
  const totalBytes = items.reduce((s, it) => s + (it.file.size || 0), 0);
  if (totalBytes > 200 * 1024 * 1024 && !localStorage.getItem('drive_chunk_mb')) {
    try {
      const pt = addTask('探测最佳分片…');
      const mb = await probeChunkSize(false);
      if (mb !== CHUNK_MB) { CHUNK_MB = mb; CHUNK_SIZE = mb * 1024 * 1024; }
      pt.querySelector('.tstatus').textContent = '分片 ' + mb + 'MB';
    } catch (e) { /* 探测失败则沿用当前分片 */ }
  }
  // 先同步计算每个文件的归属目录（文件夹在元数据里建好，避免并发竞态）
  const entries = items.map((it) => {
    const file = it.file;
    let targetFolderId = startFolder;
    let label = file.name;
    if (it.path) {
      const parts = it.path.split('/').filter(Boolean);
      parts.pop(); // 去掉文件名，剩下目录层级
      targetFolderId = ensureFolderPath(parts, startFolder);
      label = it.path;
    }
    return { file, targetFolderId, label };
  });
  // 断点续传：为每个文件分配稳定 ID（路径+大小+修改时间+分片大小），并持久化映射。
  // 刷新/重试后再传同一文件会复用 ID 与已有分片，不从头重传。
  if (!meta.uploads) meta.uploads = {};
  entries.forEach((e) => {
    const f = e.file;
    const key = (e.label || f.name) + ':' + f.size + ':' + (f.lastModified || 0) + ':' + CHUNK_SIZE;
    e.upKey = key;
    e.resumable = !!meta.uploads[key];
    if (!e.resumable) meta.uploads[key] = uid();
    e.id = meta.uploads[key];
  });
  await saveMeta(); // 先持久化，保证中途刷新后仍能续传
  const failures = [];
  let skipped = 0, okCount = 0, cancelledCount = 0;
  // 大文件夹批量上传时降低外层并发，避免同时开过多请求触发限流导致“部分文件失败”
  const outerConc = entries.length > 20 ? 2 : 4;
  await mapPool(entries, outerConc, async (e) => {
    const sig = { cancelled: false };
    const task = addTask(e.label, () => { sig.cancelled = true; task.querySelector('.tstatus').textContent = '正在取消…'; });
    try {
      const res = await uploadChunked(e.file, task, e.targetFolderId, e.id, e.upKey, e.resumable, sig);
      if (res === 'skipped') { skipped++; task.querySelector('.tstatus').textContent = '已存在，跳过'; }
      else if (res === 'cancelled') { cancelledCount++; task.querySelector('.tstatus').textContent = '已取消'; }
      else { okCount++; task.querySelector('.tstatus').textContent = '完成'; task.querySelector('.tbar > i').style.width = '100%'; }
    } catch (err) {
      if (sig.cancelled) { cancelledCount++; task.querySelector('.tstatus').textContent = '已取消'; }
      else {
        task.querySelector('.tstatus').textContent = '失败：' + (err.message || err);
        failures.push(e.label + ' —— ' + (err.message || err));
      }
    }
    const cb = task.querySelector('.tcancel'); if (cb) cb.remove();
  });
  await saveMeta();
  // 注意：保存成功后直接使用内存中的 meta 渲染，不再重新 loadMeta（避免被旧的元数据覆盖）
  // 若是“上传文件夹”，自动进入上传的根文件夹，让文件立即可见
  const tops = new Set(items.map((it) => (it.path ? it.path.split('/').filter(Boolean)[0] : null)).filter(Boolean));
  if (tops.size === 1) {
    const rootName = [...tops][0];
    const rf = meta.folders.find((f) => f.name === rootName && f.parent_id === startFolder);
    if (rf) currentFolderId = rf.id;
  }
  render();
  const targetText = startFolder == null ? '根目录' : (folderFullPath(startFolder) || '（未命名目录）');
  const summary = `上传到「${targetText}」：共 ${entries.length} 个文件，成功 ${okCount}，跳过 ${skipped}（已存在），取消 ${cancelledCount}，失败 ${failures.length}。`;
  if (failures.length) {
    const head = failures.length > 20 ? '\n…等共 ' + failures.length + ' 个' : '';
    alert(summary + '\n\n失败明细：\n' + failures.slice(0, 20).join('\n') + head);
  } else {
    alert(summary);
  }
}
async function uploadChunked(file, task, folderId, id, upKey, resumable, sig) {
  // 已完成（同目录、同名、同大小）则跳过，避免重复
  if (meta.files.some((x) => x.folder_id === folderId && x.name === file.name && x.size === file.size)) {
    task.querySelector('.tstatus').textContent = '已存在，跳过';
    task.querySelector('.tbar > i').style.width = '100%';
    if (upKey && meta.uploads) delete meta.uploads[upKey];
    return 'skipped';
  }
  if (sig && sig.cancelled) return 'cancelled';
  id = id || uid();
  const count = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const status = task.querySelector('.tstatus');
  const bar = task.querySelector('.tbar > i');
  const prefix = 'users/' + session.user.id + '/files/' + id + '/';
  // 续传：仅当该 ID 是上一次会话留下的（resumable）才查询已传分片
  let doneSet = new Set();
  if (resumable) {
    try { doneSet = new Set(await listKeys(prefix)); } catch (e) { /* 忽略 */ }
  }
  let uploaded = 0;
  const pending = [];
  for (let i = 0; i < count; i++) {
    if (doneSet.has(prefix + 'part_' + i)) uploaded += Math.min((i + 1) * CHUNK_SIZE, file.size) - i * CHUNK_SIZE;
    else pending.push(i);
  }
  if (uploaded > 0) status.textContent = '续传 ' + fmtSize(uploaded) + ' / ' + fmtSize(file.size);
  try {
    await adaptivePool(pending, UPLOAD_CTRL, async (i) => {
      if (sig && sig.cancelled) throw new Error('已取消');
      const start = i * CHUNK_SIZE, end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);
      const path = cloud.storage.userPath(session.user.id, 'files/' + id + '/part_' + i);
      try {
        await uploadPart(path, blob, sig);
      } catch (e) {
        throw new Error('分片 ' + i + '/' + count + ' 失败：' + ((e && (e.message || e.code)) || e));
      }
      uploaded += (end - start);
      bar.style.width = Math.min(100, (uploaded / file.size) * 100) + '%';
      status.textContent = fmtSize(uploaded) + ' / ' + fmtSize(file.size);
    });
  } catch (e) {
    if (sig && sig.cancelled) return 'cancelled';
    throw e;
  }
  if (sig && sig.cancelled) return 'cancelled';
  meta.files.push({ id, name: file.name, folder_id: folderId, objectKey: 'files/' + id, size: file.size, mime_type: file.type || 'application/octet-stream', chunked: true, chunkCount: count, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  if (upKey && meta.uploads) delete meta.uploads[upKey];
  // 元数据由 uploadFiles 在整批结束后统一保存一次，避免每个文件都写一份完整 meta
  return 'done';
}

// ---------- 文件删除 ----------
// 注意：该后端的 remove 可能返回 {error} 而不抛出，且实际未必能删掉对象；
// 因此这里尽力删除、忽略所有失败，不阻断元数据更新（保证“删除”在 UI 上始终可用）。
async function removeFileObjects(file) {
  try {
    if (!file.chunked) {
      await cloud.storage.remove([cloud.storage.userPath(session.user.id, file.objectKey)]);
    } else {
      const prefix = 'users/' + session.user.id + '/' + file.objectKey + '/';
      const keys = await listKeys(prefix);
      if (keys.length) await cloud.storage.remove(keys);
    }
  } catch (e) { /* 物理删除失败不阻断 */ }
}
async function deleteFile(f) {
  if (!confirm(`删除文件“${f.name}”？不可恢复。`)) return;
  try {
    await removeFileObjects(f);
    meta.files = meta.files.filter((x) => x.id !== f.id);
    await saveMeta(); render();
  } catch (e) {
    alert('删除文件失败：' + (e.message || e));
  }
}

// ---------- 文件下载 ----------
// 把多个分片对象串成一个 ReadableStream：边读边吐，峰值内存仅一个分片大小，避免大文件 OOM。
async function readPartAsStream(path) {
  const r = await cloud.storage.download(path);
  const s = await getStream(r);
  if (s) return s;
  const b = await getBlob(r);
  if (!b) throw new Error('下载失败（空数据）');
  return new Response(b).body;
}
function combineStreams(paths) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= paths.length) { controller.close(); return; }
      const stream = await readPartAsStream(paths[i++]);
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
    },
  });
}
async function downloadFile(f) {
  const paths = partPaths(f);
  const suggested = f.name;
  // 主路径：File System Access API 边下边写磁盘；并行拉取、按序写盘，内存只保留少量分片。
  if (window.showSaveFilePicker) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: suggested }); }
    catch (e) { if (e && e.name === 'AbortError') return; alert('下载失败：' + (e.message || e)); return; }
    let writable;
    try { writable = await handle.createWritable(); }
    catch (e) { alert('无法写入文件：' + (e.message || e)); return; }
    ensureTasks();
    const sig = { cancelled: false };
    const task = addTask('下载：' + f.name, () => { sig.cancelled = true; status.textContent = '正在取消…'; });
    const status = task.querySelector('.tstatus');
    const bar = task.querySelector('.tbar > i');
    const total = paths.length;
    let nextFetch = 0, nextWrite = 0, written = 0, failed = null, active = 0;
    const buffers = new Map();
    const BUF_CAP = 4;
    const started = Date.now();
    const etaTrack = makeEtaTracker(f.size);
    const update = () => {
      const secs = Math.max(0.001, (Date.now() - started) / 1000);
      const r = etaTrack(written);
      const speedMBs = (r.speed > 0 ? r.speed : written / secs) / 1048576;
      bar.style.width = Math.min(100, (written / Math.max(1, f.size)) * 100) + '%';
      status.textContent = fmtSize(written) + ' / ' + fmtSize(f.size) + ' · ' + speedMBs.toFixed(1) + ' MB/s · ' + fmtEta(r.eta);
    };
    status.textContent = '准备中…';
    const spawn = () => {
      while (!failed && !sig.cancelled && active < DOWNLOAD_CTRL.value && nextFetch < total && buffers.size < BUF_CAP) {
        const i = nextFetch++;
        active += 1;
        (async () => {
          try {
            if (sig.cancelled) throw new Error('已取消');
            const s = await readPartAsStream(paths[i]);
            const reader = s.getReader();
            const chunks = [];
            while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
            buffers.set(i, chunks);
            DOWNLOAD_CTRL.success();
          } catch (e) {
            DOWNLOAD_CTRL.failure(e);
            failed = failed || e;
          } finally {
            active -= 1;
            spawn();
          }
        })();
      }
    };
    spawn();
    try {
      while (nextWrite < total) {
        if (sig.cancelled) throw new Error('已取消');
        if (failed) throw failed;
        if (!buffers.has(nextWrite)) {
          if (active === 0 && nextFetch >= total) throw new Error('分片 ' + nextWrite + ' 缺失');
          await new Promise((r) => setTimeout(r, 25));
          spawn();
          continue;
        }
        const chunks = buffers.get(nextWrite); buffers.delete(nextWrite);
        for (const c of chunks) { await writable.write(c); written += c.length; }
        update();
        nextWrite++;
        spawn();
      }
      await writable.close();
      bar.style.width = '100%';
      status.textContent = '完成 · ' + fmtSize(written);
    } catch (e) {
      try { await writable.close(); } catch (e2) { /* ignore */ }
      if (sig.cancelled) {
        status.textContent = '已取消（已保留部分文件）';
      } else {
        status.textContent = '失败：' + (e.message || e);
        alert('下载中断：' + (e.message || e));
      }
    }
    const cb = task.querySelector('.tcancel'); if (cb) cb.remove();
    return;
  }
  // 回退：浏览器不支持 File System Access API，无法直接流式落盘。
  // 超大文件若整文件缓冲会撑爆内存导致崩溃，故超过阈值直接提示改用 Chrome/Edge。
  if (f.size > 1.5 * 1024 * 1024 * 1024) {
    alert('该文件超过 1.5GB，当前浏览器不支持“边下边写”的流式落盘（File System Access API）。\n请使用 Chrome 或 Edge 打开本页面下载，可做到零内存堆积。');
    return;
  }
  try {
    const blob = await new Response(combineStreams(paths)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = suggested; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    alert('下载失败：' + (e.message || e));
  }
}

// ---------- 文件预览 ----------
async function previewFile(f) {
  const paths = partPaths(f);
  const blobs = [];
  for (const p of paths) blobs.push(await getBlob(await cloud.storage.download(p)));
  const blob = new Blob(blobs, { type: f.mime_type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const body = $('preview-body'); const title = $('preview-title');
  body.innerHTML = ''; title.textContent = f.name;
  const mime = f.mime_type || '';
  if (mime.startsWith('image/')) {
    const img = document.createElement('img'); img.src = url; body.appendChild(img);
  } else if (mime === 'application/pdf' || mime.endsWith('pdf')) {
    const ifr = document.createElement('iframe'); ifr.src = url; body.appendChild(ifr);
  } else if (mime.startsWith('text/') || mime === 'application/json' || mime.includes('xml')) {
    const pre = document.createElement('pre'); pre.textContent = await blob.text(); body.appendChild(pre);
  } else {
    body.innerHTML = '<p>该类型不支持在线预览，请下载后查看。<button id="pv-dl" class="btn primary">下载</button></p>';
    $('pv-dl').onclick = () => downloadFile(f);
  }
  $('preview-modal').classList.remove('hidden');
}

// ---------- 诊断（排查元数据/列表真实返回） ----------
async function runDiag() {
  const L = [];
  const shape = (x) => { try { return JSON.stringify(x).slice(0, 1800); } catch (e) { return String(x); } };
  L.push('user.id: ' + session.user.id);
  L.push('user.email: ' + (session.user.email || '(none)'));
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); L.push('localStorage: 可用'); }
  catch (e) { L.push('localStorage: 不可用 — ' + e.message); }
  let lsk = null; try { lsk = localStorage.getItem(metaKeyLS()); } catch (e) {}
  L.push('localStorage metaKey: ' + (lsk || '(空)'));
  try {
    const r = await cloud.storage.download(metaLegacyPath());
    const b = await getBlob(r);
    L.push('index.json: ' + (b ? b.size + ' bytes' : 'null'));
  } catch (e) { L.push('index.json 读取错误: ' + (e.message || e)); }
  try {
    const r = await cloud.storage.list(metaPrefix(), { limit: 20 });
    L.push('list(meta) r.data: ' + shape(r && r.data) + ' / error: ' + ((r && r.error && (r.error.message || r.error.code)) || '(无)'));
  } catch (e) { L.push('list(meta) 错误: ' + (e.message || e)); }
  try {
    const r = await cloud.storage.list('users/' + session.user.id + '/', { limit: 20 });
    L.push('list(root) r.data: ' + shape(r && r.data) + ' / error: ' + ((r && r.error && (r.error.message || r.error.code)) || '(无)'));
  } catch (e) { L.push('list(root) 错误: ' + (e.message || e)); }
  L.push('内存 meta: 文件夹 ' + meta.folders.length + ' 个, 文件 ' + meta.files.length + ' 个, __ver=' + (meta.__ver || 0));
  // 签名能力测试（用已知存在的 index.json）
  try {
    const u = await withTimeout(createSignedUrlAny(metaLegacyPath(), 3600), 15000, '签名测试');
    L.push('签名测试(index.json): OK — ' + String(u).slice(0, 90) + '…');
  } catch (e) { L.push('签名测试(index.json): 失败 — ' + ((e && (e.message || e.code)) || e)); }
  // 公开直链测试
  try {
    const api = cloud.storage.fileApi;
    if (api && typeof api.getPublicUrl === 'function') {
      const pr = api.getPublicUrl(metaLegacyPath());
      const pu = (pr && pr.data && pr.data.publicUrl) || (pr && pr.publicUrl);
      L.push('公开URL: ' + (pu || '(无)'));
      if (pu) {
        const hr = await fetch(pu, { method: 'GET', headers: { Range: 'bytes=0-0' } });
        L.push('公开URL访问: HTTP ' + hr.status);
      }
    } else L.push('公开URL: 不支持');
  } catch (e) { L.push('公开URL测试失败: ' + ((e && (e.message || e)) || e)); }
  // 文件完整性（前 6 个）：比较实际分片数与记录数
  for (const f of meta.files.slice(0, 6)) {
    try {
      const keys = await listKeys('users/' + session.user.id + '/files/' + f.id + '/', false);
      L.push('完整性(list 返回，单次上限 1000): ' + f.name + ' 分片 ' + keys.length + ' / 记录 ' + (f.chunkCount || '?') + '，大小 ' + fmtSize(f.size) + (keys.length >= 1000 ? '（已达 list 上限，可能被截断）' : ''));
    } catch (e) { L.push('完整性: ' + f.name + ' 查询失败 ' + ((e && (e.message || e)) || e)); }
  }
  const body = $('preview-body'); const title = $('preview-title');
  body.innerHTML = ''; title.textContent = '诊断信息（截图发我）';
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap'; pre.style.fontSize = '12px'; pre.style.wordBreak = 'break-all';
  pre.textContent = L.join('\n\n');
  body.appendChild(pre);
  $('preview-modal').classList.remove('hidden');
}

// ---------- 分享（1 小时签名链接，多分片统一打包） ----------
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时（' + Math.round(ms / 1000) + 's）')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// 公开直链（若桶允许公开读，则无需签名、无过期）
function publicUrlFor(key) {
  try {
    const api = cloud.storage.fileApi;
    if (!api || typeof api.getPublicUrl !== 'function') return null;
    const pr = api.getPublicUrl(key);
    const u = (pr && pr.data && pr.data.publicUrl) || (pr && pr.publicUrl);
    return u || null;
  } catch (e) { return null; }
}
let PUBLIC_OK = null;
async function probePublicOnce() {
  if (PUBLIC_OK !== null) return PUBLIC_OK;
  try {
    const pu = publicUrlFor(metaLegacyPath());
    if (!pu) { PUBLIC_OK = false; return false; }
    const r = await fetch(pu, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    PUBLIC_OK = (r.ok || r.status === 206);
    return PUBLIC_OK;
  } catch (e) { PUBLIC_OK = false; return false; }
}
// 批量签名：一次请求签多个路径（每批 100），大幅减少请求数、避开限流。
// 直接调底层 fileApi，绕过 SDK 对 ttl>3600 的客户端校验。
async function createSignedUrlsBatch(keys, ttl) {
  const api = cloud.storage.fileApi;
  if (!api || typeof api.createSignedUrls !== 'function') throw new Error('当前 SDK 不支持批量签名');
  const out = new Array(keys.length);
  const BATCH = 100;
  for (let start = 0; start < keys.length; start += BATCH) {
    const slice = keys.slice(start, start + BATCH);
    const r = await api.createSignedUrls(slice, ttl);
    if (!r) throw new Error('批量签名无返回');
    if (r.error) throw r.error;
    const arr = r.data || [];
    if (arr.length < slice.length) throw new Error('批量签名返回数量不足（' + arr.length + '/' + slice.length + '）');
    for (let j = 0; j < slice.length; j++) {
      const item = arr[j] || {};
      let u = item.signedUrl || item.signedURL;
      if (u && !/^https?:\/\//i.test(u)) { try { u = new URL(u, location.origin).toString(); } catch (e) { /* keep */ } }
      if (!u) throw new Error('批量签名返回缺少链接');
      out[start + j] = u;
    }
  }
  return out;
}
// 生成签名链接：SDK 公开方法对 ttl>3600 会硬校验抛错，此时直接调底层 fileApi 绕过客户端校验，交由后端判断。
async function createSignedUrlAny(key, ttl) {
  if (!(ttl > 3600)) {
    const { data, error } = await cloud.storage.createSignedUrl(key, ttl);
    if (error) throw error;
    const u = (data && data.signedUrl) ? data.signedUrl : data;
    if (!u) throw new Error('签名链接为空');
    return u;
  }
  const api = cloud.storage.fileApi;
  if (!api || typeof api.createSignedUrl !== 'function') throw new Error('当前 SDK 不支持自定义有效期');
  const r = await api.createSignedUrl(key, ttl);
  if (!r) throw new Error('签名接口无返回');
  if (r.error) throw r.error;
  const d = r.data;
  const u = (d && d.signedUrl) ? d.signedUrl : d;
  if (!u) throw new Error('签名链接为空');
  return u;
}
// 统一分享：把清单（每个文件的分片签名地址）存为云端对象，链接只带清单的短签名地址。
// 这样无论文件多大，链接都保持很短、可分享。
async function shareItems(items, displayName) {
  const urlEl = $('share-url');
  urlEl.value = '生成中…';
  $('share-msg').textContent = '';
  $('share-modal').classList.remove('hidden');
  const ttlRequested = Math.max(1, Number($('share-ttl') && $('share-ttl').value) || SHARE_TTL);
  try {
    if (!items.length) throw new Error('没有可分享的文件');
    const totalParts = items.reduce((s, it) => s + filePartsCount(it.file), 0);
    if (totalParts > 20000) throw new Error('文件过多（' + totalParts + ' 个分片），超出分享上限。');
    // 先探测链接方式：优先签名（可选有效期）；签名失败则尝试公开直链
    let ttl = ttlRequested;
    let ttlNote = '';
    let usePublic = false;
    const sample = fileKeys(items[0].file)[0];
    try {
      await withTimeout(createSignedUrlAny(sample, ttl), 20000, '生成签名链接');
    } catch (e) {
      let ok = false;
      if (ttl > 3600) {
        try { await withTimeout(createSignedUrlAny(sample, 3600), 20000, '生成签名链接'); ttl = 3600; ttlNote = '（后端不支持长有效期，已自动改用 1 小时）'; ok = true; } catch (e2) { /* 继续尝试公开直链 */ }
      }
      if (!ok) {
        if (await probePublicOnce()) { usePublic = true; ttlNote = '（签名不可用，已改用公开直链，长期有效）'; }
        else throw new Error('签名失败（' + ((e && (e.message || e.code)) || e) + '）：可能是文件分片未完整上传，或签名权限受限');
      }
    }
    let done = 0;
    const files = [];
    for (const it of items) {
      const f = it.file;
      const keys = fileKeys(f);
      let urls;
      if (usePublic) {
        urls = keys.map((k) => publicUrlFor(k));
        if (urls.some((u) => !u)) throw new Error('公开直链生成失败');
      } else {
        urls = await withTimeout(createSignedUrlsBatch(keys, ttl), 120000, '批量生成签名链接');
      }
      files.push({ name: it.relPath || f.name, size: f.size, parts: urls });
      done += keys.length;
      urlEl.value = '生成中… ' + done + '/' + totalParts;
    }
    const manifest = { type: 'folder', name: displayName, files };
    const mid = uid();
    const mkey = cloud.storage.userPath(session.user.id, 'shares/' + mid + '.json');
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    const up = await cloud.storage.upload(mkey, blob, { contentType: 'application/json' });
    if (up && up.error) throw up.error;
    const murl = usePublic ? publicUrlFor(mkey) : await withTimeout(createSignedUrlAny(mkey, ttl), 15000, '生成清单链接');
    if (!murl) throw new Error('清单链接生成失败');
    const codeParam = SITE_CODE ? ('&sharecode=' + encodeURIComponent(SITE_CODE)) : '';
    urlEl.value = location.origin + '/?s=' + b64encodeUrl(JSON.stringify({ type: 'manifest', url: murl })) + codeParam;
    if (usePublic) {
      $('share-msg').textContent = '已使用公开直链（长期有效）。' + ttlNote;
    } else {
      const hours = Math.round(ttl / 3600 * 10) / 10;
      const bigHint = (totalParts > 2000 && ttl <= 3600) ? ' 该文件较大，1 小时内可能下不完；若接收方下载中途报 401，请改用更长有效期（建议 15 小时）重新生成链接。' : '';
      if (totalParts > 2000) $('share-msg').textContent = `提示：文件较大，链接 ${hours} 小时内有效，请接收方尽快下载。${ttlNote}${bigHint}`;
      else $('share-msg').textContent = `链接 ${hours} 小时内有效。${ttlNote}`;
    }
  } catch (e) {
    urlEl.value = '';
    const m = (e && (e.message || e)) || e;
    let hint = '';
    if (/403/.test(String(m))) hint = '（存储接口返回 403：最常见原因是登录已过期，请点右上角「退出」重新登录后再试。若重新登录仍 403，说明平台未开放分享签名权限。）';
    $('share-msg').textContent = '生成分享链接失败：' + m + hint;
  }
}
async function shareFile(f) {
  return shareItems([{ file: f, relPath: f.name }], f.name);
}

// ---------- 文件夹打包下载 / 分享 ----------
function collectFolderFiles(folderId, basePath) {
  const out = [];
  const walk = (id, prefix) => {
    meta.files.filter((x) => x.folder_id === id).forEach((f) => out.push({ file: f, relPath: prefix + f.name }));
    meta.folders.filter((x) => x.parent_id === id).forEach((sub) => walk(sub.id, prefix + sub.name + '/'));
  };
  walk(folderId, basePath ? basePath + '/' : '');
  return out;
}
async function loadDownloadZip() {
  const mod = await import('https://cdn.jsdelivr.net/npm/client-zip@2/+esm');
  return mod.downloadZip;
}
function filePartsCount(f) { return f.chunkCount || Math.max(1, Math.ceil(f.size / CHUNK_SIZE)); }
function fileKeys(f) { const n = filePartsCount(f); const keys = []; for (let i = 0; i < n; i++) keys.push(filePath(f, i)); return keys; }

async function downloadFolder(folder) {
  const items = collectFolderFiles(folder.id, folder.name);
  if (!items.length) { alert('该文件夹为空。'); return; }
  const total = items.reduce((s, it) => s + (it.file.size || 0), 0);
  if (!window.showSaveFilePicker && total > 800 * 1024 * 1024) {
    alert('文件夹较大（' + fmtSize(total) + '），当前浏览器不支持流式落盘。请使用 Chrome 或 Edge 下载。');
    return;
  }
  let downloadZip;
  try { downloadZip = await loadDownloadZip(); }
  catch (e) { alert('加载打包组件失败（需要联网）。请检查网络后重试。'); return; }
  ensureTasks();
  const sig = { cancelled: false };
  const task = addTask('下载文件夹：' + folder.name, () => { sig.cancelled = true; status.textContent = '正在取消…'; });
  const status = task.querySelector('.tstatus');
  const bar = task.querySelector('.tbar > i');
  let written = 0;
  const started = Date.now();
  const etaTrack = makeEtaTracker(total);
  const update = () => {
    const secs = Math.max(0.001, (Date.now() - started) / 1000);
    const shown = Math.min(written, total);
    const r = etaTrack(shown);
    const speedMBs = (r.speed > 0 ? r.speed : shown / secs) / 1048576;
    bar.style.width = Math.min(100, (shown / Math.max(1, total)) * 100) + '%';
    status.textContent = fmtSize(shown) + ' / ' + fmtSize(total) + ' · ' + speedMBs.toFixed(1) + ' MB/s · ' + fmtEta(r.eta);
  };
  status.textContent = '准备中…';
  try {
    const inputs = items.map((it) => ({
      name: it.relPath,
      size: it.file.size,
      input: (async function* () {
        const reader = combineStreams(partPaths(it.file)).getReader();
        while (true) {
          if (sig.cancelled) throw new Error('已取消');
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      })(),
    }));
    const response = downloadZip(inputs);
    const counted = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        if (sig.cancelled) { controller.error(new Error('已取消')); return; }
        written += chunk.length;
        update();
        controller.enqueue(chunk);
      },
    }));
    let fw = null;
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: folder.name + '.zip' });
      fw = await handle.createWritable();
      await counted.pipeTo(fw);
      fw = null;
    } else {
      const blob = await new Response(counted).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = folder.name + '.zip'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }
    bar.style.width = '100%';
    status.textContent = '完成 · ' + fmtSize(written);
  } catch (e) {
    try { if (fw) await fw.close(); } catch (e2) { /* ignore */ }
    if ((e && e.name === 'AbortError') || sig.cancelled) {
      status.textContent = '已取消';
    } else {
      status.textContent = '失败：' + (e.message || e);
      alert('下载文件夹失败：' + (e.message || e));
    }
  }
  const cb = task.querySelector('.tcancel'); if (cb) cb.remove();
}

async function shareFolder(folder) {
  return shareItems(collectFolderFiles(folder.id, folder.name), folder.name);
}

// ---------- 校验文件夹（比对本地与云端元数据，不重传） ----------
function folderFullPath(id) {
  const parts = []; let cur = id; const seen = new Set();
  while (cur) {
    if (seen.has(cur)) break; seen.add(cur);
    const f = meta.folders.find((x) => x.id === cur);
    if (!f) break;
    parts.unshift(f.name);
    cur = f.parent_id;
  }
  return parts.join('/');
}
function cloudFileMap() {
  const map = new Map(); // 相对路径 -> 大小
  for (const f of meta.files) {
    const dir = f.folder_id ? folderFullPath(f.folder_id) : '';
    const rel = dir ? dir + '/' + f.name : f.name;
    map.set(rel, f.size);
  }
  return map;
}
async function runFolderCheck(fileList) {
  const locals = [...fileList].map((f) => ({
    path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
    size: f.size,
  }));
  if (!locals.length) { alert('没有读取到任何文件，请确认所选文件夹内有文件。'); return; }
  const cmap = cloudFileMap();
  const matched = [], missing = [], diff = [];
  let totalBytes = 0, matchedBytes = 0;
  for (const it of locals) {
    totalBytes += it.size;
    if (cmap.has(it.path)) {
      const cs = cmap.get(it.path);
      if (cs === it.size) { matched.push(it); matchedBytes += it.size; }
      else diff.push({ path: it.path, local: it.size, cloud: cs });
    } else missing.push(it);
  }
  const pct = ((matched.length / locals.length) * 100).toFixed(1);
  const bpct = totalBytes ? ((matchedBytes / totalBytes) * 100).toFixed(1) : '0.0';
  const L = [];
  const topFolders = meta.folders.filter((f) => f.parent_id === null).map((f) => f.name);
  L.push(`云端元数据：${meta.folders.length} 个文件夹 / ${meta.files.length} 个文件；顶层目录：${topFolders.slice(0, 20).join('、') || '(无)'}`);
  L.push(`本地：${locals.length} 个文件，${fmtSize(totalBytes)}`);
  L.push(`云端已有且大小一致：${matched.length} 个（${fmtSize(matchedBytes)}，文件数 ${pct}%，体积 ${bpct}%）`);
  L.push(`缺失：${missing.length} 个`);
  L.push(`大小不一致：${diff.length} 个`);
  if (missing.length) {
    L.push('');
    L.push('— 缺失文件（前 100 个）—');
    missing.slice(0, 100).forEach((m) => L.push(m.path + '  (' + fmtSize(m.size) + ')'));
    if (missing.length > 100) L.push(`…等共 ${missing.length} 个`);
  }
  if (diff.length) {
    L.push('');
    L.push('— 大小不一致（前 50 个）—');
    diff.slice(0, 50).forEach((d) => L.push(`${d.path}  本地 ${fmtSize(d.local)} / 云端 ${fmtSize(d.cloud)}`));
    if (diff.length > 50) L.push(`…等共 ${diff.length} 个`);
  }
  const body = $('preview-body'); const title = $('preview-title');
  body.innerHTML = ''; title.textContent = '校验结果';
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap'; pre.style.fontSize = '12px'; pre.style.wordBreak = 'break-all';
  pre.textContent = L.join('\n');
  body.appendChild(pre);
  $('preview-modal').classList.remove('hidden');
}

// ---------- 上传设置（分片大小 / 并发数） ----------
function isSizeLikeError(e) {
  const m = String((e && (e.message || e.code)) || e);
  return /fetch|network|timeout|超时|413|payload|too large|abort|failed/i.test(m);
}
// 探测网关允许的最大分片：先试 16MB，成功再试 32MB；失败回退 8MB。结果缓存 7 天。
async function probeChunkSize(force) {
  const cachedMb = Number(localStorage.getItem('drive_chunk_auto_mb') || 0);
  const cachedTs = Number(localStorage.getItem('drive_chunk_auto_ts') || 0);
  if (!force && cachedMb && Date.now() - cachedTs < 7 * 86400000) return cachedMb;
  const tryMb = async (mb) => {
    const blob = new Blob([new Uint8Array(mb * 1024 * 1024)]);
    const key = cloud.storage.userPath(session.user.id, '.probe/' + mb + '_' + Date.now() + '.bin');
    const r = await cloud.storage.upload(key, blob, { contentType: 'application/octet-stream' });
    if (r && r.error) throw r.error;
  };
  let best = 8;
  try { await tryMb(16); best = 16; } catch (e) { if (!isSizeLikeError(e)) throw e; }
  if (best === 16) {
    try { await tryMb(32); best = 32; } catch (e) { /* 保持 16MB */ }
  }
  try {
    localStorage.setItem('drive_chunk_auto_mb', String(best));
    localStorage.setItem('drive_chunk_auto_ts', String(Date.now()));
  } catch (e) { /* ignore */ }
  return best;
}
async function openUploadSettings() {
  const mb = prompt('分片大小（MB，建议 8 / 16 / 32）\n越小越稳，越大越快（过大可能被网关拒绝）：', String(CHUNK_MB));
  if (mb === null) return;
  const conc = prompt('并发分片数（建议 6 / 10 / 16）\n越大越快，过高可能被限流触发重试：', String(UPLOAD_CONC));
  if (conc === null) return;
  const mbN = Math.max(1, Math.min(64, Number(mb) || 8));
  const concN = Math.max(1, Math.min(16, Number(conc) || 6));
  CHUNK_MB = mbN; UPLOAD_CONC = concN; CHUNK_SIZE = mbN * 1024 * 1024;
  UPLOAD_CTRL = makeCtrl(concN, 2, Math.max(12, concN), 10);
  try { localStorage.setItem('drive_chunk_mb', String(mbN)); localStorage.setItem('drive_upload_conc', String(concN)); } catch (e) {}
  if (confirm('是否现在自动探测网关允许的最大分片？\n会临时上传约 16–48MB 测试数据（可跳过）。')) {
    try {
      const best = await probeChunkSize(true);
      CHUNK_MB = best; CHUNK_SIZE = best * 1024 * 1024;
      try { localStorage.setItem('drive_chunk_mb', String(best)); } catch (e) {}
      alert('探测完成：' + best + 'MB 可用，已应用。');
      return;
    } catch (e) {
      alert('探测失败：' + (e.message || e) + '\n继续使用 ' + CHUNK_MB + 'MB。');
      return;
    }
  }
  alert('已保存：分片 ' + mbN + 'MB，并发 ' + concN + '。\n新上传立即生效（改变分片大小会使该文件从头开始）。');
}

// ---------- 自定义域名：配置 / 校验 / 探测 ----------
function normalizeDomain(input) {
  let s = String(input || '').trim();
  if (!s) return { error: '请输入域名，例如 drive.example.com' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return { error: '域名格式不正确，请只填写域名（如 drive.example.com）' }; }
  if (u.protocol !== 'https:') return { error: '只支持 HTTPS 域名（http 无法安全登录与存储）' };
  if (u.pathname && u.pathname !== '/') return { error: '只填写域名，不要带路径或参数' };
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  return { host };
}
function validateDomainHost(host) {
  if (!host) return '域名为空';
  if (host.length > 253) return '域名过长（超过 253 字符）';
  if (host.startsWith('*.')) return '不支持泛域名：泛域名需 DNS Delegation 验证，建议绑定具体子域名';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '请填写域名，不要填写 IP 地址';
  if (host === 'localhost' || host.endsWith('.local')) return '不支持 localhost / .local 等本地域名';
  if (host.endsWith('.workbuddy.host')) return '请填写你自己的域名，不要使用平台默认域名';
  const labels = host.split('.');
  if (labels.length < 2) return '请填写完整域名（如 drive.example.com）';
  for (const l of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return '域名包含非法字符（只允许字母、数字、连字符，且不能以连字符开头/结尾）';
  }
  return null;
}
function setDomainStatus(state, msg) {
  const el = $('domain-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = state === 'error' ? 'var(--danger)' : (state === 'verified' ? 'var(--primary)' : '');
}
async function probeUrl(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // no-cors：只要 HTTPS 有响应（即使 404）也会 resolve；DNS/TLS 失败会抛错
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? '探测超时' : ((e && e.message) || String(e)) };
  } finally { clearTimeout(timer); }
}
function openDomainModal() {
  const cur = $('domain-current'); if (cur) cur.textContent = location.origin;
  const inp = $('domain-input');
  if (inp) inp.value = (meta.domain && meta.domain.domain) || '';
  const st = $('domain-status');
  if (st) {
    st.textContent = (meta.domain && meta.domain.message) || '';
    st.style.color = (meta.domain && meta.domain.status === 'error') ? 'var(--danger)' : '';
  }
  const m = $('domain-modal'); if (m) m.classList.remove('hidden');
}
async function saveDomainConfig() {
  const norm = normalizeDomain($('domain-input').value);
  if (norm.error) { setDomainStatus('error', norm.error); return; }
  const verr = validateDomainHost(norm.host);
  if (verr) { setDomainStatus('error', verr); return; }
  meta.domain = { domain: norm.host, status: 'pending', message: '已保存，等待配置 CNAME 与 HTTPS', checkedAt: new Date().toISOString() };
  try { await saveMeta(); } catch (e) { setDomainStatus('error', '保存失败：' + (e.message || e)); return; }
  setDomainStatus('pending', '已保存：' + norm.host + '。请按下方步骤配置 CNAME 与 HTTPS，然后点“检测解析”。');
}
async function verifyDomain() {
  const norm = normalizeDomain($('domain-input').value);
  if (norm.error) { setDomainStatus('error', norm.error); return; }
  const host = norm.host;
  const verr = validateDomainHost(host);
  if (verr) { setDomainStatus('error', verr); return; }
  if (host === location.hostname.toLowerCase()) {
    meta.domain = { domain: host, status: 'verified', message: '当前就是该域名，已生效', checkedAt: new Date().toISOString() };
    setDomainStatus('verified', '当前就是该域名，已生效。');
    try { await saveMeta(); } catch (e) { /* ignore */ }
    return;
  }
  setDomainStatus('pending', '正在检测 DNS / HTTPS / 存储路径（最长 8 秒）…');
  const [root, storage] = await Promise.all([
    probeUrl('https://' + host + '/?domain_check=' + Date.now(), 8000),
    probeUrl('https://' + host + '/.cloud/storage/?domain_check=' + Date.now(), 8000),
  ]);
  let state = 'reachable', msg = '';
  if (!root.ok) {
    state = 'error';
    msg = '域名不可访问（' + root.error + '）。请检查：CNAME 是否已生效、HTTPS 证书是否已部署、DNS 是否已传播（最长 48 小时）。';
  } else if (!storage.ok) {
    state = 'error';
    msg = '域名可访问，但 /.cloud/storage/ 未通过探测：自定义域名可能没有代理存储路径，会导致登录/上传/下载失败。请确认域名是在 WorkBuddy 应用内绑定，而不是直接绑到 EdgeOne Pages 裸项目。';
  } else {
    msg = '域名与 /.cloud/storage/ 均可访问。请用该域名打开本应用，确认看到同一个云盘；若一致即绑定成功。';
  }
  meta.domain = { domain: host, status: state, message: msg, checkedAt: new Date().toISOString() };
  setDomainStatus(state, msg);
  try { await saveMeta(); } catch (e) { /* ignore */ }
}
function copyDomainGuide() {
  const norm = normalizeDomain($('domain-input').value);
  const host = norm.host || 'drive.example.com';
  const sub = host.split('.')[0];
  const text = [
    '自定义域名配置步骤：',
    '1) 在 WorkBuddy「设置 → 数据管理 → 应用」或 EdgeOne 控制台 →「域名管理」，添加域名 ' + host,
    '2) 记录平台给出的 CNAME 目标（形如 xxx.eo.dnse.com）',
    '3) 在域名服务商添加记录：类型 CNAME，主机记录 ' + sub + '，记录值 = 平台 CNAME 目标，TTL 600',
    '4) 不要按线路/地域解析；等待 5–10 分钟生效（最长 48 小时）',
    '5) 在平台申请免费 HTTPS 证书（TrustAsia / Let\'s Encrypt），等待“已部署”',
    '6) 用 https://' + host + ' 打开本应用，确认登录、上传、下载正常（/.cloud/storage/ 必须同源可用）',
  ].join('\n');
  const done = () => setDomainStatus('pending', '配置说明已复制到剪贴板。');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => setDomainStatus('error', '复制失败，请手动选择说明文本。'));
  } else {
    setDomainStatus('error', '当前浏览器不支持自动复制，请手动选择说明文本。');
  }
}

// ---------- 使用帮助 ----------
function openHelp() {
  const m = $('help-modal');
  if (m) m.classList.remove('hidden');
}
function closeHelp() {
  const m = $('help-modal');
  if (m) m.classList.add('hidden');
  try { localStorage.setItem('drive_help_seen', '1'); } catch (e) { /* ignore */ }
}
function maybeShowHelp() {
  try { if (localStorage.getItem('drive_help_seen')) return; } catch (e) { return; }
  setTimeout(() => { openHelp(); }, 800);
}

// ---------- 事件绑定 ----------
$('tab-login').onclick = () => { $('tab-login').classList.add('active'); $('tab-signup').classList.remove('active'); $('login-form').classList.remove('hidden'); $('signup-form').classList.add('hidden'); $('forgot-form').classList.add('hidden'); };
$('tab-signup').onclick = () => { $('tab-signup').classList.add('active'); $('tab-login').classList.remove('active'); $('signup-form').classList.remove('hidden'); $('login-form').classList.add('hidden'); $('forgot-form').classList.add('hidden'); };
$('li-submit').onclick = doLogin;
$('su-send').onclick = sendSignupCode;
$('su-submit').onclick = doSignup;
$('li-forgot') && ($('li-forgot').onclick = showForgot);
$('fp-back') && ($('fp-back').onclick = showLoginForm);
$('fp-send') && ($('fp-send').onclick = fpSendCode);
$('fp-submit') && ($('fp-submit').onclick = fpSubmit);
$('btn-logout').onclick = doLogout;
$('btn-settings') && ($('btn-settings').onclick = openUploadSettings);
$('btn-diag') && ($('btn-diag').onclick = runDiag);
$('btn-domain') && ($('btn-domain').onclick = openDomainModal);
$('domain-close') && ($('domain-close').onclick = () => $('domain-modal').classList.add('hidden'));
$('domain-save') && ($('domain-save').onclick = saveDomainConfig);
$('domain-check') && ($('domain-check').onclick = verifyDomain);
$('domain-guide') && ($('domain-guide').onclick = copyDomainGuide);
$('btn-help') && ($('btn-help').onclick = openHelp);
$('help-close') && ($('help-close').onclick = () => closeHelp());
$('help-start') && ($('help-start').onclick = () => closeHelp());
document.querySelectorAll('.help-toc a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
$('btn-new-folder').onclick = createFolder;
$('btn-upload').onclick = async () => {
  const id = await pickUploadFolder(currentFolderId, '选择上传路径');
  if (id === undefined) return; // 用户取消，不打开文件选择器
  pendingUploadTarget = id;
  $('file-input').click();
};
$('file-input').onchange = (e) => {
  const files = [...e.target.files];
  const target = pendingUploadTarget;
  pendingUploadTarget = undefined;
  e.target.value = '';
  if (files.length) uploadFiles(files, target);
};
$('btn-upload-folder').onclick = async () => {
  const id = await pickUploadFolder(currentFolderId, '选择上传路径');
  if (id === undefined) return;
  pendingUploadTarget = id;
  $('folder-input').click();
};
$('folder-input').onchange = async (e) => {
  // 显式携带每个文件的相对路径（webkitRelativePath 含根文件夹名），不依赖修改 File 对象
  const items = [...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  const target = pendingUploadTarget;
  pendingUploadTarget = undefined;
  if (!items.length) { e.target.value = ''; return; }
  // 等上传完成后再清空，避免个别浏览器在清空 input 后使 File 对象失效
  await uploadFiles(items, target);
  e.target.value = '';
};
$('btn-check-folder') && ($('btn-check-folder').onclick = () => $('check-input').click());
$('check-input') && ($('check-input').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await runFolderCheck(files);
});
$('tasks-close').onclick = () => $('tasks').classList.add('hidden');
$('btn-tasks') && ($('btn-tasks').onclick = () => $('tasks').classList.remove('hidden'));
$('preview-close').onclick = () => { $('preview-modal').classList.add('hidden'); };
$('share-close').onclick = () => $('share-modal').classList.add('hidden');
// 移动弹窗：关闭 / 取消 / 确认，以及点击遮罩关闭（旧缓存 HTML 可能没有这些节点）
if ($('move-close')) $('move-close').onclick = closeMoveDialog;
if ($('move-cancel')) $('move-cancel').onclick = closeMoveDialog;
if ($('move-confirm')) $('move-confirm').onclick = () => performMove();
if ($('move-modal')) $('move-modal').addEventListener('click', (e) => { if (e.target === $('move-modal')) closeMoveDialog(); });
// 上传目标弹窗：关闭 / 取消 / 确认，以及点击遮罩关闭
if ($('upload-pick-close')) $('upload-pick-close').onclick = () => closeUploadPick(undefined);
if ($('upload-pick-cancel')) $('upload-pick-cancel').onclick = () => closeUploadPick(undefined);
if ($('upload-pick-confirm')) $('upload-pick-confirm').onclick = () => {
  if (uploadPickId === undefined) return;
  if (!resolveMoveTarget(uploadPickId).ok) { refreshUploadPick(); return; }
  closeUploadPick(uploadPickId);
};
if ($('upload-target-modal')) $('upload-target-modal').addEventListener('click', (e) => {
  if (e.target === $('upload-target-modal')) closeUploadPick(undefined);
});
$('share-copy').onclick = () => { $('share-url').select(); document.execCommand('copy'); $('share-msg').textContent = '已复制'; };

// 拖拽上传（支持整个文件夹）：先选目标目录，再上传
const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', async (e) => {
  let files = [];
  if (e.dataTransfer.items && e.dataTransfer.items.length) files = await getDroppedFiles(e.dataTransfer);
  if (!files.length && e.dataTransfer.files && e.dataTransfer.files.length) files = [...e.dataTransfer.files];
  if (!files.length) return;
  const id = await pickUploadFolder(currentFolderId, '选择上传路径');
  if (id === undefined) return; // 取消则放弃本次拖拽
  pendingUploadTarget = undefined;
  uploadFiles(files, id);
});

// 递归读取拖入的目录
function readDirEntries(dirEntry) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const all = [];
    const readBatch = () => reader.readEntries((ents) => {
      if (!ents.length) { resolve(all); return; }
      all.push(...ents); readBatch();
    }, () => resolve(all));
    readBatch();
  });
}
async function traverseEntry(entry, path, out) {
  if (entry.isFile) {
    await new Promise((res) => entry.file((f) => { out.push({ file: f, path: path + entry.name }); res(); }, () => res()));
  } else if (entry.isDirectory) {
    const ents = await readDirEntries(entry);
    for (const c of ents) await traverseEntry(c, path + entry.name + '/', out);
  }
}
async function getDroppedFiles(dt) {
  const out = [];
  for (const it of [...dt.items]) {
    const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (entry) await traverseEntry(entry, '', out);
  }
  return out;
}

// ---------- 加速器桥接：向 accel.js 暴露内部能力，保持单一 SDK 实例 / 会话 / 元数据 ----------
// 这里只暴露只读引用与无副作用工具，保证加速器的认证、权限校验、数据格式与主应用完全一致。
window.__driveBridge = {
  cloud: () => cloud,
  session: () => session,
  meta: () => meta,
  siteCode: () => SITE_CODE,
  currentFolder: () => currentFolderId,
  setCurrentFolder: (id) => { currentFolderId = id; },
  fmtSize, fmtEta, makeEtaTracker, esc, uid,
  saveMeta, render, partPaths, listKeys,
  createSignedUrlsBatch, getBlob, getStream, collectFolderFiles,
  pickUploadFolder,
};

// 文件/文件夹卡片「⚡ 加速」入口：统一转发给加速器；未加载时静默回退到原生下载。
function accelDownload(obj) {
  const isFolder = !!(obj && meta.folders.some((x) => x.id === obj.id));
  if (!window.Accel || typeof window.Accel.addDownloadTask !== 'function') {
    return isFolder ? downloadFolder(obj) : downloadFile(obj);
  }
  if (isFolder) {
    if (window.Accel.addFolderDownloadTasks) return window.Accel.addFolderDownloadTasks(obj);
    return downloadFolder(obj);
  }
  return window.Accel.addDownloadTask(obj);
}

// 绑定文件夹删除入口已移至 renderFolder 内联按钮

// 分享接收页由 index.html 的内联脚本处理，不初始化应用，避免覆盖接收视图
if (!new URLSearchParams(location.search).get('s')) init();
