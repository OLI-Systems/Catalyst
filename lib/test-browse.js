const { Worker } = require('worker_threads');
const workerCode = `
  const { parentPort } = require('worker_threads');
  const nfd = require('native-file-dialog');
  try {
    const result = nfd.folder_dialog();
    parentPort.postMessage(result || 'EMPTY');
  } catch(e) { parentPort.postMessage('ERR:' + e.message); }
`;
const w = new Worker(workerCode, { eval: true });
w.on('message', m => { console.log('GOT:', m); process.exit(0); });
w.on('error', e => { console.log('WORKER ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 15000);
