const pty = require('node-pty');
const { execSync, exec, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./session-store');
const credStore = require('./credential-store');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ConPTY on Windows sometimes echoes terminal response sequences (cursor
// position reports, device-attribute replies) into the output stream. These
// belong on stdin only; when they leak into stdout xterm.js can't fully
// consume them and their trailing characters render as visible text artifacts
// ("Ra", "Re", etc.). Strip them before forwarding to the client.
const CONPTY_RE = IS_WIN
  ? /\x1b\[\d+;\d+R|\x1b\[\?\d+(?:;\d+)*c|\x1b\[>\d+(?:;\d+)*c/g
  : null;
function cleanPtyOutput(data) {
  if (!CONPTY_RE) return data;
  CONPTY_RE.lastIndex = 0;
  return data.replace(CONPTY_RE, '');
}

const sessions = new Map();
const RECONNECT_BUFFER_MAX = 512 * 1024; // 512KB per session
const OUTPUT_BUFFER_MAX = 512 * 1024; // 512KB cap for outputBuffer

let clientConnected = false;

// Cross-platform "is this command on PATH?" — Windows uses `where`, POSIX uses
// `command -v` via /bin/sh. Async (execFile-based) so it never blocks the loop.
function commandExists(cmd, extendedPath) {
  const env = { ...process.env, PATH: extendedPath || process.env.PATH };
  return new Promise(resolve => {
    if (IS_WIN) {
      execFile('where', [cmd], { windowsHide: true, env }, (err) => resolve(!err));
    } else {
      execFile('/bin/sh', ['-c', `command -v ${cmd}`], { env }, (err) => resolve(!err));
    }
  });
}

const CLI_COMMANDS = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini'
};

// Quote a value for `bash -c`, which takes the whole command as one string.
// Windows deliberately does NOT go through here — see spawnCliPty.
function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Making additional repositories visible to the agent. Each CLI spells this
// differently; these were read off the installed CLIs' own --help output:
//
//   claude  --add-dir <dirs...>
//   gemini  --include-directories <dir>   (repeatable)
//   codex   no equivalent. Codex's workspace is its cwd, and the closest lever
//           is widening the sandbox's writable roots — which grants write
//           access but does not add workspace roots, so multi-repo is
//           genuinely degraded for codex. Callers should say so in the UI
//           rather than imply parity.
function extraDirArgv(cli, dirs) {
  const list = (dirs || []).filter(Boolean);
  if (!list.length) return [];

  switch (cli) {
    case 'claude':
      return ['--add-dir', ...list];
    case 'gemini':
      return list.flatMap((d) => ['--include-directories', d]);
    case 'codex': {
      // TOML literal strings (single quotes) so Windows backslashes are not
      // treated as escape sequences by the TOML parser.
      const roots = list.map((d) => `'${d}'`).join(', ');
      return ['-c', `sandbox_workspace_write.writable_roots=[${roots}]`];
    }
    default:
      return [];
  }
}

// Resuming a previous conversation. claude/gemini take a flag; codex takes a
// `resume` subcommand, which has to precede any options.
function resumeArgv(cli, resume) {
  if (!resume) return [];
  switch (cli) {
    case 'claude':
      return ['--resume', resume];
    case 'gemini':
      // Accepts an index or the literal "latest".
      return ['--resume', resume];
    default:
      return [];
  }
}

// Assemble the argv for a session as an array — never a pre-quoted string.
// Stored on the session so restartSession reproduces the same arguments.
function buildArgv(cli, opts = {}) {
  const base = CLI_COMMANDS[cli];
  if (!base) throw new Error(`Unknown CLI: ${cli}`);

  const argv = [base];
  if (opts.resume && cli === 'codex') argv.push('resume', opts.resume);
  argv.push(...extraDirArgv(cli, opts.extraDirs));
  if (cli !== 'codex') argv.push(...resumeArgv(cli, opts.resume));
  return argv;
}

// Cache npm global bin — it won't change during the lifetime of the app.
let _npmGlobalBinCache = undefined;
function getNpmGlobalBin() {
  if (_npmGlobalBinCache !== undefined) return _npmGlobalBinCache;
  try {
    _npmGlobalBinCache = execSync('npm prefix -g', { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch {
    _npmGlobalBinCache = '';
  }
  return _npmGlobalBinCache;
}

// Fill the npm-prefix cache asynchronously at startup so the first PTY spawn
// never pays the ~1s blocking `npm prefix -g` on the event loop.
function prewarm() {
  if (_npmGlobalBinCache !== undefined) return Promise.resolve();
  return new Promise(resolve => {
    exec('npm prefix -g', { encoding: 'utf-8', windowsHide: true }, (err, stdout) => {
      if (_npmGlobalBinCache === undefined) {
        _npmGlobalBinCache = err ? '' : (stdout || '').trim();
      }
      resolve();
    });
  });
}

// Build an extended PATH with npm global bin, WindowsApps shim, and .local/bin.
// Cached after first computation — these paths don't change at runtime.
let _extendedPathCache = undefined;
function getExtendedPath(basePath) {
  if (_extendedPathCache !== undefined) {
    return _extendedPathCache ? `${basePath || ''}${path.delimiter}${_extendedPathCache}` : (basePath || '');
  }
  const npmBin = getNpmGlobalBin();
  let extras;
  if (IS_WIN) {
    const wingetShim = process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps` : '';
    const localBin = process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.local\\bin` : '';
    extras = [npmBin, wingetShim, localBin];
  } else {
    const npmPosixBin = npmBin ? path.join(npmBin, 'bin') : '';
    const home = process.env.HOME || '';
    extras = [
      npmPosixBin,
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      home ? path.join(home, '.local', 'bin') : '',
    ];
  }
  _extendedPathCache = extras.filter(Boolean).join(path.delimiter);
  return _extendedPathCache ? `${basePath || ''}${path.delimiter}${_extendedPathCache}` : (basePath || '');
}

// Build the env every spawned PTY should inherit:
//   - PATH augmented with npm global bin and the winget WindowsApps shim
//   - AZURE_DEVOPS_EXT_PAT so `az devops`/`az repos`/`az boards` work non-interactively
//   - GITHUB_TOKEN / GH_TOKEN so `gh` and PR-creation tooling work non-interactively
//   - AZURE_DEVOPS_ORG_URL when an Azure org is configured, so devops commands have a default
// Identity/state markers an agent CLI sets for its own child processes. If
// Catalyst itself was launched from inside such a session (entirely plausible
// when dogfooding), these leak into every session we spawn and the new CLI
// decides it is a nested child — which silently turns off transcript saving,
// so the session cannot be resumed later. Sessions Catalyst starts are
// independent, so these are dropped.
//
// Deliberately a fixed list rather than a CLAUDE_* wildcard: settings a user
// sets on purpose (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR,
// CLAUDE_CODE_FORCE_SESSION_PERSISTENCE) must survive.
const INHERITED_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

function enrichEnv(base) {
  const env = { ...(base || process.env) };

  // Env var names are case-insensitive on Windows, so match accordingly.
  const drop = new Set(INHERITED_SESSION_MARKERS.map((k) => k.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (drop.has(key.toLowerCase())) delete env[key];
  }

  // Windows env var names are case-insensitive and the key is usually 'Path',
  // not 'PATH'. Extend the existing key so cmd.exe/child processes see our
  // additions instead of a duplicate 'PATH' they may ignore.
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = getExtendedPath(env[pathKey]);
  try {
    const azurePat = credStore.loadPAT();
    if (azurePat) env.AZURE_DEVOPS_EXT_PAT = azurePat;
  } catch {}
  try {
    const ghPat = credStore.loadGithubPAT();
    if (ghPat) {
      env.GITHUB_TOKEN = ghPat;
      env.GH_TOKEN = ghPat;
    }
  } catch {}
  try {
    const settings = store.getSettings();
    if (settings && settings.azureOrg) {
      env.AZURE_DEVOPS_ORG_URL = `https://dev.azure.com/${settings.azureOrg}`;
    }
  } catch {}
  return env;
}

// Hits cached forever (a CLI that exists won't vanish mid-run); misses cached
// for a short TTL — long enough to stop repeated failed launches re-spawning
// `where`, short enough to notice a fresh install.
const _cliInstalledCache = new Map(); // cli -> true | { missedAt: ts }
const CLI_MISS_TTL = 30000;
async function checkCliInstalled(cli) {
  const cmd = CLI_COMMANDS[cli];
  if (!cmd) return false;
  const cached = _cliInstalledCache.get(cli);
  if (cached === true) return true;
  if (cached && Date.now() - cached.missedAt < CLI_MISS_TTL) return false;
  const extended = getExtendedPath(process.env.PATH);
  // Primary: ask the shell resolver (async — the sync version blocked the event
  // loop, freezing every live terminal on each session-creation attempt).
  const found = await commandExists(cmd, extended);
  if (found) {
    _cliInstalledCache.set(cli, true);
    return true;
  }
  // Fallback: scan PATH dirs ourselves for any common executable extension.
  // Robust against PATHEXT/registry differences and against `where` not being on PATH.
  const exts = IS_WIN
    ? ['.exe', '.cmd', '.bat', '.ps1', '']
    : [''];
  const dirs = (extended || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, cmd + ext))) {
          _cliInstalledCache.set(cli, true);
          return true;
        }
      } catch {}
    }
  }
  _cliInstalledCache.set(cli, { missedAt: Date.now() });
  return false;
}

// Spawn a PTY running `argv` under the platform shell. The shell is needed so
// the CLI name resolves via PATH (on Windows these are .cmd shims).
//
// Windows passes argv as separate entries rather than one joined string. This
// matters: node-pty builds the Windows command line itself and escapes embedded
// quotes as \" , which cmd.exe forwards literally — so a hand-quoted
// `--add-dir "C:\repo"` arrives at the CLI as `"C:\repo"`, quotes included, and
// the directory is invalid. Handing node-pty the array lets it quote correctly.
// POSIX still needs one string, because `bash -c` takes a single argument.
//
// `env` is optional; defaults to a fresh enrichEnv() so a restart picks up
// current credentials/PATH.
function spawnCliPty(argv, repoPath, env) {
  const shell = IS_WIN ? 'cmd.exe' : '/bin/bash';
  const list = Array.isArray(argv) ? argv : [argv];
  const args = IS_WIN ? ['/c', ...list] : ['-c', list.map(posixQuote).join(' ')];
  return pty.spawn(shell, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: repoPath,
    env: env || enrichEnv()
  });
}

// launchOpts: { extraDirs?: string[], resume?: string }
async function createSession(cli, repoPath, repoName, onData, onExit, worktreeOpts, launchOpts) {
  const id = crypto.randomUUID();
  const opts = launchOpts || {};
  const argv = buildArgv(cli, opts);

  if (!(await checkCliInstalled(cli))) {
    const hint = IS_WIN
      ? ` (looked in PATH, %USERPROFILE%\\.local\\bin, npm global bin, and WindowsApps). Try Settings → AI CLI → Install ${cli}, then fully restart Catalyst.`
      : '';
    throw new Error(`${cli} is not installed or not in PATH${hint}`);
  }

  const ptyProcess = spawnCliPty(argv, repoPath);

  // Mutable buffer state lives in one object so restartSession can reset it
  // without re-creating the session's public buffer interface.
  const buf = {
    outputBuffer: [],
    outputBufferSize: 0,
    outputDropCount: 0, // number of leading items logically removed
    reconnectParts: [],
    reconnectSize: 0,
  };

  const wt = worktreeOpts || {};

  const session = {
    id,
    cli,
    // argv is what restartSession re-spawns; command is a readable form of the
    // same thing for logs and the UI.
    argv,
    command: argv.join(' '),
    repo: repoName,
    repoPath,
    ptyProcess,
    // Stored so restartSession can rebind output to the same frontend terminal.
    onData,
    onExit,
    _buf: buf,
    outputBuffer: buf.outputBuffer,
    reconnectBuffer: {
      get() { return buf.reconnectParts.join(''); },
      clear() { buf.reconnectParts = []; buf.reconnectSize = 0; }
    },
    worktreePath: wt.worktreePath || null,
    worktreeBranch: wt.worktreeBranch || null,
    originalRepoPath: wt.originalRepoPath || repoPath,
    // Extra repos and the resumed conversation id, kept so the sessions modal
    // can describe a running session accurately.
    extraDirs: (opts.extraDirs || []).filter(Boolean),
    resumedFrom: opts.resume || null,
    startedAt: Date.now()
  };

  bindPtyHandlers(session);

  sessions.set(id, session);
  store.addSession({ id, cli, repo: repoName, repoPath, worktreePath: session.worktreePath, originalRepoPath: session.originalRepoPath, extraDirs: session.extraDirs });

  return {
    id, cli, repo: repoName, repoPath,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    extraDirs: session.extraDirs,
    resumedFrom: session.resumedFrom
  };
}

// Wire onData/onExit for a session's current ptyProcess. Reused by both
// createSession and restartSession so output keeps flowing under the same id.
function bindPtyHandlers(session) {
  const id = session.id;
  const buf = session._buf;
  session.ptyProcess.onData((raw) => {
    const data = cleanPtyOutput(raw);
    if (!data) return;
    buf.outputBuffer.push(data);
    buf.outputBufferSize += data.length;
    while (buf.outputBufferSize > OUTPUT_BUFFER_MAX && buf.outputBuffer.length > buf.outputDropCount + 1) {
      buf.outputBufferSize -= buf.outputBuffer[buf.outputDropCount].length;
      buf.outputBuffer[buf.outputDropCount] = undefined; // release reference without O(n) shift
      buf.outputDropCount++;
    }
    // Compact when half the array is dead slots to avoid unbounded array growth
    if (buf.outputDropCount > 0 && buf.outputDropCount >= buf.outputBuffer.length / 2) {
      buf.outputBuffer.splice(0, buf.outputDropCount);
      buf.outputDropCount = 0;
    }
    if (!clientConnected) {
      buf.reconnectParts.push(data);
      buf.reconnectSize += data.length;
      if (buf.reconnectSize > RECONNECT_BUFFER_MAX) {
        // Trim from the front until within budget
        while (buf.reconnectSize > RECONNECT_BUFFER_MAX && buf.reconnectParts.length > 1) {
          buf.reconnectSize -= buf.reconnectParts[0].length;
          buf.reconnectParts.shift();
        }
      }
    }
    session.onData(id, data);
  });

  session.ptyProcess.onExit(({ exitCode }) => {
    // A restart kills the old pty; ignore the resulting exit so we don't tear
    // down a session that has already been re-spawned under the same id.
    if (session._restarting) { session._restarting = false; return; }
    sessions.delete(id);
    store.removeSession(id);
    session.onExit(id, exitCode);
  });
}

// Restart a session's CLI process in place, keeping the SAME id so the frontend
// terminal stays bound. Returns true on success, false if no such session.
function restartSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  // Suppress the old pty's exit handler so it doesn't delete the session.
  session._restarting = true;
  try { session.ptyProcess.kill(); } catch {}
  // Reset output/reconnect buffers — the new process starts fresh.
  const buf = session._buf;
  buf.outputBuffer.length = 0;
  buf.outputBufferSize = 0;
  buf.outputDropCount = 0;
  buf.reconnectParts = [];
  buf.reconnectSize = 0;
  session.ptyProcess = spawnCliPty(session.argv, session.repoPath, enrichEnv());
  bindPtyHandlers(session);
  return true;
}

function writeToSession(sessionId, data) {
  const session = sessions.get(sessionId);
  if (session) {
    session.ptyProcess.write(data);
  }
}

function resizeSession(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (session) {
    try { session.ptyProcess.resize(cols, rows); } catch {}
  }
}

function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.ptyProcess.kill();
    sessions.delete(sessionId);
    store.removeSession(sessionId);
  }
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function getAllSessions() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    cli: s.cli,
    repo: s.repo,
    repoPath: s.repoPath,
    worktreePath: s.worktreePath || null,
    worktreeBranch: s.worktreeBranch || null,
    // Needed to group and describe sessions in the sessions modal. Grouping
    // uses originalRepoPath so a worktree session still belongs to its repo.
    originalRepoPath: s.originalRepoPath || s.repoPath,
    startedAt: s.startedAt || null,
    extraDirs: s.extraDirs || [],
    resumedFrom: s.resumedFrom || null
  }));
}

function getOutputHistory(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return '';
  // Skip undefined (dropped) slots at the front of the buffer
  const buf = session.outputBuffer;
  const parts = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== undefined) parts.push(buf[i]);
  }
  return parts.join('');
}

function getReconnectBuffer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return '';
  return session.reconnectBuffer.get();
}

function clearReconnectBuffers() {
  for (const [, session] of sessions) {
    session.reconnectBuffer.clear();
  }
}

function setClientConnected(connected) {
  clientConnected = connected;
}

function killAll() {
  for (const [id, session] of sessions) {
    try { session.ptyProcess.kill(); } catch {}
    try { store.removeSession(id); } catch {}
  }
  sessions.clear();
}

module.exports = {
  createSession,
  restartSession,
  writeToSession,
  resizeSession,
  killSession,
  getSession,
  getAllSessions,
  getOutputHistory,
  getReconnectBuffer,
  clearReconnectBuffers,
  setClientConnected,
  killAll,
  checkCliInstalled,
  commandExists,
  enrichEnv,
  prewarm,
  cleanPtyOutput
};
