const fs = require('fs');
const path = require('path');

// A collection is a named workspace: one primary repo, the extra repos that go
// with it, and the CLI it is meant to run. Kept next to sessions.json rather
// than in the browser so the same collections show up in the desktop app and in
// a plain browser tab, and survive a cleared site storage.
const STORE_DIR = require('./paths').DATA_DIR;
const STORE_PATH = path.join(STORE_DIR, 'collections.json');

const MAX_COLLECTIONS = 60;
const MAX_NAME = 60;

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function read() {
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    return Array.isArray(data.collections) ? data.collections : [];
  } catch {
    return [];
  }
}

function write(collections) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify({ collections }, null, 2), 'utf-8');
}

function list() {
  return read();
}

function repoEntry(r) {
  if (!r || typeof r.path !== 'string' || !r.path.trim()) return null;
  return { name: String(r.name || path.basename(r.path)).slice(0, 120), path: r.path };
}

// Upsert. A collection is identified by its id; saving under a name that is
// already taken replaces that one instead of leaving two rows the user cannot
// tell apart.
function save(input) {
  const primary = repoEntry(input && input.primary);
  const name = String((input && input.name) || '').trim().slice(0, MAX_NAME);
  if (!primary || !name) return { error: 'A collection needs a name and a primary repo.' };

  const extras = [];
  for (const e of (input.extras || [])) {
    const entry = repoEntry(e);
    if (entry && entry.path !== primary.path && !extras.some(x => x.path === entry.path)) extras.push(entry);
  }

  const collections = read();
  const byName = name.toLowerCase();
  const idx = collections.findIndex(c =>
    (input.id && c.id === input.id) || String(c.name || '').trim().toLowerCase() === byName);

  const record = {
    id: (idx >= 0 && collections[idx].id) || input.id || `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    cli: ['claude', 'codex', 'gemini'].includes(input.cli) ? input.cli : 'claude',
    primary,
    extras,
    createdAt: (idx >= 0 && collections[idx].createdAt) || Date.now(),
    updatedAt: Date.now()
  };

  if (idx >= 0) collections[idx] = record;
  else collections.unshift(record);

  write(collections.slice(0, MAX_COLLECTIONS));
  return { collection: record };
}

function remove(id) {
  const collections = read().filter(c => c.id !== id);
  write(collections);
  return collections;
}

module.exports = { list, save, remove };
