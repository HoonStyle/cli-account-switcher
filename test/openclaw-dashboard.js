'use strict';
const assert = require('assert/strict');
const { createOpenClawMonitor, identity, projectDetail, stateOf, gatewayRead } = require('../src/dashboard/openclaw');
const { createDashboard } = require('../src/dashboard/server');
const row = { key:'agent:fixture:discord:channel:fixture',sessionId:'session-1',agentId:'fixture',groupChannel:'#fixture',status:'done',updatedAt:1000,model:'fixture-model' };
const messages = [
 {role:'assistant',timestamp:1100,__openclaw:{runId:'run-1'},content:[{type:'toolCall',id:'spawn',name:'spawn_agent',arguments:{arguments:JSON.stringify({task_name:'review',message:'PRIVATE_ARGUMENT'})}}]},
 {role:'toolResult',toolName:'spawn_agent',toolCallId:'spawn',timestamp:1101,__openclaw:{runId:'run-1'},content:[{type:'text',text:'{"task_name":"/root/review"}'}]},
 {role:'assistant',timestamp:1102,content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'text',text:'<img src=x onerror=alert(1)>'}]},
 {role:'toolResult',toolName:'bash',timestamp:1103,content:[{type:'text',text:'PRIVATE_TOOL_OUTPUT'}]},
];
let clock=5000, offline=false, reset=false, requests=[];
const read=async(method,params)=>{
 requests.push({method,params});
 if(offline)throw Error('private error details never returned');
 if(method==='sessions.list')return {sessions:[row],hasMore:false};
 if(method==='sessions.preview')return {previews:[{key:row.key,status:'ok',items:[{role:'user',text:'실제 요청'}]}]};
 if(method==='chat.history')return {sessionId:reset?'new-session':row.sessionId,sessionInfo:row,messages,hasMore:true};
 if(method==='audit.activity.list')return {events:[{sessionId:row.sessionId,runId:'run-1',kind:'agent_run',action:'agent.run.started',occurredAt:1000},{sessionId:row.sessionId,runId:'run-1',kind:'agent_run',action:'agent.run.finished',status:'succeeded',occurredAt:1200}]};
 throw Error('No other method is allowed');
};
(async()=>{
 await assert.rejects(gatewayRead('agent',{}),/Unsupported/);
 const monitor=createOpenClawMonitor({read,now:()=>clock,ttl:100});
 const [a,b]=await Promise.all([monitor.list(),monitor.list()]);assert.deepEqual(a,b);assert.equal(requests.length,2);
 assert.equal(a.roots[0].status,'observed_ended');assert.equal(a.roots[0].readOnly,true);assert.equal(a.roots[0].goal,'#fixture · 실제 요청');
 let d=await monitor.get(identity(row));assert.equal(d.root.source,'openclaw');assert.equal(d.tasks[0].state,'observed_unknown');assert.equal(d.external.runs[0].state,'observed_ended');assert(d.external.partialHistory);
 const serialized=JSON.stringify(d);for(const secret of ['PRIVATE_ARGUMENT','PRIVATE_REASONING','PRIVATE_TOOL_OUTPUT'])assert(!serialized.includes(secret));
 await assert.rejects(monitor.get('oc-'+ 'f'.repeat(32)),/조회 범위/);await assert.rejects(monitor.get('../config'),/Invalid/);
 clock+=101;offline=true;let x=await monitor.list();assert.equal(x.status,'offline');assert.equal(x.roots[0].status,'observed_stale');assert.equal(x.checkedAt,5000);
 await assert.rejects(monitor.get(identity(row)),/연결/);
 clock+=101;offline=false;x=await monitor.list();assert.equal(x.status,'ok');assert.equal(x.roots.length,1);
 reset=true;await assert.rejects(monitor.get(identity(row)),/재설정/);reset=false;
 const active={...row,status:'running',hasActiveRun:true};assert.equal(stateOf(active),'running');assert.notEqual(identity({...row,sessionId:'new'}),identity(row));
 d=projectDetail(row,{sessionInfo:row,messages:[...messages,{role:'toolResult',toolName:'list_agents',timestamp:1200,__openclaw:{runId:'run-1'},content:[{type:'text',text:'{"agents":[{"agent_name":"/root/review","agent_status":"completed"}]}'}]}]},null,null);
 assert.equal(d.tasks.length,1);assert.equal(d.tasks[0].state,'observed_ended');assert(d.external.auditUnavailable);
 const completed={role:'toolResult',toolName:'list_agents',timestamp:1200,__openclaw:{runId:'run-1'},content:[{type:'text',text:JSON.stringify({agents:[{agent_name:'/root/review',agent_status:'completed'}]})}]};
 const followup=[{role:'assistant',timestamp:1300,__openclaw:{runId:'run-1'},content:[{type:'toolCall',id:'follow',name:'followup_task',arguments:{target:'review',message:'PRIVATE_FOLLOWUP'}}]},{role:'toolResult',toolName:'followup_task',toolCallId:'follow',timestamp:1301,__openclaw:{runId:'run-1'},content:[{type:'text',text:'ok'}]}];
 const resumed=projectDetail(row,{messages:[...messages,completed,...followup]},null,null);
 assert.equal(resumed.tasks[0].state,'observed_unknown');assert.equal(resumed.tasks[0].updatedAt,1301);assert(!JSON.stringify(resumed).includes('PRIVATE_FOLLOWUP'));
 const otherRun={...completed,__openclaw:{runId:'run-0'}};
 const scoped=projectDetail(row,{messages:[otherRun,...messages,completed,...followup]},null,null);
 assert.equal(scoped.tasks.find(t=>t.runId==='run-0').state,'observed_ended','follow-up preserves other runs with the same child name');
 assert.equal(stateOf({...row,abortedLastRun:true,hasActiveRun:true}),'running');
 assert.equal(projectDetail(row,{sessionInfo:{key:'other',agentId:'other',sessionId:'other'},messages:[]},null,null).root.id,identity(row),'detail retains roster identity');

 let pages=0;const paged=createOpenClawMonitor({read:async(m,p)=>m==='sessions.list'?(pages++,{sessions:[{...row,key:'k'+p.offset}],hasMore:p.offset===0,nextOffset:100}):{previews:[]}});assert.equal((await paged.list()).roots.length,2);assert.equal(pages,2);
 const calls=[];
 const server=createDashboard({port:0,openclaw:monitor,runtime:{ensureService:async()=>{},request:async(m,p)=>{calls.push(m);return[];}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-CLI-Accounts':'dashboard'};
  assert.equal((await fetch(base+'/api/openclaw/tasks')).status,403);
  assert.equal((await fetch(base+'/api/openclaw/tasks',{headers:{...headers,Origin:'https://other.invalid'}})).status,403);
  const list=await(await fetch(base+'/api/openclaw/tasks',{headers})).json();assert.equal(list.status,'ok');
  assert.equal((await fetch(base+'/api/openclaw/tasks/'+identity(row),{headers})).status,200);
  assert.equal((await fetch(base+'/api/openclaw/tasks/'+identity(row)+'/cancel',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json'},body:'{}'})).status,404);
  for (const method of ['cancel','respond','ack']) assert.equal((await fetch(base+'/api/tasks/'+identity(row)+'/'+method,{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({message:'fixture',version:1})})).status,403);
  assert.equal(calls.length,0,'OpenClaw monitor never mutates the switcher runtime');
 }finally{await new Promise(r=>server.close(r));}
 console.log('PASS OpenClaw monitor: read-only methods, deduplicated polling, session reset, pagination, ended != completed, native receipts, safe projection, source outage/recovery and HTTP guards');
})().catch(e=>{console.error(e);process.exitCode=1;});
