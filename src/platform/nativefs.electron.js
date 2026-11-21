/* Electron NativeFs 适配器（classic script，非 ESM）
 * 仅调用 preload 通过 contextBridge 暴露的白名单 API；渲染层不持有整文件字节。
 */
(function (global) {
  'use strict';

  var CODES = global.NativeFsErrorCodes;
  var IPC_TIMEOUT_MS = 30000;

  function bridge() {
    var api = global.electronNativeFs;
    if (!api) {
      throw new global.NativeFsError(
        CODES.UNSUPPORTED,
        'Electron 原生文件系统桥未注入（请在 preload 中暴露 electronNativeFs）',
      );
    }
    return api;
  }

  function withTimeout(promise, taskId, label) {
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new global.NativeFsError(CODES.IPC_TIMEOUT, label + ' 超时', taskId, null));
      }, IPC_TIMEOUT_MS);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(function () {
      clearTimeout(timer);
    });
  }

  function invoke(method, payload, taskId) {
    var api = bridge();
    if (typeof api[method] !== 'function') {
      return Promise.reject(new global.NativeFsError(CODES.UNSUPPORTED, 'Electron 不支持 ' + method, taskId, null));
    }
    return withTimeout(api[method](payload), taskId, method).catch(function (error) {
      throw global.NativeFsWrapError(error, CODES.IO, taskId);
    });
  }

  function pickSavePath(opts) {
    return invoke('pickSavePath', opts || {}, undefined);
  }

  function pickFolder() {
    return invoke('pickFolder', {}, undefined);
  }

  function saveParts(req) {
    var request = req || {};
    var taskId = request.taskId || 'electron-' + Date.now();
    var api = bridge();
    var unsubscribe = null;
    if (typeof api.onProgress === 'function') {
      unsubscribe = api.onProgress(function (progress) {
        if (!progress || progress.taskId !== taskId || typeof request.onProgress !== 'function') return;
        request.onProgress(Number(progress.written) || 0, Number(progress.total) || Number(request.totalSize) || 0);
      });
    }
    return invoke('saveParts', {
      target: request.target,
      parts: request.parts,
      totalSize: request.totalSize,
      taskId: taskId,
    }, taskId).finally(function () {
      if (typeof unsubscribe === 'function') unsubscribe();
    });
  }

  function readFileSlice(req) {
    var request = req || {};
    return invoke('readFileSlice', request, request.taskId);
  }

  function openExternal(url) {
    return invoke('openExternal', { url: String(url) }, undefined);
  }

  function getAppInfo() {
    return invoke('getAppInfo', {}, undefined);
  }

  function cancel(taskId) {
    return invoke('cancel', { taskId: taskId }, taskId);
  }

  global.ElectronNativeFs = Object.freeze({
    pickSavePath: pickSavePath,
    saveParts: saveParts,
    pickFolder: pickFolder,
    readFileSlice: readFileSlice,
    openExternal: openExternal,
    getAppInfo: getAppInfo,
    cancel: cancel,
  });
})(typeof window !== 'undefined' ? window : self);
