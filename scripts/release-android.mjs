#!/usr/bin/env node
/** Android 官网直发正式 APK/AAB 构建与收集。 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS_FILE = resolve(ROOT, 'release', 'secrets', 'android-release.env');
const APK_SRC = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const AAB_SRC = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const OUT = resolve(ROOT, 'release', 'android');
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function run(label, command, args, env = {}, cwd = ROOT) {
  const r = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32' && (command.endsWith('.cmd') || command.endsWith('.bat')),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${label} 失败（exit ${r.status}）`);
}

function loadSecrets() {
  const env = {};
  if (!existsSync(SECRETS_FILE)) throw new Error(`缺少 ${SECRETS_FILE}`);
  for (const line of readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq > 0) env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return env;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function collect(src, target) {
  if (!existsSync(src)) throw new Error(`找不到产物：${src}`);
  copyFileSync(src, target);
  console.log(`[release:android] ${src.replace(ROOT, '.')} → ${target.replace(ROOT, '.')} (${sha256(target)})`);
}

function main() {
  const secrets = loadSecrets();
  mkdirSync(OUT, { recursive: true });
  run('build:web', process.execPath, [resolve(ROOT, 'scripts', 'build-all.mjs'), '--web']);
  run('cap copy', resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'cap.cmd' : 'cap'), ['copy', 'android']);
  const chainEnv = {
    JAVA_HOME: resolve(ROOT, '.toolchain', 'jdk21'),
    ANDROID_HOME: resolve(ROOT, '.toolchain', 'android-sdk'),
    ANDROID_SDK_ROOT: resolve(ROOT, '.toolchain', 'android-sdk'),
    GRADLE_USER_HOME: resolve(ROOT, '.toolchain', 'gradle-home'),
    ...secrets,
  };
  const gradle = resolve(ROOT, '.toolchain', 'gradle-8.14.3', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
  run('gradle assembleRelease', gradle, ['assembleRelease', '--no-daemon'], chainEnv, resolve(ROOT, 'android'));
  collect(APK_SRC, resolve(OUT, `个人云盘-${version}-release.apk`));
  try {
    run('gradle bundleRelease', gradle, ['bundleRelease', '--no-daemon'], chainEnv, resolve(ROOT, 'android'));
    collect(AAB_SRC, resolve(OUT, `personal-drive-${version}-release.aab`));
  } catch (e) {
    console.warn(`[release:android] AAB 构建失败（不影响官网 APK）：${e.message}`);
  }
  writeFileSync(resolve(OUT, 'SHA256SUMS.txt'), Object.entries({
    [`个人云盘-${version}-release.apk`]: resolve(OUT, `个人云盘-${version}-release.apk`),
    [`personal-drive-${version}-release.aab`]: resolve(OUT, `personal-drive-${version}-release.aab`),
  }).filter(([, p]) => existsSync(p)).map(([name, p]) => `${sha256(p)}  ${name}`).join('\n') + '\n');
}

try { main(); } catch (e) { console.error(`[release:android] ${e.message}`); process.exitCode = 1; }
