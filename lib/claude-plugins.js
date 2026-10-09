// Catalyst's Claude Code add-ons: the mods and skills in claude-plugins/,
// installed into the user's Claude Code when Catalyst is first run and again
// whenever an update ships a different set.
//
// They go in as a real plugin marketplace named "catalyst", so they show up in
// /plugin like anything else the user installed, and can be disabled or
// uninstalled there. The marketplace is a copy under ~/.catalyst rather than the
// app's own resources folder: Claude Code remembers the path it was added from,
// and an install directory is not a path that stays put across updates.
//
// The whole thing goes through the `claude plugin` CLI. Nothing here edits
// Claude Code's settings files directly, so a format change on their side cannot
// leave them half-written.
//
// A plugin the user uninstalled is not put back by an update: the state file
// remembers what Catalyst installed, and anything that was installed before but
// is missing now was removed on purpose. Reinstall in Settings restores it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./paths');

const IS_WIN = process.platform === 'win32';
const MARKETPLACE = 'catalyst';
const SOURCE_DIR = path.join(__dirname, '..', 'claude-plugins');
const TARGET_DIR = path.join(DATA_DIR, 'claude-plugins');
const STATE_FILE = path.join(DATA_DIR, 'claude-plugins.json');
const CLI_TIMEOUT = 120000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// The plugins this build ships, from its marketplace manifest.
function bundledPlugins() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, '.claude-plugin', 'marketplace.json'), 'utf-8'));
    return (manifest.plugins || []).map((p) => ({ name: p.name, description: p.description || '' }));
  } catch {
    return [];
  }
}

// A hash of every shipped file, so a changed mod reinstalls even when the app
// version did not move (and an unchanged set is not reinstalled on every launch).
function hashDir(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        hash.update(path.relative(dir, full).replace(/\\/g, '/'));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

// Claude Code caches an installed plugin by its version, so new files under an
// unchanged version would never reach it. Each copied manifest's version gets
// the plugin's content hash appended (1.0.0 -> 1.0.0-c0ffee12): any change to a
// plugin is a new version to `claude plugin update`, and an untouched one keeps
// its version and is left alone.
function stampVersions(plugins) {
  for (const { name } of plugins) {
    const dir = path.join(TARGET_DIR, name);
    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const base = String(manifest.version || '0.0.0').replace(/-[0-9a-f]{8}$/, '');
      manifest.version = `${base}-${hashDir(dir).slice(0, 8)}`;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {}
  }
}

// Quote one argument for cmd.exe. Only used for the .cmd shim npm installs,
// which cannot be executed without a shell.
function cmdQuote(arg) {
  const s = String(arg);
  return /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Run `claude <args>` and resolve { code, stdout, stderr }. Never rejects.
function runClaude(args, env) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || (err && !stdout ? err.message : '')),
    });
    const opts = { env, timeout: CLI_TIMEOUT, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
    if (IS_WIN) {
      const line = ['claude', ...args].map(cmdQuote).join(' ');
      execFile('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true }, done);
    } else {
      execFile('claude', args, opts, done);
    }
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Some CLI builds print a notice before the JSON; take the last JSON value.
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    try { return JSON.parse(text.slice(start)); } catch { return null; }
  }
}

function installedIds(listed) {
  const rows = Array.isArray(listed) ? listed : (listed && (listed.plugins || listed.installed)) || [];
  const ids = new Set();
  for (const row of rows) {
    if (typeof row === 'string') ids.add(row);
    else if (row && (row.id || row.name)) ids.add(String(row.id || `${row.name}@${row.marketplace || ''}`));
  }
  return ids;
}

function marketplaceNames(listed) {
  const rows = Array.isArray(listed) ? listed : (listed && listed.marketplaces) || [];
  return new Set(rows.map((r) => (typeof r === 'string' ? r : r && r.name)).filter(Boolean));
}

let running = null;

// Install or update the bundled add-ons. `force` (the Settings page's Reinstall)
// runs even when nothing changed and restores add-ons the user removed. Concurrent calls share one run. Resolves the status object.
function ensureInstalled({ env, force = false, isClaudeInstalled } = {}) {
  if (running) return running;
  running = (async () => {
    const state = loadState();
    const plugins = bundledPlugins();
    if (!plugins.length || !fs.existsSync(SOURCE_DIR)) {
      return;
    }
    if (isClaudeInstalled && !(await isClaudeInstalled())) {
      saveState({ ...state, lastError: 'Claude Code is not installed yet', checkedAt: Date.now() });
      return;
    }

    const hash = hashDir(SOURCE_DIR);
    if (!force && state.hash === hash && !state.lastError) {
      return;
    }

    const log = [];
    const step = async (args) => {
      const r = await runClaude(args, env);
      log.push(`claude ${args.join(' ')} -> ${r.code}${r.code ? `: ${(r.stderr || r.stdout).trim().slice(0, 300)}` : ''}`);
      return r;
    };

    try {
      // Refresh the stable copy the marketplace points at.
      fs.rmSync(TARGET_DIR, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
      fs.cpSync(SOURCE_DIR, TARGET_DIR, { recursive: true });
      stampVersions(plugins);

      const marketList = parseJson((await step(['plugin', 'marketplace', 'list', '--json'])).stdout);
      if (marketList === null) throw new Error('could not read the marketplace list from claude');
      const markets = marketplaceNames(marketList);
      const added = markets.has(MARKETPLACE)
        ? await step(['plugin', 'marketplace', 'update', MARKETPLACE])
        : await step(['plugin', 'marketplace', 'add', TARGET_DIR]);
      if (added.code !== 0) throw new Error(`could not register the ${MARKETPLACE} marketplace`);

      // An unreadable list must stop the run: read as empty, it would look as
      // though the user had uninstalled every add-on.
      const pluginList = parseJson((await step(['plugin', 'list', '--json'])).stdout);
      if (pluginList === null) throw new Error('could not read the installed plugins from claude');
      const ids = installedIds(pluginList);
      const previously = new Set(state.installed || []);
      const installed = [];
      const failed = [];
      for (const { name } of plugins) {
        const id = `${name}@${MARKETPLACE}`;
        if (ids.has(id)) {
          const r = await step(['plugin', 'update', id]);
          (r.code === 0 ? installed : failed).push(name);
        } else if (previously.has(name) && !force) {
          // Installed by Catalyst before and gone now: the user removed it. Only
          // the Settings page's Reinstall (force) puts it back.
          continue;
        } else {
          const r = await step(['plugin', 'install', id, '--scope', 'user']);
          (r.code === 0 ? installed : failed).push(name);
        }
      }

      saveState({
        hash: failed.length ? null : hash,
        installed: [...new Set([...(state.installed || []), ...installed])],
        failed,
        lastError: failed.length ? `could not install ${failed.join(', ')}` : null,
        log,
        checkedAt: Date.now(),
      });
    } catch (err) {
      saveState({ ...state, hash: null, lastError: err.message, log, checkedAt: Date.now() });
    }
  })().finally(() => { running = null; }).then(status);
  return running;
}

// What the Settings page shows: each bundled add-on and whether it is in.
function status() {
  const state = loadState();
  const installed = new Set(state.installed || []);
  return {
    plugins: bundledPlugins().map((p) => ({ ...p, installed: installed.has(p.name) })),
    lastError: state.lastError || null,
    checkedAt: state.checkedAt || null,
    isRunning: Boolean(running),
    marketplaceDir: TARGET_DIR,
  };
}

module.exports = { ensureInstalled, status, SOURCE_DIR, TARGET_DIR, MARKETPLACE };
