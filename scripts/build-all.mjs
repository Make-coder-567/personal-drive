#!/usr/bin/env node
/**
 * 构建编排：gen-config → vendor → vite build；按参数可选触发 Android / Windows 构建。
 * 原生构建依赖本机 SDK（Android SDK/JDK、 Electron 二进制），缺失时明确报错，不伪造产物。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const wantDev = args.has('--dev');
const wantAndroid = args.has('--android') || args.has('--all');
const wantWindows = args.has('--windows') || args.has('--all');
const wantWeb = !wantDev || args.has('--web');

function run(label, command, commandArgs, options = {}) {
  console.log(`\n[build-all] ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} 失败（exit ${result.status}）`);
}

function nodeScript(name, extraArgs = []) {
  run(name, process.execPath, [resolve(ROOT, 'scripts', name), ...extraArgs]);
}

function main() {
  const mode = process.env.VITE_MODE || (wantDev ? 'development' : 'production');
  nodeScript('gen-config.mjs', [mode]);
  nodeScript('build-vendor.mjs');

  if (wantDev) {
    run('vite dev', resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'), ['--host']);
    return;
  }

  run('vite build', resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'), ['build', '--mode', mode]);

  if (wantAndroid) {
    const cap = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'cap.cmd' : 'cap');
    run('capacitor sync', cap, ['sync', 'android']);
    const gradlew = resolve(ROOT, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    run('android assembleRelease', gradlew, ['assembleRelease'], { cwd: resolve(ROOT, 'android') });
  }

  if (wantWindows) {
    const builder = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
    run('electron-builder', builder, ['--win', 'x64']);
  }

  console.log('\n[build-all] 完成。');
}

try {
  main();
} catch (error) {
  console.error(`\n[build-all] 构建失败：${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
