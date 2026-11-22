#!/usr/bin/env node
/** 生成 GitHub Pages 部署目录：页面本体 + 静态文档 + 图标；大文件仍由 GitHub Releases 托管。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_INDEX = resolve(ROOT, 'release', 'download', 'index.html');
const OUT = resolve(ROOT, 'release', 'github-pages');
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function copyIfExists(src, target) {
  if (!existsSync(src)) throw new Error(`缺少文件：${src}`);
  copyFileSync(src, target);
}

function copyDir(srcDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = resolve(srcDir, entry);
    const out = resolve(outDir, entry);
    if (statSync(src).isDirectory()) copyDir(src, out);
    else copyFileSync(src, out);
  }
}

function main() {
  mkdirSync(OUT, { recursive: true });
  copyDir(resolve(ROOT, 'release', 'assets'), resolve(OUT, 'assets'));

  let index = readFileSync(SRC_INDEX, 'utf8')
    .replaceAll('../assets/', 'assets/')
    .replaceAll('../PRIVACY-POLICY.html', 'PRIVACY-POLICY.html')
    .replaceAll('../TERMS-OF-USE.html', 'TERMS-OF-USE.html')
    .replaceAll('../RELEASE-NOTES.html', 'RELEASE-NOTES.html');
  writeFileSync(resolve(OUT, 'index.html'), index, 'utf8');

  copyIfExists(resolve(ROOT, 'release', 'PRIVACY-POLICY.html'), resolve(OUT, 'PRIVACY-POLICY.html'));
  copyIfExists(resolve(ROOT, 'release', 'TERMS-OF-USE.html'), resolve(OUT, 'TERMS-OF-USE.html'));
  copyIfExists(resolve(ROOT, 'release', 'RELEASE-NOTES.html'), resolve(OUT, 'RELEASE-NOTES.html'));
  writeFileSync(resolve(OUT, '.nojekyll'), '', 'utf8');

  const sums = [
    [`personal-drive-${version}-release.apk`, resolve(ROOT, 'release', 'android', `个人云盘-${version}-release.apk`)],
    [`personal-drive-${version}-win-x64-setup-unsigned.exe`, resolve(ROOT, 'release', 'windows', `个人云盘-${version}-win-x64-setup-unsigned.exe`)],
    [`personal-drive-${version}-win-x64-portable-unsigned.exe`, resolve(ROOT, 'release', 'windows', `个人云盘-${version}-win-x64-portable-unsigned.exe`)],
  ].filter(([, p]) => existsSync(p)).map(([name, p]) => `${sha256(p)}  ${name}`).join('\n') + '\n';
  writeFileSync(resolve(OUT, 'SHA256SUMS.txt'), sums, 'utf8');

  writeFileSync(resolve(OUT, 'README.md'), `# GitHub Pages 部署目录

本目录只含静态页面，可直接发布到 GitHub Pages。Windows 大安装包由 GitHub Releases 托管。

## 部署方式一：main 分支 /docs 目录

1. 将本目录内所有文件（包含 \`.nojekyll\`）复制到仓库 \`docs/\` 目录。
2. 提交并推送到 GitHub。
3. 仓库设置 → Pages → Source 选择 \`main / docs\` → Save。
4. 访问：https://make-coder-567.github.io/personal-drive/

## 部署方式二：gh-pages 分支根目录

1. 新建 \`gh-pages\` 分支。
2. 将本目录内所有文件复制到分支根目录。
3. 推送到 GitHub。
4. 仓库设置 → Pages → Source 选择 \`gh-pages / root\` → Save。
5. 访问：https://make-coder-567.github.io/personal-drive/

## 创建 GitHub Release

在仓库 Releases 页面创建 tag \`v1.0.0\`，并上传以下资产：

- \`个人云盘-${version}-release.apk\`
- \`个人云盘-${version}-win-x64-setup-unsigned.exe\`
- \`个人云盘-${version}-win-x64-portable-unsigned.exe\`

文件名必须与下载页中的链接完全一致。

## 自定义域名（可选）

在仓库根目录添加 \`CNAME\` 文件，内容为你自己的域名，例如：

\`\`\`text
download.example.com
\`\`\`

再到 DNS 服务商添加 CNAME 记录指向 \`make-coder-567.github.io\`，并在 Pages 设置中启用 HTTPS。
`, 'utf8');

  console.log(`[pages] 已生成：${OUT}`);
  console.log('[pages] 包含：index.html / PRIVACY-POLICY.html / TERMS-OF-USE.html / RELEASE-NOTES.html / assets / SHA256SUMS.txt / README.md');
}

try { main(); } catch (e) { console.error(`[pages] ${e.message}`); process.exitCode = 1; }
