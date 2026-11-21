/* preload：只暴露白名单 API，绝不暴露 ipcRenderer 本体。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronNativeFs', {
  pickSavePath: (options) => ipcRenderer.invoke('nativefs:pick-save-path', options || {}),

  pickFolder: () => ipcRenderer.invoke('nativefs:pick-folder', {}),

  saveParts: (request) => ipcRenderer.invoke('nativefs:save-parts', request || {}),

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
