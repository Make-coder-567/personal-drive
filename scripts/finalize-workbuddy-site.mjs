#!/usr/bin/env node
/** 将 GitHub Pages 目录转换为 WorkBuddy 内置发布版本：安装包随站部署，所有链接带 sharecode。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(ROOT, 'release', 'github-pages');
const INDEX = resolve(SITE, 'index.html');
const DOWNLOADS = resolve(SITE, 'downloads');
const SHARE_CODE = 'PBCK' + 'Y4YAA5';
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  if (!existsSync(INDEX)) throw new Error('请先运行 npm run build:pages');
  // 清空旧 downloads：历史版本里曾以中文名落盘，与页面里的 ASCII 链接不一致会导致 404。
  if (existsSync(DOWNLOADS)) rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });

  // 页面链接统一为 ASCII 文件名（GitHub Release 会剥掉中文名），落盘名必须与之完全一致。
  const artifacts = [
    [resolve(ROOT, 'release', 'android', `个人云盘-${version}-release.apk`), `personal-drive-${version}-release.apk`],
    [resolve(ROOT, 'release', 'windows', `个人云盘-${version}-win-x64-setup-unsigned.exe`), `personal-drive-${version}-win-x64-setup-unsigned.exe`],
    [resolve(ROOT, 'release', 'windows', `个人云盘-${version}-win-x64-portable-unsigned.exe`), `personal-drive-${version}-win-x64-portable-unsigned.exe`],
  ];
  // 内容指纹：文件名不变时，用安装包内容前 8 位哈希作为链接版本参数。
  // 包内容一变 URL 就变，浏览器/手机不会再命中旧缓存（线上无 Cache-Control 时尤其必要）。
  const stamp = {};
  for (const [src, name] of artifacts) {
    if (!existsSync(src)) throw new Error(`缺少安装包：${src}`);
    stamp[name] = sha256(src).slice(0, 8);
    copyFileSync(src, resolve(DOWNLOADS, name));
  }

  let html = readFileSync(INDEX, 'utf8');
  html = html.replace(
    /href="https:\/\/github\.com\/Make-coder-567\/personal-drive\/releases\/download\/v1\.0\.0\/([^"]+)"/g,
    (_, file) => `href="downloads/${file}?sharecode=${SHARE_CODE}&v=${stamp[file] || '0'}"`,
  );
  html = html.replace(
    '安装包通过 <strong>GitHub Releases</strong> 分发；本页只托管静态内容，不存放 120MB 的 Windows 安装包。',
    '安装包已随本下载站一起部署，可直接在当前页面下载；SHA-256 校验值见下方。',
  );
  for (const name of ['PRIVACY-POLICY.html', 'TERMS-OF-USE.html', 'RELEASE-NOTES.html']) {
    html = html.replace(`href="${name}"`, `href="${name}?sharecode=${SHARE_CODE}"`);
  }
  writeFileSync(INDEX, html, 'utf8');

  console.log(`[workbuddy-site] 已生成：${SITE}`);
  console.log(`[workbuddy-site] 下载链接版本指纹：${Object.entries(stamp).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

try { main(); } catch (e) { console.error(`[workbuddy-site] ${e.message}`); process.exitCode = 1; }
