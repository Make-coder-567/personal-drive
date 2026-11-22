/* 旧版 Android WebView 兼容垫片（classic script）
 * 1) 提供 crypto.randomUUID；不覆盖原生已实现的能力。
 * 2) CORS 兼容层：cloud-service 网关的 Access-Control-Allow-Headers 白名单不含
 *    SDK 默认携带的 X-Client-Info 与上传时的 x-upsert。桌面 Electron 不校验 CORS，
 *    但 Android WebView(https://localhost) 会在预检阶段拒绝，fetch 抛 TypeError:
 *    Failed to fetch，表现为「元数据读不到 + 上传全部失败」。
 *    这两个头只影响遥测与覆盖语义，剥离后不影响本应用的键设计（写唯一键 / PUT 覆盖），
 *    因此在发起请求前统一移除。
 */
(function (global) {
  'use strict';
  var crypto = global.crypto || global.msCrypto;
  if (crypto && typeof crypto.randomUUID !== 'function') {
    try {
      Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: function randomUUID() {
          var bytes = new Uint8Array(16);
          if (crypto.getRandomValues) crypto.getRandomValues(bytes);
          else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          var h = [];
          for (var j = 0; j < 16; j++) h.push(('0' + bytes[j].toString(16)).slice(-2));
          return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
            h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
            h.slice(10, 16).join('');
        },
      });
    } catch (e) { /* 某些 WebView 不允许扩展 crypto，忽略即可 */ }
  }

  // ---- CORS 头兼容层 ----
  var nativeFetch = global.fetch;
  var STRIP_HEADERS = ['x-client-info', 'x-upsert'];
  if (typeof nativeFetch === 'function' && !global.__driveCorsFetchPatched) {
    global.__driveCorsFetchPatched = true;
    global.fetch = function driveCorsFetch(input, init) {
      if (!init || !init.headers) return nativeFetch.call(global, input, init);
      try {
        var headers = new Headers(init.headers);
        var changed = false;
        for (var i = 0; i < STRIP_HEADERS.length; i++) {
          if (headers.has(STRIP_HEADERS[i])) {
            headers.delete(STRIP_HEADERS[i]);
            changed = true;
          }
        }
        if (changed) {
          var nextInit = {};
          for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) nextInit[k] = init[k];
          nextInit.headers = headers;
          return nativeFetch.call(global, input, nextInit);
        }
      } catch (e) { /* Headers 构造失败时保持原行为，不阻断请求 */ }
      return nativeFetch.call(global, input, init);
    };
  }
})(typeof window !== 'undefined' ? window : self);
