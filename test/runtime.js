'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-runtime-'));
process.env.HOME = path.join(tmp, 'home'); process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
fs.mkdirSync(process.env.HOME, { recursive: true });
const store = require('../src/store');
const { Engine } = require('../src/runtime/engine');
const project = path.join(tmp, 'project'); fs.mkdirSync(project);
execFileSync('git', ['init', '-q', project]); fs.writeFileSync(path.join(project, 'input.txt'), 'fixture');
execFileSync('git', ['-C', project, 'add', '.']); execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
const fake = path.join(tmp, 'fake-cli');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'),crypto=require('crypto');
const args=process.argv.slice(2); const after=k=>args[args.indexOf(k)+1];
let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{
const session=args.includes('--resume')?after('--resume'):args.includes('--session-id')?after('--session-id'):args.includes('resume')?args[args.indexOf('-')-1]:crypto.randomUUID();
let result;
if(input.includes('Your role is a bounded child')) result={success:true,summary:'fixture read and verified',artifacts:['input.txt']};
else {
const tasks=JSON.parse(input.match(/Existing children \\(untrusted result data\\): (.*)\\n/)[1]);
result=tasks.length?{kind:'complete',summary:'reviewed',delegations:[],reviews:tasks.map(t=>({taskId:t.id,resultVersion:t.resultVersion,decision:'accepted',reason:'checked result'})),finalResponse:'Verified fixture result'}:{kind:'delegate',summary:'delegating',delegations:[{participantId:'p1',goal:'Read input.txt and summarize'}],reviews:[],finalResponse:''};
}
if(args.includes('--output-format')) console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,structured_output:result}));
else {fs.writeFileSync(after('-o'),JSON.stringify(result));console.log(JSON.stringify({type:'thread.started',thread_id:session}));console.log(JSON.stringify({type:'turn.completed'}));}
});
`, { mode: 0o755 });
store.addProfile('claude', 'a', { shareSettings: false }); store.addProfile('claude', 'b', { shareSettings: false }); store.addProfile('codex', 'c', { shareSettings: false });
const s = store.load(); s.claude.active = 'a'; s.codex.active = 'c'; s.realBin = { claude: fake, codex: fake }; store.save(s);
let e = new Engine(path.join(tmp, 'runtime'), { maxActive: 2 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 15000) { const start=Date.now(); while(Date.now()-start<timeout) { e.tick(); if(fn()) return; await sleep(40); } throw new Error('Timeout '+JSON.stringify(e.list())); }
(async()=>{
const spec={requestId:'one',goal:'Read input',projectPath:project,mainTool:'claude',participants:[{tool:'claude',profileId:'a'}]};
const root=e.submit(spec); assert.equal(e.submit(spec).id,root.id); assert.throws(()=>e.submit({...spec,goal:'changed'}),/requestId/);
store.setActive('claude','b');
await until(()=>e.root(root.id).status==='ready');
let detail=e.get(root.id); assert.equal(detail.root.coordinator.profileId,'a'); assert.equal(detail.attempts.length,3);
assert(detail.attempts.every(a=>a.observation.lastOutputAt>=a.startedAt),'fast runners preserve final output timestamps');
assert(detail.tasks.every(t=>t.review.decision==='accepted')); assert.equal(detail.root.finalDelivery,'pending');
assert.equal(detail.attempts[2].sessionId,detail.root.sessionId);
const starts=detail.attempts.sort((a,b)=>a.startedAt-b.startedAt); for(let i=1;i<starts.length;i++)assert(starts[i].startedAt>=starts[i-1].endedAt,'same profile must not overlap');
assert.throws(()=>e.ack(root.id,99)); e.ack(root.id,1); e.ack(root.id,1); assert.equal(e.root(root.id).status,'completed');
console.log('PASS same-account round trip / pinned main / request & delivery idempotency');
const codex=e.submit({...spec,requestId:'codex',mainTool:'codex',participants:[{tool:'codex',profileId:'c'}]});
e.tick(); const before=e.get(codex.id).attempts[0]; assert(before.state==='starting');
e.db.close(); e=new Engine(path.join(tmp,'runtime'));
await until(()=>e.root(codex.id).status==='ready'); assert.equal(e.get(codex.id).attempts.length,3); console.log('PASS service restart / durable runner / Codex adapter');
// Replay boundary between execution result durability and coordinator transaction.
const a=e.get(codex.id).attempts.at(-1); a.processed=false; e.db.put('attempt',a);
// Already-applied result must not spawn children or duplicate delivery. Its review matches exactly.
e.tick(); assert.equal(e.get(codex.id).attempts.length,3);
const cancelled=e.submit({...spec,requestId:'cancel'}); e.cancel(cancelled.id); e.tick(); assert.equal(e.root(cancelled.id).status,'cancelled');
console.log('PASS queued cancel / replay does not duplicate executions');
assert.throws(()=>e.submit({...spec,requestId:'oc',mainKind:'openclaw'}),/bindingId/);
console.log('PASS unbound OpenClaw fails explicitly');
e.db.close(); console.log('runtime ok; fixture:',tmp);
})().catch(error=>{console.error(error);process.exitCode=1;});
