// Bring dialog to front using Windows API, then open folder picker
const { execSync } = require('child_process');
try {
  // Flash the taskbar to get attention, then open dialog
  execSync('powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName(\'Microsoft.VisualBasic\')"', { stdio: 'ignore', timeout: 2000 });
} catch {}

const nfd = require('native-file-dialog');
try {
  const r = nfd.folder_dialog();
  process.stdout.write(r || '');
} catch {
  process.stdout.write('');
}
