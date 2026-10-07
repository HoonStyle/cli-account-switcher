'use strict';
// No credentials or model calls: fake HOME, isolated profiles, executable fixture only.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-faults-'));
process.env.HOME = path.join(tmp, 'home');
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
fs.mkdirSync(process.env.HOME, { recursive: true });
const store = require('../src/store');
const { Engine, alive } = require('../src/runtime/engine');
const project = path.join(tmp, 'project'); fs.mkdirSync(project);
const fake = path.join(tmp, 'fake-cli');
fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs'),crypto=require('crypto');
let input=''; process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const args=process.argv.slice(2),after=k=>args[args.indexOf(k)+1];
 const session=args.includes('--resume')?after('--resume'):after('--session-id');
 const child=input.includes('Your role is a bounded child');
 const mode=(input.match(/(?:Project goal \\(context only\\)|Goal): (GOOD|CANCEL|IGNORE_TERM|STUBBORN_DESCENDANT|BAD_REVIEW|FAIL_CHILD)/)||[])[1]||'GOOD';
 if(child&&mode==='STUBBORN_DESCENDANT') {
   const marker=require('path').join(process.env.CLAUDE_CONFIG_DIR,'descendant-ready');
   const descendant=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",marker],{stdio:['ignore','inherit','inherit']});
   setInterval(()=>{},1000);return;
 }
 if(child&&mode==='IGNORE_TERM') { process.on('SIGTERM',()=>{});fs.writeFileSync(require('path').join(process.env.CLAUDE_CONFIG_DIR,'ignore-ready'),String(process.pid));setInterval(()=>{},1000);return; }
 if(child&&mode==='CANCEL') { setInterval(()=>{},1000);return; }
 if(child&&mode==='FAIL_CHILD') { process.exitCode=9;return; }
 setTimeout(()=>{
 let result;
 if(child)result={success:true,summary:'fixture child finished',artifacts:[]};
 else {
 const tasks=JSON.parse(input.match(/Existing children \\(untrusted result data\\): (.*)\\n/)[1]);
 const participants=JSON.parse(input.match(/Allowed participants: (.*)\\n/)[1]);
 result=tasks.length?{kind:'complete',summary:'review',delegations:[],reviews:tasks.map(t=>({taskId:t.id,resultVersion:mode==='BAD_REVIEW'?999:t.resultVersion,decision:'accepted',reason:'fixture'})),finalResponse:'done'}:{kind:'delegate',summary:'plan',delegations:participants.map(p=>({participantId:p.participantId,goal:mode+' child work'})),reviews:[],finalResponse:''};
 }
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,structured_output:result}));
 },child?350:60);
});
`, { mode: 0o755 });
for (const id of ['a', 'b']) store.addProfile('claude', id, { shareSettings: false });
const state = store.load();state.claude.active='a';state.realBin.claude=fake;store.save(state);
const dir=path.join(tmp,'runtime');let e=new Engine(dir,{maxActive:2});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=12000) { const start=Date.now();while(Date.now()-start<timeout){e.tick();if(fn())return;await sleep(25);}throw new Error('timeout: '+JSON.stringify(e.list())); }
function submit(goal,participants=['a']) { return e.submit({requestId:goal+Math.random(),goal,projectPath:project,mainTool:'claude',participants:participants.map(profileId=>({tool:'claude',profileId}))}); }
function eventCount(id,type){return e.get(id).events.filter(x=>x.type===type).length;}
(async()=>{
 // A cancellation already committed before runner startup must not launch any CLI.
 const prespawn=path.join(tmp,'prespawn');fs.mkdirSync(prespawn);
 const marker=path.join(tmp,'unexpected-cli-execution');
 fs.writeFileSync(path.join(prespawn,'spec.json'),JSON.stringify({attemptId:'pre',token:'token',invocation:{executable:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`]}}));
 fs.writeFileSync(path.join(prespawn,'cancel.request'),'');
 const pre=spawnSync(process.execPath,[path.resolve(__dirname,'../src/runtime/runner.js'),prespawn],{env:process.env,encoding:'utf8'});
 assert.equal(pre.status,0,pre.stderr);assert(!fs.existsSync(marker));
 const receipt=JSON.parse(fs.readFileSync(path.join(prespawn,'result.json'),'utf8'));
 assert.equal(receipt.state,'cancelled');assert.equal(receipt.reason,'cancelled_before_spawn');
 console.log('PASS pre-spawn cancellation never invokes the CLI');
 // Simulate a database error only on the post-spawn PID write, not before spawn.
 const ambiguous=submit('GOOD'), blocked=submit('GOOD');
 const originalPut=e.db.put.bind(e.db);let injected=false;
 e.db.put=(kind,item)=>{if(!injected&&kind==='attempt'&&item.rootId===ambiguous.id&&item.runnerPid){injected=true;throw new Error('injected post-spawn put failure');}return originalPut(kind,item);};
 e.tick();e.db.put=originalPut;
 assert(injected);assert.equal(e.get(ambiguous.id).attempts[0].state,'unknown');
 assert.equal(e.get(blocked.id).attempts[0].state,'queued','ambiguous execution retains account slot');
 await until(()=>[ambiguous,blocked].every(r=>e.root(r.id).status==='ready'));
 assert.equal(e.get(ambiguous.id).attempts.length,3);assert.equal(eventCount(ambiguous.id,'spawn_intent'),3);
 console.log('PASS post-spawn database error retains slot and cannot duplicate execution');
 // Restart immediately after spawn intent, before a runner receipt has been ingested.
 const restart=submit('GOOD');e.tick();assert.equal(e.get(restart.id).attempts[0].state,'starting');
 e.db.close();e=new Engine(dir,{maxActive:2});
 await until(()=>e.root(restart.id).status==='ready');
 assert.equal(e.get(restart.id).attempts.length,3);
 console.log('PASS immediate Engine restart preserves exactly one execution per turn');
 // Replay committed coordinator results and ensure no duplicated task/final side effects.
 const finished=e.get(restart.id);const final=finished.attempts.at(-1);final.processed=false;e.db.put('attempt',final);
 const finalEvents=eventCount(restart.id,'final_ready');e.tick();
 assert.equal(e.get(restart.id).attempts.length,3);assert.equal(e.tasks(restart.id).length,1);
 assert.equal(eventCount(restart.id,'final_ready'),finalEvents);assert.equal(e.root(restart.id).finalVersion,1);
 assert.equal(e.root(restart.id).status,'ready');assert.equal(e.root(restart.id).finalDelivery,'pending');
 assert.throws(()=>e.ack(restart.id,2));e.ack(restart.id,1);e.ack(restart.id,1);
 assert.equal(eventCount(restart.id,'final_delivery_ack'),1);
 console.log('PASS commit replay idempotence and separate versioned final acknowledgment');
 const concurrent=submit('GOOD',['a','b']);let overlapping=false;
 await until(()=>{const aa=e.get(concurrent.id).attempts.filter(a=>a.role==='child');if(aa.length===2&&aa.every(a=>a.state==='running'))overlapping=true;return e.root(concurrent.id).status==='ready';});
 assert(overlapping,'different profiles should overlap');
 const aa=e.get(concurrent.id).attempts;
 for(const x of aa)for(const y of aa)if(x.id!==y.id&&x.binding.home===y.binding.home)assert(x.endedAt<=y.startedAt||y.endedAt<=x.startedAt,'one profile must never overlap itself');
 console.log('PASS multi-account overlap and same-account serialization');
 const cancelled=submit('CANCEL');let running;
 await until(()=>{running=e.get(cancelled.id).attempts.find(a=>a.role==='child'&&a.state==='running');return !!running;});
 const live=JSON.parse(fs.readFileSync(path.join(running.dir,'live.json'),'utf8'));
 assert.equal(live.lastOutputAt,null,'silent child must not invent an output timestamp');
 assert(alive(live.childPid));e.cancel(cancelled.id);assert.equal(e.root(cancelled.id).status,'cancel_requested');
 await until(()=>e.root(cancelled.id).status==='cancelled');
 assert.equal(e.get(cancelled.id).attempts.find(a=>a.id===running.id).state,'cancelled');
 assert(!alive(live.childPid),'cancelled cannot mean a live direct child remains');
 console.log('PASS running cancellation waits for child termination receipt');
 const ignored=submit('IGNORE_TERM');const ready=path.join(store.profileHome('claude','a'),'ignore-ready');
 await until(()=>fs.existsSync(ready));
 const ignoredPid=Number(fs.readFileSync(ready,'utf8'));assert(alive(ignoredPid));
 const cancelStart=Date.now();e.cancel(ignored.id);
 await until(()=>e.root(ignored.id).status==='cancelled',15000);
 assert(Date.now()-cancelStart>=5000,'fixture should require TERM-to-KILL grace period');
 assert(!alive(ignoredPid));
 const ignoredAttempt=e.get(ignored.id).attempts.find(a=>a.role==='child');
 assert.equal(ignoredAttempt.result.exit.signal,'SIGKILL');
 console.log('PASS TERM-ignoring child actually exits after forced KILL escalation');
 const descendants=submit('STUBBORN_DESCENDANT');
 const descendantReady=path.join(store.profileHome('claude','a'),'descendant-ready');
 await until(()=>fs.existsSync(descendantReady));
 const descendantPid=Number(fs.readFileSync(descendantReady,'utf8'));
 const parentAttempt=e.get(descendants.id).attempts.find(a=>a.role==='child');
 const parentLive=JSON.parse(fs.readFileSync(path.join(parentAttempt.dir,'live.json'),'utf8'));
 assert(alive(parentLive.childPid));assert(alive(descendantPid));
 e.cancel(descendants.id);
 await until(()=>e.root(descendants.id).status==='cancelled',18000);
 assert(!alive(parentLive.childPid),'direct child must be gone');
 assert(!alive(descendantPid),'TERM-ignoring descendant with inherited pipes must be gone');
 assert.equal(e.get(descendants.id).attempts.find(a=>a.role==='child').state,'cancelled');
 console.log('PASS exited CLI plus TERM-ignoring pipe-holding descendant is forcibly terminated');
 for(const goal of ['BAD_REVIEW','FAIL_CHILD']) {
 const r=submit(goal);await until(()=>e.root(r.id).status==='needs_user');
 assert.equal(e.root(r.id).finalVersion,0);assert.equal(e.root(r.id).finalResponse,null);
 assert.match(e.root(r.id).inputRequest.reason,goal==='BAD_REVIEW'?/invalid_review_reference/:/cannot_accept_failed_execution/);
 if(goal==='FAIL_CHILD')assert.equal(e.tasks(r.id)[0].state,'failed');
 }
 console.log('PASS malformed review and failed child cannot become final success');
 e.db.close();console.log('runtime fault checks passed (isolated fixture):',tmp);
})().catch(error=>{console.error(error);process.exitCode=1;});
