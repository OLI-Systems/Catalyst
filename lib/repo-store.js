const fs = require('fs');
const path = require('path');

const REPOS_DIR = path.join(require('./paths').DATA_DIR, 'repos');

function ensureDir() {
  if (!fs.existsSync(REPOS_DIR)) fs.mkdirSync(REPOS_DIR, { recursive: true });
}

function keyFor(repoPath) {
  return repoPath.replace(/[\\/:*?"<>|]/g, '_');
}

function filePath(repoPath) {
  return path.join(REPOS_DIR, keyFor(repoPath) + '.json');
}

function load(repoPath) {
  ensureDir();
  const fp = filePath(repoPath);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function save(repoPath, settings) {
  ensureDir();
  fs.writeFileSync(filePath(repoPath), JSON.stringify(settings, null, 2), 'utf-8');
}

module.exports = { load, save };
