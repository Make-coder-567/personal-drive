#!/usr/bin/env node
/** 快速自检：Web 产物齐备 + 源码无硬编码密钥/域名/站点码。 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = [
  'dist/index.html',
  'dist/__config__.js',
  'dist/vendor/workbuddy-cloud-sdk.js',
  'dist/vendor/client-zip.global.js',
];
// 分段拼接，避免校验脚本自身命中禁用词
const FORBIDDEN = ['w' + 'bpk_', 'PBCK' + 'Y4YAA5', 'personal-drive-52476.app' + '.workbuddy.host'];
// docs 为历史设计文档；public/vendor 为第三方依赖副本，均不属于业务源码
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'docs', '.git', '.workbuddy', 'android',
  'vendor', 'public',
]);

let failed = false;
for (const rel of REQUIRED) {
  const file = resolve(ROOT, rel);
  const ok = existsSync(file) && statSync(file).size > 0;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${rel}`);
  if (!ok) failed = true;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.env.') || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|mjs|ts|html|css|json|md)$/i.test(name)) {
      const text = readFileSync(full, 'utf8');
      for (const token of FORBIDDEN) {
        if (text.includes(token)) {
          console.log(`FAIL 硬编码 ${token} → ${full.split(sep).slice(-2).join(sep)}`);
          failed = true;
        }
      }
    }
  }
}
walk(ROOT);

if (failed) {
  console.error('\n[check] 自检失败。');
  process.exitCode = 1;
} else {
  console.log('\n[check] 自检通过。');
}
