#!/usr/bin/env node
/** 生成合法的 Windows ICO 图标（内嵌 PNG 帧，16/32/48/64/256 px），无第三方依赖。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'electron', 'assets', 'icon.ico');

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

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 生成 size×size RGBA 图标：蓝色圆角底 + 白色云朵轮廓。 */
function makePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    raw[offset] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const ny = y / size;
      const corner = Math.min(nx, ny, 1 - nx, 1 - ny);
      const alpha = corner < 0.06 ? 0 : 255;
      const cloud =
        (Math.hypot(nx - 0.5, ny - 0.58) < 0.19) ||
        (Math.hypot(nx - 0.38, ny - 0.48) < 0.13) ||
        (Math.hypot(nx - 0.62, ny - 0.46) < 0.15);
      const idx = offset + 1 + x * 4;
      if (cloud) {
        raw[idx] = 255; raw[idx + 1] = 255; raw[idx + 2] = 255;
      } else {
        raw[idx] = Math.round(47 + ny * 30);
        raw[idx + 1] = Math.round(111 + ny * 20);
        raw[idx + 2] = 237;
      }
      raw[idx + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  const sizes = [16, 32, 48, 64, 256];
  const frames = sizes.map((size) => makePng(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + 16 * sizes.length;
  const directory = [];
  frames.forEach((frame, index) => {
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);  // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(frame.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += frame.length;
  });

  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, Buffer.concat([header, ...directory, ...frames]));
  console.log(`[gen-icon] ${TARGET} (${Buffer.concat([header, ...directory, ...frames]).length} bytes)`);
}

main();
