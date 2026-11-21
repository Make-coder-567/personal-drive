/* Capacitor（Android）NativeFs 适配器（classic script，非 ESM）
 * 调用 Capacitor.Plugins.NativeFs；进度通过 plugin addListener('progress') 推送。
 */
(function (global) {
  'use strict';

  var CODES = global.NativeFsErrorCodes;

  function plugin() {
    var capacitor = global.Capacitor;
    if (!capacitor || !capacitor.Plugins || !capacitor.Plugins.NativeFs) {
      throw new global.NativeFsError(
        CODES.UNSUPPORTED,
        'Capacitor NativeFs 插件未注册',
      );
    }
    return capacitor.Plugins.NativeFs;
  }

  function call(method, payload, taskId) {
    var api = plugin();
    if (typeof api[method] !== 'function') {
      return Promise.reject(new global.NativeFsError(CODES.UNSUPPORTED, 'NativeFs 插件不支持 ' + method, taskId, null));
    }
    return Promise.resolve(api[method](payload || {})).catch(function (error) {
      throw global.NativeFsWrapError(error, CODES.IO, taskId);
    });
  }

  function pickSavePath(opts) {
    return call('pickSavePath', opts || {}, undefined);
  }

  function pickFolder() {
    return call('pickFolder', {}, undefined);
  }

  function saveParts(req) {
    var request = req || {};
    var taskId = request.taskId || 'android-' + Date.now();
    var api = plugin();
    var listener = null;
    var ready = Promise.resolve();
    if (typeof api.addListener === 'function') {
      ready = api.addListener('progress', function (data) {
        if (!data || data.taskId !== taskId || typeof request.onProgress !== 'function') return;
        request.onProgress(Number(data.written) || 0, Number(data.total) || Number(request.totalSize) || 0);
      }).then(function (handle) { listener = handle; });
    }
    return ready.then(function () {
      return call('saveParts', {
        target: request.target,
        parts: request.parts,
        totalSize: request.totalSize,
        taskId: taskId,
      }, taskId);
    }).finally(function () {
      if (listener && typeof listener.remove === 'function') listener.remove();
    });
  }

  function readFileSlice(req) {
    var request = req || {};
    return call('readFileSlice', request, request.taskId);
  }

  function openExternal(url) {
    return call('openExternal', { url: String(url) }, undefined);
  }

  function getAppInfo() {
    return call('getAppInfo', {}, undefined);
  }

  function cancel(taskId) {
    return call('cancel', { taskId: taskId }, taskId);
  }

  global.CapacitorNativeFs = Object.freeze({
    pickSavePath: pickSavePath,
    saveParts: saveParts,
    pickFolder: pickFolder,
    readFileSlice: readFileSlice,
    openExternal: openExternal,
    getAppInfo: getAppInfo,
    cancel: cancel,
  });
})(typeof window !== 'undefined' ? window : self);
