#!/usr/bin/env node
// Assembles src-tauri/sidecar/ — the self-contained Node backend that Tauri
// bundles as a resource and runs via the node.exe sidecar. Ships only runtime
// dependencies (the dev tree is excluded), so the installer stays small.
// Run automatically by tauri.conf.json's beforeBuildCommand.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const stage = path.join(root, 'src-tauri', 'sidecar');

// Runtime dependencies the backend actually loads or serves. @xterm/* are served
// to the renderer from node_modules via express.static, so they must be present.
const RUNTIME_DEPS = [
  '@xterm/addon-fit',
  '@xterm/addon-web-links',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'express',
  'native-file-dialog',
  'node-pty',
  'ws',
];

function log(msg) { console.log(`[stage-sidecar] ${msg}`); }

log(`staging into ${stage}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. App code.
fs.copyFileSync(path.join(root, 'server.js'), path.join(stage, 'server.js'));
fs.cpSync(path.join(root, 'lib'), path.join(stage, 'lib'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(stage, 'public'), { recursive: true });

// 2. A minimal package.json pinned to the versions already resolved at the repo
//    root, so the staged install matches what was tested.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const deps = {};
for (const name of RUNTIME_DEPS) {
  const ver = rootPkg.dependencies && rootPkg.dependencies[name];
  if (!ver) throw new Error(`Runtime dependency "${name}" missing from root package.json dependencies`);
  deps[name] = ver;
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'catalyst-sidecar',
  version: rootPkg.version || '1.0.0',
  private: true,
  main: 'server.js',
  dependencies: deps,
}, null, 2));

// 3. Production-only install (rebuilds/fetches native prebuilds for plain Node).
log('installing production dependencies (this can take a minute)...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: stage,
  stdio: 'inherit',
  shell: process.platform === 'win32', // npm is npm.cmd on Windows
});

// 4. Trim node-pty prebuilds to the platform we're building on (keeps all
//    arches for that OS, e.g. win32-* on Windows, darwin-* on macOS).
const keepPrefix = `${process.platform}-`; // 'win32-' on Windows, 'darwin-' on macOS
const prebuilds = path.join(stage, 'node_modules', 'node-pty', 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const entry of fs.readdirSync(prebuilds)) {
    if (!entry.startsWith(keepPrefix)) {
      fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true });
    }
  }
}

log('done');
