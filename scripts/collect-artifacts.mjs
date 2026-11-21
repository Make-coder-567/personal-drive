#!/usr/bin/env node
/** 把原生构建的真实产物复制为项目约定的中文文件名；找不到产物时明确失败，不伪造。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2] || '';
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

let failed = false;

function copyReal(source, target) {
  if (!source || !existsSync(source) || statSync(source).size === 0) {
    console.error(`[collect] 找不到非空产物：${source || '(未找到匹配文件)'}`);
    failed = true;
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  if (resolve(source) === resolve(target)) {
    console.log(`[collect] 已就位：${target}`);
    return;
  }
  copyFileSync(source, target);
  console.log(`[collect] ${source.replace(ROOT, '.')} → ${target.replace(ROOT, '.')} (${statSync(target).size} bytes)`);
}

function findFirst(dir, predicate) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).map((name) => join(dir, name)).find(predicate) || null;
}

function isAndroidSigned() {
  const keystore = process.env.ANDROID_KEYSTORE || '';
  return !!keystore && existsSync(keystore);
}

function isWindowsSigned() {
  return !!(process.env.CSC_LINK || process.env.WIN_CSC_FILE || process.env.WINDOWS_CERT_FILE);
}

function collectAndroid() {
  const apk = findFirst(resolve(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release'),
    (file) => file.toLowerCase().endsWith('.apk'));
  if (!apk) {
    console.error('[collect] 未找到 android/app/build/outputs/apk/release/*.apk');
    failed = true;
    return;
  }
  const suffix = isAndroidSigned() ? 'release' : 'release-unsigned';
  copyReal(apk, resolve(ROOT, 'build', 'android', `个人云盘-${version}-${suffix}.apk`));
}

function collectWindows() {
  const output = resolve(ROOT, 'build', 'windows');
  const suffix = isWindowsSigned() ? '' : '-unsigned';
  // 只从 electron-builder 原始产物复制；排除上次收集生成的 *-unsigned 副本，避免覆盖成旧包
  const setup = findFirst(output, (file) =>
    file.toLowerCase().endsWith('.exe') && /setup/i.test(file) && !/unsigned/i.test(file));
  // electron-builder 26 的 portable 产物名为 "<productName> <version>.exe"（无 portable 字样）
  const portable = findFirst(output, (file) =>
    file.toLowerCase().endsWith('.exe') && !/setup|uninstall|unsigned/i.test(file));
  copyReal(setup, resolve(output, `个人云盘-${version}-win-x64-setup${suffix}.exe`));
  copyReal(portable, resolve(output, `个人云盘-${version}-win-x64-portable${suffix}.exe`));
}

if (platform === 'android') collectAndroid();
else if (platform === 'windows') collectWindows();
else {
  console.error('[collect] 用法：node scripts/collect-artifacts.mjs android|windows');
  failed = true;
}

if (failed) {
  console.error('[collect] 产物收集失败：未生成的文件不会被伪造。');
  process.exitCode = 1;
}
