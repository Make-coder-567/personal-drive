/* 平台运行时引导（classic script，非 ESM）
 * 加载顺序：asset-code.js → __config__.js → platform-runtime.js → share-receive.js。
 * 负责初始化 RuntimeConfig / NativeFsAdapter，并在原生端挂载 window.NativeFs；
 * Web 端保持原有 FSAPI / SW / Blob 下载路径，不替换 window.NativeFs。
 */
(function (global) {
  'use strict';

  var boot = global.NativeFsAdapter.init();
  var config = global.RuntimeConfig.get();

  // 原生宿主可在页面脚本之前注入 __DRIVE_CONFIG_RUNTIME__ 覆盖平台与服务端地址。
  if (boot.platform === 'electron' || boot.platform === 'android') {
    global.NativeFs = global.NativeFsAdapter;
  }

  global.PlatformRuntime = Object.freeze({
    config: config,
    platform: boot.platform,
    nativeFs: boot.adapter,
    getNativeFs: function () { return global.NativeFsAdapter; },
    getConfig: function () { return global.RuntimeConfig.refresh(); },
    getShareBaseUrl: function () { return global.RuntimeConfig.getShareBaseUrl(); },
    getSwUrl: function () { return global.RuntimeConfig.getSwUrl(); },
    shareUrl: function (payload) { return global.RuntimeConfig.shareUrl(payload); },
  });

  console.log('[platform] ' + boot.platform + ' · v' + config.version);
})(typeof window !== 'undefined' ? window : self);
