const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { exec, execSync, execFile } = require('child_process');
const crypto = require('crypto');
const nfd = require('native-file-dialog');
const sessionManager = require('./lib/session-manager');
const store = require('./lib/session-store');
const credStore = require('./lib/credential-store');
const worktreeManager = require('./lib/worktree-manager');
const repoStore = require('./lib/repo-store');
const paths = require('./lib/paths');
const conversationStore = require('./lib/conversation-store');
const cliTrust = require('./lib/cli-trust');

// Loose path comparison for grouping sessions by repo: case-insensitive and
// trailing-separator agnostic, which matters on Windows.
function samePathish(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  try { return norm(a) === norm(b); } catch { return false; }
}

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Failed-builds tracker — monitors session output for build failure patterns.
// Keyed by repoPath, each entry records the last failure snippet and timestamp.
const _buildFailures = new Map();
const BUILD_FAIL_RE = /(?:BUILD FAILED|build failed|FAILED|error (?:TS|CS|MSB)\d+|npm ERR!|Error: Process completed with exit code [^0]|FAILURE: Build failed|make\[?\d*\]?: \*\*\*|cargo build.*error|pytest.*FAILED|FAIL\s+(?:\.\/)?[^\s]+)/i;
const BUILD_FAIL_TTL = 3600000; // 1 hour

function trackBuildOutput(repoPath, repoName, data) {
  if (!repoPath || !data) return;
  const match = BUILD_FAIL_RE.exec(data);
  if (match) {
    _buildFailures.set(repoPath, {
      repoName,
      snippet: match[0].substring(0, 120),
      at: Date.now()
    });
  }
}

function getRecentBuildFailures() {
  const now = Date.now();
  const results = [];
  for (const [rp, entry] of _buildFailures) {
    if (now - entry.at < BUILD_FAIL_TTL) {
      results.push({ path: rp, ...entry });
    } else {
      _buildFailures.delete(rp);
    }
  }
  return results;
}

function isPathWithin(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild.startsWith(resolvedParent + path.sep) || resolvedChild === resolvedParent;
}

// The PAT header must only ever reach real Azure DevOps hosts, over https. A
// substring test on the remote URL also matched dev.azure.com.attacker.tld and
// attacker.tld/dev.azure.com/repo.git.
function isAzureHttpsRemote(remoteUrl) {
  try {
    const raw = String(remoteUrl || '').trim();
    // The URL parser silently strips tabs/newlines, but the raw string is what
    // becomes the http.<url>.extraheader config key — keep the two identical.
    if (/\s/.test(raw)) return false;
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'dev.azure.com' || h === 'visualstudio.com' || h.endsWith('.visualstudio.com');
  } catch {
    return false;
  }
}

function refreshChangedFiles(session, sessionId, ws) {
  exec('git status --porcelain', { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
    const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', '??': 'untracked', 'R': 'renamed', 'C': 'copied', 'U': 'conflict' };
    const files = (stdout || '').split('\n').filter(l => l.trim()).map(line => {
      const ix = line[0]; const wt = line[1]; const filePath = line.substring(3);
      const raw = line.substring(0, 2).trim();
      const staged = ix !== ' ' && ix !== '?' && wt === ' ';
      return { status: statusMap[raw] || 'modified', statusCode: raw, file: filePath, staged };
    });
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'git-changed-files', sessionId, files }));
  });
}

// For values interpolated into HTML the client renders (e.g. smartpill tips).
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const app = express();
const server = http.createServer(app);

// Per-launch WebSocket auth token. The socket can spawn shells and run commands,
// so a loopback bind alone is not enough: the token (injected into the served
// page) is required on every connection, which closes the old "no Origin header
// → allow" bypass that let any local process take full control. Browser origins
// are additionally pinned to loopback (blocks CSRF/DNS-rebinding).
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

function tokenMatches(token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }) => {
    let token = '';
    try { token = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch {}
    if (!tokenMatches(token)) return false;
    if (!origin) return true;
    try {
      const { hostname } = new URL(origin);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
      return false;
    }
  }
});

// Pin the Host header to loopback names — a DNS-rebound hostname must not be
// able to fetch the page (and with it the WS token).
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    res.status(403).end();
    return;
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
    "img-src 'self' data: blob:",
    // ipc.localhost / tauri.localhost: the Tauri desktop shell's IPC transport.
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://ipc.localhost https://tauri.localhost https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// The shipped version, for the places the UI displays it. Read once here rather
// than hardcoded in the markup, where it silently went stale every release.
const APP_VERSION = (() => {
  try {
    return require('./package.json').version || '';
  } catch {
    return '';
  }
})();

// Serve index.html with the per-launch WS token injected (must come before
// express.static so '/' doesn't fall through to the raw file).
app.get(['/', '/index.html'], (req, res) => {
  fs.promises.readFile(path.join(__dirname, 'public', 'index.html'), 'utf-8').then(html => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html.replace(/<head>/i,
      `<head>\n  <meta name="ws-token" content="${AUTH_TOKEN}">` +
      `\n  <meta name="app-version" content="${APP_VERSION}">`));
  }).catch(() => res.status(500).end());
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/xterm-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));
app.use('/xterm-webgl', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-webgl')));
app.use('/xterm-web-links', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-web-links')));
app.use('/design', express.static(path.join(__dirname, 'design')));

const clients = new Set();
const clientCmdPtys = new WeakMap(); // ws -> Map(cmdId -> cmdPty)
const innerSessions = new Map(); // innerSessionId -> { pty, parentSessionId }
const pty = require('node-pty');
const os = require('os');
const net = require('net');

const CATALYST_IMG_DIR = path.join(os.tmpdir(), 'catalyst-images');
setInterval(() => {
  fs.promises.readdir(CATALYST_IMG_DIR).then(files => {
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(CATALYST_IMG_DIR, f);
      fs.promises.stat(fp).then(stat => {
        if (now - stat.mtimeMs > 3600000) fs.promises.unlink(fp).catch(() => {});
      }).catch(() => {});
    }
  }).catch(() => {}); // dir doesn't exist — fine
}, 600000);

const KNOWN_CLIS = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', icon: 'claude', install: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', icon: 'gemini', install: 'npm install -g @google/gemini-cli' },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', icon: 'codex', install: 'npm install -g @openai/codex' },
  { id: 'copilot', name: 'GitHub Copilot', cmd: 'gh copilot', icon: 'copilot', install: 'gh extension install github/gh-copilot' },
  { id: 'terminal', name: 'Terminal', cmd: IS_WIN ? 'powershell.exe' : 'bash', icon: 'terminal', install: '' },
];

// winget installers are Windows-only. On macOS swap to Homebrew; on Linux leave
// the winget string (it fails gracefully). npm-based installers are
// cross-platform and pass through unchanged. Computed at use-time so a single
// definition serves every platform.
function installCommandFor(cliDef) {
  if (!cliDef || !cliDef.install) return '';
  const install = cliDef.install;
  if (IS_MAC && install.startsWith('winget ')) {
    const brewMap = {
      gh: 'brew install gh',
      azcli: 'brew install azure-cli',
    };
    return brewMap[cliDef.id] || install;
  }
  return install;
}

// Integration tools — installable from Settings → Integrations but NOT exposed as AI CLI sessions.
const INTEGRATION_TOOLS = [
  {
    id: 'azcli',
    name: 'Azure CLI + DevOps extension',
    cmd: 'az',
    install: 'winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements',
    postInstall: 'az extension add --name azure-devops --upgrade --only-show-errors'
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    cmd: 'gh',
    install: 'winget install -e --id GitHub.cli --accept-source-agreements --accept-package-agreements'
  },
];

function findInstallTarget(id) {
  return KNOWN_CLIS.find(c => c.id === id) || INTEGRATION_TOOLS.find(c => c.id === id);
}

// All async — the sync versions ran on the event loop inside install retry
// intervals and froze every live terminal. npm prefix is cached separately so
// a PATH refresh doesn't re-pay the ~1s npm cold start.
let _cachedNpmPrefix = null;
async function getNpmPrefix() {
  if (_cachedNpmPrefix !== null) return _cachedNpmPrefix;
  _cachedNpmPrefix = await execAsync('npm prefix -g', { encoding: 'utf-8', windowsHide: true });
  return _cachedNpmPrefix;
}

let _cachedVerifyPath = null;
async function buildVerifyPath() {
  if (_cachedVerifyPath) return _cachedVerifyPath;
  const npmGlobalBin = await getNpmPrefix();
  let extras;
  if (IS_WIN) {
    const wingetShim = process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps` : '';
    const localBin = process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.local\\bin` : '';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    extras = [
      npmGlobalBin, wingetShim, localBin,
      `${pf}\\GitHub CLI`,
      `${pfx86}\\GitHub CLI`,
      `${pf}\\GitHub CLI\\bin`,
    ];
  } else {
    const npmPosixBin = npmGlobalBin ? path.join(npmGlobalBin, 'bin') : '';
    const home = process.env.HOME || '';
    extras = [
      npmPosixBin,
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      home ? path.join(home, '.local', 'bin') : '',
    ];
  }
  const extrasStr = extras.filter(Boolean).join(path.delimiter);
  _cachedVerifyPath = extrasStr ? `${process.env.PATH || ''}${path.delimiter}${extrasStr}` : (process.env.PATH || '');
  return _cachedVerifyPath;
}
async function refreshVerifyPath() {
  _cachedVerifyPath = null;
  if (IS_WIN) {
    const [sysPath, userPath] = await Promise.all([
      execAsync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path', { encoding: 'utf-8', windowsHide: true }),
      execAsync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf-8', windowsHide: true }),
    ]);
    const extract = (s) => { const m = s.match(/REG_(?:EXPAND_)?SZ\s+(.*)/); return m ? m[1].trim() : ''; };
    const freshPath = [extract(sysPath), extract(userPath)].filter(Boolean).join(';');
    if (freshPath) process.env.PATH = freshPath;
  }
  // POSIX: no registry — just rebuild from the current process.env.PATH.
  return buildVerifyPath();
}

// Cross-platform "is this command on PATH?" — Windows uses `where`, POSIX uses
// `command -v` via /bin/sh. Delegates to the session-manager helper.
async function verifyCommand(cmd) {
  const checkCmd = cmd.includes(' ') ? cmd.split(' ')[0] : cmd;
  const verifyPath = await buildVerifyPath();
  return sessionManager.commandExists(checkCmd, verifyPath);
}

async function verifyProviderAuth(provider, ws) {
  if (!provider || provider === 'none') return;
  if (provider === 'azure') {
    const pat = credStore.loadPAT();
    const settings = store.getSettings();
    if (!pat || !settings.azureOrg) {
      ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: 'PAT or org missing' }));
      return;
    }
    const url = `https://dev.azure.com/${encodeURIComponent(settings.azureOrg)}/_apis/connectionData?api-version=7.1`;
    const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    try {
      const res = await fetch(url, { headers: { 'Authorization': auth } });
      if (!res.ok) {
        ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: `Azure DevOps rejected the PAT (HTTP ${res.status}). Check that the token has not expired and includes Code (read/write) + Work Items scopes.` }));
        return;
      }
      const text = await res.text();
      // connectionData returns HTML when org URL is wrong; valid JSON when reachable.
      let identity = '';
      try {
        const data = JSON.parse(text);
        identity = data && data.authenticatedUser && (data.authenticatedUser.providerDisplayName || data.authenticatedUser.subjectDescriptor) || '';
      } catch {
        ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: 'Azure DevOps returned an unexpected response — double-check the org URL.' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'pat-verified', provider, success: true, identity, message: identity ? `Signed in as ${identity}` : 'Verified' }));
      // Configure az devops defaults so commands run without --organization each time.
      configureAzDevopsDefaults(settings, pat).catch(() => {});
    } catch (err) {
      ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: 'Azure DevOps unreachable: ' + err.message }));
    }
    return;
  }
  if (provider === 'github') {
    const pat = credStore.loadGithubPAT();
    if (!pat) {
      ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: 'GitHub PAT missing' }));
      return;
    }
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': 'token ' + pat,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Catalyst'
        }
      });
      if (!res.ok) {
        ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: `GitHub rejected the PAT (HTTP ${res.status}). Check expiry and the repo scope.` }));
        return;
      }
      const data = await res.json();
      const identity = data.login || '';
      ws.send(JSON.stringify({ type: 'pat-verified', provider, success: true, identity, message: identity ? `Signed in as @${identity}` : 'Verified' }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'pat-verified', provider, success: false, message: 'GitHub unreachable: ' + err.message }));
    }
    return;
  }
}

function configureAzDevopsDefaults(settings, pat) {
  // These values come from user-editable settings and end up in a shell command —
  // restrict them to characters that can't break out of the quoting.
  const org = String(settings.azureOrg || '');
  const project = String(settings.azureProject || '');
  if (!/^[A-Za-z0-9._-]+$/.test(org)) return Promise.resolve();
  if (project && !/^[A-Za-z0-9 ._-]+$/.test(project)) return Promise.resolve();
  const orgUrl = `https://dev.azure.com/${org}`;
  const args = project
    ? `--defaults organization="${orgUrl}" project="${project}"`
    : `--defaults organization="${orgUrl}"`;
  const cmd = `az devops configure ${args} --only-show-errors`;
  return buildVerifyPath().then(verifyPath => new Promise((resolve) => {
    // Check if az is available before configuring (async)
    sessionManager.commandExists('az', verifyPath).then(found => {
      if (!found) { resolve(); return; } // az not installed — skip silently
      exec(cmd, { env: { ...process.env, PATH: verifyPath, AZURE_DEVOPS_EXT_PAT: pat }, windowsHide: true }, () => resolve());
    });
  }));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function execAsync(cmd, opts) {
  return new Promise((resolve) => {
    exec(cmd, opts, (err, stdout) => {
      if (err) resolve('');
      else resolve((stdout || '').trim());
    });
  });
}

// Run git with an argv array (no shell) and resolve stdout ('' on error). Safe
// for format strings containing % which cmd.exe would otherwise expand.
function gitOut(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout || ''));
    });
  });
}

// List branches with remote-tracking state. `gone: true` means the branch had
// an upstream that has since been deleted on the remote (detected via
// %(upstream:track) → "[gone]"). Purely-local branches have hasUpstream:false.
function listBranches(repoPath) {
  return Promise.all([
    gitOut(repoPath, ['for-each-ref', '--format=%(HEAD)\t%(refname:short)\t%(upstream:track)', 'refs/heads']),
    gitOut(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']),
  ]).then(([localOut, remoteOut]) => {
    const branches = [];
    const seen = new Set();
    localOut.split('\n').filter(l => l.trim()).forEach(line => {
      const parts = line.split('\t');
      const head = parts[0];
      const name = (parts[1] || '').trim();
      const track = (parts[2] || '').trim();
      if (!name || name.includes('HEAD')) return;
      seen.add(name);
      branches.push({
        name,
        current: head === '*',
        remote: false,
        gone: track.includes('[gone]'),
        hasUpstream: track.length > 0,
      });
    });
    remoteOut.split('\n').filter(l => l.trim()).forEach(r => {
      const name = r.replace(/^origin\//, '').trim();
      if (!name || name.includes('HEAD') || seen.has(name)) return;
      seen.add(name);
      branches.push({ name, current: false, remote: true, gone: false, hasUpstream: true });
    });
    return branches;
  });
}

// ── Dynamic model lists for the Manage panel ────────────────────────────────
// Each CLI's models come from that provider's models API when an API key is
// present in the environment; otherwise we fall back to a current curated list.
// Results are cached for an hour. Values are what we send to the CLI's /model.
const MODEL_CACHE_TTL = 60 * 60 * 1000;
const _modelCache = new Map(); // cli -> { at, models, source }

const FALLBACK_MODELS = {
  claude: [
    { value: 'opus', label: 'Opus · most capable' },
    { value: 'sonnet', label: 'Sonnet · balanced' },
    { value: 'haiku', label: 'Haiku · fastest' },
  ],
  codex: [{ value: '', label: 'Default (CLI default)' }],
  gemini: [{ value: '', label: 'Default (CLI default)' }],
};

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 6000);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Anthropic Models API: GET /v1/models (x-api-key + anthropic-version headers).
async function fetchClaudeModels() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.data || []).map(m => ({ value: m.id, label: m.display_name || m.id }));
    return models.length ? models : null;
  } catch { return null; }
}

async function fetchOpenAIModels() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.data || [])
      .map(m => m.id)
      .filter(id => /^(gpt-|o\d|chatgpt|codex)/i.test(id))
      .sort()
      .map(id => ({ value: id, label: id }));
    return models.length ? models : null;
  } catch { return null; }
}

async function fetchGeminiModels() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key));
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => {
        const id = (m.name || '').replace(/^models\//, '');
        return { value: id, label: m.displayName || id };
      })
      .filter(m => m.value);
    return models.length ? models : null;
  } catch { return null; }
}

async function listModels(cli) {
  const cached = _modelCache.get(cli);
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL) return cached;
  let live = null;
  if (cli === 'claude') live = await fetchClaudeModels();
  else if (cli === 'codex') live = await fetchOpenAIModels();
  else if (cli === 'gemini') live = await fetchGeminiModels();
  const result = live
    ? { models: live, source: 'live' }
    : { models: FALLBACK_MODELS[cli] || FALLBACK_MODELS.claude, source: 'fallback' };
  result.at = Date.now();
  _modelCache.set(cli, result);
  return result;
}

async function scanRepoInfo(rp) {
  const info = { technologies: [], devEnvironments: [] };
  try {
    // Read the root directory once — reuse for all file-existence checks.
    // All reads are async: a cold-cache scan must not stall the event loop.
    let rootEntries;
    try { rootEntries = await fs.promises.readdir(rp, { withFileTypes: true }); } catch { rootEntries = []; }
    const rootNames = new Set(rootEntries.map(e => e.name));
    const rootDirs = rootEntries.filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules');

    // One async read per first-level subdir, reused by the csproj/Docker/IaC checks below.
    const subListings = await Promise.all(rootDirs.map(async d => {
      try { return { name: d.name, files: await fs.promises.readdir(path.join(rp, d.name)) }; }
      catch { return { name: d.name, files: [] }; }
    }));

    const pkgPath = path.join(rp, 'package.json');
    if (rootNames.has('package.json')) {
      try {
        const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
        info.technologies.push('Node.js');
        if (pkg.dependencies) {
          if (pkg.dependencies.react) info.technologies.push('React');
          if (pkg.dependencies.next) info.technologies.push('Next.js');
          if (pkg.dependencies.express) info.technologies.push('Express');
          if (pkg.dependencies.vue) info.technologies.push('Vue');
          if (pkg.dependencies.angular || pkg.dependencies['@angular/core']) info.technologies.push('Angular');
        }
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.typescript) info.technologies.push('TypeScript');
      } catch {}
    }

    const rootFileNames = rootEntries.filter(e => !e.isDirectory()).map(e => e.name);
    let csprojFiles = rootFileNames.filter(f => f.endsWith('.csproj') || f.endsWith('.sln'));
    if (csprojFiles.length === 0) {
      for (const sub of subListings) {
        const found = sub.files.filter(f => f.endsWith('.csproj') || f.endsWith('.sln'));
        if (found.length > 0) { csprojFiles = found; break; }
      }
    }
    if (csprojFiles.length > 0) { info.technologies.push('.NET / C#'); info.devEnvironments.push('Visual Studio'); }
    if (rootNames.has('requirements.txt') || rootNames.has('setup.py') || rootNames.has('pyproject.toml')) info.technologies.push('Python');
    if (rootNames.has('go.mod')) info.technologies.push('Go');
    if (rootNames.has('Cargo.toml')) info.technologies.push('Rust');
    if (rootNames.has('pom.xml') || rootNames.has('build.gradle')) { info.technologies.push('Java'); info.devEnvironments.push('IntelliJ IDEA'); }
    // Docker: check root and one level deep
    let hasDocker = rootNames.has('Dockerfile') || rootNames.has('docker-compose.yml') || rootNames.has('docker-compose.yaml');
    if (!hasDocker) hasDocker = subListings.some(sub => sub.files.includes('Dockerfile'));
    if (hasDocker) info.devEnvironments.push('Docker');

    // IaC: Terraform, Bicep, CloudFormation, Pulumi
    if (rootFileNames.some(f => f.endsWith('.tf'))) info.technologies.push('Terraform');
    if (rootFileNames.some(f => f.endsWith('.bicep'))) info.technologies.push('Azure Bicep');
    if (rootNames.has('serverless.yml') || rootNames.has('template.yaml') || rootNames.has('template.json')) info.technologies.push('CloudFormation');
    if (rootNames.has('Pulumi.yaml')) info.technologies.push('Pulumi');

    // Check subdirs for IaC files too
    for (const sub of subListings) {
      if (!info.technologies.includes('Terraform') && sub.files.some(f => f.endsWith('.tf'))) info.technologies.push('Terraform');
      if (!info.technologies.includes('Azure Bicep') && sub.files.some(f => f.endsWith('.bicep'))) info.technologies.push('Azure Bicep');
    }

    if (rootNames.has('.github')) info.devEnvironments.push('GitHub Actions');
    if (rootFileNames.some(f => f.startsWith('azure-pipelines') || f === 'pipeline.yaml' || f === 'pipeline.yml')) info.devEnvironments.push('Azure Pipelines');
    if (rootNames.has('.azuredevops')) info.devEnvironments.push('Azure DevOps');
    if (rootNames.has('.vscode')) info.devEnvironments.push('VS Code');

    // Detect test infrastructure
    if (rootNames.has('package.json')) {
      try {
        const pkg = JSON.parse(await fs.promises.readFile(path.join(rp, 'package.json'), 'utf-8'));
        if (pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          info.hasTests = true;
          info.testCmd = 'npm test';
        }
      } catch {}
    }
    if (!info.hasTests && (rootNames.has('pytest.ini') || rootNames.has('conftest.py') || rootNames.has('tox.ini'))) {
      info.hasTests = true;
      info.testCmd = 'pytest';
    }
    if (!info.hasTests) {
      const testDirs = ['test', 'tests', '__tests__', 'spec', 'specs'];
      if (testDirs.some(d => rootNames.has(d))) {
        info.hasTests = true;
      }
    }

    // Git info — run all commands concurrently instead of sequentially
    const gitOpts = { cwd: rp, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] };
    const gitTimedOpts = { ...gitOpts, timeout: 3000 };
    const [branch, lastCommit, status, behind, branchList, ahead, lastTestTouch, lastSrcTouch] = await Promise.all([
      execAsync('git branch --show-current', gitOpts),
      execAsync('git log -1 --format=%cr', gitOpts),
      execAsync('git status --porcelain', gitOpts),
      execAsync('git rev-list --count HEAD..@{u}', gitTimedOpts),
      execAsync('git branch --list', gitOpts),
      execAsync('git rev-list --count @{u}..HEAD', gitTimedOpts),
      // Last commit touching test files vs source files (for stale-test detection)
      execAsync('git log -1 --format=%ct -- "test*/" "tests/" "__tests__/" "spec*/" "*.test.*" "*.spec.*"', gitTimedOpts).catch(() => ''),
      execAsync('git log -1 --format=%ct -- "src/" "lib/" "app/" "*.js" "*.ts" "*.py" "*.cs" "*.go" "*.rs" ":!*.test.*" ":!*.spec.*"', gitTimedOpts).catch(() => ''),
    ]);
    info.branch = branch || 'main';
    info.lastCommit = lastCommit;
    info.changes = status ? status.split('\n').length : 0;
    info.behind = parseInt(behind) || 0;
    info.branches = branchList ? branchList.split('\n').length : 1;
    info.ahead = parseInt(ahead) || 0;
    info.lastTestCommitTs = parseInt(lastTestTouch) || 0;
    info.lastSrcCommitTs = parseInt(lastSrcTouch) || 0;
  } catch {}
  return info;
}

async function listRepos(rootDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirNames = entries.filter(e => e.isDirectory()).map(e => e.name);
  const repoNames = (await Promise.all(dirNames.map(async name => {
    try {
      await fs.promises.access(path.join(rootDir, name, '.git'));
      return name;
    } catch { return null; }
  }))).filter(Boolean);

  const results = await Promise.all(repoNames.map(async (name) => {
    const repoPath = path.join(rootDir, name);
    const cached = repoStore.load(repoPath);
    // The remote name virtually never changes — resolve it once and cache it
    // instead of spawning `git remote get-url` per repo on every welcome screen.
    let gitName;
    if (cached && typeof cached.gitName === 'string') {
      gitName = cached.gitName;
    } else {
      gitName = '';
      try {
        const url = await execAsync('git remote get-url origin', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
        const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
        if (match) gitName = match[1];
      } catch {}
    }
    let repoInfo;
    if (cached && cached.repoInfo) {
      repoInfo = cached.repoInfo;
      if (typeof cached.gitName !== 'string') {
        cached.gitName = gitName;
        repoStore.save(repoPath, cached);
      }
    } else {
      repoInfo = await scanRepoInfo(repoPath);
      const toSave = cached || {};
      toSave.repoInfo = repoInfo;
      toSave.scannedAt = Date.now();
      toSave.gitName = gitName;
      repoStore.save(repoPath, toSave);
    }
    return { name, path: repoPath, gitName: gitName && gitName !== name ? gitName : '', repoInfo };
  }));
  return results;
}

// A repo path coming over the socket is only trusted if it sits under the
// configured projects root, or (first-run, before a root exists) is itself a
// git repo root. Stops a compromised page from opening a "session" rooted at
// C:\ and using the file APIs to read/write anywhere on disk.
function isAllowedRepoPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (/^\\\\|^\/\//.test(p)) return false; // UNC/remote
  try {
    const rootDir = store.load().rootDir;
    if (rootDir && isPathWithin(p, rootDir)) return true;
    return fs.existsSync(path.join(p, '.git'));
  } catch {
    return false;
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  clientCmdPtys.set(ws, new Map());
  sessionManager.setClientConnected(true);

  const existing = sessionManager.getAllSessions();
  ws.send(JSON.stringify({ type: 'session-list', sessions: existing }));

  // Send reconnect buffers for any sessions that accumulated output while disconnected
  existing.forEach(s => {
    const buf = sessionManager.getReconnectBuffer(s.id);
    if (buf) {
      ws.send(JSON.stringify({ type: 'reconnect-buffer', sessionId: s.id, data: buf }));
    }
  });
  sessionManager.clearReconnectBuffers();

  const storeData = store.load();
  if (storeData.rootDir) {
    ws.send(JSON.stringify({ type: 'root-dir', rootDir: storeData.rootDir }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'list-repos': {
        listRepos(msg.rootDir).then(repos => {
        if (repos.length > 0 && msg.rootDir) {
          store.setRootDir(msg.rootDir);
        }

        // Only repos with no cached scan at all — a cached scan with zero detected
        // technologies is a valid result, not a reason to rescan on every launch.
        const uncachedRepos = repos.filter(r => !r.repoInfo || !r.repoInfo.technologies);
        ws.send(JSON.stringify({ type: 'repos', repos, rootDir: msg.rootDir }));

        // Generate SmartPill tips
        const tips = [];
        const behindRepos = repos.filter(r => r.repoInfo && r.repoInfo.behind > 0);
        if (behindRepos.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${behindRepos.length}</strong> repos have updates upstream — <strong>pull all?</strong>`,
            btn: '↻ PULL ALL',
            command: 'pull-behind',
            repos: behindRepos.map(r => ({ name: r.name, path: r.path }))
          });
          behindRepos.forEach(r => {
            tips.push({
              header: 'CATALYST',
              msg: `<strong>${escapeHtml(r.name)}</strong> is ${Number(r.repoInfo.behind) || 0} commits behind — pull latest?`,
              btn: '↻ PULL',
              command: 'pull-repo',
              repoPath: r.path,
              repoName: r.name
            });
          });
        }
        const changedRepos = repos.filter(r => r.repoInfo && r.repoInfo.changes > 0);
        if (changedRepos.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${changedRepos.length}</strong> repos with uncommitted changes`,
            btn: 'VIEW',
            command: 'info-only'
          });
        }
        const staleRepos = repos.filter(r => {
          if (!r.repoInfo || !r.repoInfo.lastCommit) return false;
          return r.repoInfo.lastCommit.includes('month') || r.repoInfo.lastCommit.includes('year');
        });
        if (staleRepos.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${staleRepos.length}</strong> repos haven't been touched in over a month`,
            btn: 'OK',
            command: 'info-only'
          });
        }
        // Unpushed commits
        const unpushedRepos = repos.filter(r => r.repoInfo && r.repoInfo.ahead > 0);
        if (unpushedRepos.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${unpushedRepos.length}</strong> repos have unpushed commits`,
            btn: '⬆ PUSH ALL',
            command: 'push-unpushed',
            repos: unpushedRepos.map(r => ({ name: r.name, path: r.path }))
          });
          unpushedRepos.forEach(r => {
            tips.push({
              header: 'CATALYST',
              msg: `<strong>${escapeHtml(r.name)}</strong> is ${Number(r.repoInfo.ahead) || 0} commits ahead — push to origin?`,
              btn: '⬆ PUSH',
              command: 'push-repo',
              repoPath: r.path,
              repoName: r.name
            });
          });
        }

        // Stale tests — source was edited more recently than tests
        const staleTestRepos = repos.filter(r => {
          if (!r.repoInfo || !r.repoInfo.hasTests) return false;
          if (!r.repoInfo.lastSrcCommitTs || !r.repoInfo.lastTestCommitTs) return false;
          return r.repoInfo.lastSrcCommitTs > r.repoInfo.lastTestCommitTs;
        });
        if (staleTestRepos.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${staleTestRepos.length}</strong> repos have source changes newer than test changes — run tests?`,
            btn: 'OK',
            command: 'info-only'
          });
          staleTestRepos.forEach(r => {
            tips.push({
              header: 'CATALYST',
              msg: `Tests in <strong>${escapeHtml(r.name)}</strong> may be stale — source edited after last test change`,
              btn: 'OK',
              command: 'info-only'
            });
          });
        }

        // PR readiness — on a feature branch, ahead of origin, clean working tree
        const prReadyRepos = repos.filter(r => {
          if (!r.repoInfo) return false;
          const br = r.repoInfo.branch;
          if (!br || br === 'main' || br === 'master') return false;
          return r.repoInfo.ahead > 0 && r.repoInfo.changes === 0;
        });
        if (prReadyRepos.length > 0) {
          prReadyRepos.forEach(r => {
            tips.push({
              header: 'CATALYST',
              msg: `<strong>${escapeHtml(r.name)}</strong> on <code>${escapeHtml(r.repoInfo.branch)}</code> — ${r.repoInfo.ahead} pushed commits, clean tree. PR time?`,
              btn: 'OK',
              command: 'info-only'
            });
          });
        }

        // Feature branches (basic awareness — kept for repos that don't meet PR-ready criteria)
        const detachedRepos = repos.filter(r => r.repoInfo && r.repoInfo.branch && r.repoInfo.branch !== 'main' && r.repoInfo.branch !== 'master');
        const nonPrReady = detachedRepos.filter(r => !prReadyRepos.some(pr => pr.path === r.path));
        if (nonPrReady.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${nonPrReady.length}</strong> repos on feature branches`,
            btn: 'OK',
            command: 'info-only'
          });
        }
        // Failed builds — surface recent build failures tracked across sessions
        const failures = getRecentBuildFailures();
        if (failures.length > 0) {
          tips.push({
            header: 'CATALYST',
            msg: `<strong>${failures.length}</strong> repos had build failures recently`,
            btn: 'OK',
            command: 'info-only'
          });
          failures.forEach(f => {
            tips.push({
              header: 'CATALYST',
              msg: `Build failed in <strong>${escapeHtml(f.repoName)}</strong> — <code>${escapeHtml(f.snippet)}</code>`,
              btn: 'OK',
              command: 'info-only'
            });
          });
        }

        if (tips.length > 0) {
          ws.send(JSON.stringify({ type: 'smartpill-tips', tips }));
        }

        // Send scan status for each cached repo
        const cachedRepos = repos.filter(r => r.repoInfo);
        for (const r of cachedRepos) {
          const techs = (r.repoInfo.technologies || []).join(', ') || 'no tech detected';
          ws.send(JSON.stringify({ type: 'scan-status', status: 'scanned', repo: r.name, message: `${r.name}: ${techs}` }));
        }
        if (cachedRepos.length > 0) {
          ws.send(JSON.stringify({ type: 'scan-status', status: 'cached', count: cachedRepos.length, total: repos.length, message: `${cachedRepos.length}/${repos.length} repos loaded from cache` }));
        }

        // Background scan only repos without cached info
        console.log(`[bg-scan] ${uncachedRepos.length} repos need scanning, ${cachedRepos.length} already cached`);
        if (uncachedRepos.length > 0) {
          ws.send(JSON.stringify({ type: 'scan-status', status: 'scanning', count: 0, total: uncachedRepos.length, message: `Scanning ${uncachedRepos.length} repos...` }));
          (async () => {
            let done = 0;
            for (const r of uncachedRepos) {
              try {
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'scan-status', status: 'scanning', repo: r.name, count: done, total: uncachedRepos.length, message: `Scanning ${r.name}...` }));
                }
                const info = await scanRepoInfo(r.path);
                const existing = repoStore.load(r.path) || {};
                existing.repoInfo = info;
                existing.scannedAt = Date.now();
                repoStore.save(r.path, existing);
                done++;
                const techStr = info.technologies.join(', ') || 'no tech detected';
                console.log(`[bg-scan] ${done}/${uncachedRepos.length} ${r.name} — ${techStr}`);
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'repo-info', repoPath: r.path, info }));
                  ws.send(JSON.stringify({ type: 'scan-status', status: 'scanned', repo: r.name, techs: techStr, count: done, total: uncachedRepos.length, message: `${r.name}: ${techStr}` }));
                }
              } catch (e) { console.error(`[bg-scan] Error scanning ${r.name}:`, e.message); done++; }
            }
            console.log('[bg-scan] Complete');
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'scan-status', status: 'complete', count: done, total: uncachedRepos.length, message: `Scan complete — ${done} repos scanned` }));
              ws.send(JSON.stringify({ type: 'repo-scan-complete' }));
            }
          })();
        } else {
          ws.send(JSON.stringify({ type: 'scan-status', status: 'complete', count: 0, total: 0, message: 'All repos already cached' }));
        }
        }).catch(err => console.error('[list-repos] Error:', err));
        break;
      }

      case 'smartpill-command': {
        if (msg.command === 'pull-repo' && isAllowedRepoPath(msg.repoPath)) {
          exec('git pull', { cwd: msg.repoPath, encoding: 'utf-8' }, (err, stdout) => {
            const result = err ? `Pull failed: ${err.message}` : `Pulled: ${(stdout || '').trim().split('\n')[0]}`;
            console.log(`[smartpill] ${msg.repoName}: ${result}`);
            ws.send(JSON.stringify({ type: 'smartpill-result', repoName: msg.repoName, result, success: !err }));
          });
        } else if (msg.command === 'pull-behind' && Array.isArray(msg.repos)) {
          let done = 0;
          msg.repos = msg.repos.filter(r => r && isAllowedRepoPath(r.path));
          for (const r of msg.repos) {
            exec('git pull', { cwd: r.path, encoding: 'utf-8' }, (err, stdout) => {
              done++;
              const result = err ? 'failed' : 'pulled';
              console.log(`[smartpill] ${r.name}: ${result}`);
              if (done === msg.repos.length && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'smartpill-result', result: `Pulled ${done} repos`, success: true }));
              }
            });
          }
        } else if (msg.command === 'push-repo' && isAllowedRepoPath(msg.repoPath)) {
          exec('git push', { cwd: msg.repoPath, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const output = (stdout || stderr || '').trim().split('\n')[0];
            const result = err ? `Push failed: ${err.message}` : `Pushed: ${output || 'up to date'}`;
            console.log(`[smartpill] ${msg.repoName}: ${result}`);
            ws.send(JSON.stringify({ type: 'smartpill-result', repoName: msg.repoName, result, success: !err }));
          });
        } else if (msg.command === 'push-unpushed' && Array.isArray(msg.repos)) {
          let done = 0;
          msg.repos = msg.repos.filter(r => r && isAllowedRepoPath(r.path));
          for (const r of msg.repos) {
            exec('git push', { cwd: r.path, encoding: 'utf-8' }, (err) => {
              done++;
              console.log(`[smartpill] ${r.name}: ${err ? 'push failed' : 'pushed'}`);
              if (done === msg.repos.length && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'smartpill-result', result: `Pushed ${done} repos`, success: true }));
              }
            });
          }
        }
        break;
      }

      case 'scan-repo-info': {
        const rp = msg.repoPath;
        if (!rp || !isAllowedRepoPath(rp) || !fs.existsSync(rp)) { ws.send(JSON.stringify({ type: 'repo-info', repoPath: rp, info: null })); break; }
        // Short TTL — clicking through repo cards re-requested a full scan
        // (6 git spawns + directory walk) for results gathered seconds earlier.
        const recentCache = repoStore.load(rp);
        if (recentCache && recentCache.repoInfo && recentCache.scannedAt && Date.now() - recentCache.scannedAt < 60000) {
          ws.send(JSON.stringify({ type: 'repo-info', repoPath: rp, info: recentCache.repoInfo }));
          break;
        }
        scanRepoInfo(rp).then(scannedInfo => {
          const existingData = repoStore.load(rp) || {};
          existingData.repoInfo = scannedInfo;
          existingData.scannedAt = Date.now();
          repoStore.save(rp, existingData);
          ws.send(JSON.stringify({ type: 'repo-info', repoPath: rp, info: scannedInfo }));
        }).catch(() => {
          ws.send(JSON.stringify({ type: 'repo-info', repoPath: rp, info: null }));
        });
        break;
      }

      // Open the repo in the OS file manager. Only reachable for paths that pass
      // isAllowedRepoPath, and the path is passed as an argv entry (never through
      // a shell) so a directory name cannot become a command.
      case 'reveal-in-explorer': {
        const dir = msg.repoPath;
        if (!isAllowedRepoPath(dir) || !fs.existsSync(dir)) {
          ws.send(JSON.stringify({ type: 'reveal-result', ok: false, message: 'That folder is not available' }));
          break;
        }
        const cmd = IS_WIN ? 'explorer.exe' : (IS_MAC ? 'open' : 'xdg-open');
        // explorer.exe exits non-zero even when it succeeded, so its code is not
        // a signal worth reporting; the other two are honest about failure.
        execFile(cmd, [path.resolve(dir)], { windowsHide: true }, (err) => {
          if (ws.readyState !== 1) return;
          const ok = IS_WIN ? true : !err;
          ws.send(JSON.stringify({
            type: 'reveal-result',
            ok,
            message: ok ? null : `Could not open the folder: ${err.message}`
          }));
        });
        break;
      }

      case 'validate-dir': {
        fs.promises.stat(msg.dir).then(stat => {
          ws.send(JSON.stringify({ type: 'dir-validated', valid: stat.isDirectory(), dir: msg.dir }));
        }).catch(() => {
          ws.send(JSON.stringify({ type: 'dir-validated', valid: false, dir: msg.dir }));
        });
        break;
      }

      // Which agents have already been let into each repo. Drives the extra-repo
      // picker, which only offers folders the chosen CLI already knows — see
      // lib/cli-trust.js for why. Read-only, and paths are still filtered
      // through isAllowedRepoPath so this cannot be used to probe the disk.
      case 'repo-trust': {
        const paths = (Array.isArray(msg.paths) ? msg.paths : []).filter(
          (p) => typeof p === 'string' && isAllowedRepoPath(p)
        );
        const trust = {};
        for (const p of paths) {
          try { trust[p] = cliTrust.repoTrust(p); } catch { /* leave it out — client treats missing as unknown */ }
        }
        const enforced = {};
        for (const cli of ['claude', 'codex', 'gemini']) {
          try { enforced[cli] = cliTrust.enforcesTrust(cli); } catch { enforced[cli] = true; }
        }
        ws.send(JSON.stringify({ type: 'repo-trust', trust, enforced }));
        break;
      }

      // What is already available for this repo + CLI: sessions Catalyst has
      // running right now, and conversations the CLI itself can resume.
      case 'list-sessions-for': {
        (async () => {
          const { cli, repoPath } = msg;
          let running = [];
          let conversations = [];
          let note = null;
          try {
            running = sessionManager.getAllSessions()
              .filter(s => s.cli === cli && samePathish(s.originalRepoPath || s.repoPath, repoPath))
              .map(s => ({
                id: s.id,
                repo: s.repo,
                startedAt: s.startedAt || null,
                worktreeBranch: s.worktreeBranch || null,
                extraDirs: s.extraDirs || [],
                resumedFrom: s.resumedFrom || null
              }));
          } catch (e) { note = 'Could not read running sessions: ' + e.message; }

          if (isAllowedRepoPath(repoPath)) {
            const res = conversationStore.list(cli, repoPath);
            conversations = res.conversations.map(c => ({
              id: c.id, label: c.label, updatedAt: c.updatedAt,
              messages: c.messages, bytes: c.bytes,
              resumeByIndexOnly: !!c.resumeByIndexOnly
            }));
            if (res.note) note = res.note;
          }

          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'sessions-for', cli, repoPath, running, conversations, note }));
          }
        })();
        break;
      }

      case 'kill-sessions-for': {
        (async () => {
          const { cli, repoPath } = msg;
          let killed = 0;
          try {
            for (const s of sessionManager.getAllSessions()) {
              if (s.cli !== cli || !samePathish(s.originalRepoPath || s.repoPath, repoPath)) continue;
              sessionManager.killSession(s.id);
              killed++;
            }
          } catch {}
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sessions-killed', cli, repoPath, killed }));
        })();
        break;
      }

      // Destructive: removes specific transcripts by id. Ids are resolved
      // server-side against this repo's own history, so a client cannot name an
      // arbitrary file. The client confirms with the user first.
      case 'delete-conversations': {
        (async () => {
          const { cli, repoPath, ids } = msg;
          let result = { removed: 0, errors: ['Repository path is outside the configured projects folder'] };
          if (isAllowedRepoPath(repoPath)) {
            try { result = conversationStore.remove(cli, repoPath, ids); }
            catch (e) { result = { removed: 0, errors: [e.message] }; }
          }
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'conversations-cleared', cli, repoPath, ...result }));
          }
        })();
        break;
      }

      // Destructive: removes the CLI's own transcript files. The client confirms
      // with the user before sending this.
      case 'clear-conversations-for': {
        (async () => {
          const { cli, repoPath } = msg;
          let result = { removed: 0, errors: ['Repository path is outside the configured projects folder'] };
          if (isAllowedRepoPath(repoPath)) {
            try { result = conversationStore.clear(cli, repoPath); }
            catch (e) { result = { removed: 0, errors: [e.message] }; }
          }
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'conversations-cleared', cli, repoPath, ...result }));
          }
        })();
        break;
      }

      case 'create-session': {
        (async () => {
          try {
            if (!isAllowedRepoPath(msg.repoPath)) {
              throw new Error('Repository path is outside the configured projects folder');
            }

            // Additional repos for multi-repo sessions. Validated individually:
            // without this a client could hand the agent any directory on disk.
            const extraDirs = Array.isArray(msg.extraDirs) ? msg.extraDirs.filter(Boolean) : [];
            for (const dir of extraDirs) {
              if (!isAllowedRepoPath(dir)) {
                throw new Error(`Additional repository is outside the configured projects folder: ${dir}`);
              }
            }
            if (extraDirs.includes(msg.repoPath)) {
              throw new Error('The primary repository cannot also be listed as an additional repository');
            }

            // An extra repo is only handed over if the chosen CLI has already
            // been let into it. Otherwise the flag either does nothing useful or
            // lands the tab on a trust prompt the user did not ask for. The
            // picker greys these out, so reaching here means a stale trust
            // reading — refuse rather than start a session that misleads.
            // Only the agent CLIs take extra directories at all.
            if (['claude', 'codex', 'gemini'].includes(msg.cli)) {
              for (const dir of extraDirs) {
                if (!cliTrust.canAddDir(msg.cli, dir)) {
                  throw new Error(cliTrust.refusalReason(msg.cli, dir));
                }
              }
            } else {
              extraDirs.length = 0;
            }

            let spawnPath = msg.repoPath;
            let worktreePath = null;
            let worktreeBranch = null;

            if (msg.useWorktree) {
              const wt = await worktreeManager.createWorktree(msg.repoPath, msg.branchName);
              spawnPath = wt.worktreePath;
              worktreePath = wt.worktreePath;
              worktreeBranch = wt.branch;
            }

            const info = await sessionManager.createSession(
              msg.cli,
              spawnPath,
              msg.repo,
              (sessionId, data) => {
                broadcast({ type: 'output', sessionId, data });
                trackBuildOutput(msg.repoPath, msg.repo, data);
              },
              (sessionId, exitCode) => broadcast({ type: 'session-ended', sessionId, exitCode }),
              { worktreePath, worktreeBranch, originalRepoPath: msg.repoPath },
              { extraDirs, resume: typeof msg.resume === 'string' ? msg.resume : null }
            );
            broadcast({ type: 'session-created', ...info });
          } catch (err) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
        })();
        break;
      }

      case 'input': {
        sessionManager.writeToSession(msg.sessionId, msg.data);
        break;
      }

      case 'resize': {
        sessionManager.resizeSession(msg.sessionId, msg.cols, msg.rows);
        break;
      }

      case 'kill-session': {
        const sessionToKill = sessionManager.getSession(msg.sessionId);
        if (sessionToKill && sessionToKill.worktreePath) {
          const origRepo = sessionToKill.originalRepoPath || msg.repoPath;
          setTimeout(() => {
            worktreeManager.removeWorktree(origRepo, sessionToKill.worktreePath).catch(() => {});
          }, 500);
        }
        sessionManager.killSession(msg.sessionId);
        broadcast({ type: 'session-killed', sessionId: msg.sessionId });
        break;
      }

      case 'restart-session': {
        const ok = sessionManager.restartSession(msg.sessionId);
        if (ok) broadcast({ type: 'session-restarted', sessionId: msg.sessionId });
        break;
      }

      case 'export-session': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: 'session-exported', sessionId: msg.sessionId, success: false, error: 'Session not found' }));
          break;
        }
        const history = sessionManager.getOutputHistory(msg.sessionId);
        // Strip ANSI control sequences + OSC for a readable plain-text log.
        const cleaned = history
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)/g, '');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const exportPath = path.join(session.repoPath, `catalyst-session-${stamp}.txt`);
        fs.promises.writeFile(exportPath, cleaned, 'utf-8').then(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session-exported', sessionId: msg.sessionId, success: true, path: exportPath }));
        }).catch(err => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session-exported', sessionId: msg.sessionId, success: false, error: err.message }));
        });
        break;
      }

      case 'get-history': {
        const history = sessionManager.getOutputHistory(msg.sessionId);
        ws.send(JSON.stringify({ type: 'history', sessionId: msg.sessionId, data: history }));
        break;
      }

      case 'check-cli': {
        Promise.resolve(sessionManager.checkCliInstalled(msg.cli)).then(installed => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cli-check', cli: msg.cli, installed }));
        });
        break;
      }

      case 'browse-folder': {
        try {
          const result = nfd.folder_dialog();
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'folder-selected', path: result || '' }));
          }
        } catch {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'folder-selected', path: '' }));
          }
        }
        break;
      }

      case 'get-scripts': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        (async () => {
        const repoPath = session.repoPath;
        const scripts = {};
        let projectType = 'unknown';

        // Read root directory once for all detection below (async — must not
        // stall the event loop on a cold disk cache)
        let repoEntries;
        try { repoEntries = await fs.promises.readdir(repoPath, { withFileTypes: true }); } catch { repoEntries = []; }
        const repoFileNames = new Set(repoEntries.filter(e => !e.isDirectory()).map(e => e.name));
        const repoDirEntries = repoEntries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');

        // Node.js
        const pkgPath = path.join(repoPath, 'package.json');
        if (repoFileNames.has('package.json')) {
          projectType = 'node';
          try {
            const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
            const s = pkg.scripts || {};
            if (s.build) scripts['build'] = `npm run build`;
            if (s.start) scripts['start'] = `npm start`;
            if (s.dev) scripts['dev'] = `npm run dev`;
            if (s.test) scripts['test'] = `npm test`;
            if (s.lint) scripts['lint'] = `npm run lint`;
            Object.keys(s).forEach(k => {
              if (!scripts[k]) scripts[k] = `npm run ${k}`;
            });
          } catch {}
        }

        // .NET / C#
        const slnFiles = [...repoFileNames].filter(f => f.endsWith('.sln'));
        const csprojFiles = [...repoFileNames].filter(f => f.endsWith('.csproj'));
        // Also scan one level deep for .csproj in subdirectories
        let subCsproj = [];
        await Promise.all(repoDirEntries.map(async dir => {
          try {
            const sub = (await fs.promises.readdir(path.join(repoPath, dir.name))).filter(f => f.endsWith('.csproj'));
            sub.forEach(f => subCsproj.push({ dir: dir.name, file: f }));
          } catch {}
        }));
        if (slnFiles.length > 0 || csprojFiles.length > 0 || subCsproj.length > 0) {
          projectType = 'dotnet';
          if (slnFiles.length > 0) {
            scripts['build'] = 'dotnet build';
            scripts['test'] = 'dotnet test';
            scripts['restore'] = 'dotnet restore';
            scripts['clean'] = 'dotnet clean';
            scripts['publish'] = 'dotnet publish';
          }
          if (csprojFiles.length > 0) {
            scripts['build'] = 'dotnet build';
            scripts['run'] = 'dotnet run';
            scripts['test'] = 'dotnet test';
            scripts['watch'] = 'dotnet watch run';
          }
          subCsproj.forEach(({ dir, file }) => {
            const projName = file.replace('.csproj', '');
            scripts[`build:${projName}`] = `dotnet build ${dir}/${file}`;
            scripts[`run:${projName}`] = `dotnet run --project ${dir}/${file}`;
          });
        }

        // Python
        if (repoFileNames.has('requirements.txt') ||
            repoFileNames.has('setup.py') ||
            repoFileNames.has('pyproject.toml')) {
          projectType = 'python';
          scripts['install'] = 'pip install -r requirements.txt';
          if (repoFileNames.has('manage.py')) {
            scripts['runserver'] = 'python manage.py runserver';
            scripts['migrate'] = 'python manage.py migrate';
            scripts['test'] = 'python manage.py test';
          } else {
            scripts['test'] = 'pytest';
          }
        }

        // Go
        if (repoFileNames.has('go.mod')) {
          projectType = 'go';
          scripts['build'] = 'go build ./...';
          scripts['run'] = 'go run .';
          scripts['test'] = 'go test ./...';
        }

        // Rust
        if (repoFileNames.has('Cargo.toml')) {
          projectType = 'rust';
          scripts['build'] = 'cargo build';
          scripts['run'] = 'cargo run';
          scripts['test'] = 'cargo test';
        }

        // Java/Maven
        if (repoFileNames.has('pom.xml')) {
          projectType = 'maven';
          scripts['build'] = 'mvn compile';
          scripts['test'] = 'mvn test';
          scripts['package'] = 'mvn package';
        }

        // Java/Gradle
        if (repoFileNames.has('build.gradle') || repoFileNames.has('build.gradle.kts')) {
          projectType = 'gradle';
          scripts['build'] = 'gradle build';
          scripts['test'] = 'gradle test';
          scripts['run'] = 'gradle run';
        }

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'scripts', sessionId: msg.sessionId, scripts, projectType }));
        }
        })();
        break;
      }

      case 'run-command': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const shell = IS_WIN ? 'cmd.exe' : '/bin/bash';
        const args = IS_WIN ? ['/c', msg.command] : ['-c', msg.command];
        const cmdCwd = msg.subdir ? path.join(session.repoPath, msg.subdir) : session.repoPath;
        if (!isPathWithin(cmdCwd, session.repoPath)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Subdirectory is outside the repository' }));
          break;
        }
        const cmdPty = pty.spawn(shell, args, {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: cmdCwd,
          env: sessionManager.enrichEnv()
        });
        const cmdId = crypto.randomUUID();
        const cmdMap = clientCmdPtys.get(ws);
        if (cmdMap) cmdMap.set(cmdId, cmdPty);
        ws.send(JSON.stringify({ type: 'cmd-started', sessionId: msg.sessionId, cmdId, command: msg.command }));
        cmdPty.onData(raw => {
          const data = sessionManager.cleanPtyOutput(raw);
          if (data && ws.readyState === 1) ws.send(JSON.stringify({ type: 'cmd-output', cmdId, data }));
        });
        cmdPty.onExit(({ exitCode }) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cmd-ended', cmdId, exitCode }));
          const map = clientCmdPtys.get(ws);
          if (map) map.delete(cmdId);
        });
        break;
      }

      case 'paste-image': {
        const imgDir = CATALYST_IMG_DIR;
        const match = msg.data.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
          const fname = `clipboard-${Date.now()}.${ext}`;
          const fpath = path.join(imgDir, fname);
          fs.promises.mkdir(imgDir, { recursive: true }).then(() => {
            return fs.promises.writeFile(fpath, Buffer.from(match[2], 'base64'));
          }).then(() => {
            const session = sessionManager.getSession(msg.sessionId);
            if (session) sessionManager.writeToSession(msg.sessionId, fpath + '\r');
            ws.send(JSON.stringify({ type: 'image-saved', sessionId: msg.sessionId, path: fpath }));
          }).catch(() => {});
        }
        break;
      }

      case 'get-settings': {
        const settings = store.getSettings();
        const hasPat = credStore.hasPAT();
        const hasGithubPat = credStore.hasGithubPAT();
        ws.send(JSON.stringify({ type: 'settings', settings, hasPat, hasGithubPat }));
        break;
      }

      case 'save-theme': {
        if (msg.theme) store.saveSettings({ theme: msg.theme });
        break;
      }

      // Coerced to a real boolean: the Tauri startup check reads this key out of
      // sessions.json and treats anything that isn't `true` as opted out.
      case 'save-auto-update': {
        store.saveSettings({ autoUpdate: msg.autoUpdate === true });
        break;
      }

      case 'save-settings': {
        try {
          store.saveSettings(msg.settings || {});
          const provider = (msg.settings && msg.settings.provider) || msg.provider;
          if (msg.pat) {
            try {
              if (provider === 'github') credStore.saveGithubPAT(msg.pat);
              else credStore.savePAT(msg.pat);
            } catch (e) { console.error('Settings credential save error'); }
          }
          if (msg.githubPat) {
            try { credStore.saveGithubPAT(msg.githubPat); } catch (e) { console.error('GitHub PAT save error'); }
          }
          if (msg.azurePat) {
            try { credStore.savePAT(msg.azurePat); } catch (e) { console.error('Azure PAT save error'); }
          }
          let hasPat = false, hasGithubPat = false;
          try { hasPat = credStore.hasPAT(); } catch {}
          try { hasGithubPat = credStore.hasGithubPAT(); } catch {}
          ws.send(JSON.stringify({ type: 'settings-saved', hasPat, hasGithubPat, provider }));

          // Verify the saved PAT actually authenticates against the provider.
          verifyProviderAuth(provider, ws).catch(err => console.error('verifyProviderAuth error:', err));
        } catch(e) {
          console.error('Settings save error:', e);
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to save settings: ' + e.message }));
        }
        break;
      }

      case 'verify-pat': {
        verifyProviderAuth(msg.provider, ws).catch(err => console.error('verify-pat error:', err));
        break;
      }

      case 'verify-pat-inline': {
        (async () => {
          const provider = msg.provider;
          const pat = (msg.pat || '').trim();
          if (!pat) {
            ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: false, message: 'Enter a PAT first' }));
            return;
          }
          try {
            if (provider === 'azure') {
              const org = (msg.org || '').trim();
              if (!org) {
                ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: false, message: 'Enter a DevOps URL first' }));
                return;
              }
              const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData?api-version=7.1`;
              const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
              const res = await fetch(url, { headers: { 'Authorization': auth } });
              if (!res.ok) {
                ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: false, message: `Rejected (HTTP ${res.status}) — check token expiry and scopes` }));
                return;
              }
              const text = await res.text();
              let identity = '';
              try {
                const data = JSON.parse(text);
                identity = data?.authenticatedUser?.providerDisplayName || '';
              } catch {
                ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: false, message: 'Unexpected response — double-check the org URL' }));
                return;
              }
              ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: true, identity, message: identity ? `Authenticated as ${identity}` : 'Verified' }));
            } else if (provider === 'github') {
              const res = await fetch('https://api.github.com/user', {
                headers: { 'Authorization': 'token ' + pat, 'Accept': 'application/vnd.github+json', 'User-Agent': 'Catalyst' }
              });
              if (!res.ok) {
                ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: false, message: `Rejected (HTTP ${res.status}) — check token expiry and repo scope` }));
                return;
              }
              const data = await res.json();
              const identity = data.login || '';
              ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: true, identity, message: identity ? `Authenticated as @${identity}` : 'Verified' }));
            }
          } catch (err) {
            ws.send(JSON.stringify({ type: 'pat-verified-inline', provider, success: false, message: 'Unreachable: ' + err.message }));
          }
        })();
        break;
      }

      case 'reset-catalyst': {
        (async () => {
          const errors = [];
          try {
            // Wipe any pre-rename ~/.codey too, so a reset does not leave a
            // legacy dir behind for lib/paths.js to migrate back in later.
            for (const dir of [paths.DATA_DIR, paths.LEGACY_DATA_DIR]) {
              if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
              }
            }
          } catch (e) { errors.push('Could not delete ~/.catalyst: ' + e.message); }
          // Cross-platform wipe of both PAT entries (credential-store owns the
          // platform-specific deletion).
          try { await credStore.deleteAll(); } catch (e) { errors.push('deleteAll: ' + e.message); }
          try { credStore.clearCache(); } catch {}
          try { store.invalidateCache(); } catch {} // ~/.catalyst was just deleted
          try { sessionManager.killAll(); } catch (e) { errors.push('killAll: ' + e.message); }
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'reset-complete', success: errors.length === 0, errors }));
          }
        })();
        break;
      }

      case 'git-status': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        exec('git status --short', { cwd: session.repoPath, encoding: 'utf-8' }, (err, stdout) => {
          ws.send(JSON.stringify({ type: 'git-status-result', sessionId: msg.sessionId, data: stdout || '', error: err ? err.message : null }));
        });
        break;
      }

      case 'git-branch': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        exec('git branch --show-current', { cwd: session.repoPath, encoding: 'utf-8' }, (err, stdout) => {
          ws.send(JSON.stringify({ type: 'git-branch-result', sessionId: msg.sessionId, branch: (stdout || '').trim() }));
        });
        break;
      }

      case 'list-branches': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        listBranches(session.repoPath).then(branches => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'branches', sessionId: msg.sessionId, branches }));
        });
        break;
      }

      case 'list-models': {
        const modelCli = msg.cli || 'claude';
        listModels(modelCli).then(r => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'models-list', cli: modelCli, models: r.models, source: r.source }));
        });
        break;
      }

      case 'prune-remote-branches': {
        // Background check: sync with origin and drop remote-tracking refs that
        // were deleted on the remote, then re-list so branches whose upstream is
        // now gone are flagged. Does NOT delete local branches.
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        execFile('git', ['fetch', '--prune', '--quiet'], { cwd: session.repoPath, windowsHide: true, timeout: 30000 }, () => {
          listBranches(session.repoPath).then(branches => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'branches', sessionId: msg.sessionId, branches, pruned: true }));
          });
        });
        break;
      }

      case 'create-branch': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        // Leading '-' would let the name be parsed as a git option (argument injection).
        if (!msg.branch || !/^[a-zA-Z0-9._\/-]+$/.test(msg.branch) || msg.branch.startsWith('-')) {
          ws.send(JSON.stringify({ type: 'branch-error', message: 'Invalid branch name. Only letters, numbers, dots, underscores, slashes, and hyphens are allowed.' }));
          break;
        }
        execFile('git', ['checkout', '-b', msg.branch], { cwd: session.repoPath, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'branch-error', message: (stderr || err.message).trim() }));
          } else {
            ws.send(JSON.stringify({ type: 'branch-switched', sessionId: msg.sessionId, branch: msg.branch }));
          }
        });
        break;
      }

      case 'switch-branch': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        // Leading '-' would let the name be parsed as a git option (argument injection).
        if (!msg.branch || !/^[a-zA-Z0-9._\/-]+$/.test(msg.branch) || msg.branch.startsWith('-')) {
          ws.send(JSON.stringify({ type: 'branch-error', message: 'Invalid branch name. Only letters, numbers, dots, underscores, slashes, and hyphens are allowed.' }));
          break;
        }
        execFile('git', ['checkout', msg.branch], { cwd: session.repoPath, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'branch-error', message: (stderr || err.message).trim() }));
          } else {
            ws.send(JSON.stringify({ type: 'branch-switched', sessionId: msg.sessionId, branch: msg.branch }));
          }
        });
        break;
      }

      case 'list-subdirs': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const basePath = session.repoPath;
        const relPath = msg.path || '';
        const fullPath = path.join(basePath, relPath);
        if (!isPathWithin(fullPath, basePath)) {
          ws.send(JSON.stringify({ type: 'subdirs', sessionId: msg.sessionId, path: relPath, dirs: [], error: 'Path is outside the repository' }));
          break;
        }
        try {
          const entries = fs.readdirSync(fullPath, { withFileTypes: true });
          const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'bin' && e.name !== 'obj' && e.name !== '__pycache__')
            .map(e => e.name)
            .sort();
          ws.send(JSON.stringify({ type: 'subdirs', sessionId: msg.sessionId, path: relPath, dirs }));
        } catch {
          ws.send(JSON.stringify({ type: 'subdirs', sessionId: msg.sessionId, path: relPath, dirs: [] }));
        }
        break;
      }

      case 'git-pull': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const pullPat = credStore.loadPAT();
        const pullEnv = { ...process.env };
        if (pullPat) {
          pullEnv.GIT_ASKPASS = 'echo';
          pullEnv.GIT_TERMINAL_PROMPT = '0';
          pullEnv.GCM_INTERACTIVE = 'never';
          exec('git remote get-url origin', { cwd: session.repoPath, encoding: 'utf-8' }, (remoteErr, remoteStdout) => {
            const remoteUrl = (remoteStdout || '').trim();
            if (!remoteErr && isAzureHttpsRemote(remoteUrl)) {
              const pullB64 = Buffer.from(':' + pullPat).toString('base64');
              const pullPatEscaped = pullPat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pullB64Escaped = pullB64.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pullScrubRe = new RegExp(pullPatEscaped + '|' + pullB64Escaped, 'g');
              // Auth goes through GIT_CONFIG_* env vars, not `-c` on the command
              // line — argv is visible to every local process (Task Manager/WMI).
              // URL-scoped so git cannot replay the header anywhere but this
              // remote — the unscoped key travelled with redirects and
              // submodule fetches to whatever host they pointed at.
              pullEnv.GIT_CONFIG_COUNT = '1';
              pullEnv.GIT_CONFIG_KEY_0 = `http.${remoteUrl}.extraheader`;
              pullEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${pullB64}`;
              execFile('git', ['pull'], { cwd: session.repoPath, encoding: 'utf-8', env: pullEnv, windowsHide: true }, (err, stdout, stderr) => {
                const output = (stdout || stderr || '').replace(pullScrubRe, '***');
                const errMsg = err ? err.message.replace(pullScrubRe, '***') : '';
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'git-pull-result', sessionId: msg.sessionId, success: !err, data: err ? (errMsg + '\n' + output) : output }));
                }
              });
            } else {
              exec('git pull', { cwd: session.repoPath, encoding: 'utf-8' }, (err, stdout, stderr) => {
                const output = stdout || stderr || '';
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'git-pull-result', sessionId: msg.sessionId, success: !err, data: err ? (err.message + '\n' + output) : output }));
                }
              });
            }
          });
        } else {
          exec('git pull', { cwd: session.repoPath, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const output = stdout || stderr || '';
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'git-pull-result', sessionId: msg.sessionId, success: !err, data: err ? (err.message + '\n' + output) : output }));
            }
          });
        }
        break;
      }

      case 'git-push': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        ws.send(JSON.stringify({ type: 'git-push-status', sessionId: msg.sessionId, status: 'pushing' }));
        const pushPat = credStore.loadPAT();
        const pushEnv = { ...process.env };
        if (pushPat) {
          pushEnv.GIT_ASKPASS = 'echo';
          pushEnv.GIT_TERMINAL_PROMPT = '0';
          pushEnv.GCM_INTERACTIVE = 'never';
          // Get remote URL and branch concurrently (async instead of execSync)
          const gitOpts = { cwd: session.repoPath, encoding: 'utf-8' };
          Promise.all([
            execAsync('git remote get-url origin', gitOpts),
            execAsync('git rev-parse --abbrev-ref HEAD', gitOpts),
          ]).then(([pushRemote, pushBranch]) => {
            if (!/^[a-zA-Z0-9._\/-]+$/.test(pushBranch) || pushBranch.startsWith('-')) {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'git-push-result', sessionId: msg.sessionId, success: false, data: 'Refusing to push: unexpected branch name ' + JSON.stringify(pushBranch) }));
              }
              return;
            }
            if (isAzureHttpsRemote(pushRemote)) {
              const pushB64 = Buffer.from(':' + pushPat).toString('base64');
              const pushPatEscaped = pushPat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pushB64Escaped = pushB64.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pushScrubRe = new RegExp(pushPatEscaped + '|' + pushB64Escaped, 'g');
              // Auth goes through GIT_CONFIG_* env vars, not `-c` on the command
              // line — argv is visible to every local process (Task Manager/WMI).
              // URL-scoped: see the git-pull branch above.
              pushEnv.GIT_CONFIG_COUNT = '1';
              pushEnv.GIT_CONFIG_KEY_0 = `http.${pushRemote}.extraheader`;
              pushEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${pushB64}`;
              execFile('git', ['push', 'origin', pushBranch], { cwd: session.repoPath, encoding: 'utf-8', env: pushEnv, windowsHide: true }, (err, stdout, stderr) => {
                const output = (stdout || stderr || '').replace(pushScrubRe, '***');
                const errMsg = err ? err.message.replace(pushScrubRe, '***') : '';
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'git-push-result', sessionId: msg.sessionId, success: !err, data: err ? (errMsg + '\n' + output) : output }));
                }
              });
            } else {
              exec('git push', { cwd: session.repoPath, encoding: 'utf-8' }, (err, stdout, stderr) => {
                const output = stdout || stderr || '';
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'git-push-result', sessionId: msg.sessionId, success: !err, data: err ? (err.message + '\n' + output) : output }));
                }
              });
            }
          });
        } else {
          exec('git push', { cwd: session.repoPath, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const output = stdout || stderr || '';
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'git-push-result', sessionId: msg.sessionId, success: !err, data: err ? (err.message + '\n' + output) : output }));
            }
          });
        }
        break;
      }

      case 'git-changed-files': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        exec('git status --porcelain', { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: msg.sessionId, files: [], error: err.message }));
            return;
          }
          const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', '??': 'untracked', 'R': 'renamed', 'C': 'copied', 'U': 'conflict' };
          const files = (stdout || '').split('\n').filter(l => l.trim()).map(line => {
            const ix = line[0];  // index (staged) column
            const wt = line[1];  // worktree column
            const filePath = line.substring(3);
            const raw = line.substring(0, 2).trim();
            const staged = ix !== ' ' && ix !== '?' && wt === ' ';
            return { status: statusMap[raw] || 'modified', statusCode: raw, file: filePath, staged };
          });
          ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: msg.sessionId, files }));
        });
        break;
      }

      case 'git-stage': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const stageFiles = Array.isArray(msg.files) ? msg.files : [msg.file];
        const safe = stageFiles.every(f => f && isPathWithin(path.join(session.repoPath, f), session.repoPath));
        if (!safe) break;
        execFile('git', ['add', '--'].concat(stageFiles), { cwd: session.repoPath, windowsHide: true }, () => {
          exec('git status --porcelain', { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
            const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', '??': 'untracked', 'R': 'renamed', 'C': 'copied', 'U': 'conflict' };
            const files = (stdout || '').split('\n').filter(l => l.trim()).map(line => {
              const ix = line[0]; const wt = line[1]; const filePath = line.substring(3);
              const raw = line.substring(0, 2).trim();
              const staged = ix !== ' ' && ix !== '?' && wt === ' ';
              return { status: statusMap[raw] || 'modified', statusCode: raw, file: filePath, staged };
            });
            ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: msg.sessionId, files }));
          });
        });
        break;
      }

      case 'git-unstage': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const unstageFiles = Array.isArray(msg.files) ? msg.files : [msg.file];
        const safeU = unstageFiles.every(f => f && isPathWithin(path.join(session.repoPath, f), session.repoPath));
        if (!safeU) break;
        execFile('git', ['reset', 'HEAD', '--'].concat(unstageFiles), { cwd: session.repoPath, windowsHide: true }, () => {
          exec('git status --porcelain', { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
            const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', '??': 'untracked', 'R': 'renamed', 'C': 'copied', 'U': 'conflict' };
            const files = (stdout || '').split('\n').filter(l => l.trim()).map(line => {
              const ix = line[0]; const wt = line[1]; const filePath = line.substring(3);
              const raw = line.substring(0, 2).trim();
              const staged = ix !== ' ' && ix !== '?' && wt === ' ';
              return { status: statusMap[raw] || 'modified', statusCode: raw, file: filePath, staged };
            });
            ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: msg.sessionId, files }));
          });
        });
        break;
      }

      case 'git-discard': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const discardFile = msg.file;
        if (!discardFile || !isPathWithin(path.join(session.repoPath, discardFile), session.repoPath)) break;
        // For untracked files, remove them; for tracked files, checkout from HEAD
        execFile('git', ['checkout', 'HEAD', '--', discardFile], { cwd: session.repoPath, windowsHide: true }, (err) => {
          if (err) {
            // Might be untracked — try clean
            execFile('git', ['clean', '-f', '--', discardFile], { cwd: session.repoPath, windowsHide: true }, () => {
              refreshChangedFiles(session, msg.sessionId, ws);
            });
          } else {
            refreshChangedFiles(session, msg.sessionId, ws);
          }
        });
        break;
      }

      case 'git-all-files': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        exec('git ls-files', { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'git-all-files', sessionId: msg.sessionId, files: [], error: err.message }));
            return;
          }
          const files = (stdout || '').split('\n').filter(l => l.trim()).map(filePath => {
            return { status: 'tracked', statusCode: '', file: filePath };
          });
          ws.send(JSON.stringify({ type: 'git-all-files', sessionId: msg.sessionId, files }));
        });
        break;
      }

      case 'save-file': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const savePath = path.join(session.repoPath, msg.file);
        if (!isPathWithin(savePath, session.repoPath)) {
          ws.send(JSON.stringify({ type: 'save-file-result', sessionId: msg.sessionId, file: msg.file, success: false, error: 'Path is outside the repository' }));
          break;
        }
        fs.promises.writeFile(savePath, msg.content, 'utf-8').then(() => {
          ws.send(JSON.stringify({ type: 'save-file-result', sessionId: msg.sessionId, file: msg.file, success: true }));
        }).catch(err => {
          ws.send(JSON.stringify({ type: 'save-file-result', sessionId: msg.sessionId, file: msg.file, success: false, error: err.message }));
        });
        break;
      }

      case 'git-file-diff': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const filePath = msg.file;
        if (!filePath || !isPathWithin(path.join(session.repoPath, filePath), session.repoPath)) {
          ws.send(JSON.stringify({ type: 'git-file-diff', sessionId: msg.sessionId, file: filePath, diff: '', error: 'Path is outside the repository' }));
          break;
        }
        const diffOpts = { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true };
        execFile('git', ['diff', 'HEAD', '--', filePath], diffOpts, (err, stdout) => {
          if (!stdout && !err) {
            execFile('git', ['diff', '--', filePath], diffOpts, (err2, stdout2) => {
              ws.send(JSON.stringify({ type: 'git-file-diff', sessionId: msg.sessionId, file: filePath, diff: stdout2 || '(new file)' }));
            });
          } else {
            ws.send(JSON.stringify({ type: 'git-file-diff', sessionId: msg.sessionId, file: filePath, diff: stdout || '(no changes)' }));
          }
        });
        break;
      }

      case 'git-file-contents': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const reqFile = msg.file;
        const fullFilePath = path.join(session.repoPath, reqFile);
        if (!isPathWithin(fullFilePath, session.repoPath)) {
          ws.send(JSON.stringify({ type: 'git-file-contents', sessionId: msg.sessionId, file: reqFile, original: '', modified: '', error: 'Path is outside the repository' }));
          break;
        }
        // Read working-tree file and git HEAD version concurrently
        const modifiedPromise = fs.promises.readFile(fullFilePath, 'utf-8').catch(() => '');
        const originalPromise = new Promise(resolve => {
          execFile('git', ['show', `HEAD:${reqFile.replace(/\\/g, '/')}`], { cwd: session.repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
            resolve(err ? '' : (stdout || ''));
          });
        });
        Promise.all([modifiedPromise, originalPromise]).then(([modified, original]) => {
          ws.send(JSON.stringify({ type: 'git-file-contents', sessionId: msg.sessionId, file: reqFile, original, modified }));
        });
        break;
      }

      case 'list-repo-files': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const basePath = session.repoPath;
        const files = [];
        const ignored = new Set(['.git','node_modules','bin','obj','__pycache__','dist','build','.vs','.idea','.next','coverage','vendor']);
        // Async walk — a large repo on a cold disk cache would otherwise block the
        // event loop (and every live terminal) for the whole traversal.
        async function walk(dir, prefix) {
          if (files.length > 2000) return;
          let entries;
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });
          for (const e of entries) {
            if (e.name.startsWith('.') && e.name !== '.env.example') continue;
            if (ignored.has(e.name)) continue;
            const rel = prefix ? prefix + '/' + e.name : e.name;
            if (e.isDirectory()) {
              files.push({ name: e.name, path: rel, type: 'dir' });
              await walk(path.join(dir, e.name), rel);
            } else {
              files.push({ name: e.name, path: rel, type: 'file' });
            }
          }
        }
        walk(basePath, '').then(() => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'repo-files', sessionId: msg.sessionId, files }));
          }
        });
        break;
      }

      case 'read-file': {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;
        const fullPath = path.join(session.repoPath, msg.file);
        if (!isPathWithin(fullPath, session.repoPath)) {
          ws.send(JSON.stringify({ type: 'file-content', sessionId: msg.sessionId, file: msg.file, content: '', error: 'Path is outside the repository' }));
          break;
        }
        fs.promises.readFile(fullPath, 'utf-8').then(content => {
          ws.send(JSON.stringify({ type: 'file-content', sessionId: msg.sessionId, file: msg.file, content }));
        }).catch(e => {
          ws.send(JSON.stringify({ type: 'file-content', sessionId: msg.sessionId, file: msg.file, content: '', error: e.message }));
        });
        break;
      }

      case 'list-repo-folders': {
        const basePath = msg.repoPath;
        if (!basePath || !isAllowedRepoPath(basePath) || !fs.existsSync(basePath)) {
          ws.send(JSON.stringify({ type: 'repo-folders', repoPath: basePath, folders: [] }));
          break;
        }
        // Async walk — the sync version traversed the whole repo tree on the
        // event loop, stalling every live terminal on large repos.
        (async () => {
          const folders = ['/ (root)'];
          async function walkDirs(dir, prefix) {
            let subs;
            try {
              subs = (await fs.promises.readdir(dir, { withFileTypes: true }))
                .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules','bin','obj','__pycache__','dist','build','.git'].includes(e.name))
                .sort((a, b) => a.name.localeCompare(b.name));
            } catch { return; }
            for (const s of subs) {
              const rel = prefix ? prefix + '/' + s.name : s.name;
              folders.push(rel);
              if (folders.length < 200) await walkDirs(path.join(dir, s.name), rel);
            }
          }
          try { await walkDirs(basePath, ''); } catch {}
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'repo-folders', repoPath: basePath, folders }));
          }
        })();
        break;
      }

      case 'get-repo-settings': {
        const settings = repoStore.load(msg.repoPath);
        ws.send(JSON.stringify({ type: 'repo-settings', repoPath: msg.repoPath, settings }));
        break;
      }

      case 'save-repo-settings': {
        repoStore.save(msg.repoPath, msg.settings);
        ws.send(JSON.stringify({ type: 'repo-settings-saved', repoPath: msg.repoPath, settings: msg.settings }));
        break;
      }

      case 'check-cli-availability': {
        buildVerifyPath().then(extPath => {
          const cliChecks = KNOWN_CLIS.map(cli => {
            const checkCmd = cli.cmd.includes(' ') ? cli.cmd.split(' ')[0] : cli.cmd;
            return sessionManager.commandExists(checkCmd, extPath)
              .then(installed => ({ id: cli.id, installed, install: installCommandFor(cli) }));
          });
          return Promise.all(cliChecks);
        }).then(results => {
          const cliStatus = {};
          for (const r of results) cliStatus[r.id] = { installed: r.installed, install: r.install };
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cli-availability', cliStatus }));
        });
        break;
      }

      case 'install-cli': {
        (async () => {
        const cliDef = findInstallTarget(msg.cli);
        if (!cliDef || !cliDef.install) {
          ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: false, message: 'Unknown CLI or no installer defined' }));
          return;
        }
        // If the tool is already on PATH (or its winget/npm shim is), skip the install and just confirm.
        if (!msg.force && await verifyCommand(cliDef.cmd)) {
          ws.send(JSON.stringify({
            type: 'install-cli-result',
            cli: msg.cli,
            success: true,
            message: 'Already installed'
          }));
          return;
        }
        // Prerequisite installs (e.g. Copilot needs `gh` first).
        const preSteps = [];
        if (msg.cli === 'copilot' && !(await verifyCommand('gh'))) {
          const ghDef = INTEGRATION_TOOLS.find(t => t.id === 'gh');
          if (ghDef) preSteps.push({ command: installCommandFor(ghDef), verifyCmd: 'gh', label: 'GitHub CLI' });
        }

        async function runStep(command, onDone) {
          ws.send(JSON.stringify({ type: 'install-cli-started', cli: msg.cli, command }));
          const installShell = IS_WIN ? 'cmd.exe' : '/bin/bash';
          const installArgs = IS_WIN ? ['/c', command] : ['-c', command];
          const installPath = await buildVerifyPath();
          let installPty;
          try {
            installPty = pty.spawn(installShell, installArgs, {
              name: 'xterm-color',
              cols: 100,
              rows: 30,
              cwd: os.homedir(),
              env: sessionManager.enrichEnv({ ...process.env, PATH: installPath })
            });
          } catch (err) {
            onDone(null, err);
            return;
          }
          // Track in the per-client PTY map so a disconnect mid-install kills it
          const installId = crypto.randomUUID();
          const installMap = clientCmdPtys.get(ws);
          if (installMap) installMap.set(installId, installPty);
          installPty.onData((raw) => {
            const data = sessionManager.cleanPtyOutput(raw);
            if (data && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'install-cli-progress', cli: msg.cli, data }));
            }
          });
          installPty.onExit(({ exitCode }) => {
            const m = clientCmdPtys.get(ws);
            if (m) m.delete(installId);
            onDone(exitCode, null);
          });
        }

        function runPreSteps(idx, done) {
          if (idx >= preSteps.length) { done(); return; }
          const step = preSteps[idx];
          ws.send(JSON.stringify({ type: 'install-cli-progress', cli: msg.cli, data: `\r\n--- Installing prerequisite: ${step.label} ---\r\n` }));
          runStep(step.command, async (exitCode, err) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: false, exitCode, message: `Failed to install prerequisite ${step.label}: ${err.message}` }));
              return;
            }
            await refreshVerifyPath();
            if (await verifyCommand(step.verifyCmd)) {
              ws.send(JSON.stringify({ type: 'install-cli-progress', cli: msg.cli, data: `\r\n✓ ${step.label} verified on PATH\r\n` }));
              runPreSteps(idx + 1, done);
              return;
            }
            ws.send(JSON.stringify({ type: 'install-cli-progress', cli: msg.cli, data: `\r\n⟳ Waiting for ${step.label} to appear on PATH…\r\n` }));
            let retries = 0;
            let checking = false; // guard against overlapping async checks
            const retryInterval = setInterval(async () => {
              if (checking) return;
              checking = true;
              try {
                await refreshVerifyPath();
                if (await verifyCommand(step.verifyCmd)) {
                  clearInterval(retryInterval);
                  ws.send(JSON.stringify({ type: 'install-cli-progress', cli: msg.cli, data: `✓ ${step.label} verified on PATH\r\n` }));
                  runPreSteps(idx + 1, done);
                } else if (++retries >= 5) {
                  clearInterval(retryInterval);
                  ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: false, exitCode, message: `Prerequisite ${step.label} was installed but \`${step.verifyCmd}\` was not found on PATH. Restart Catalyst and try again.` }));
                }
              } finally {
                checking = false;
              }
            }, 2000);
          });
        }

        runPreSteps(0, () => {
          runStep(installCommandFor(cliDef), async (exitCode, err) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: false, message: 'Failed to spawn installer: ' + err.message }));
              return;
            }
            await refreshVerifyPath();
            const installed = await verifyCommand(cliDef.cmd);
            if (!installed) {
              ws.send(JSON.stringify({
                type: 'install-cli-result',
                cli: msg.cli,
                success: false,
                exitCode,
                message: exitCode === 0
                  ? 'Installer finished but the command was not found on PATH — you may need to restart Catalyst'
                  : `Installer exited with code ${exitCode}`
              }));
              return;
            }
            if (!cliDef.postInstall) {
              ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: true, exitCode, message: 'Installed and verified' }));
              return;
            }
            // Run optional post-install step (e.g. add Azure DevOps extension).
            runStep(cliDef.postInstall, (postExit, postErr) => {
              if (postErr) {
                ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: true, exitCode, message: 'Installed, but post-install step failed to start: ' + postErr.message }));
                return;
              }
              ws.send(JSON.stringify({
                type: 'install-cli-result',
                cli: msg.cli,
                success: postExit === 0,
                exitCode: postExit,
                message: postExit === 0 ? 'Installed and verified (post-install complete)' : `Post-install step exited with code ${postExit}`
              }));
            });
          });
        });
        })().catch(err => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'install-cli-result', cli: msg.cli, success: false, message: err.message }));
        });
        break;
      }

      case 'list-available-clis': {
        buildVerifyPath().then(extPath2 => {
          const cliChecks2 = KNOWN_CLIS.map(cli => {
            const checkCmd = cli.cmd.includes(' ') ? cli.cmd.split(' ')[0] : cli.cmd;
            return sessionManager.commandExists(checkCmd, extPath2)
              .then(installed => ({ cli, installed }));
          });
          return Promise.all(cliChecks2);
        }).then(results => {
          const available = results.filter(r => r.installed).map(r => r.cli);
          // Terminal is always available
          if (!available.find(c => c.id === 'terminal')) {
            available.push(KNOWN_CLIS.find(c => c.id === 'terminal'));
          }
          ws.send(JSON.stringify({ type: 'available-clis', clis: available, sessionId: msg.sessionId }));
        });
        break;
      }

      case 'create-inner-session': {
        const parentSession = sessionManager.getSession(msg.parentSessionId);
        if (!parentSession) {
          ws.send(JSON.stringify({ type: 'inner-session-error', error: 'Parent session not found' }));
          break;
        }
        const cliDef = KNOWN_CLIS.find(c => c.id === msg.cliId);
        if (!cliDef) {
          ws.send(JSON.stringify({ type: 'inner-session-error', error: 'Unknown CLI' }));
          break;
        }
        const innerId = crypto.randomUUID();
        const shell = IS_WIN ? 'cmd.exe' : '/bin/bash';
        const isTerminal = msg.cliId === 'terminal';
        const args = isTerminal ? [] : (IS_WIN ? ['/c', cliDef.cmd] : ['-c', cliDef.cmd]);
        // Interactive terminal: Windows → powershell (KNOWN_CLIS cmd); POSIX →
        // the user's login shell, falling back to /bin/bash.
        const spawnCmd = isTerminal
          ? (IS_WIN ? cliDef.cmd : (process.env.SHELL || '/bin/bash'))
          : shell;

        // Optional subfolder cwd (for run configs), kept within the repo.
        let innerCwd = parentSession.repoPath;
        if (msg.subdir) {
          const base = path.resolve(parentSession.repoPath);
          const resolved = path.resolve(base, msg.subdir);
          if ((resolved === base || resolved.startsWith(base + path.sep)) && fs.existsSync(resolved)) {
            innerCwd = resolved;
          }
        }

        let innerPty;
        try {
          innerPty = pty.spawn(spawnCmd, args, {
            name: 'xterm-color',
            cols: msg.cols || 120,
            rows: msg.rows || 30,
            cwd: innerCwd,
            env: sessionManager.enrichEnv()
          });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'inner-session-error', error: 'Failed to spawn: ' + err.message }));
          break;
        }

        // Optional initial command (e.g. a run-config's run command), sent once
        // the shell has had a moment to show its prompt.
        if (msg.initialCommand) {
          setTimeout(() => { try { innerPty.write(msg.initialCommand + '\r'); } catch {} }, 700);
        }

        innerPty.onData((raw) => {
          const data = sessionManager.cleanPtyOutput(raw);
          if (data && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'inner-session-output', innerSessionId: innerId, data }));
          }
        });

        innerPty.onExit(({ exitCode }) => {
          innerSessions.delete(innerId);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'inner-session-ended', innerSessionId: innerId, exitCode }));
          }
        });

        innerSessions.set(innerId, { pty: innerPty, parentSessionId: msg.parentSessionId, ws });
        ws.send(JSON.stringify({ type: 'inner-session-created', innerSessionId: innerId, cliId: msg.cliId, cliName: msg.name || cliDef.name, parentSessionId: msg.parentSessionId, clientRef: msg.clientRef || null }));
        break;
      }

      case 'inner-session-input': {
        const inner = innerSessions.get(msg.innerSessionId);
        if (inner) inner.pty.write(msg.data);
        break;
      }

      case 'inner-session-resize': {
        const inner = innerSessions.get(msg.innerSessionId);
        if (inner) { try { inner.pty.resize(msg.cols, msg.rows); } catch {} }
        break;
      }

      case 'kill-inner-session': {
        const inner = innerSessions.get(msg.innerSessionId);
        if (inner) {
          inner.pty.kill();
          innerSessions.delete(msg.innerSessionId);
        }
        break;
      }

      case 'fetch-work-item': {
        const settings = store.getSettings();
        const pat = credStore.loadPAT();
        if (!pat) {
          ws.send(JSON.stringify({ type: 'work-item-result', success: false, error: 'No PAT configured. Go to Settings to add one.' }));
          break;
        }
        if (!settings.azureOrg || !settings.azureProject) {
          ws.send(JSON.stringify({ type: 'work-item-result', success: false, error: 'Azure DevOps org/project not configured. Go to Settings.' }));
          break;
        }
        const wiId = msg.workItemId;
        const org = encodeURIComponent(settings.azureOrg);
        const project = encodeURIComponent(settings.azureProject);
        const authHeader = 'Basic ' + Buffer.from(':' + pat).toString('base64');
        const wiUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${encodeURIComponent(wiId)}?$expand=all&api-version=7.1`;

        fetch(wiUrl, { headers: { 'Authorization': authHeader } })
          .then(r => r.json())
          .then(wi => {
            if (wi.id) {
              const commentsUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${encodeURIComponent(wiId)}/comments?api-version=7.1-preview.4`;
              return fetch(commentsUrl, { headers: { 'Authorization': authHeader } })
                .then(r => r.json())
                .then(commentsData => {
                  const comments = (commentsData.comments || []).map(c => ({
                    text: (c.text || '').replace(/<[^>]*>/g, ''),
                    author: c.createdBy?.displayName || '',
                    date: c.createdDate || ''
                  }));
                  const fields = wi.fields || {};
                  ws.send(JSON.stringify({
                    type: 'work-item-result',
                    success: true,
                    workItem: {
                      id: wi.id,
                      title: fields['System.Title'] || '',
                      state: fields['System.State'] || '',
                      description: (fields['System.Description'] || '').replace(/<[^>]*>/g, ''),
                      acceptanceCriteria: (fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '').replace(/<[^>]*>/g, ''),
                      assignedTo: fields['System.AssignedTo']?.displayName || '',
                      type: fields['System.WorkItemType'] || '',
                      url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${wi.id}`,
                      comments
                    }
                  }));
                });
            } else {
              ws.send(JSON.stringify({ type: 'work-item-result', success: false, error: wi.message || 'Work item not found' }));
            }
          })
          .catch(err => {
            ws.send(JSON.stringify({ type: 'work-item-result', success: false, error: err.message }));
          });
        break;
      }

      case 'update-work-item-state': {
        console.log('[update-work-item-state] Setting work item', msg.workItemId, 'to', msg.newState);
        const settings = store.getSettings();
        const pat = credStore.loadPAT();
        if (!pat || !settings.azureOrg || !settings.azureProject) {
          console.error('[update-work-item-state] Missing PAT or Azure config');
          break;
        }
        const wiId = msg.workItemId;
        const org = encodeURIComponent(settings.azureOrg);
        const project = encodeURIComponent(settings.azureProject);
        const authHeader = 'Basic ' + Buffer.from(':' + pat).toString('base64');
        const patchUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${encodeURIComponent(wiId)}?api-version=7.1`;
        const statesToTry = [msg.newState, 'Active', 'In Progress', 'Doing', 'Committed'];

        async function trySetState(states) {
          for (const s of states) {
            try {
              const res = await fetch(patchUrl, {
                method: 'PATCH',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json-patch+json' },
                body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: s }])
              });
              const result = await res.json();
              if (result.id) {
                ws.send(JSON.stringify({ type: 'work-item-state-updated', success: true, workItemId: wiId, newState: s }));
                return;
              }
            } catch {}
          }
          ws.send(JSON.stringify({ type: 'work-item-state-updated', success: false, error: 'Could not transition work item to an in-progress state' }));
        }
        trySetState(statesToTry);
        break;
      }

      case 'create-pr': {
        const settings = store.getSettings();
        const pat = credStore.loadPAT();
        if (!pat) {
          ws.send(JSON.stringify({ type: 'pr-result', success: false, error: 'No PAT configured. Go to Settings to add one.' }));
          break;
        }
        if (!settings.azureOrg || !settings.azureProject) {
          ws.send(JSON.stringify({ type: 'pr-result', success: false, error: 'Azure DevOps org/project not configured. Go to Settings.' }));
          break;
        }

        const session = sessionManager.getSession(msg.sessionId);
        if (!session) break;

        const org = encodeURIComponent(settings.azureOrg);
        const project = encodeURIComponent(settings.azureProject);
        const authHeader = 'Basic ' + Buffer.from(':' + pat).toString('base64');

        execAsync('git remote get-url origin', { cwd: session.repoPath, encoding: 'utf-8' }).then(remoteUrl => {
          let repoName;
          const match = remoteUrl.match(/\/([^\/]+?)(?:\.git)?$/);
          repoName = match ? match[1] : session.repo;

          const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests?api-version=7.1`;

          const body = {
            sourceRefName: `refs/heads/${msg.sourceBranch}`,
            targetRefName: `refs/heads/${msg.targetBranch}`,
            title: msg.title,
            description: msg.description || ''
          };

          if (msg.workItemId) {
            body.workItemRefs = [{ id: msg.workItemId }];
          }

          return fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': authHeader
            },
            body: JSON.stringify(body)
          })
          .then(r => r.json())
          .then(data => {
            if (data.pullRequestId) {
              const prUrl = `https://dev.azure.com/${org}/${project}/_git/${repoName}/pullrequest/${data.pullRequestId}`;
              ws.send(JSON.stringify({ type: 'pr-result', success: true, prUrl, prId: data.pullRequestId }));
            } else {
              ws.send(JSON.stringify({ type: 'pr-result', success: false, error: data.message || JSON.stringify(data) }));
            }
          });
        })
        .catch(err => {
          ws.send(JSON.stringify({ type: 'pr-result', success: false, error: err.message }));
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Kill all command PTYs for this client
    const cmdMap = clientCmdPtys.get(ws);
    if (cmdMap) {
      for (const [cmdId, cmdPty] of cmdMap) {
        try { cmdPty.kill(); } catch {}
      }
      cmdMap.clear();
      clientCmdPtys.delete(ws);
    }
    // Kill all inner sessions for this client
    for (const [innerId, inner] of innerSessions) {
      if (inner.ws === ws) {
        try { inner.pty.kill(); } catch {}
        innerSessions.delete(innerId);
      }
    }
    if (clients.size === 0) {
      sessionManager.setClientConnected(false);
    }
  });
});

function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    function check(port) {
      if (port > end) return reject(new Error('No free port found'));
      const tester = net.createServer();
      tester.once('error', () => check(port + 1));
      tester.listen(port, '127.0.0.1', () => tester.close(() => resolve(port)));
    }
    check(start);
  });
}

function startServer(preferredPort = 4200) {
  // Warm the caches that would otherwise cost a blocking process spawn on the
  // first request (PAT loads via PowerShell, npm global prefix, verify PATH).
  credStore.prewarm().catch(() => {});
  sessionManager.prewarm().catch(() => {});
  buildVerifyPath().catch(() => {});
  return findFreePort(preferredPort, preferredPort + 10).then(port => {
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      // Loopback only — this server can spawn shells; it must not be LAN-reachable.
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        const url = `http://localhost:${port}`;
        console.log(`Catalyst running at ${url}`);
        resolve({ server, port, url });
      });
    });
  });
}

process.on('SIGINT', () => {
  sessionManager.killAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sessionManager.killAll();
  process.exit(0);
});

if (require.main === module) {
  startServer(4200).then(info => {
    // Machine-readable readiness line — the desktop shell parses this from
    // stdout to learn the chosen port and point the window at the backend.
    console.log('CATALYST_LISTENING ' + info.port);
  }).catch(err => {
    console.error('Failed to start Catalyst backend:', err);
    process.exit(1);
  });
}

module.exports = { startServer, app, sessionManager };
