/* 旧版 Android WebView 兼容垫片（classic script）
 * 提供 crypto.randomUUID；不覆盖原生已实现的能力。
 */
(function (global) {
  'use strict';
  var crypto = global.crypto || global.msCrypto;
  if (!crypto) return;
  if (typeof crypto.randomUUID !== 'function') {
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
            h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
        },
      });
    } catch (e) { /* 某些 WebView 不允许扩展 crypto，忽略即可 */ }
  }
})(typeof window !== 'undefined' ? window : self);
