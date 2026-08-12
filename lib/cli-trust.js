// Whether an agent CLI has already been let into a folder.
//
// Catalyst can hand extra repos to an agent at launch (`claude --add-dir`,
// `gemini --include-directories`, codex's writable roots). That is only a safe
// thing to do for a folder the CLI already knows: every one of these tools has
// its own trust gate, and a folder that has never been through it is an unknown
// quantity — claude, for one, opens a blocking "do you trust the files in this
// folder?" prompt, which inside a PTY tab means a session that looks started
// but is really sitting on a question the user did not expect. So the picker
// only offers folders each CLI has already accepted, and this module is how we
// find that out.
//
// Every layout below was read off real files on disk on Windows, except where a
// comment says otherwise:
//
//   claude  ~/.claude.json  → projects["C:/forward/slash/path"]
//                             .hasTrustDialogAccepted (true | false)
//   codex   ~/.codex/config.toml → [projects.'c:\lower\case\path']
//                                  trust_level = "trusted"
//   gemini  ~/.gemini/projects.json → projects["c:\\lower\\case\\path"] = name
//                                     (presence only — that it has been opened)
//           ~/.gemini/trustedFolders.json → path → TRUST_FOLDER | TRUST_PARENT
//                                     | DO_NOT_TRUST  (only written when
//                                     gemini's folder-trust feature is on)
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

// Three states, because "never opened" and "opened and not trusted" are
// different problems with different fixes.
const UNKNOWN = 'unknown';  // the CLI has no record of this folder at all
const SEEN = 'seen';        // it has been opened here, but nothing granted trust
const TRUSTED = 'trusted';  // the CLI's own trust record says yes

// Path keys differ per CLI (slash direction, casing), so compare on a single
// normalised form. Windows paths are case-insensitive; POSIX ones are not.
function norm(p) {
  const s = String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return IS_WIN ? s.toLowerCase() : s;
}

function isAncestorOf(parent, child) {
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a + '/');
}

// These files are rewritten by the CLIs while Catalyst runs, and ~/.claude.json
// in particular carries per-project usage metrics and grows to megabytes. Cache
// per file and re-read only when mtime/size move.
const cache = new Map();
function readCached(file, parse, empty) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* absent is a valid answer */ }

  const hit = cache.get(file);
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'absent';
  if (hit && hit.stamp === stamp) return hit.value;

  let value = empty;
  if (stat) {
    try { value = parse(fs.readFileSync(file, 'utf-8')); }
    catch { value = empty; } // unreadable or half-written — treat as no record
  }
  cache.set(file, { stamp, value });
  return value;
}

// ─── claude ────────────────────────────────────────────────────────────────
// One entry per cwd claude has run in. The entry appears on first run; the
// boolean only flips once the user answers the trust prompt, so a `false` here
// is a real "not trusted", not a missing record.
function claudeProjects() {
  return readCached(
    path.join(os.homedir(), '.claude.json'),
    (text) => {
      const projects = JSON.parse(text).projects || {};
      const map = new Map();
      for (const [key, val] of Object.entries(projects)) {
        map.set(norm(key), !!(val && val.hasTrustDialogAccepted));
      }
      return map;
    },
    new Map()
  );
}

function claudeState(dir) {
  const trusted = claudeProjects().get(norm(dir));
  if (trusted === undefined) return UNKNOWN;
  return trusted ? TRUSTED : SEEN;
}

// ─── codex ─────────────────────────────────────────────────────────────────
// config.toml is hand-editable TOML and we have no TOML parser in the tree, so
// scan for the one table shape codex writes for this: a [projects.'<path>']
// header followed by trust_level. Only that pair is read; everything else in
// the file is ignored.
function codexTrust() {
  return readCached(
    path.join(os.homedir(), '.codex', 'config.toml'),
    (text) => {
      const map = new Map();
      let current = null;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const header = line.match(/^\[(.+)\]$/);
        if (header) {
          const key = header[1].match(/^projects\.\s*(?:'([^']*)'|"([^"]*)"|(.+))$/);
          current = key ? norm(key[1] ?? key[2] ?? key[3]) : null;
          if (current !== null && !map.has(current)) map.set(current, null);
          continue;
        }
        if (!current) continue;
        const level = line.match(/^trust_level\s*=\s*['"]([^'"]+)['"]/);
        if (level) map.set(current, level[1].toLowerCase());
      }
      return map;
    },
    new Map()
  );
}

function codexState(dir) {
  const level = codexTrust().get(norm(dir));
  if (level === undefined) return UNKNOWN;
  return level === 'trusted' ? TRUSTED : SEEN;
}

// ─── gemini ────────────────────────────────────────────────────────────────
// projects.json records every folder gemini has been run in. Explicit trust
// only exists when the folder-trust feature is enabled, and then it lives in
// trustedFolders.json — where TRUST_PARENT means "and everything under it".
// The settings shapes below are the documented ones; no machine here has
// folder trust enabled, so unlike the rest of this file they are unverified.
function geminiSeen() {
  return readCached(
    path.join(os.homedir(), '.gemini', 'projects.json'),
    (text) => new Set(Object.keys(JSON.parse(text).projects || {}).map(norm)),
    new Set()
  );
}

function geminiTrustedFolders() {
  return readCached(
    path.join(os.homedir(), '.gemini', 'trustedFolders.json'),
    (text) => {
      const obj = JSON.parse(text);
      // Either a flat path→rule map or one nested under "rules".
      const rules = obj && typeof obj === 'object' && obj.rules && typeof obj.rules === 'object'
        ? obj.rules
        : obj || {};
      return Object.entries(rules).map(([p, rule]) => ({
        path: norm(p),
        rule: String(rule || '').toUpperCase()
      }));
    },
    []
  );
}

function geminiFolderTrustEnabled() {
  return readCached(
    path.join(os.homedir(), '.gemini', 'settings.json'),
    (text) => {
      const s = JSON.parse(text) || {};
      const ft = (s.security && s.security.folderTrust) || s.folderTrust;
      if (ft === true) return true;
      return !!(ft && typeof ft === 'object' && ft.enabled);
    },
    false
  );
}

function geminiState(dir) {
  const key = norm(dir);
  for (const entry of geminiTrustedFolders()) {
    if (entry.rule === 'TRUST_FOLDER' && entry.path === key) return TRUSTED;
    if (entry.rule === 'TRUST_PARENT' && isAncestorOf(entry.path, key)) return TRUSTED;
    if (entry.rule === 'DO_NOT_TRUST' && entry.path === key) return SEEN;
  }
  return geminiSeen().has(key) ? SEEN : UNKNOWN;
}

// ─── public ────────────────────────────────────────────────────────────────
const READERS = { claude: claudeState, codex: codexState, gemini: geminiState };

// Does this CLI keep an explicit trust record we can insist on? Where it does,
// "opened but never trusted" is not good enough. Gemini only writes one when
// folder trust is switched on, so with the feature off, having been opened
// there is the strongest signal that exists.
function enforcesTrust(cli) {
  if (cli === 'gemini') return geminiFolderTrustEnabled();
  return cli === 'claude' || cli === 'codex';
}

// Per-CLI state for one folder — what the picker shows on each row.
function repoTrust(dir) {
  const out = {};
  for (const cli of Object.keys(READERS)) out[cli] = READERS[cli](dir);
  return out;
}

// The gate. A folder the CLI has never seen is never handed over, and where the
// CLI records trust explicitly, that record has to say yes.
function canAddDir(cli, dir) {
  const read = READERS[cli];
  if (!read) return false;
  const state = read(dir);
  if (state === UNKNOWN) return false;
  return state === TRUSTED || !enforcesTrust(cli);
}

// Why a folder was refused, in words a user can act on.
function refusalReason(cli, dir) {
  const name = cli === 'claude' ? 'Claude Code' : cli.replace(/^./, (c) => c.toUpperCase());
  const state = (READERS[cli] || (() => UNKNOWN))(dir);
  if (state === UNKNOWN) {
    return `${name} has never been opened in ${path.basename(dir) || dir}. `
      + `Start a session there once (and accept its trust prompt), then it can be added as an extra repo.`;
  }
  return `${name} has been opened in ${path.basename(dir) || dir} but its trust prompt was never accepted. `
    + `Open a session there and accept it first.`;
}

module.exports = {
  UNKNOWN, SEEN, TRUSTED,
  repoTrust, canAddDir, refusalReason, enforcesTrust,
  // Exported for tests / debugging.
  _norm: norm
};
