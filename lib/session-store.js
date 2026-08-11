const fs = require('fs');
const path = require('path');

const STORE_DIR = require('./paths').DATA_DIR;
const STORE_PATH = path.join(STORE_DIR, 'sessions.json');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

// In-memory cache — load() is on the hot path (every PTY spawn reads settings),
// so it must not hit disk each time. save() writes through synchronously.
let _cache = null;

function load() {
  if (_cache) return _cache;
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) {
    _cache = { rootDir: null, sessions: [] };
    return _cache;
  }
  try {
    _cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    _cache = { rootDir: null, sessions: [] };
  }
  return _cache;
}

function save(data) {
  _cache = data;
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// For when ~/.catalyst is wiped externally (reset-catalyst).
function invalidateCache() {
  _cache = null;
}

function addSession(session) {
  const data = load();
  data.sessions.push(session);
  save(data);
}

function removeSession(sessionId) {
  const data = load();
  data.sessions = data.sessions.filter(s => s.id !== sessionId);
  save(data);
}

function setRootDir(rootDir) {
  const data = load();
  data.rootDir = rootDir;
  save(data);
}

function getSettings() {
  const data = load();
  return data.settings || { azureOrg: '', azureProject: '' };
}

function saveSettings(settings) {
  const data = load();
  data.settings = { ...data.settings, ...settings };
  save(data);
}

module.exports = { load, save, addSession, removeSession, setRootDir, getSettings, saveSettings, invalidateCache };
