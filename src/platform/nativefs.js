/* NativeFs 端口门面（classic script，非 ESM）
 * 按平台选择 Web / Electron / Capacitor 适配器，统一包装为 NativeFsError。
 */
(function (global) {
  'use strict';

  var CODES = global.NativeFsErrorCodes;
  var METHODS = ['pickSavePath', 'saveParts', 'pickFolder', 'readFileSlice', 'openExternal', 'getAppInfo', 'cancel'];
  var adapter = null;

  function detectPlatform() {
    var configured = '';
    try {
      configured = String((global.RuntimeConfig && global.RuntimeConfig.get().platform) || '');
    } catch (e) { /* ignore */ }
    if (configured === 'electron' || global.electronNativeFs) return 'electron';
    if (configured === 'android') return 'android';
    var capacitor = global.Capacitor;
    if (configured === 'web' && !(capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform())) return 'web';
    if (capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform()) return 'android';
    return 'web';
  }

  function chooseAdapter(platform) {
    if (platform === 'electron') return global.ElectronNativeFs;
    if (platform === 'android') return global.CapacitorNativeFs;
    return global.WebNativeFs;
  }

  function init(forcePlatform) {
    var platform = forcePlatform || detectPlatform();
    adapter = chooseAdapter(platform);
    if (!adapter) throw new global.NativeFsError(CODES.UNSUPPORTED, 'NativeFs 适配器未加载：' + platform);
    return { platform: platform, adapter: adapter };
  }

  function current() {
    if (!adapter) init();
    return adapter;
  }

  function delegate(method) {
    return function (payload) {
      try {
        var api = current();
        if (typeof api[method] !== 'function') {
          return Promise.reject(new global.NativeFsError(CODES.UNSUPPORTED, 'NativeFs.' + method + ' 不可用'));
        }
        return Promise.resolve(api[method](payload)).catch(function (error) {
          var taskId = payload && payload.taskId ? payload.taskId : undefined;
          throw global.NativeFsWrapError(error, CODES.IO, taskId);
        });
      } catch (error) {
        return Promise.reject(global.NativeFsWrapError(error, CODES.UNSUPPORTED));
      }
    };
  }

  var facade = { init: init, platform: function () { return init().platform; } };
  METHODS.forEach(function (method) { facade[method] = delegate(method); });
  global.NativeFsAdapter = Object.freeze(facade);
})(typeof window !== 'undefined' ? window : self);
