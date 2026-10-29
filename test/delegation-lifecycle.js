'use strict';
// Real process trees, fake executables/profiles; no model or authentication calls.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-lifecycle-'));
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
const store = require('../src/store');
const fake = path.join(tmp, 'fake-cli');
fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs'),{spawn}=require('child_process');
const [mode,marker]=process.argv.slice(-2);
fs.writeFileSync(marker+'.cli',String(process.pid));
if(mode==='normal'){console.log('normal result');process.exit(17);}
if(mode==='quiet'){setTimeout(()=>{console.log('quiet result');},2200);}
else {
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",marker+'.descendant'],{stdio:['ignore','inherit','inherit']});
 const ready=setInterval(()=>{if(!fs.existsSync(marker+'.descendant'))return;clearInterval(ready);console.log('descendant ready');if(mode==='orphan')process.exit(0);},20);
 setInterval(()=>{},1000);
}
`, { mode: 0o755 });
for (const tool of ['claude', 'codex']) store.addProfile(tool, 'fixture', { shareSettings: false });
const state = store.load(); for (const tool of ['claude', 'codex']) state.realBin[tool] = fake; store.save(state);
const before = fs.readFileSync(require('../src/paths').STATE_FILE, 'utf8');
const cli = process.env.LIFECYCLE_TEST_CLI || path.resolve(__dirname, '../src/cli.js');
const active = [], knownPids = new Set();
const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
knownPids.add(unrelated.pid);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
async function until(check, timeout = 13000) { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await sleep(40); } throw Error('Delegation lifecycle did not settle within bound'); }
function start(tool, mode, { caller = false } = {}) {
  const marker = path.join(tmp, tool + '-' + mode + '-' + active.length);
  const args = [cli, 'delegate', tool, '--profile', 'fixture', '--', ...(tool === 'codex' ? ['exec'] : ['-p']), mode, marker];
  const parentCode = `const {spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,${JSON.stringify(args)},{stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(marker + '.wrapper')},String(child.pid));setInterval(()=>{},1000);`;
  const proc = spawn(process.execPath, caller ? ['-e', parentCode] : args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const run = { proc, marker, stdout: '', stderr: '', closed: false };
  proc.stdout.on('data', data => run.stdout += data); proc.stderr.on('data', data => run.stderr += data);
  proc.on('close', (code, signal) => Object.assign(run, { closed: true, code, signal }));
  active.push(run); knownPids.add(proc.pid); return run;
}
function pid(run, suffix) { const value = Number(fs.readFileSync(run.marker + suffix, 'utf8')); knownPids.add(value); return value; }
(async () => {
  try {
    for (const tool of ['claude', 'codex']) {
      const normal = start(tool, 'normal'); await until(() => normal.closed);
      assert.equal(normal.code, 17); assert.equal(normal.stdout.trim(), 'normal result');
      const quiet = start(tool, 'quiet'); await sleep(1300);
      assert(!quiet.closed, 'silence alone must not stop a live CLI'); await until(() => quiet.closed); assert.equal(quiet.code, 0);
      console.log('PASS ' + tool + ': original exit/output and quiet live task preserved');
      const orphan = start(tool, 'orphan');
      await until(() => fs.existsSync(orphan.marker + '.descendant'));
      const orphanPid = pid(orphan, '.descendant');
      await until(() => orphan.closed);
      assert.equal(orphan.code, 1, 'forced orphan cleanup is not success'); assert(!alive(orphanPid));
      assert.match(orphan.stderr, /live descendants/);
      console.log('PASS ' + tool + ': exited CLI cannot leave a pipe-holding descendant');
      const cancel = start(tool, 'running');
      await until(() => fs.existsSync(cancel.marker + '.descendant'));
      const cancelPid = pid(cancel, '.descendant'); cancel.proc.kill('SIGTERM');
      await until(() => cancel.closed); assert.equal(cancel.signal, 'SIGTERM'); assert(!alive(cancelPid));
      console.log('PASS ' + tool + ': cancellation stops owned descendants before wrapper termination');
      const caller = start(tool, 'running', { caller: true });
      await until(() => fs.existsSync(caller.marker + '.descendant'));
      const childPid = pid(caller, '.cli'), descendantPid = pid(caller, '.descendant'), wrapperPid = pid(caller, '.wrapper');
      caller.proc.kill('SIGKILL');
      await until(() => caller.closed);
      assert(!alive(childPid)); assert(!alive(descendantPid)); await until(() => !alive(wrapperPid));
      assert(alive(unrelated.pid), 'unrelated process group must remain alive');
      console.log('PASS ' + tool + ': lost caller is detected without cancelling unrelated tasks');
    }
    assert.equal(fs.readFileSync(require('../src/paths').STATE_FILE, 'utf8'), before);
  } finally {
    for (const run of active) for (const suffix of ['.cli', '.descendant', '.wrapper']) { try { pid(run, suffix); } catch {} }
    for (const value of knownPids) { try { process.kill(value, 'SIGKILL'); } catch {} }
    console.log('Fixture evidence: ' + tmp);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
