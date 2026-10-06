'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'task-output-'));
process.env.CLI_ACCOUNTS_ROOT=path.join(tmp,'accounts');process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS='1';
const store=require('../src/store'),{Engine}=require('../src/runtime/engine');
const {attemptOutput,STDOUT_LIMIT}=require('../src/runtime/output');
const fake=path.join(tmp,'fake-cli');
fs.writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2),after=k=>args[args.indexOf(k)+1],claude=args.includes('--output-format');
const session=claude?after('--session-id'):crypto.randomUUID(),release=path.join(__dirname,'release');
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 if(claude && (after('--output-format')!=='stream-json' || !args.includes('--verbose')))process.exit(9);
 console.log(JSON.stringify(claude?{type:'assistant',message:{content:[{type:'text',text:'실행 중 출력'}]}}:{type:'thread.started',thread_id:session}));
 if(!claude)console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'실행 중 출력'}}));
 console.error('stderr-live');
 const timer=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(timer);
 const result={kind:'needs_user',summary:'stream-complete',delegations:[],reviews:[],finalResponse:''};
 if(claude){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'x'.repeat(4*1024*1024+1000)}]}}));console.log(JSON.stringify({type:'result',subtype:'success',session_id:session,structured_output:result}));}
 else {fs.writeFileSync(after('-o'),JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed'}));}
 },30);
});
`,{mode:0o755});
for(const tool of ['codex','claude'])store.addProfile(tool,'fixture',{shareSettings:false});
const state=store.load();for(const tool of ['codex','claude']){state[tool].active='fixture';state.realBin[tool]=fake;}store.save(state);
const dir=path.join(tmp,'runtime'),engine=new Engine(dir);
async function until(fn){const end=Date.now()+12000;while(Date.now()<end){engine.tick();if(fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Streaming fixture timeout');}
(async()=>{try{
 for(const tool of ['codex','claude']){
  const r=engine.submit({requestId:tool,mainTool:tool,projectPath:tmp,goal:'Streaming fixture'});
  let a,output;await until(()=>{a=engine.attempts(r.id)[0];if(!a.dir)return false;output=engine.output(r.id,a.id);return output.stdout.includes('실행 중 출력');});
  assert(['starting','running'].includes(a.state));assert(output.stderr.includes('stderr-live'));assert(output.childPid>0);assert(!Object.hasOwn(output,'token'));assert(!fs.existsSync(path.join(a.dir,'stdout.log')),'output must arrive before process exit');
  const other=engine.submit({requestId:tool+'-other',mainTool:tool,projectPath:tmp,goal:'Other root'});engine.cancel(other.id);
  assert.throws(()=>engine.output(other.id,a.id),/Unknown attempt/);
  assert.throws(()=>engine.output(r.id,'../../state.json'),/Unknown attempt/);
  fs.writeFileSync(path.join(tmp,'release'),'yes');await until(()=>engine.root(r.id).status==='needs_user');
  assert.equal(engine.root(r.id).summary,'stream-complete');
  fs.renameSync(path.join(a.dir,'terminal.json'),path.join(a.dir,'terminal.json.saved'));
  const legacy=engine.output(r.id,a.id);assert(legacy.stdout.includes('turn.completed')||legacy.stdout.includes('stream-complete'));assert(Buffer.byteLength(legacy.stdout)<=STDOUT_LIMIT+3);
  fs.renameSync(path.join(tmp,'release'),path.join(tmp,'release-'+tool));engine.cancel(r.id);
 }
 const a={id:'fixture',rootId:'fixture',state:'succeeded',token:'match',dir:path.join(dir,'attempts','fixture')};fs.mkdirSync(a.dir);
 fs.writeFileSync(path.join(a.dir,'terminal.json'),JSON.stringify({attemptId:a.id,token:'wrong',stdout:'must-not-leak'}));
 const secret=path.join(tmp,'secret');fs.writeFileSync(secret,'must-not-leak');fs.symlinkSync(secret,path.join(a.dir,'stdout.log'));
 assert.equal(attemptOutput(dir,a).stdout,'');
 fs.renameSync(path.join(a.dir,'stdout.log'),path.join(a.dir,'stdout-link.saved'));fs.writeFileSync(path.join(a.dir,'stdout.log'),'x'.repeat(STDOUT_LIMIT*2));
 const bounded=attemptOutput(dir,a);assert(bounded.truncated);assert.equal(bounded.stdout.length,STDOUT_LIMIT);
 assert.throws(()=>attemptOutput(dir,{...a,dir:tmp}),/path mismatch/);
 console.log('PASS live stdout/stderr before exit, Claude streaming/ring/final result, ownership, bounded legacy tail, receipt and symlink protection');
}finally{for(const r of engine.list())if(!['completed','cancelled'].includes(r.status))engine.cancel(r.id);engine.db.close();}})().catch(e=>{console.error(e);process.exitCode=1});
