// Catalyst's Claude Code mods: two plugin marketplaces shipped inside the app
// and registered with the user's Claude Code.
//
//   catalyst            claude-plugins/            Catalyst's own mods and skills.
//                                                   Installed on first launch and
//                                                   after every update that changes them.
//   catalyst-community  claude-plugins-community/  A pinned, reviewed copy of
//                                                   awesome-claude-code-mods. Nothing is
//                                                   installed until the user switches a
//                                                   mod on in Settings → Mods.
//
// They go in as real marketplaces, so they show up in /plugin like anything else
// the user installed. Each is a copy under ~/.catalyst rather than the app's own
// resources folder: Claude Code remembers the path a marketplace was added from,
// and an install directory is not a path that stays put across updates.
//
// Everything goes through the `claude plugin` CLI. Nothing here edits Claude
// Code's settings files directly, so a format change on their side cannot leave
// them half-written. CLI calls are serialized: two at once would race on those
// same files.
//
// Switching a mod off in Settings disables it rather than uninstalling it, so a
// mod that keeps the user's notes in its plugin store still has them when it is
// switched back on. A Catalyst mod the user uninstalled is not put back by an
// update: the state file remembers what Catalyst installed, and anything that was
// installed before but is missing now was removed on purpose. Reinstall in
// Settings (force) restores them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./paths');

const IS_WIN = process.platform === 'win32';
const APP_ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(DATA_DIR, 'claude-plugins.json');
const CLI_TIMEOUT = 120000;
// Installed mods load in the terminal from this Claude Code version on.
const MODS_MIN_VERSION = '2.1.287';

const MARKETPLACES = [
  {
    name: 'catalyst',
    title: 'Catalyst',
    description: 'Built for Catalyst and installed with it.',
    source: path.join(APP_ROOT, 'claude-plugins'),
    target: path.join(DATA_DIR, 'claude-plugins'),
    autoInstall: true,
  },
  {
    name: 'catalyst-community',
    title: 'Community',
    description: 'From awesome-claude-code-mods by Yash Thakker and contributors (MIT), pinned and reviewed. Switch on the ones you want.',
    source: path.join(APP_ROOT, 'claude-plugins-community'),
    target: path.join(DATA_DIR, 'claude-plugins-community'),
    autoInstall: false,
  },
];

function loadState() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  // 1.7.0 kept one hash and bare plugin names for the catalyst marketplace.
  if (state.hash !== undefined || (state.installed || []).some((n) => !String(n).includes('@'))) {
    state = {
      ...state,
      hashes: { ...(state.hashes || {}), ...(state.hash ? { catalyst: state.hash } : {}) },
      installed: (state.installed || []).map((n) => (String(n).includes('@') ? n : `${n}@catalyst`)),
    };
    delete state.hash;
  }
  state.hashes = state.hashes || {};
  state.installed = state.installed || [];
  return state;
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// The plugins a marketplace ships, with what Settings shows for each: the
// manifest's entry, and for the community set its catalog's title, category,
// what it can reach, and the surface it draws on.
function pluginsOf(market) {
  const manifest = readJson(path.join(market.source, '.claude-plugin', 'marketplace.json'));
  const catalog = new Map((readJson(path.join(market.source, 'catalog.json')) || []).map((c) => [c.id, c]));
  return ((manifest && manifest.plugins) || []).map((p) => {
    const c = catalog.get(p.name) || {};
    return {
      name: p.name,
      id: `${p.name}@${market.name}`,
      title: c.title || p.name,
      description: c.description || p.description || '',
      category: c.category || (market.name === 'catalyst' ? 'Catalyst' : 'Other'),
      access: c.access || '',
      surface: c.surface || null,
    };
  });
}

// A hash of every shipped file, so a changed mod reinstalls even when the app
// version did not move (and an unchanged set is not reinstalled on every launch).
// Tests are left out: they are not copied, so they must not count either.
const IS_TEST_PATH = /(^|[\\/])tests([\\/]|$)/;
function hashDir(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dir, full);
      if (IS_TEST_PATH.test(rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else {
        hash.update(rel.replace(/\\/g, '/'));
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
function stampVersions(market) {
  const manifestPath = path.join(market.target, '.claude-plugin', 'marketplace.json');
  const manifest = readJson(manifestPath);
  if (!manifest) return;
  for (const entry of manifest.plugins || []) {
    const dir = path.resolve(market.target, entry.source || entry.name);
    const pluginJson = path.join(dir, '.claude-plugin', 'plugin.json');
    try {
      const plugin = JSON.parse(fs.readFileSync(pluginJson, 'utf-8'));
      const base = String(plugin.version || entry.version || '0.0.0').replace(/-[0-9a-f]{8}$/, '');
      plugin.version = `${base}-${hashDir(dir).slice(0, 8)}`;
      fs.writeFileSync(pluginJson, JSON.stringify(plugin, null, 2));
      // A version in the marketplace entry would win over the plugin's own.
      if (entry.version) entry.version = plugin.version;
    } catch {}
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
    // Some CLI builds print a notice before the JSON; take what follows it.
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    try { return JSON.parse(text.slice(start)); } catch { return null; }
  }
}

function compareVersions(a, b) {
  const parts = (v) => String(v).split(/[.\-+ ]/).map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// One CLI conversation at a time.
let chain = Promise.resolve();
let busy = 0;
function enqueue(fn) {
  busy++;
  const run = chain.then(fn, fn).finally(() => { busy--; });
  chain = run.catch(() => {});
  return run;
}

// id -> { enabled } for every installed plugin, or null when the list could not
// be read. An unreadable list must stop whatever relies on it: read as empty, it
// would look as though the user had uninstalled every mod.
async function installedMap(env, log) {
  const r = await runClaude(['plugin', 'list', '--json'], env);
  if (log) log.push(`claude plugin list --json -> ${r.code}`);
  const rows = parseJson(r.stdout);
  if (!Array.isArray(rows)) return null;
  const map = new Map();
  for (const row of rows) {
    if (row && row.id) map.set(String(row.id), { enabled: row.enabled !== false });
  }
  return map;
}

async function marketplaceNames(env, log) {
  const r = await runClaude(['plugin', 'marketplace', 'list', '--json'], env);
  if (log) log.push(`claude plugin marketplace list --json -> ${r.code}`);
  const rows = parseJson(r.stdout);
  if (!Array.isArray(rows)) return null;
  return new Set(rows.map((row) => row && row.name).filter(Boolean));
}

// Copy, stamp and register one marketplace when its files changed (or when
// forced, or when Claude Code has lost it). Resolves the new hash when it
// refreshed, false when it was already current.
async function syncMarketplace(market, { env, force, state, markets, log }) {
  const hash = hashDir(market.source);
  const isRegistered = markets.has(market.name);
  if (!force && isRegistered && state.hashes[market.name] === hash) return false;

  fs.rmSync(market.target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(market.target), { recursive: true });
  fs.cpSync(market.source, market.target, {
    recursive: true,
    // Tests run under `claude plugin test` in the repository, not in a session.
    filter: (src) => !IS_TEST_PATH.test(path.relative(market.source, src)),
  });
  stampVersions(market);

  const args = isRegistered
    ? ['plugin', 'marketplace', 'update', market.name]
    : ['plugin', 'marketplace', 'add', market.target];
  const r = await runClaude(args, env);
  log.push(`claude ${args.join(' ')} -> ${r.code}${r.code ? `: ${(r.stderr || r.stdout).trim().slice(0, 300)}` : ''}`);
  if (r.code !== 0) throw new Error(`could not register the ${market.name} marketplace`);
  markets.add(market.name);
  return hash;
}

// Install or update the shipped mods. `force` (Settings → Mods → Reinstall)
// runs even when nothing changed and restores Catalyst mods the user removed.
function ensureInstalled({ env, force = false, isClaudeInstalled } = {}) {
  return enqueue(async () => {
    const state = loadState();
    if (isClaudeInstalled && !(await isClaudeInstalled())) {
      saveState({ ...state, lastError: 'Claude Code is not installed yet', checkedAt: Date.now() });
      return;
    }
    const log = [];
    const failed = [];
    try {
      const markets = await marketplaceNames(env, log);
      if (markets === null) throw new Error('could not read the marketplace list from claude');
      for (const market of MARKETPLACES) {
        if (!fs.existsSync(market.source)) continue;
        const refreshed = await syncMarketplace(market, { env, force, state, markets, log });
        if (refreshed === false) continue;

        const installed = await installedMap(env, log);
        if (installed === null) throw new Error('could not read the installed plugins from claude');
        const previously = new Set(state.installed);
        const marketFailed = [];
        for (const plugin of pluginsOf(market)) {
          if (installed.has(plugin.id)) {
            const r = await runClaude(['plugin', 'update', plugin.id], env);
            log.push(`claude plugin update ${plugin.id} -> ${r.code}`);
            if (r.code !== 0) marketFailed.push(plugin.id);
          } else if (market.autoInstall && (force || !previously.has(plugin.id))) {
            const r = await runClaude(['plugin', 'install', plugin.id, '--scope', 'user'], env);
            log.push(`claude plugin install ${plugin.id} -> ${r.code}`);
            if (r.code === 0) state.installed = [...new Set([...state.installed, plugin.id])];
            else marketFailed.push(plugin.id);
          }
        }
        // Left unset on a failure, so the next launch tries again.
        state.hashes[market.name] = marketFailed.length ? null : refreshed;
        failed.push(...marketFailed);
      }
      saveState({ ...state, lastError: failed.length ? `could not install ${failed.join(', ')}` : null, log, checkedAt: Date.now() });
    } catch (err) {
      saveState({ ...state, lastError: err.message, log, checkedAt: Date.now() });
    }
  });
}

// Switch one mod on (install it, or enable it if it is installed but disabled)
// or off (disable it). Resolves { ok, error? }.
function setPlugin({ env, id, enabled }) {
  return enqueue(async () => {
    const market = MARKETPLACES.find((m) => id.endsWith(`@${m.name}`));
    if (!market || !pluginsOf(market).some((p) => p.id === id)) {
      return { ok: false, error: `unknown mod ${id}` };
    }
    const state = loadState();
    const log = [];
    const markets = await marketplaceNames(env, log);
    if (markets === null) return { ok: false, error: 'could not read the marketplace list from claude' };
    try {
      const refreshed = await syncMarketplace(market, { env, force: false, state, markets, log });
      // A fresh copy of the catalyst set also needs its update pass, which the
      // next launch's ensureInstalled does; the community set has nothing else.
      if (refreshed !== false && !market.autoInstall) state.hashes[market.name] = refreshed;
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const installed = await installedMap(env, log);
    if (installed === null) return { ok: false, error: 'could not read the installed plugins from claude' };

    const current = installed.get(id);
    let args = null;
    if (enabled && !current) args = ['plugin', 'install', id, '--scope', 'user'];
    else if (enabled && !current.enabled) args = ['plugin', 'enable', id];
    else if (!enabled && current && current.enabled) args = ['plugin', 'disable', id];
    if (args) {
      const r = await runClaude(args, env);
      if (r.code !== 0) {
        saveState(state);
        const said = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop();
        return { ok: false, error: said || `claude ${args.join(' ')} failed` };
      }
      if (args[1] === 'install') state.installed = [...new Set([...state.installed, id])];
    }
    saveState(state);
    return { ok: true };
  });
}

let versionCache = null;
async function claudeVersion(env) {
  if (versionCache) return versionCache;
  const r = await runClaude(['--version'], env);
  const m = r.stdout.match(/\d+\.\d+\.\d+/);
  if (m) versionCache = m[0];
  return m ? m[0] : null;
}

// What Settings → Mods shows: every shipped mod, whether it is on, and whether
// this Claude Code can load mods at all.
async function listMods({ env } = {}) {
  const installed = await enqueue(() => installedMap(env));
  const version = await claudeVersion(env);
  const state = loadState();
  return {
    marketplaces: MARKETPLACES.filter((m) => fs.existsSync(m.source)).map((m) => ({
      name: m.name,
      title: m.title,
      description: m.description,
      plugins: pluginsOf(m).map((p) => {
        const row = installed && installed.get(p.id);
        return { ...p, installed: Boolean(row), enabled: Boolean(row && row.enabled) };
      }),
    })),
    isListed: installed !== null,
    claudeVersion: version,
    modsMinVersion: MODS_MIN_VERSION,
    canLoadMods: version ? compareVersions(version, MODS_MIN_VERSION) >= 0 : null,
    isBusy: busy > 0,
    lastError: state.lastError || null,
  };
}

module.exports = { ensureInstalled, setPlugin, listMods, MARKETPLACES };
