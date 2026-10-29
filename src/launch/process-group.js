'use strict';
const { execFileSync } = require('child_process');

// Darwin killpg returns EPERM, not ESRCH, while a group contains only zombies.
// Those processes cannot execute or hold output pipes. Confirm the state instead
// of confusing an already-exited group with a live group we cannot signal.
function hasLiveMembers(pgid) {
  const output = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match) throw Error('Cannot verify process-group state');
    if (Number(match[1]) === pgid && !match[2].startsWith('Z')) return true;
  }
  return false;
}
function signalGroup(pgid, signal) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw Error('Invalid owned process group');
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (process.platform === 'darwin' && error.code === 'EPERM' && !hasLiveMembers(pgid)) return false;
    throw error;
  }
}
module.exports = { signalGroup, groupAlive: pgid => signalGroup(pgid, 0) };
