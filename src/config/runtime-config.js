/* 运行时配置门面（classic script，非 ESM）
 * 合并优先级：window.__DRIVE_CONFIG_RUNTIME__ > window.__DRIVE_CONFIG__ > 内置默认值。
 * 业务内核只依赖 window.RuntimeConfig，不再读取硬编码配置。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    appName: '个人云盘',
    version: '1.0.0',
    endpoint: '',
    oauthRelayBaseUrl: '',
    publishableKey: '',
    defaultSiteCode: '',
    shareBaseUrl: '',
    swUrl: './sw.js',
    downloadPrefix: '/__dl__/',
    platform: 'web',
    chunkMb: 8,
    uploadConc: 6,
    cspSources: {
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["'self'"],
    },
  };

  var cached = null;

  function locationOrigin() {
    try {
      return global.location && global.location.origin ? global.location.origin : '';
    } catch (e) {
      return '';
    }
  }

  function resolveConfig() {
    var injected = global.__DRIVE_CONFIG__ || {};
    var runtime = global.__DRIVE_CONFIG_RUNTIME__ || {};
    var merged = {};
    var key;
    for (key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) merged[key] = DEFAULTS[key];
    }
    for (key in injected) {
      if (Object.prototype.hasOwnProperty.call(injected, key)) merged[key] = injected[key];
    }
    for (key in runtime) {
      if (Object.prototype.hasOwnProperty.call(runtime, key)) merged[key] = runtime[key];
    }
    merged.cspSources = Object.assign(
      {},
      DEFAULTS.cspSources,
      injected.cspSources || {},
      runtime.cspSources || {},
    );
    if (!merged.shareBaseUrl) merged.shareBaseUrl = locationOrigin();
    if (!merged.swUrl) merged.swUrl = './sw.js';
    if (!merged.downloadPrefix) merged.downloadPrefix = '/__dl__/';
    return Object.freeze(merged);
  }

  function get() {
    if (!cached) cached = resolveConfig();
    return cached;
  }

  function getShareBaseUrl() {
    return String(get().shareBaseUrl || locationOrigin()).replace(/\/+$/, '');
  }

  function getSwUrl() {
    return String(get().swUrl || './sw.js');
  }

  function getDownloadPrefix() {
    return String(get().downloadPrefix || '/__dl__/');
  }

  // 与 app.js 的 b64encodeUrl 保持完全一致（分享链接向后兼容）
  function b64encodeUrl(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }

  function shareUrl(payload) {
    var code = get().defaultSiteCode
      ? '&sharecode=' + encodeURIComponent(get().defaultSiteCode)
      : '';
    return getShareBaseUrl() + '/?s=' + b64encodeUrl(JSON.stringify(payload)) + code;
  }

  global.RuntimeConfig = Object.freeze({
    get: get,
    getShareBaseUrl: getShareBaseUrl,
    getSwUrl: getSwUrl,
    getDownloadPrefix: getDownloadPrefix,
    shareUrl: shareUrl,
    refresh: function () {
      cached = null;
      return get();
    },
  });
})(typeof window !== 'undefined' ? window : self);
