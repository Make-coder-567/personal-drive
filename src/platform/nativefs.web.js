/* Web NativeFs 适配器（classic script，非 ESM）
 * 保留浏览器 File System Access API 边下边写能力；无 FSAPI 时明确返回 UNSUPPORTED，
 * 由 app.js / accel.js 原有的 SW + Blob 路径继续兜底。
 */
(function (global) {
  'use strict';

  var controllers = new Map();
  var CODES = global.NativeFsErrorCodes;

  function fail(code, message, taskId, cause) {
    throw new global.NativeFsError(code, message, taskId, cause);
  }

  function normalizeParts(parts) {
    return (parts || []).map(function (part) {
      if (typeof part === 'string') return { url: part, headers: {}, size: 0 };
      return {
        url: part.url || '',
        headers: part.headers || {},
        size: Number(part.size) || 0,
      };
    });
  }

  async function pickSavePath(opts) {
    var options = opts || {};
    var suggestedName = options.suggestedName || 'download';
    if (typeof global.showSaveFilePicker !== 'function') {
      fail(CODES.UNSUPPORTED, '当前浏览器不支持 File System Access API', undefined, null);
    }
    try {
      var handle = await global.showSaveFilePicker({ suggestedName: suggestedName });
      return { kind: 'handle', handle: handle, name: handle.name || suggestedName, canceled: false };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        fail(CODES.CANCEL, '已取消保存位置选择', undefined, error);
      }
      fail(CODES.IO, '选择保存位置失败', undefined, error);
    }
  }

  async function saveParts(req) {
    var request = req || {};
    var taskId = request.taskId || 'web-' + Date.now();
    var target = request.target || {};
    if (target.kind !== 'handle' || !target.handle || typeof target.handle.createWritable !== 'function') {
      fail(CODES.UNSUPPORTED, 'Web 端无原生落盘目标，请使用应用内下载回退路径', taskId, null);
    }
    var parts = normalizeParts(request.parts);
    if (!parts.length) fail(CODES.INVALID_PATH, '没有可下载的分片', taskId, null);

    var controller = new AbortController();
    controllers.set(taskId, controller);
    var writable = null;
    var written = 0;
    try {
      writable = await target.handle.createWritable();
      for (var i = 0; i < parts.length; i++) {
        if (controller.signal.aborted) fail(CODES.CANCEL, '已取消', taskId, null);
        var response = await fetch(parts[i].url, {
          headers: parts[i].headers,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) fail(CODES.IO, '分片 ' + i + ' 下载失败（' + response.status + '）', taskId, null);
        var reader = response.body.getReader();
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          await writable.write(chunk.value);
          written += chunk.value.length;
          if (typeof request.onProgress === 'function') {
            request.onProgress(written, Number(request.totalSize) || written);
          }
        }
      }
      await writable.close();
      writable = null;
      return { path: '', bytesWritten: written, canceled: false, kind: 'web' };
    } catch (error) {
      if (writable) {
        try { await writable.close(); } catch (e2) { /* ignore */ }
      }
      throw global.NativeFsWrapError(error, CODES.IO, taskId);
    } finally {
      controllers.delete(taskId);
    }
  }

  function pickFolder() {
    return new Promise(function (resolve, reject) {
      var input = global.document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      input.style.display = 'none';
      input.onchange = function () {
        var name = 'folder';
        var file = input.files && input.files[0];
        if (file && file.webkitRelativePath) name = file.webkitRelativePath.split('/')[0];
        global.document.body.removeChild(input);
        resolve({ kind: 'folder', name: name, canceled: false });
      };
      input.oncancel = function () {
        global.document.body.removeChild(input);
        reject(new global.NativeFsError(CODES.CANCEL, '已取消目录选择'));
      };
      global.document.body.appendChild(input);
      input.click();
    });
  }

  async function readFileSlice(req) {
    var request = req || {};
    if (typeof request.path !== 'string') {
      fail(CODES.UNSUPPORTED, 'Web 端仅支持按 URL 读取分片', request.taskId, null);
    }
    var headers = Object.assign({}, request.headers || {}, {
      Range: 'bytes=' + Number(request.offset || 0) + '-' + (Number(request.offset || 0) + Number(request.length || 0) - 1),
    });
    var response = await fetch(request.path, { headers: headers });
    if (!response.ok && response.status !== 206) {
      fail(CODES.IO, '读取分片失败（' + response.status + '）', request.taskId, null);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  function openExternal(url) {
    return Promise.resolve(global.open(String(url), '_blank', 'noopener,noreferrer'));
  }

  function getAppInfo() {
    var config = global.RuntimeConfig ? global.RuntimeConfig.get() : {};
    return Promise.resolve({
      platform: 'web',
      version: config.version || '1.0.0',
      appName: config.appName || '个人云盘',
      osVersion: navigator.userAgent || '',
    });
  }

  function cancel(taskId) {
    var controller = controllers.get(taskId);
    if (controller) {
      controller.abort();
      controllers.delete(taskId);
    }
    return Promise.resolve({ ok: !!controller });
  }

  global.WebNativeFs = Object.freeze({
    pickSavePath: pickSavePath,
    saveParts: saveParts,
    pickFolder: pickFolder,
    readFileSlice: readFileSlice,
    openExternal: openExternal,
    getAppInfo: getAppInfo,
    cancel: cancel,
  });
})(typeof window !== 'undefined' ? window : self);
