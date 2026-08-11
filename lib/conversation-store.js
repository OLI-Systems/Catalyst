// Resumable conversations belonging to each agent CLI, for the sessions modal.
//
// Every CLI stores this differently, and each layout below was read off real
// data on disk rather than assumed — except Gemini's session files, which no
// machine here has yet (see listGemini).
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LABEL = 90;
// Counting lines means reading the file; skip that for very large transcripts
// and report the size instead of a message count.
const MAX_COUNT_BYTES = 5 * 1024 * 1024;

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function tidy(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s;
}

// Injected wrappers rather than anything the user typed — a label made from
// these tells the reader nothing.
function isNoise(text) {
  return /^<(local-command|command-|system-reminder|caveat)/i.test(String(text).trim());
}

// Read the head of a JSONL transcript and return the first thing the user
// actually said. Claude and Codex use different schemas, both handled here:
//   claude: {type:'user', message:{content: string | [{type:'text',text}]}}
//   codex:  {type:'response_item', payload:{type:'message', role:'user',
//                                           content:[{type:'input_text',text}]}}
function firstUserMessage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(131072);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.slice(0, read).toString('utf8').split('\n');
    // A partial read can leave the final line truncated.
    if (lines.length > 1) lines.pop();

    const texts = (content) => {
      if (typeof content === 'string') return [content];
      if (!Array.isArray(content)) return [];
      return content
        .filter((p) => p && (p.type === 'text' || p.type === 'input_text') && p.text)
        .map((p) => p.text);
    };

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      let candidates = [];
      if (obj.type === 'user' && obj.message) {
        candidates = texts(obj.message.content);
      } else if (obj.type === 'response_item' && obj.payload
                 && obj.payload.type === 'message' && obj.payload.role === 'user') {
        candidates = texts(obj.payload.content);
      }

      for (const raw of candidates) {
        if (isNoise(raw)) continue;
        const label = tidy(raw);
        if (label) return label;
      }
    }
  } catch {
    // Unreadable transcript — fall through to the generic label.
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return '';
}

function countLines(file, size) {
  if (size > MAX_COUNT_BYTES) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) if (line.trim()) n++;
    return n;
  } catch {
    return null;
  }
}

// ─── Claude Code ────────────────────────────────────────────────────────────
// ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>/
//   <sessionId>.jsonl
// Confirmed on disk: C:\Source\repos\Codey → C--Source-repos-Codey
function claudeProjectDir(repoPath) {
  return path.join(
    os.homedir(), '.claude', 'projects',
    String(repoPath).replace(/[^a-zA-Z0-9]/g, '-')
  );
}

function listClaude(repoPath) {
  const dir = claudeProjectDir(repoPath);
  if (!fs.existsSync(dir)) return { supported: true, conversations: [] };

  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { supported: true, conversations: [] }; }

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const st = safeStat(file);
    if (!st || !st.isFile() || st.size === 0) continue;
    const id = name.replace(/\.jsonl$/, '');
    out.push({
      id,
      label: firstUserMessage(file) || 'Untitled conversation',
      updatedAt: st.mtimeMs,
      messages: countLines(file, st.size),
      bytes: st.size,
      file
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return { supported: true, conversations: out };
}

// ─── Codex ──────────────────────────────────────────────────────────────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl — not grouped
// by project, so each file's recorded cwd has to be matched against the repo.
function codexSessionFiles() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return files;
}

// The first line of a Codex rollout is a session_meta record carrying both the
// working directory and the session id that `codex resume` accepts.
function codexMeta(file) {
  try {
    const fd = fs.openSync(file, 'r');
    // Generous: session_meta embeds the full instructions block, so this first
    // line runs to many kilobytes. Too small a read truncates it, JSON.parse
    // fails, and the session silently stops matching its repo.
    const buf = Buffer.alloc(524288);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    try { fs.closeSync(fd); } catch {}
    const head = buf.slice(0, read).toString('utf8');

    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'session_meta' && obj.payload) {
        return { cwd: obj.payload.cwd || null, id: obj.payload.session_id || obj.payload.id || null };
      }
    }

    // Fallback for a first line longer than the read above: scrape the two
    // fields directly rather than dropping the session.
    const cwd = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const id = head.match(/"session_id"\s*:\s*"([^"]+)"/);
    if (cwd || id) {
      return {
        cwd: cwd ? JSON.parse('"' + cwd[1] + '"') : null,
        id: id ? id[1] : null
      };
    }
  } catch {}
  return null;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  try { return norm(a) === norm(b); } catch { return false; }
}

function listCodex(repoPath) {
  const out = [];
  for (const file of codexSessionFiles()) {
    const meta = codexMeta(file);
    if (!meta || !samePath(meta.cwd, repoPath)) continue;
    const st = safeStat(file);
    if (!st || st.size === 0) continue;
    // Prefer the recorded session id; fall back to the uuid in the filename.
    const fromName = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const id = meta.id || (fromName && fromName[1]);
    if (!id) continue;
    out.push({
      id,
      label: firstUserMessage(file) || 'Untitled conversation',
      updatedAt: st.mtimeMs,
      messages: countLines(file, st.size),
      bytes: st.size,
      file
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return { supported: true, conversations: out };
}

// ─── Gemini CLI ─────────────────────────────────────────────────────────────
// ~/.gemini/projects.json maps a lowercased repo path to a project name, whose
// history lives in ~/.gemini/history/<name>/.
//
// `gemini --list-sessions` would be the proper source, but it refuses to run
// without an auth method configured, so it cannot be relied on from here. No
// machine available had any Gemini sessions recorded, so the on-disk session
// file format is unverified: this reports what it finds and says so rather than
// guessing at a parser.
function geminiProjectName(repoPath) {
  try {
    const p = path.join(os.homedir(), '.gemini', 'projects.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = j.projects || {};
    const want = String(repoPath).toLowerCase();
    for (const [k, v] of Object.entries(map)) {
      if (String(k).toLowerCase() === want) return v;
    }
  } catch {}
  return null;
}

function listGemini(repoPath) {
  const name = geminiProjectName(repoPath);
  if (!name) return { supported: true, conversations: [] };

  const dir = path.join(os.homedir(), '.gemini', 'history', name);
  if (!fs.existsSync(dir)) return { supported: true, conversations: [] };

  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { supported: true, conversations: [] }; }

  for (const file of entries) {
    if (file.startsWith('.')) continue; // .project_root marker
    const full = path.join(dir, file);
    const st = safeStat(full);
    if (!st || !st.isFile() || st.size === 0) continue;
    out.push({
      id: path.basename(file).replace(/\.[^.]+$/, ''),
      label: firstUserMessage(full) || path.basename(file),
      updatedAt: st.mtimeMs,
      messages: null,
      bytes: st.size,
      file,
      // Gemini resumes by index, not id, so the UI must not offer a
      // one-click resume it cannot honour.
      resumeByIndexOnly: true
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    supported: true,
    conversations: out,
    note: out.length
      ? 'Gemini resumes by position rather than id, so pick from its own picker with --resume.'
      : null
  };
}

const LISTERS = { claude: listClaude, codex: listCodex, gemini: listGemini };

function list(cli, repoPath) {
  const fn = LISTERS[cli];
  if (!fn || !repoPath) return { supported: false, conversations: [] };
  try {
    return fn(repoPath);
  } catch (err) {
    return { supported: false, conversations: [], note: 'Could not read history: ' + err.message };
  }
}

// Deletes the transcript files for this repo + CLI. Destructive and not
// recoverable, so callers must confirm with the user first.
function clear(cli, repoPath) {
  const { conversations } = list(cli, repoPath);
  let removed = 0;
  const errors = [];
  for (const c of conversations) {
    if (!c.file) continue;
    try { fs.rmSync(c.file, { force: true }); removed++; }
    catch (e) { errors.push(`${path.basename(c.file)}: ${e.message}`); }
  }
  return { removed, errors };
}

module.exports = { list, clear, claudeProjectDir, geminiProjectName };
