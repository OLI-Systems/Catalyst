// TypeSafe Jev support, for jev-kit (https://github.com/jonathanavis96/jev-kit).
//
// jev-kit wires TypeSafe's Jev model into Claude Code: Airlock judges tool calls,
// Belay re-checks finished work, and the rest of the kit reads the same
// TYPESAFE_API_KEY. Its key lookup takes the environment first, before any file
// (airlock/keyfile.py, step 1), and Claude Code's hooks inherit the session's
// environment. So Catalyst keeps the key in the OS credential store and hands it
// to every session it starts as TYPESAFE_API_KEY (session-manager.js enrichEnv):
// the kit's hooks pick it up there and the key never has to sit in jev-kit's
// plaintext env file.
//
// The key never goes back to the page. Settings learns only whether one is
// stored, and a save is checked against TypeSafe before it is kept.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const IS_WIN = process.platform === 'win32';
const API_HOST = 'api.typesafe.ai';
const API_PATH = '/v1/systemone';

// Ask TypeSafe whether the key is good without paying for an answer: the
// request carries an empty body, so a good key fails validation (422) and a bad
// one fails authentication (401). No model runs either way.
// Resolves { status: 'valid' | 'invalid' | 'unknown', detail }.
function verifyKey(key) {
  return new Promise((resolve) => {
    const body = '{}';
    const req = https.request({
      host: API_HOST,
      path: API_PATH,
      method: 'POST',
      timeout: 10000,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      const code = res.statusCode;
      if (code === 401 || code === 403) resolve({ status: 'invalid', detail: 'TypeSafe rejected this key.' });
      else if (code === 422 || code === 400 || (code >= 200 && code < 300)) resolve({ status: 'valid', detail: 'TypeSafe accepted this key.' });
      else if (code === 429 || code === 529) resolve({ status: 'unknown', detail: `TypeSafe is busy (HTTP ${code}); the key was not checked.` });
      else resolve({ status: 'unknown', detail: `TypeSafe answered HTTP ${code}; the key was not checked.` });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    // The error's text never includes the request headers, so the key cannot leak here.
    req.on('error', (err) => resolve({ status: 'unknown', detail: `Could not reach TypeSafe (${err.code || err.message}).` }));
    req.end(body);
  });
}

function home(...parts) {
  return path.join(os.homedir(), ...parts);
}

function appData(envName, ...fallback) {
  return process.env[envName] || home('AppData', ...fallback);
}

// Where jev-kit puts things, per docs/INSTALL-WINDOWS.md and docs/install.md.
function kitPaths() {
  if (IS_WIN) {
    const roaming = appData('APPDATA', 'Roaming');
    const local = appData('LOCALAPPDATA', 'Local');
    return {
      hook: path.join(local, 'airlock', 'airlock-hook.py'),
      mode: path.join(roaming, 'airlock', 'mode'),
      disabled: path.join(roaming, 'airlock', 'disabled'),
      keyFiles: [path.join(roaming, 'jev-kit', 'env'), path.join(roaming, 'airlock', 'env')],
    };
  }
  return {
    hook: home('.local', 'share', 'airlock', 'current', 'hooks', 'airlock.py'),
    mode: home('.config', 'airlock', 'mode'),
    disabled: home('.config', 'airlock', 'disabled'),
    keyFiles: [home('.config', 'jev-kit', 'env'), home('.config', 'airlock', 'env')],
  };
}

function readSmall(file) {
  try {
    return fs.readFileSync(file, 'utf-8').slice(0, 64 * 1024);
  } catch {
    return null;
  }
}

// What Settings shows about jev-kit on this machine. Reads only paths and the
// one-word mode file: never the kit's key file contents, only whether one exists.
function kitStatus() {
  const p = kitPaths();
  const isInstalled = fs.existsSync(p.hook);
  const settings = readSmall(home('.claude', 'settings.json')) || '';
  const isWired = /airlock/i.test(settings);
  const modeText = (readSmall(p.mode) || '').trim().toLowerCase();
  const isDisabled = fs.existsSync(p.disabled) || process.env.AIRLOCK_DISABLE === '1';
  return {
    isInstalled,
    isWired,
    // jev-kit's default is shadow: judge and log, block nothing.
    mode: isDisabled ? 'disabled' : (['shadow', 'enforce', 'off'].includes(modeText) ? modeText : (isInstalled ? 'shadow' : null)),
    hasKeyFile: p.keyFiles.some((f) => fs.existsSync(f)),
    repoUrl: 'https://github.com/jonathanavis96/jev-kit',
    installDoc: IS_WIN
      ? 'https://github.com/jonathanavis96/jev-kit/blob/main/docs/INSTALL-WINDOWS.md'
      : 'https://github.com/jonathanavis96/jev-kit/blob/main/docs/install.md',
  };
}

// A plausible key: no whitespace, printable, and a sane length. TypeSafe's own
// check (verifyKey) is the real test; this only stops pastes of the wrong thing.
function looksLikeKey(key) {
  return typeof key === 'string' && /^[\x21-\x7e]{16,512}$/.test(key);
}

module.exports = { verifyKey, kitStatus, looksLikeKey };
