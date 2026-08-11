const { execSync, execFile, execFileSync } = require('child_process');

const CRED_TARGET = 'Catalyst:AzureDevOps:PAT';
const GH_CRED_TARGET = 'Catalyst:GitHub:PAT';
const ACCOUNT = 'catalyst';

// null = not loaded yet; '' = known absent. Caching the miss matters: every PTY
// spawn calls loadPAT, and a cache miss costs a synchronous backend spawn.
let _cachedPat = null;
let _cachedGhPat = null;

// ---------------------------------------------------------------------------
// Windows backend — Credential Manager via PowerShell PasswordVault.
// Kept EXACTLY as-is; do not regress Windows.
// ---------------------------------------------------------------------------

// Single-quoted PowerShell string literal — no interpolation, no injection.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Run a PowerShell script via -EncodedCommand so the secret never touches
// disk or the visible command line as plaintext.
function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    encoding: 'utf-8',
    windowsHide: true,
    // Without this, execSync inherits stderr — PowerShell serializes redirected
    // streams as CLIXML there, which would echo the secret into the app log.
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

// Async variant — a PowerShell spawn costs 0.5–3s and the sync version blocks
// the event loop (freezing every live terminal). Used by prewarm() and saves.
function runPowerShellAsync(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf-8', windowsHide: true },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

// Script builders parameterized by Credential Manager target.
function saveScriptFor(target, pat) {
  return [
    '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]',
    '$vault = New-Object Windows.Security.Credentials.PasswordVault',
    'try {',
    `  $old = $vault.Retrieve(${psQuote(target)}, 'catalyst')`,
    '  $vault.Remove($old)',
    '} catch {}',
    `$cred = New-Object Windows.Security.Credentials.PasswordCredential(${psQuote(target)}, 'catalyst', ${psQuote(pat)})`,
    '$vault.Add($cred)',
    'Write-Output "OK"'
  ].join('\r\n');
}

function loadScriptFor(target) {
  return [
    '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]',
    '$vault = New-Object Windows.Security.Credentials.PasswordVault',
    'try {',
    `  $cred = $vault.Retrieve(${psQuote(target)}, 'catalyst')`,
    '  $cred.RetrievePassword()',
    // Write-Output, not Write-Host: the information stream gets serialized as
    // CLIXML onto stderr under redirected hosts, which would leak the secret.
    '  Write-Output $cred.Password',
    '} catch {',
    '  Write-Output ""',
    '}'
  ].join('\r\n');
}

function deleteScriptFor(target) {
  return [
    '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]',
    '$vault = New-Object Windows.Security.Credentials.PasswordVault',
    'try {',
    `  $old = $vault.Retrieve(${psQuote(target)}, 'catalyst')`,
    '  $vault.Remove($old)',
    '} catch {}',
    'Write-Output "OK"'
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Cross-platform backend abstraction. Each function branches on platform and
// never interpolates the secret into a shell string: Windows uses
// -EncodedCommand, macOS passes it as an argv arg to `security`, Linux writes
// it to `secret-tool` stdin.
// ---------------------------------------------------------------------------

// Persist a secret (async). Resolves on success, rejects on failure.
function storeSecret(service, value) {
  if (process.platform === 'win32') {
    return runPowerShellAsync(saveScriptFor(service, value)).then(() => undefined);
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      // -U updates the item if it already exists; -w passes the secret as an
      // argv arg (not shell-interpolated).
      execFile('security',
        ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', value],
        { windowsHide: true },
        (err) => err ? reject(err) : resolve(undefined));
    });
  }
  // Linux best-effort: libsecret via secret-tool, secret on stdin.
  return new Promise((resolve, reject) => {
    const child = execFile('secret-tool',
      ['store', '--label=Catalyst', 'service', service, 'account', ACCOUNT],
      { windowsHide: true },
      (err) => err ? reject(err) : resolve(undefined));
    child.on('error', reject);
    try {
      child.stdin.end(String(value));
    } catch (e) {
      reject(e);
    }
  });
}

// Read a secret (async). Resolves to the secret, or '' when absent / on error.
function readSecret(service) {
  if (process.platform === 'win32') {
    return runPowerShellAsync(loadScriptFor(service)).then(out => out.trim()).catch(() => '');
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('security',
        ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'],
        { windowsHide: true },
        (err, stdout) => resolve(err ? '' : String(stdout).replace(/\n$/, '')));
    });
  }
  return new Promise((resolve) => {
    execFile('secret-tool',
      ['lookup', 'service', service, 'account', ACCOUNT],
      { windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout).replace(/\n$/, '')))
      .on('error', () => resolve(''));
  });
}

// Sync read — only hit if a PAT is requested before prewarm() resolves.
function readSecretSync(service) {
  try {
    if (process.platform === 'win32') {
      return runPowerShell(loadScriptFor(service)).trim();
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('security',
        ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'],
        { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return String(out).replace(/\n$/, '');
    }
    const out = execFileSync('secret-tool',
      ['lookup', 'service', service, 'account', ACCOUNT],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).replace(/\n$/, '');
  } catch {
    return '';
  }
}

// Remove a secret (async). Resolves regardless of whether it existed; never
// rejects (delete-of-absent is not an error for our purposes).
function deleteSecret(service) {
  if (process.platform === 'win32') {
    return runPowerShellAsync(deleteScriptFor(service)).then(() => undefined).catch(() => undefined);
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('security',
        ['delete-generic-password', '-s', service, '-a', ACCOUNT],
        { windowsHide: true },
        () => resolve(undefined));
    });
  }
  return new Promise((resolve) => {
    const child = execFile('secret-tool',
      ['clear', 'service', service, 'account', ACCOUNT],
      { windowsHide: true },
      () => resolve(undefined));
    child.on('error', () => resolve(undefined));
  });
}

// ---------------------------------------------------------------------------
// Public surface (unchanged signatures/semantics).
// ---------------------------------------------------------------------------

// Populate both PAT caches off the request path (call once at server startup)
// so loadPAT/loadGithubPAT never fall back to a blocking backend spawn.
let _prewarmPromise = null;
function prewarm() {
  if (_prewarmPromise) return _prewarmPromise;
  _prewarmPromise = Promise.all([
    _cachedPat === null
      ? readSecret(CRED_TARGET).then(out => { if (_cachedPat === null) _cachedPat = out; }).catch(() => { if (_cachedPat === null) _cachedPat = ''; })
      : Promise.resolve(),
    _cachedGhPat === null
      ? readSecret(GH_CRED_TARGET).then(out => { if (_cachedGhPat === null) _cachedGhPat = out; }).catch(() => { if (_cachedGhPat === null) _cachedGhPat = ''; })
      : Promise.resolve(),
  ]).then(() => undefined);
  return _prewarmPromise;
}

function savePATSecure(pat) {
  // Optimistic: cache immediately so the session works, persist to the OS store
  // asynchronously (the sync spawn froze every live terminal).
  _cachedPat = pat;
  storeSecret(CRED_TARGET, pat).catch(err => {
    console.error('Failed to persist Azure PAT to the credential store:', err.message);
  });
  return true;
}

function loadPATSecure() {
  if (_cachedPat !== null) return _cachedPat;
  _cachedPat = readSecretSync(CRED_TARGET);
  return _cachedPat;
}

function hasPAT() {
  return loadPATSecure() !== '';
}

function saveGithubPAT(pat) {
  _cachedGhPat = pat;
  storeSecret(GH_CRED_TARGET, pat).catch(err => {
    console.error('Failed to persist GitHub PAT to the credential store:', err.message);
  });
  return true;
}

function loadGithubPAT() {
  if (_cachedGhPat !== null) return _cachedGhPat;
  _cachedGhPat = readSecretSync(GH_CRED_TARGET);
  return _cachedGhPat;
}

function hasGithubPAT() {
  return loadGithubPAT() !== '';
}

function clearCache() {
  _cachedPat = null;
  _cachedGhPat = null;
  _prewarmPromise = null;
}

// Remove BOTH stored secrets from the OS store and clear the in-memory cache.
function deleteAll() {
  _cachedPat = '';
  _cachedGhPat = '';
  _prewarmPromise = null;
  return Promise.all([
    deleteSecret(CRED_TARGET),
    deleteSecret(GH_CRED_TARGET),
  ]).then(() => undefined);
}

module.exports = {
  savePAT: savePATSecure,
  loadPAT: loadPATSecure,
  hasPAT,
  saveGithubPAT,
  loadGithubPAT,
  hasGithubPAT,
  clearCache,
  prewarm,
  deleteAll
};
