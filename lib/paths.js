const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.catalyst');
const LEGACY_DATA_DIR = path.join(os.homedir(), '.codey');

// One-time migration for installs that predate the Catalyst rename, which kept
// sessions.json and repos/ under ~/.codey. Runs on require (before any store
// reads its paths) so a single rename covers every consumer. Only moves when
// there is no ~/.catalyst yet, so a fresh install never clobbers real data.
try {
  if (fs.existsSync(LEGACY_DATA_DIR) && !fs.existsSync(DATA_DIR)) {
    fs.renameSync(LEGACY_DATA_DIR, DATA_DIR);
  }
} catch {
  // Best effort — if the rename fails the stores just create a fresh ~/.catalyst.
}

module.exports = { DATA_DIR, LEGACY_DATA_DIR };
