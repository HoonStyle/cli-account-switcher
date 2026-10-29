'use strict';
// Exercise actual runner processes with isolated profiles and a fake CLI.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-parent-exit-'));
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const store = require('../src/store');
const { Engine, alive } = require('../src/runtime/engine');
const fake = path.join(tmp, 'fake-cli');
fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1];
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const mode=input.includes('ORPHAN_PIPE')?'pipe':input.includes('ORPHAN_CLOSED')?'ignore':input.includes('QUIET_LIVE')?'quiet':'normal';
 const finish=()=>console.log(JSON.stringify({type:'result',subtype:'success',session_id:session,structured_output:{kind:'needs_user',summary:'fixture completed',delegations:[],reviews:[]}}));
 if(mode==='quiet'){setTimeout(finish,2200);return;}
 if(mode==='normal'){finish();return;}
 const marker=path.join(process.env.CLAUDE_CONFIG_DIR,mode+'.pid');
 const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",marker],{stdio:mode==='pipe'?['ignore','inherit','inherit']:'ignore'});
 const ready=setInterval(()=>{if(!fs.existsSync(marker))return;clearInterval(ready);finish();process.exit(0);},20);
});
`, { mode: 0o755 });
store.addProfile('claude', 'fixture', { shareSettings: false });
const state = store.load(); state.claude.active = 'fixture'; state.realBin.claude = fake; store.save(state);
const engine = new Engine(path.join(tmp, 'runtime'), { maxActive: 1 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { engine.tick(); if (check()) return; await sleep(40); }
  throw Error('Lifecycle did not settle within bound');
}
function submit(requestId, goal = requestId) { return engine.submit({ requestId, goal, mainTool: 'claude', projectPath: tmp }); }
(async () => {
  try {
    const quiet = submit('QUIET_LIVE');
    await until(() => engine.attempts(quiet.id)[0].state === 'running');
    await sleep(1300); engine.tick();
    assert.equal(engine.attempts(quiet.id)[0].state, 'running', 'a quiet but live CLI must not be terminated');
    await until(() => engine.root(quiet.id).status === 'needs_user');
    assert.equal(engine.attempts(quiet.id)[0].state, 'succeeded');
    console.log('PASS quiet live CLI is preserved');
    for (const mode of ['ORPHAN_PIPE', 'ORPHAN_CLOSED']) {
      const root = submit(mode);
      await until(() => engine.attempts(root.id)[0].state === 'running');
      const next = submit(mode + '_FOLLOWUP_NORMAL', 'NORMAL');
      engine.tick();
      assert.equal(engine.attempts(next.id)[0].state, 'queued');
      await until(() => engine.root(root.id).status === 'needs_user');
      const attempt = engine.attempts(root.id)[0];
      assert.equal(attempt.state, 'failed', 'forced descendant cleanup must not become model success');
      assert.equal(attempt.result.reason, 'orphaned_descendants');
      const marker = path.join(store.profileHome('claude', 'fixture'), mode === 'ORPHAN_PIPE' ? 'pipe.pid' : 'ignore.pid');
      assert(!alive(Number(fs.readFileSync(marker, 'utf8'))), 'owned descendant must be gone before releasing the slot');
      await until(() => engine.root(next.id).status === 'needs_user');
      assert.equal(engine.attempts(next.id)[0].state, 'succeeded', 'same-account next work must proceed');
      console.log('PASS ' + mode + ': cleanup confirmed, failed receipt preserved, account slot reusable');
    }
  } finally {
    // Only clean up PIDs created by this isolated fixture, including pre-fix failures.
    for (const attempt of engine.attempts()) {
      if (attempt.dir) {
        try { const live = JSON.parse(fs.readFileSync(path.join(attempt.dir, 'live.json'))); process.kill(-live.childPid, 'SIGKILL'); } catch {}
      }
      if (attempt.runnerPid) { try { process.kill(attempt.runnerPid, 'SIGTERM'); } catch {} }
    }
    await sleep(100); engine.db.close();
    console.log('Fixture evidence: ' + tmp);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
