/* preload：只暴露白名单 API，绝不暴露 ipcRenderer 本体。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronNativeFs', {
  pickSavePath: (options) => ipcRenderer.invoke('nativefs:pick-save-path', options || {}),

  pickFolder: () => ipcRenderer.invoke('nativefs:pick-folder', {}),

  saveParts: (request) => ipcRenderer.invoke('nativefs:save-parts', request || {}),

  /** 按偏移量读取本地文件片段，返回可结构化克隆的 Uint8Array。 */
  readFileSlice: (request) => {
    const req = request || {};
    return ipcRenderer.invoke('nativefs:read-file-slice', {
      path: String(req.path || ''),
      offset: Number(req.offset) || 0,
      length: Number(req.length) || 0,
    });
  },

  cancel: (taskId) => ipcRenderer.invoke('nativefs:cancel', { taskId: String(taskId) }),

  getAppInfo: () => ipcRenderer.invoke('nativefs:app-info', {}),

  openExternal: (url) => ipcRenderer.invoke('nativefs:open-external', { url: String(url) }),

  /** 订阅主进程进度推送，返回解绑函数。 */
  onProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('nativefs:progress', listener);
    return () => ipcRenderer.removeListener('nativefs:progress', listener);
  },
});
