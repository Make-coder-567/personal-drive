#!/usr/bin/env node
/**
 * 本地依赖预处理：
 *  1. 复制 WorkBuddy Cloud SDK 的浏览器全局构建到 public/vendor/workbuddy-cloud-sdk.js；
 *  2. 用 esbuild 把 client-zip 打成 classic IIFE，暴露 window.clientZip.downloadZip。
 * 依赖缺失时写入明确占位文件与非零退出码，不静默失败。
 */
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = resolve(ROOT, 'public', 'vendor');
const SDK_SOURCE = resolve(ROOT, 'node_modules', '@tencent-ai', 'workbuddy-cloud-sdk', 'lib', 'index.global.js');
const SDK_TARGET = resolve(VENDOR_DIR, 'workbuddy-cloud-sdk.js');
const ZIP_TARGET = resolve(VENDOR_DIR, 'client-zip.global.js');
const MISSING_MARKER = resolve(VENDOR_DIR, 'VENDOR_MISSING.txt');

mkdirSync(VENDOR_DIR, { recursive: true });

let failed = false;

function noteFailure(name, detail) {
  failed = true;
  const message = `[build-vendor] ${name} 不可用：${detail}`;
  console.error(message);
  writeFileSync(
    MISSING_MARKER,
    `${message}\n请执行 npm install 后重新运行 npm run vendor。占位文件不可用于生产构建。\n`,
    'utf8',
  );
}

// 1) SDK：固定版本的本地副本，禁止运行时依赖 @dev CDN
if (existsSync(SDK_SOURCE)) {
  copyFileSync(SDK_SOURCE, SDK_TARGET);
  console.log(`[build-vendor] SDK → public/vendor/workbuddy-cloud-sdk.js`);
} else {
  writeFileSync(
    SDK_TARGET,
    '/* 占位文件：WorkBuddy Cloud SDK 未安装，请执行 npm install。 */\n' +
      "console.error('[vendor] WorkBuddy Cloud SDK 缺失，请执行 npm install 后重试。');\n",
    'utf8',
  );
  noteFailure('WorkBuddy Cloud SDK', `未找到 ${SDK_SOURCE}`);
}

// 2) client-zip：ESM → IIFE 全局
try {
  await build({
    stdin: {
      contents: "import { downloadZip } from 'client-zip'; export { downloadZip };",
      resolveDir: ROOT,
      sourcefile: 'client-zip-entry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    globalName: 'clientZip',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    outfile: ZIP_TARGET,
    footer: { js: '\nwindow.clientZip = clientZip;' },
    logLevel: 'warning',
  });
  console.log('[build-vendor] client-zip → public/vendor/client-zip.global.js');
} catch (error) {
  writeFileSync(
    ZIP_TARGET,
    '/* 占位文件：client-zip 未安装或打包失败，请执行 npm install。 */\n' +
      "window.clientZip = { downloadZip: function () { throw new Error('client-zip 本地依赖缺失'); } };\n",
    'utf8',
  );
  noteFailure('client-zip', error && error.message ? error.message : String(error));
}

if (failed) {
  process.exitCode = 1;
  console.error('[build-vendor] vendor 构建未成功完成，详见 public/vendor/VENDOR_MISSING.txt。');
} else {
  if (existsSync(MISSING_MARKER)) unlinkSync(MISSING_MARKER);
  console.log('[build-vendor] 完成。');
}
