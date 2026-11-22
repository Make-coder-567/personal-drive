#!/usr/bin/env node
/** Windows 官网直发与 Microsoft Store MSIX 候选包构建。 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'release', 'windows');
const STORE_OUT = resolve(OUT, 'store');
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function run(label, command, args, env = {}) {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32' && (command.endsWith('.cmd') || command.endsWith('.bat')),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${label} 失败（exit ${r.status}）`);
}

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

function findArtifact(dir, predicate) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).map((n) => resolve(dir, n)).find(predicate) || null;
}

function collect(src, target, lines) {
  if (!src || !existsSync(src)) throw new Error(`找不到产物：${src || '(未找到匹配文件)'}`);
  copyFileSync(src, target);
  const rel = String(target).replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');
  lines.push(`${sha256(target)}  ${rel}`);
  console.log(`[release:win] ${target.replace(ROOT, '.')} (${sha256(target)})`);
}

function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(STORE_OUT, { recursive: true });
  run('gen icon', process.execPath, [resolve(ROOT, 'scripts', 'gen-icon.mjs')]);
  run('gen store assets', process.execPath, [resolve(ROOT, 'scripts', 'gen-store-assets.mjs')]);
  run('build:web', process.execPath, [resolve(ROOT, 'scripts', 'build-all.mjs'), '--web']);

  // 每次使用独立输出目录，避免被资源管理器或运行中的 EXE 锁定。
  const stamp = String(Date.now());
  const stageRel = `build/windows/.release-${stamp}`;
  const stageDir = resolve(ROOT, stageRel);
  const config = resolve(ROOT, '.electron-builder.release.yml');
  const template = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8');
  writeFileSync(config, template.replace(/output:\s*[^\r\n]+/, `output: ${stageRel}`), 'utf8');

  const builder = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  run('electron-builder nsis+portable', builder, ['--win', '-c', config]);

  const signed = !!(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.WINDOWS_CERT_FILE);
  const suffix = signed ? '' : '-unsigned';
  const lines = [];
  const setup = findArtifact(stageDir, (p) => /setup.*\.exe$/i.test(p) && !/-unsigned/i.test(p));
  const portable = findArtifact(stageDir, (p) => /\.exe$/i.test(p) && /个人云盘\s*1\.0\.0/i.test(p) && !/setup|uninstall|unsigned/i.test(p));
  collect(setup, resolve(OUT, `个人云盘-${version}-win-x64-setup${suffix}.exe`), lines);
  collect(portable, resolve(OUT, `个人云盘-${version}-win-x64-portable${suffix}.exe`), lines);

  try {
    run('electron-builder appx', builder, ['--win', 'appx', '-c', 'electron-builder.appx.yml']);
    const msix = findArtifact(STORE_OUT, (p) => /\.(msix|msixupload|appx)$/i.test(p));
    if (msix) {
      const ext = msix.slice(msix.lastIndexOf('.'));
      const target = resolve(STORE_OUT, `个人云盘-${version}-store-candidate${ext}`);
      copyFileSync(msix, target);
      lines.push(`${sha256(target)}  release/windows/store/个人云盘-${version}-store-candidate${ext}`);
    }
  } catch (e) {
    console.warn(`[release:win] AppX 商店候选构建失败：${e.message}`);
  }

  writeFileSync(resolve(OUT, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
}

try { main(); } catch (e) { console.error(`[release:win] ${e.message}`); process.exitCode = 1; }
