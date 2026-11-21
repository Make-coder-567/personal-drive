/* 由 index.html 原 body 内联脚本原样外链化（classic script，非 ESM）。
 * 本地 vendor 已在 head 优先加载；此处仅在其失败时保留多 CDN 回退，
 * 最后按原顺序加载 app.js → accel.js，所有同源资源继续透传 sharecode。
 */
(function () {
  var code = window.__ASSET_CODE__ || '';
  var q = code ? ('&sharecode=' + encodeURIComponent(code)) : '';

  function loadApp() {
    var s = document.createElement('script');
    s.src = 'app.js?v=20261119a' + q;
    // 加速器在 app.js 之后加载，通过 __driveBridge 复用同一 SDK / 会话 / 元数据，
    // 认证、权限、数据格式与主应用完全一致；加载失败也不影响主应用流程。
    s.onload = function () {
      var a = document.createElement('script');
      a.src = 'accel.js?v=20261119a' + q;
      a.onerror = function () { console.warn('accel.js 加载失败，加速器不可用'); };
      document.body.appendChild(a);
    };
    document.body.appendChild(s);
  }

  if (window.WorkBuddyCloud) {
    loadApp();
    return;
  }

  var urls = [
    'vendor/workbuddy-cloud-sdk.js' + (code ? ('?sharecode=' + encodeURIComponent(code)) : ''),
    'https://npm.elemecdn.com/@tencent-ai/workbuddy-cloud-sdk@0.1.4/lib/index.global.js',
    'https://fastly.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@0.1.4/lib/index.global.js',
    'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@0.1.4/lib/index.global.js',
    'https://unpkg.com/@tencent-ai/workbuddy-cloud-sdk@0.1.4/lib/index.global.js',
  ];

  function tryLoad(i) {
    if (i >= urls.length) { loadApp(); return; }
    var s = document.createElement('script');
    s.src = urls[i];
    s.onload = function () {
      if (window.WorkBuddyCloud) loadApp();
      else tryLoad(i + 1);
    };
    s.onerror = function () { tryLoad(i + 1); };
    document.head.appendChild(s);
  }
  tryLoad(0);
})();
