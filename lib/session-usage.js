// Context use and cost for a live claude session.
//
// The Manage panel used to show "CONTEXT — / —" forever: the markup existed but
// nothing ever filled it, and there was no data source to fill it from. This is
// that source. It comes from Claude Code's own transcript rather than from
// scraping the TUI, because the transcript records the CLI's own accounting:
// every assistant turn carries a `usage` object with the exact token counts the
// API billed for.
//
//   ~/.claude/projects/<encoded cwd>/<claude session id>.jsonl
//   {"type":"assistant","message":{"model":"claude-opus-5","usage":{
//      "input_tokens":2,"cache_creation_input_tokens":2545,
//      "cache_read_input_tokens":356388,"output_tokens":741,
//      "cache_creation":{"ephemeral_1h_input_tokens":2545,
//                        "ephemeral_5m_input_tokens":0}}},...}
//
// Context in use is the *last* turn's prompt size (input + both cache figures) —
// that is what is currently occupying the window. Cost is the sum across every
// turn, because tokens already spent stay spent.
//
// ~/.claude.json also holds per-project totals (lastCost, lastTotalInputTokens),
// but those describe the last *finished* session — checked while a session was
// live and lastSessionId pointed at the previous one — so they are no use here.
const fs = require('fs');
const path = require('path');
const conversationStore = require('./conversation-store');

// Prices are USD per million tokens, from the Anthropic pricing table (checked
// 2026-08-12). Cache multipliers: a read is 0.1x the input rate; a write is
// 1.25x for the 5-minute TTL and 2x for the 1-hour one — the transcript reports
// those two separately, so they are billed separately here.
//
// `window` is the model's context window. When a session is running with the
// 1M-context variant of a 200K model the transcript's model string does not say
// so, so an observed prompt larger than the window promotes it (see below)
// rather than rendering a nonsensical 179%.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

const MODELS = [
  { match: /^claude-(fable|mythos)-5/, window: 1000000, input: 10, output: 50 },
  { match: /^claude-opus-5/, window: 1000000, input: 5, output: 25 },
  { match: /^claude-opus-4-[678]/, window: 1000000, input: 5, output: 25 },
  { match: /^claude-opus-4/, window: 200000, input: 15, output: 75 },
  { match: /^claude-sonnet-5/, window: 1000000, input: 3, output: 15 },
  { match: /^claude-sonnet-4-6/, window: 1000000, input: 3, output: 15 },
  { match: /^claude-sonnet-4/, window: 200000, input: 3, output: 15 },
  { match: /^claude-haiku-4-5/, window: 200000, input: 1, output: 5 },
  { match: /^claude-3-5-haiku/, window: 200000, input: 0.8, output: 4 }
];

// Anything unrecognised gets Opus-tier pricing and a 200K window; the caller is
// told the rates were guessed so the UI can say "estimate" honestly.
const FALLBACK = { window: 200000, input: 5, output: 25, guessed: true };

// Reads / Writes / Commands for the Manage panel come from the same transcript,
// for the same reason. They used to be scraped off the PTY stream, and a TUI
// redraws the region it already drew, so every repaint re-counted the tool names
// still on screen: a fresh session read COMMANDS 1 before anything had run, and
// opening one modal walked it 1 → 6 → 17. In the transcript a tool call appears
// exactly once, as a tool_use content block on the assistant turn that made it.
//
// Only the CLI's own file and shell tools are mapped. MCP tools arrive as
// mcp__server__name and belong to no column, so they are left out rather than
// guessed at, and search tools (Grep, Glob) are not file reads. PowerShell is
// listed because that is the shell tool's name on Windows, where Catalyst runs.
const TOOL_COLUMNS = {
  Read: 'reads',
  NotebookRead: 'reads',
  Write: 'writes',
  Edit: 'writes',
  MultiEdit: 'writes',
  NotebookEdit: 'writes',
  Bash: 'commands',
  PowerShell: 'commands'
};

function priceFor(model) {
  const id = String(model || '');
  for (const m of MODELS) {
    if (m.match.test(id)) return m;
  }
  return FALLBACK;
}

// Read the tail of a file without loading the whole thing. Transcripts reach
// tens of megabytes on a long session, and only the last turn matters for
// context. Returns whole lines only — the first partial line is dropped.
function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Which transcript belongs to this session? Claude Code names the file after its
// own session id, which Catalyst is never told, so this has to be inferred —
// and "newest mtime in the project directory" is not good enough: another claude
// session running in the same repo (including the one editing this file) is also
// being appended to, and would win.
//
// Two cases, both deterministic:
//   resumed  — Catalyst asked for a conversation by id, and that id *is* the
//              transcript's filename. No inference needed.
//   fresh    — a new session creates a new file, so the transcript is one born
//              after the session started. Files created earlier belong to
//              somebody else no matter how recently they were written.
// Once resolved, the answer is pinned per session id: the file cannot change
// under a running session, and pinning keeps later polls off the guessing path.
const pinned = new Map();

// A little slack for clock/filesystem granularity between spawning the CLI and
// the CLI creating its file.
const BIRTH_SLACK_MS = 5000;

function statOf(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function findTranscript({ repoPath, startedAt, resumedFrom, sessionId }) {
  if (sessionId && pinned.has(sessionId)) {
    const file = pinned.get(sessionId);
    const stat = statOf(file);
    if (stat) return { file, size: stat.size };
    pinned.delete(sessionId); // deleted under us — fall through and re-resolve
  }

  const dir = conversationStore.claudeProjectDir(repoPath);

  if (resumedFrom) {
    const file = path.join(dir, `${resumedFrom}.jsonl`);
    const stat = statOf(file);
    if (stat) {
      if (sessionId) pinned.set(sessionId, file);
      return { file, size: stat.size };
    }
    return null;
  }

  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }

  let best = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const stat = statOf(file);
    if (!stat) continue;
    // Born before this session launched → another session's transcript.
    if (startedAt && stat.birthtimeMs && stat.birthtimeMs < startedAt - BIRTH_SLACK_MS) continue;
    if (startedAt && stat.mtimeMs < startedAt) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs, size: stat.size };
  }

  if (best && sessionId) pinned.set(sessionId, best.file);
  return best;
}

// Called when a session ends so the map does not grow for the life of the server.
function forget(sessionId) {
  pinned.delete(sessionId);
}

function promptTokens(usage) {
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function turnCostUSD(usage, price) {
  const creation = usage.cache_creation || {};
  // When the 1h/5m split is absent, treat the whole write as the cheaper 5m tier
  // rather than inflating the estimate.
  const write1h = creation.ephemeral_1h_input_tokens || 0;
  const write5m = creation.ephemeral_5m_input_tokens
    ?? Math.max(0, (usage.cache_creation_input_tokens || 0) - write1h);

  const inputM = price.input / 1e6;
  const outputM = price.output / 1e6;
  return (usage.input_tokens || 0) * inputM
    + (usage.cache_read_input_tokens || 0) * inputM * CACHE_READ
    + write5m * inputM * CACHE_WRITE_5M
    + write1h * inputM * CACHE_WRITE_1H
    + (usage.output_tokens || 0) * outputM;
}

// Cost needs every turn, so unlike context it cannot be read from the tail. The
// whole file is streamed in slices, and a session that has grown past this cap
// reports cost as partial rather than pretending to a total it did not read.
const MAX_COST_SCAN_BYTES = 24 * 1024 * 1024;

function scan(file, size) {
  const partial = size > MAX_COST_SCAN_BYTES;
  const text = partial
    ? readTail(file, MAX_COST_SCAN_BYTES).join('\n')
    : (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();

  let model = null;
  let effort = null;
  let contextTokens = 0;
  let costUSD = 0;
  let turns = 0;
  const tools = { reads: 0, writes: 0, commands: 0 };

  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    // Cheap pre-filter: parsing every line of a multi-megabyte transcript is the
    // expensive part, and only assistant turns carry usage.
    if (line.indexOf('"usage"') === -1) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj && obj.message;
    const usage = msg && msg.usage;
    if (obj.type !== 'assistant' || !usage) continue;

    turns++;
    costUSD += turnCostUSD(usage, priceFor(msg.model));
    // Sidechain tool calls are counted: a subagent's reads and writes are work
    // this session asked for, the same reason its tokens count toward cost. The
    // "usage" pre-filter above never hides one, because tool_use blocks only
    // ever ride on an assistant turn and every assistant turn carries usage.
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || block.type !== 'tool_use') continue;
        const column = TOOL_COLUMNS[block.name];
        if (column) tools[column]++;
      }
    }
    // Sidechain turns are subagents with their own window and possibly their own
    // model; they cost real money (so they count toward cost) but they are not
    // the main thread's context, model, or effort.
    if (!obj.isSidechain) {
      contextTokens = promptTokens(usage);
      if (msg.model) model = msg.model;
      // Recorded per turn by the CLI, so this tracks /effort as it is used.
      if (obj.effort) effort = String(obj.effort).toLowerCase();
    }
  }

  return { model, effort, contextTokens, costUSD, turns, tools, partial };
}

// Public: what the Manage panel needs for one session, or a reason it has none.
// `cli` matters — only claude keeps an accounting record we can read.
function sessionUsage({ cli, repoPath, startedAt, resumedFrom, sessionId }) {
  if (cli !== 'claude') {
    return { available: false, reason: `${cli === 'codex' ? 'Codex' : 'Gemini'} does not record token usage Catalyst can read` };
  }
  if (!repoPath) return { available: false, reason: 'No repository for this session' };

  const found = findTranscript({ repoPath, startedAt, resumedFrom, sessionId });
  if (!found) return { available: false, reason: 'Waiting for the first response' };

  const { model, effort, contextTokens, costUSD, turns, tools, partial } = scan(found.file, found.size);
  if (!turns) return { available: false, reason: 'Waiting for the first response' };

  const price = priceFor(model);
  // Promote the window when the observed prompt does not fit: that is how a
  // 1M-context variant announces itself, since the transcript's model string
  // carries no marker for it.
  let window = price.window;
  while (contextTokens > window && window < 1000000) window *= 5;

  // The Manage panel's model dropdown is keyed by family alias ("opus"), which is
  // also what /model takes — the transcript records the resolved id
  // ("claude-sonnet-5"), so reduce it to the family the UI speaks.
  const family = (String(model || '').match(/^claude-(fable|mythos|opus|sonnet|haiku)/) || [])[1] || null;

  return {
    available: true,
    model: model || null,
    modelFamily: family,
    // What the CLI is actually running, so the panel can stop showing markup
    // defaults that contradict the session.
    effort: effort || null,
    contextTokens,
    contextWindow: window,
    percent: window ? Math.min(100, (contextTokens / window) * 100) : 0,
    costUSD,
    turns,
    // Tool calls this conversation has made, by column. Truncated scans undercount
    // them exactly as they undercount cost, which costPartial already announces.
    tools,
    // The UI labels cost as an estimate when either flag is set.
    costPartial: partial,
    pricingGuessed: !!price.guessed
  };
}

module.exports = { sessionUsage, forget, _priceFor: priceFor };
