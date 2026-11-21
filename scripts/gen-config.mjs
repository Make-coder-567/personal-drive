#!/usr/bin/env node
/**
 * 构建期配置注入：读取 .env.[mode] / 进程环境变量，生成 public/__config__.js。
 * 产物是 classic script，挂载 window.__DRIVE_CONFIG__，不依赖 ESM。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'public', '__config__.js');

/**
 * 极简 .env 解析：支持 KEY=VALUE、export KEY=VALUE、# 注释、整值引号包裹。
 * 已有进程环境变量优先，便于 CI 覆盖。
 */
function parseEnvFile(file) {
  const result = {};
  if (!existsSync(file)) return result;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq < 0) continue;
    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function numberFromEnv(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

function csv(value, fallback = []) {
  if (!value || !String(value).trim()) return fallback;
  // 保留 CSP 关键字上的单引号：'self' / 'unsafe-inline' 等。
  // 解析 .env 时会剥离包裹整个值的引号，这里对已知 CSP 关键字重新加回。
  const keywords = new Set(["self", "unsafe-inline", "unsafe-eval", "none", "strict-dynamic"]);
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const raw = token.replace(/^['"]|['"]$/g, "");
      return keywords.has(raw) ? `'${raw}'` : raw;
    });
}

function main() {
  const modeArg = process.argv[2];
  const mode =
    modeArg ||
    process.env.VITE_MODE ||
    (process.env.NODE_ENV === 'development' ? 'development' : 'production');

  const fileEnv = { ...parseEnvFile(resolve(ROOT, '.env')), ...parseEnvFile(resolve(ROOT, `.env.${mode}`)) };
  const env = { ...fileEnv, ...process.env };

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const config = {
    appName: env.VITE_APP_NAME || '个人云盘',
    version: pkg.version || '1.0.0',
    endpoint: env.VITE_ENDPOINT || '',
    oauthRelayBaseUrl: env.VITE_OAUTH_RELAY_BASE_URL || '',
    publishableKey: env.VITE_PUBLISHABLE_KEY || '',
    defaultSiteCode: env.VITE_DEFAULT_SITE_CODE || '',
    shareBaseUrl: env.VITE_SHARE_BASE_URL || '',
    swUrl: env.VITE_SW_URL || './sw.js',
    downloadPrefix: env.VITE_DL_PREFIX || '/__dl__/',
    platform: env.VITE_PLATFORM || 'web',
    chunkMb: numberFromEnv(env.VITE_CHUNK_MB, 8, 1, 64),
    uploadConc: numberFromEnv(env.VITE_UPLOAD_CONC, 6, 1, 16),
    cspSources: {
      scriptSrc: csv(env.VITE_CSP_SCRIPT_SRC, ["'self'"]),
      connectSrc: csv(env.VITE_CSP_CONNECT_SRC, ["'self'"]),
      imgSrc: csv(env.VITE_CSP_IMG_SRC, ["'self'", 'data:', 'blob:']),
      styleSrc: csv(env.VITE_CSP_STYLE_SRC, ["'self'", "'unsafe-inline'"]),
      frameSrc: csv(env.VITE_CSP_FRAME_SRC, ["'self'"]),
    },
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  const body = `/* 由 scripts/gen-config.mjs 自动生成，请勿手工编辑。模式：${mode} */\nwindow.__DRIVE_CONFIG__ = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
  writeFileSync(OUT_FILE, body, 'utf8');
  console.log(`[gen-config] mode=${mode} version=${config.version} → public/__config__.js`);
  if (!config.endpoint || !config.publishableKey) {
    console.warn('[gen-config] 警告：endpoint / publishableKey 为空，生产构建必须由 CI 注入。');
  }
}

main();
