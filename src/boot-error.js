/* 启动错误可视化（classic script）
 * 在 WebView / Electron / 浏览器中把全局脚本错误显示为页面顶部提示，避免白屏无信息。
 */
(function (global) {
  'use strict';
  var BOX_ID = '__drive_boot_error__';
  var buffer = [];

  function ensureBox() {
    var box = document.getElementById(BOX_ID);
    if (box || !document.body) return box;
    box = document.createElement('div');
    box.id = BOX_ID;
    box.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:99999;background:#fff1f0;color:#a8071a;' +
      'font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:10px 12px;' +
      'max-height:38vh;overflow:auto;white-space:pre-wrap;border-bottom:2px solid #ff4d4f;box-shadow:0 2px 8px rgba(0,0,0,.12)';
    document.body.appendChild(box);
    return box;
  }

  function render() {
    // 没有错误时绝不创建浮层，避免正常页面顶部出现空红色边框。
    if (!buffer.length) return;
    var box = ensureBox();
    if (box) box.textContent = '启动/运行错误（可截图反馈）：\n' + buffer.join('\n');
  }

  function append(text) {
    buffer.push(String(text));
    if (buffer.length > 20) buffer.shift();
    render();
  }

  document.addEventListener('DOMContentLoaded', render);
  setTimeout(render, 500);

  global.addEventListener('error', function (e) {
    append('ERROR ' + (e.message || '未知错误') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''));
  }, true);
  global.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    append('REJECTION ' + ((reason && (reason.stack || reason.message)) || reason || '未知 Promise 拒绝'));
  });

  global.__driveBootError = { append: append, messages: function () { return buffer.slice(); } };
})(typeof window !== 'undefined' ? window : self);
