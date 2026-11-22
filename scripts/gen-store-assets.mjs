#!/usr/bin/env node
/** 生成商店与下载页图标资产（纯 Node，无第三方依赖）。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIRS = [
  resolve(ROOT, 'release', 'assets'),
  resolve(ROOT, 'electron', 'assets', 'appx'),
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function makePng(width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;
      const corner = Math.min(nx, ny, 1 - nx, 1 - ny);
      const alpha = corner < 0.045 ? 0 : 255;
      const cloud =
        Math.hypot(nx - 0.5, ny - 0.58) < 0.19 ||
        Math.hypot(nx - 0.38, ny - 0.48) < 0.13 ||
        Math.hypot(nx - 0.62, ny - 0.46) < 0.15;
      const idx = row + 1 + x * 4;
      if (cloud) {
        raw[idx] = raw[idx + 1] = raw[idx + 2] = 255;
      } else {
        raw[idx] = Math.round(47 + ny * 30);
        raw[idx + 1] = Math.round(111 + ny * 20);
        raw[idx + 2] = 237;
      }
      raw[idx + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const assets = {
  'icon-192.png': [192, 192],
  'icon-512.png': [512, 512],
  'StoreLogo.png': [50, 50],
  'Square44x44Logo.png': [44, 44],
  'Square150x150Logo.png': [150, 150],
  'Wide310x150Logo.png': [310, 150],
  'SplashScreen.png': [620, 300],
};

for (const dir of OUT_DIRS) mkdirSync(dir, { recursive: true });
for (const [name, [w, h]] of Object.entries(assets)) {
  const png = makePng(w, h);
  writeFileSync(resolve(ROOT, 'release', 'assets', name), png);
  if (['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Wide310x150Logo.png', 'SplashScreen.png'].includes(name)) {
    writeFileSync(resolve(ROOT, 'electron', 'assets', 'appx', name), png);
  }
  console.log(`[store-assets] ${name} ${w}x${h} ${png.length} bytes`);
}
