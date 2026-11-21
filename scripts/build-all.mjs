#!/usr/bin/env node
/**
 * 构建编排：gen-config → vendor → vite build；按参数可选触发 Android / Windows 构建。
 * 原生构建依赖本机 SDK（Android SDK/JDK、 Electron 二进制），缺失时明确报错，不伪造产物。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
    shell: process.platform === 'win32' && (command.endsWith('.cmd') || command.endsWith('.bat')),
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
    nodeScript('collect-artifacts.mjs', ['android']);
  }

  if (wantWindows) {
    nodeScript('gen-icon.mjs');
    const builder = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
    // 每次构建使用独立输出目录，避免 win-unpacked / win-unpacked.tmp 被资源管理器
    // 或正在运行的 EXE 锁定导致 EPERM；最终由 collect-artifacts 复制为约定文件名。
    const stamp = String(Date.now());
    const stagingRel = `build/windows/.stage-${stamp}`;
    const stagingDir = resolve(ROOT, stagingRel);
    const configTemplate = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8');
    const stagedConfig = resolve(ROOT, '.electron-builder.stage.yml');
    writeFileSync(
      stagedConfig,
      configTemplate.replace(/output:\s*[^\r\n]+/, `output: ${stagingRel}`),
      'utf8',
    );
    // 架构在 win.target 中声明为 x64；CLI 不再传 x64（会被当成 target 名）
    run('electron-builder', builder, ['--win', '-c', stagedConfig]);
    run('collect-artifacts', process.execPath, [resolve(ROOT, 'scripts', 'collect-artifacts.mjs'), 'windows', stagingDir]);
  }

  console.log('\n[build-all] 完成。');
}

try {
  main();
} catch (error) {
  console.error(`\n[build-all] 构建失败：${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
