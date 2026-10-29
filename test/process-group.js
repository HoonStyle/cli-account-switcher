'use strict';
const assert = require('assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { spawn } = require('child_process');
const source = fs.readFileSync(path.join(__dirname, '../src/launch/process-group.js'), 'utf8');
function fixture({ platform = 'darwin', code = 'EPERM', listing = '', psError } = {}) {
  const permission = Object.assign(new Error(code), { code }); let probes = 0;
  const context = { module: { exports: {} }, process: { platform, kill() { throw permission; } }, require(id) {
    assert.equal(id, 'child_process'); return { execFileSync(exe, args) { probes++; assert.equal(exe, '/bin/ps'); assert.deepEqual(Array.from(args), ['-axo', 'pgid=,stat=']); if (psError) throw psError; return listing; } };
  } };
  vm.runInNewContext(source, context);
  return { ...context.module.exports, permission, probes: () => probes };
}
for (const listing of ['123 Z\n', '123 Z+\n456 S\n', '456 R\n']) {
  const f = fixture({ listing }); assert.equal(f.groupAlive(123), false); assert.equal(f.signalGroup(123, 'SIGKILL'), false);
}
for (const listing of ['123 S\n', '123 Z\n123 R+\n']) {
  const f = fixture({ listing }); assert.throws(() => f.groupAlive(123), e => e === f.permission);
  assert.throws(() => f.signalGroup(123, 'SIGTERM'), e => e === f.permission);
}
const unavailable = Error('ps unavailable');
assert.throws(() => fixture({ psError: unavailable }).groupAlive(123), e => e === unavailable);
assert.throws(() => fixture({ listing: 'unparseable' }).groupAlive(123), /Cannot verify/);
const absent = fixture({ code: 'ESRCH' }); assert.equal(absent.groupAlive(123), false); assert.equal(absent.probes(), 0);
const linux = fixture({ platform: 'linux' }); assert.throws(() => linux.groupAlive(123), e => e === linux.permission); assert.equal(linux.probes(), 0);
assert.throws(() => fixture().signalGroup(1, 'SIGKILL'), /Invalid owned/);
console.log('PASS zombie/empty group state, live permission denial, unavailable/malformed probe, ESRCH and non-Darwin behavior');

(async () => {
  if (process.platform !== 'darwin') return;
  const py = spawn('python3', ['-u', '-c', 'import os,sys\npid=os.fork()\nif pid==0:\n os.setsid();os._exit(0)\nprint(pid,flush=True)\nsys.stdin.read()\nos.waitpid(pid,0)\n'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '', stderr = '';
  py.stdout.on('data', b => { text += b; }); py.stderr.on('data', b => { stderr += b; });
  const ended = new Promise((resolve, reject) => { py.once('error', reject); py.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    const deadline = Date.now() + 5000; let pgid;
    while (Date.now() < deadline) {
      if (text.trim()) { pgid = Number(text.trim()); try { process.kill(-pgid, 0); } catch (e) { if (e.code === 'EPERM') break; throw e; } }
      await new Promise(r => setTimeout(r, 20));
    }
    assert(pgid > 1, stderr || 'zombie fixture not ready');
    assert.throws(() => process.kill(-pgid, 0), { code: 'EPERM' }, 'reproduce Darwin zombie-only killpg result');
    const group = require('../src/launch/process-group');
    assert.equal(group.groupAlive(pgid), false, 'exited zombie is not a live task');
    assert.equal(group.signalGroup(pgid, 'SIGKILL'), false, 'cleanup of exited group must not corrupt original exit status');
    console.log('PASS real Darwin zombie-only process group: original killpg EPERM reproduced; production lifecycle classifies it as exited');
  } finally { py.stdin.end(); const timeout = setTimeout(() => py.kill('SIGKILL'), 3000); await ended; clearTimeout(timeout); }
})().catch(e => { console.error(e); process.exitCode = 1; });
