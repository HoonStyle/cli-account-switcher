'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { randomUUID } = require('crypto');
const { Engine } = require('../src/runtime/engine');
const D = require('../src/runtime/delivery-state');
const A = require('../src/runtime/bridge-auth');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'switcher-structural-'));
  let e = new Engine(dir);
  t.after(()=>{e.db.close(); fs.rmSync(dir,{recursive:true,force:true});});
  const owner={agentId:'fixture',sessionKey:'agent:fixture:discord:channel:fixture',sessionId:'session-1',lifecycleRevision:'epoch-1',deliveryTarget:{channel:'discord',accountId:'default',to:'channel:fixture',threadId:null}};
  const binding=e.bindOpenClaw(owner);
  const root={id:randomUUID(),coordinator:{tool:'openclaw',bindingId:binding.id,...owner},participants:[],permission:'read-only',executionPolicy:'edit-only',status:'running',generation:1,round:0,maxRounds:2,finalVersion:0,finalDelivery:'pending',createdAt:1};
  e.saveRoot(root);
  return {dir,owner,id:root.id,get e(){return e;},restart(){e.db.close();e=new Engine(dir);},
    question(reason='Q1'){e.db.transaction(()=>e.requestInput(e.root(root.id),{kind:'coordinator',reason,summary:reason}));return e.root(root.id).inputRequest.version;},
    finish(){e.db.transaction(()=>{const r=e.root(root.id);r.status='ready';r.finalVersion++;r.finalResponse='한글 최종 결과 🦕';r.finalDelivery='pending';e.saveRoot(r);e.db.put('delivery',D.makeDelivery(r,'final',r.finalVersion));});},
    clearMain(){for(const a of e.attempts(root.id)){a.state='succeeded';a.processed=true;e.db.put('attempt',a);}},
  };
}
const response=(f,version,requestId=randomUUID())=>({requestId,generation:1,inputVersion:version,message:'answer'});
function proof(f,n,extra={}) {
  return A.signDeliveryReceipt(f.dir,{deliveryId:n.id,rootId:n.rootId,kind:n.kind,version:n.version,generation:n.generation,claimToken:n.claimToken,payloadHash:n.payloadHash,owner:n.owner,outcome:'sent',receiptVersion:1,channel:'discord',accountId:'default',destination:'channel:fixture',threadId:null,parts:[{messageId:'part-1'},{messageId:'part-2'}],...extra});
}
test('W01/W03: late Q1 responses cannot consume Q2; replay returns original receipt after restart',t=>{
  const f=fixture(t),v1=f.question(),req=response(f,v1);
  const accepted=f.e.respond(f.id,req,f.owner); f.clearMain();const v2=f.question('Q2');f.restart();
  assert.equal(v2,2);const before=f.e.root(f.id);
  for(const kind of ['respond','resume']) assert.throws(()=>f.e[kind](f.id,{...response(f,v1),...(kind==='resume'?{extraRounds:1,retryTaskIds:[]}: {})},f.owner),{code:'INPUT_REQUEST_CONFLICT'});
  assert.deepEqual(f.e.root(f.id),before);
  const replay=f.e.respond(f.id,req,f.owner);assert.deepEqual(replay,accepted);assert.equal(replay.inputResponseReceipt.inputVersion,1);assert.equal(f.e.root(f.id).inputRequest.version,2);
});
test('W02: two DB connections consume one question only once; no implicit legacy target',t=>{
  const f=fixture(t),v=f.question(),other=new Engine(f.dir);t.after(()=>other.db.close());
  assert.throws(()=>f.e.respond(f.id,'unversioned',f.owner),/versioned/);
  assert.throws(()=>f.e.respond(f.id,{message:'text',requestId:'legacy'},f.owner),{code:'INPUT_PRECONDITION_REQUIRED'});
  f.e.respond(f.id,response(f,v),f.owner);
  assert.throws(()=>other.respond(f.id,response(f,v),f.owner),{code:'INPUT_REQUEST_CONFLICT'});
  assert.equal(f.e.attempts(f.id).filter(a=>a.purpose==='continuation').length,1);
});
test('input consume and budget/continuation/receipt roll back together on commit failure',t=>{
  const f=fixture(t),v=f.question(),req={...response(f,v),extraRounds:1,retryTaskIds:[]};
  const event=f.e.db.event.bind(f.e.db);f.e.db.event=(id,type,body)=>{if(type==='input_consumed')throw Error('disk full fixture');return event(id,type,body);};
  assert.throws(()=>f.e.resume(f.id,req,f.owner),/disk full/);
  assert.equal(f.e.root(f.id).maxRounds,2);assert.equal(f.e.root(f.id).status,'needs_user');assert.equal(f.e.attempts(f.id).length,0);assert.equal(f.e.db.all('input_response').length,0);
  f.e.db.event=event;f.e.resume(f.id,req,f.owner);assert.equal(f.e.root(f.id).maxRounds,3);
  assert.throws(()=>f.e.resume(f.id,{...req,message:'changed'},f.owner),{code:'IDEMPOTENCY_CONFLICT'});
});
test('V07/V08: one durable sender, including service restart before receipt',t=>{
  const f=fixture(t);f.finish();const n=f.e.claimDelivery(f.id,'final',1,f.owner);assert(n);
  assert.equal(f.e.claimDelivery(f.id,'final',1,f.owner),null);f.e.beginDelivery(f.id,'final',1,f.owner,n.claimToken);f.restart();
  assert.equal(f.e.root(f.id).finalDelivery,'unknown');assert.equal(f.e.claimDelivery(f.id,'final',1,f.owner),null);
  assert.equal(f.e.openClawPending().length,0);assert.throws(()=>f.e.ack(f.id,1,f.owner),{code:'DELIVERY_RECEIPT_REQUIRED'});
  f.e.settleDelivery(proof(f,n));f.e.ack(f.id,1,f.owner);assert.equal(f.e.root(f.id).status,'completed');
});
test('V13/V14: raw/forged/cross-kind/cross-version/cross-target/partial receipts cannot complete',t=>{
  const f=fixture(t);f.finish();const n=f.e.claimDelivery(f.id,'final',1,f.owner);f.e.beginDelivery(f.id,'final',1,f.owner,n.claimToken);
  assert.throws(()=>f.e.settleDelivery({statement:{verified:true},signature:'0'.repeat(64)}),{code:'DELIVERY_RECEIPT_REQUIRED'});
  for(const extra of [{kind:'attention'},{version:2},{payloadHash:'wrong'},{claimToken:'other'},{owner:{...n.owner,sessionId:'other'}},{destination:'elsewhere'},{accountId:'other'},{parts:[]},{parts:[{messageId:'same'},{messageId:'same'}]}]) assert.throws(()=>f.e.settleDelivery(proof(f,n,extra)),/receipt|Receipt/);
  assert.equal(f.e.root(f.id).status,'ready');f.e.settleDelivery(proof(f,n,{outcome:'unknown',parts:[{messageId:'part-1'}]}));
  assert.throws(()=>f.e.ack(f.id,1,f.owner),{code:'DELIVERY_RECEIPT_REQUIRED'});
  assert.equal(f.e.db.get('delivery',n.id).receipt.statement.parts.length,1);
  f.e.settleDelivery(proof(f,n,{outcome:'unknown',parts:[]}));f.restart();
  assert.deepEqual(f.e.db.get('delivery',n.id).observedParts,[{messageId:'part-1'}]);
  assert.throws(()=>f.e.ack(f.id,1,f.owner),{code:'DELIVERY_RECEIPT_REQUIRED'});
});
test('V14: lost settle/ack response rejoins delivered receipt without another send',t=>{
  const f=fixture(t);f.finish();const n=f.e.claimDelivery(f.id,'final',1,f.owner),r=proof(f,n);f.e.beginDelivery(f.id,'final',1,f.owner,n.claimToken);
  f.e.settleDelivery(r);f.restart();const pending=f.e.openClawPending();assert.equal(pending[0].noticeState,'delivered');
  f.e.settleDelivery(r);assert.equal(f.e.claimDelivery(f.id,'final',1,f.owner),null);
  f.e.ack(f.id,1,f.owner);f.e.ack(f.id,1,f.owner);assert.equal(f.e.db.events(f.id).filter(e=>e.type==='final_delivery_ack').length,1);
});
test('W07: superseded-first forbids old send; send-first preserves old receipt, never settles Q2',t=>{
  const f=fixture(t),v1=f.question();f.e.respond(f.id,response(f,v1),f.owner);f.clearMain();f.question('Q2');
  assert.equal(f.e.claimDelivery(f.id,'attention',v1,f.owner),null);
  const n=f.e.claimDelivery(f.id,'attention',2,f.owner);f.e.beginDelivery(f.id,'attention',2,f.owner,n.claimToken);f.e.respond(f.id,response(f,2),f.owner);f.clearMain();f.question('Q3');
  f.e.settleDelivery(proof(f,n));assert.equal(f.e.db.get('delivery',n.id).state,'delivered');assert.equal(f.e.root(f.id).attentionDelivery,'pending');
  assert.throws(()=>f.e.ackAttention(f.id,2,f.owner),/no longer pending/);assert.equal(f.e.root(f.id).inputRequest.version,3);
});
test('ack_attention only acknowledges notification, not user input or model execution',t=>{
  const f=fixture(t),v=f.question(),n=f.e.claimDelivery(f.id,'attention',v,f.owner);f.e.beginDelivery(f.id,'attention',v,f.owner,n.claimToken);
  f.e.settleDelivery(proof(f,n));f.e.ackAttention(f.id,v,f.owner);f.e.ackAttention(f.id,v,f.owner);
  assert.equal(f.e.root(f.id).status,'needs_user');assert.equal(f.e.attempts(f.id).length,0);assert.equal(f.e.openClawPending().length,0);
});
test('signed receipt cannot revive a revoked or reset conversation binding',t=>{
  const f=fixture(t);f.finish();const n=f.e.claimDelivery(f.id,'final',1,f.owner);f.e.beginDelivery(f.id,'final',1,f.owner,n.claimToken);f.e.suspendOpenClaw(n.owner.bindingId,'reset');
  f.e.settleDelivery(proof(f,n));assert.throws(()=>f.e.ack(f.id,1,f.owner),/binding mismatch/);
  assert.throws(()=>f.e.claimDelivery(f.id,'final',1,{...f.owner,sessionId:'new'}),/binding mismatch/);assert.equal(f.e.root(f.id).status,'ready');
});
test('schema1 migration preserves IDs/budget and quarantines unverified historical delivery',t=>{
  const f=fixture(t);f.finish();let r=f.e.root(f.id);r.status='completed';r.finalDelivery='delivered';r.deliveryWakeAttempts=3;f.e.saveRoot(r);
  f.e.db.db.exec('PRAGMA user_version=1');f.restart();r=f.e.root(f.id);
  assert.equal(r.id,f.id);assert.equal(r.maxRounds,2);assert.equal(r.deliveryWakeAttempts,3);assert.equal(r.status,'ready');assert.equal(r.finalDelivery,'unknown');assert.equal(f.e.openClawPending().length,0);
  assert.equal(f.e.db.db.prepare('PRAGMA user_version').get().user_version,2);
});
test('host authorization is mandatory and cannot be reused for a different method/body',t=>{
  const f=fixture(t),params={id:f.id,kind:'final',version:1,owner:f.owner},p=A.hostRequest(f.dir,'bridgeClaimDelivery',params);
  assert.deepEqual(A.assertHostRequest(f.e.hostReceiptKey,'bridgeClaimDelivery',p),params);
  assert.throws(()=>A.assertHostRequest(f.e.hostReceiptKey,'bridgeSettleDelivery',p),/Authenticated/);
  assert.throws(()=>A.assertHostRequest(f.e.hostReceiptKey,'bridgeClaimDelivery',{...p,version:2}),/Authenticated/);
});
test('real bridge adapter sends multipart once, no model injection, exact session expectation',async t=>{
  const f=fixture(t);f.finish();let sends=0;
  const {deliverPending}=await import('../plugins/openclaw/delivery.mjs');
  const client={requestFromHost:async(method,p)=>method==='bridgeClaimDelivery'?f.e.claimDelivery(p.id,p.kind,p.version,p.owner):method==='bridgeBeginDelivery'?f.e.beginDelivery(p.id,p.kind,p.version,p.owner,p.claimToken):f.e.settleDelivery(p.receipt),signDeliveryReceipt:p=>A.signDeliveryReceipt(f.dir,p),request:async(_,p)=>f.e.ack(p.id,p.version,p.owner)};
  const api={logger:{warn(){}},runtime:{agent:{session:{getSessionEntry:()=>({...f.owner,delivery:{kind:'external',context:f.owner.deliveryTarget}})}}}};
  const sendHost=async p=>{await p.onPlatformSendDispatch();p.assertCurrent();sends++;assert.equal(p.sessionId,f.owner.sessionId);assert.equal(p.lifecycleRevision,'epoch-1');return {status:'sent',deliveryReceiptVersion:1,idempotencyKey:p.idempotencyKey,target:p.target,sessionId:p.sessionId,lifecycleRevision:p.lifecycleRevision,receipt:{parts:[{platformMessageId:'p1'},{platformMessageId:'p2'}]}};};
  const pending=f.e.openClawPending()[0];await Promise.all([deliverPending(api,client,pending,()=>false,sendHost),deliverPending(api,client,pending,()=>false,sendHost)]);
  assert.equal(sends,1);assert.equal(f.e.root(f.id).status,'completed');
});
test('same-session rebind with a new lifecycle cannot resurrect an old owner',t=>{
  const f=fixture(t);f.question();f.e.bindOpenClaw({...f.owner,lifecycleRevision:'epoch-2'});
  assert.throws(()=>f.e.authorizeOpenClaw(f.id,f.owner),/binding mismatch/);
});
test('claim is not dispatch: a newer question revokes an unredeemed delivery claim',t=>{
  const f=fixture(t);f.question();const n=f.e.claimDelivery(f.id,'attention',1,f.owner);
  f.e.respond(f.id,response(f,1),f.owner);f.clearMain();f.question('Q2');
  assert.throws(()=>f.e.beginDelivery(f.id,'attention',1,f.owner,n.claimToken),{code:'DELIVERY_SUPERSEDED'});
  f.e.settleDelivery(proof(f,n,{outcome:'not_sent'}));assert.equal(f.e.root(f.id).inputRequest.version,2);
  assert.equal(f.e.db.get('delivery',n.id).state,'blocked');
});
test('two simultaneous processes consume the displayed question only once',async t=>{
  const f=fixture(t),version=f.question();
  const {fork}=require('child_process');
  const script=path.join(f.dir,'consume-fixture.cjs');
  fs.writeFileSync(script,`const {Engine}=require(${JSON.stringify(require.resolve('../src/runtime/engine'))});const e=new Engine(process.argv[2]);process.send('ready');process.once('message',p=>{try{e.respond(p.id,p.request,p.owner);process.send({ok:true});}catch(error){process.send({ok:false,code:error.code});}finally{e.db.close();process.disconnect();}});`);
  const children=Array.from({length:2},()=>fork(script,[f.dir],{stdio:['ignore','ignore','ignore','ipc']}));
  t.after(()=>{for(const c of children) if(c.exitCode===null)c.kill();});
  await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);})));
  const outcomes=children.map(c=>new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);}));
  children.forEach(c=>c.send({id:f.id,owner:f.owner,request:response(f,version)}));
  const results=await Promise.all(outcomes);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'INPUT_REQUEST_CONFLICT');
  assert.equal(f.e.attempts(f.id).filter(a=>a.purpose==='continuation').length,1);
  assert.equal(f.e.db.all('input_response').length,1);
});
test('unknown send recovers solely from retained host receipt, never another dispatch',async t=>{
  const f=fixture(t);f.finish();const n=f.e.claimDelivery(f.id,'final',1,f.owner);f.e.beginDelivery(f.id,'final',1,f.owner,n.claimToken);f.restart();
  const pending=f.e.openClawPending(true)[0];assert.equal(pending.noticeState,'unknown');
  let reads=0;
  const {deliverPending}=await import('../plugins/openclaw/delivery.mjs');
  const client={requestFromHost:async(method,p)=>method==='bridgeReadDelivery'?f.e.readDeliveryForRecovery(p.id,p.kind,p.version,p.owner):method==='bridgeSettleDelivery'?f.e.settleDelivery(p.receipt):assert.fail('Recovery cannot claim or begin a new send'),signDeliveryReceipt:p=>A.signDeliveryReceipt(f.dir,p),request:async(_,p)=>f.e.ack(p.id,p.version,p.owner)};
  const api={logger:{warn(){}},runtime:{agent:{session:{getSessionEntry:()=>({...f.owner,delivery:{kind:'external',context:f.owner.deliveryTarget}})}}}};
  const readReceipt=async p=>{reads++;return {status:'sent',source:'retained-completion',deliveryReceiptVersion:1,idempotencyKey:p.idempotencyKey,target:p.target,sessionId:p.sessionId,lifecycleRevision:p.lifecycleRevision,receipt:{parts:[{platformMessageId:'original-message'}]}};};
  await deliverPending(api,client,pending,()=>false,()=>assert.fail('no new send'),readReceipt);
  assert.equal(reads,1);assert.equal(f.e.root(f.id).status,'completed');assert.equal(f.e.openClawPending(true).length,0);
});
test('T16: authenticated pre-dispatch rejection retries with a durable bound; stale sender cannot settle',t=>{
  const f=fixture(t);f.finish();let now=100000;f.e.now=()=>now;
  const first=f.e.claimDelivery(f.id,'final',1,f.owner);
  const rejected=proof(f,first,{outcome:'not_sent',parts:[]});
  f.e.settleDelivery(rejected);
  assert.equal(f.e.db.get('delivery',first.id).state,'pending');
  assert.equal(f.e.claimDelivery(f.id,'final',1,f.owner),null);assert.equal(f.e.openClawPending().length,0);
  f.restart();f.e.now=()=>now+=5000;
  const second=f.e.claimDelivery(f.id,'final',1,f.owner);assert.equal(second.sendAttempts,2);
  assert.throws(()=>f.e.settleDelivery(rejected),/identity mismatch/);
  f.e.settleDelivery(proof(f,second,{outcome:'not_sent',parts:[]}));
  const third=f.e.claimDelivery(f.id,'final',1,f.owner);assert.equal(third.sendAttempts,3);
  f.e.settleDelivery(proof(f,third,{outcome:'not_sent',parts:[]}));
  f.restart();f.e.now=()=>now+=5000;
  assert.equal(f.e.db.get('delivery',first.id).state,'blocked');
  assert.equal(f.e.claimDelivery(f.id,'final',1,f.owner),null);
});
