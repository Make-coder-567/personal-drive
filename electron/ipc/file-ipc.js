/* IPC handlers：渲染层只通过 preload 白名单调用这些 channel。 */
const { app, dialog, ipcMain, shell } = require('electron');
const os = require('node:os');
const writer = require('../file/download-writer');
const { resolveTarget, isAllowedExternalUrl } = require('../file/path-guard');

function ipcError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function registerIpc(getWindow) {
  ipcMain.handle('nativefs:pick-save-path', async (_event, options = {}) => {
    const filters = Array.isArray(options.filters) && options.filters.length
      ? options.filters
      : [{ name: '所有文件', extensions: ['*'] }];
    const result = await dialog.showSaveDialog({
      title: '选择保存位置',
      defaultPath: options.suggestedName || 'download',
      filters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    return {
      canceled: result.canceled,
      filePath: result.filePath || '',
      name: result.filePath ? require('node:path').basename(result.filePath) : '',
      kind: 'file',
    };
  });

  ipcMain.handle('nativefs:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return {
      canceled: result.canceled,
      filePath: result.filePaths && result.filePaths[0] ? result.filePaths[0] : '',
      kind: 'folder',
    };
  });

  ipcMain.handle('nativefs:save-parts', async (event, request = {}) => {
    const taskId = String(request.taskId || `electron-${Date.now()}`);
    // 主进程先校验目标，渲染层传入的相对路径不得逃逸
    resolveTarget(request.target);
    const window = getWindow ? getWindow() : null;
    const onProgress = (written, total) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('nativefs:progress', { taskId, written, total });
      }
    };
    return writer.streamParts({ ...request, taskId }, onProgress);
  });

  ipcMain.handle('nativefs:cancel', async (_event, payload = {}) => {
    return { ok: writer.cancel(payload.taskId) };
  });

  ipcMain.handle('nativefs:app-info', async () => ({
    platform: 'electron',
    version: app.getVersion(),
    appName: app.name || '个人云盘',
    osVersion: `${process.platform} ${os.release()}`,
  }));

  ipcMain.handle('nativefs:open-external', async (_event, payload = {}) => {
    if (!isAllowedExternalUrl(payload.url)) {
      throw ipcError('E_NATIVEFS_INVALID_PATH', '外链不在白名单内');
    }
    await shell.openExternal(payload.url);
    return { ok: true };
  });
}

function disposeIpc() {
  for (const channel of [
    'nativefs:pick-save-path',
    'nativefs:pick-folder',
    'nativefs:save-parts',
    'nativefs:cancel',
    'nativefs:app-info',
    'nativefs:open-external',
  ]) {
    ipcMain.removeHandler(channel);
  }
}

module.exports = { registerIpc, disposeIpc };
