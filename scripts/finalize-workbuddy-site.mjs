#!/usr/bin/env node
/** 将 GitHub Pages 目录转换为 WorkBuddy 内置发布版本：安装包随站部署，所有链接带 sharecode。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(ROOT, 'release', 'github-pages');
const INDEX = resolve(SITE, 'index.html');
const DOWNLOADS = resolve(SITE, 'downloads');
const SHARE_CODE = 'PBCK' + 'Y4YAA5';
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function main() {
  if (!existsSync(INDEX)) throw new Error('请先运行 npm run build:pages');
  mkdirSync(DOWNLOADS, { recursive: true });

  let html = readFileSync(INDEX, 'utf8');
  html = html.replace(
    /href="https:\/\/github\.com\/Make-coder-567\/personal-drive\/releases\/download\/v1\.0\.0\/([^"]+)"/g,
    (_, file) => `href="downloads/${file}?sharecode=${SHARE_CODE}"`,
  );
  html = html.replace(
    '安装包通过 <strong>GitHub Releases</strong> 分发；本页只托管静态内容，不存放 120MB 的 Windows 安装包。',
    '安装包已随本下载站一起部署，可直接在当前页面下载；SHA-256 校验值见下方。',
  );
  for (const name of ['PRIVACY-POLICY.html', 'TERMS-OF-USE.html', 'RELEASE-NOTES.html']) {
    html = html.replace(`href="${name}"`, `href="${name}?sharecode=${SHARE_CODE}"`);
  }
  writeFileSync(INDEX, html, 'utf8');

  const artifacts = [
    [resolve(ROOT, 'release', 'android', `个人云盘-${version}-release.apk`), `个人云盘-${version}-release.apk`],
    [resolve(ROOT, 'release', 'windows', `个人云盘-${version}-win-x64-setup-unsigned.exe`), `个人云盘-${version}-win-x64-setup-unsigned.exe`],
    [resolve(ROOT, 'release', 'windows', `个人云盘-${version}-win-x64-portable-unsigned.exe`), `个人云盘-${version}-win-x64-portable-unsigned.exe`],
  ];
  for (const [src, name] of artifacts) {
    if (!existsSync(src)) throw new Error(`缺少安装包：${src}`);
    copyFileSync(src, resolve(DOWNLOADS, name));
  }
  console.log(`[workbuddy-site] 已生成：${SITE}`);
}

try { main(); } catch (e) { console.error(`[workbuddy-site] ${e.message}`); process.exitCode = 1; }
