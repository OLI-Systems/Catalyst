#!/usr/bin/env node
// Copies the local Node runtime into src-tauri/binaries/ under the
// target-triple name Tauri's externalBin expects. The ~90MB binary is NOT
// committed to git (see src-tauri/.gitignore); this regenerates it on install
// so both `tauri dev` and `tauri build` have a sidecar runtime to bundle.
const fs = require('fs');
const path = require('path');

const TRIPLES = {
  win32: {
    x64: 'x86_64-pc-windows-msvc',
    arm64: 'aarch64-pc-windows-msvc',
  },
  darwin: {
    x64: 'x86_64-apple-darwin',
    arm64: 'aarch64-apple-darwin',
  },
};

const archMap = TRIPLES[process.platform];
if (!archMap) {
  console.log(`[prepare-sidecar-bin] unsupported platform: ${process.platform} — skipping.`);
  process.exit(0);
}

const triple = archMap[process.arch];
if (!triple) {
  console.error(`[prepare-sidecar-bin] unsupported arch: ${process.arch} on ${process.platform}`);
  process.exit(1);
}

// Windows sidecars carry the .exe extension; macOS binaries have none.
const ext = process.platform === 'win32' ? '.exe' : '';
const dest = path.join(__dirname, '..', 'src-tauri', 'binaries', `catalyst-server-${triple}${ext}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });

if (fs.existsSync(dest)) {
  console.log(`[prepare-sidecar-bin] already present: ${dest}`);
  process.exit(0);
}

fs.copyFileSync(process.execPath, dest);
if (process.platform !== 'win32') {
  // Preserve the executable bit lost by copyFileSync on Unix-like systems.
  fs.chmodSync(dest, 0o755);
}
console.log(`[prepare-sidecar-bin] copied ${process.execPath} -> ${dest}`);
