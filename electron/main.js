/* Electron 主进程：加载 Web 内核 dist/，提供安全的最小原生文件能力。 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerIpc, disposeIpc } = require('./ipc/file-ipc');
const { isAllowedExternalUrl } = require('./file/path-guard');

const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.html');
const ICON = path.resolve(__dirname, 'assets', 'icon.ico');

/** 允许应用内导航的来源：本地文件与白名单 HTTPS 外链。 */
function isAllowedNavigationUrl(rawUrl) {
  if (!rawUrl) return false;
  if (rawUrl.startsWith('file://')) return true;
  return isAllowedExternalUrl(rawUrl);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: '个人云盘',
    icon: ICON,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {});
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  window.loadFile(DIST_INDEX).catch((error) => {
    console.error('[electron] 加载 dist/index.html 失败：', error);
  });
  return window;
}

let mainWindow = null;

app.whenReady().then(() => {
  registerIpc(() => mainWindow);
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  disposeIpc();
  if (process.platform !== 'darwin') app.quit();
});
