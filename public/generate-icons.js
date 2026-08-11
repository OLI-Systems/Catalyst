/**
 * Icon generator for the Catalyst PWA.
 * Run with: node public/generate-icons.js
 *
 * Uses a canvas-based approach to create PNG icons from the "C_" brand mark.
 * No external dependencies — uses Node.js built-in modules only.
 *
 * The icons are simple enough to generate as raw PNG buffers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, 'icons');
const BG_COLOR = { r: 6, g: 8, b: 13 };       // #06080d
const FG_COLOR = { r: 56, g: 189, b: 248 };    // #38bdf8

// Ensure icons directory exists
if (!fs.existsSync(ICON_DIR)) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
}

// ---- Minimal PNG encoder (no dependencies) ----

function createPNG(width, height, pixels) {
  // pixels is a Uint8Array of RGBA data (width * height * 4 bytes)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT chunk — raw pixel data with zlib
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx + 1] = pixels[srcIdx + 1];
      rawData[dstIdx + 2] = pixels[srcIdx + 2];
      rawData[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuffer, data, crcBuf]);
}

// CRC32 for PNG chunks
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return ~crc;
}

// ---- Drawing helpers ----

function fillRect(pixels, w, x, y, rw, rh, color) {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px >= 0 && px < w && py >= 0 && py < w) {
        const idx = (py * w + px) * 4;
        pixels[idx] = color.r;
        pixels[idx + 1] = color.g;
        pixels[idx + 2] = color.b;
        pixels[idx + 3] = 255;
      }
    }
  }
}

// Draw the "C_" glyph as pixel art
function drawCUnderscore(pixels, size, fg, padRatio) {
  const pad = Math.floor(size * padRatio);
  const area = size - pad * 2;
  const thick = Math.max(Math.floor(area / 8), 2);

  // "C" character: top bar, left bar, bottom bar
  const cLeft = pad;
  const cTop = pad;
  const cWidth = Math.floor(area * 0.5);
  const cHeight = area;

  // Top horizontal bar of C
  fillRect(pixels, size, cLeft, cTop, cWidth, thick, fg);
  // Left vertical bar of C
  fillRect(pixels, size, cLeft, cTop, thick, cHeight, fg);
  // Bottom horizontal bar of C
  fillRect(pixels, size, cLeft, cTop + cHeight - thick, cWidth, thick, fg);

  // "_" underscore: to the right of C, at the bottom
  const uLeft = cLeft + cWidth + Math.floor(thick * 0.8);
  const uTop = cTop + cHeight - thick;
  const uWidth = Math.floor(area * 0.35);
  fillRect(pixels, size, uLeft, uTop, uWidth, thick, fg);
}

function generateIcon(size, maskable) {
  const pixels = new Uint8Array(size * size * 4);

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = BG_COLOR.r;
    pixels[i * 4 + 1] = BG_COLOR.g;
    pixels[i * 4 + 2] = BG_COLOR.b;
    pixels[i * 4 + 3] = 255;
  }

  // Maskable icons need more padding (safe zone is inner 80%)
  const padRatio = maskable ? 0.2 : 0.15;
  drawCUnderscore(pixels, size, FG_COLOR, padRatio);

  return createPNG(size, size, pixels);
}

// Generate all icon variants
const variants = [
  { size: 192, maskable: false, name: 'icon-192.png' },
  { size: 512, maskable: false, name: 'icon-512.png' },
  { size: 192, maskable: true, name: 'icon-maskable-192.png' },
  { size: 512, maskable: true, name: 'icon-maskable-512.png' }
];

for (const v of variants) {
  const png = generateIcon(v.size, v.maskable);
  const outPath = path.join(ICON_DIR, v.name);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${v.size}x${v.size}${v.maskable ? ' maskable' : ''})`);
}

console.log('All icons generated successfully.');
