'use strict';
// Isolated bridge contracts: no real accounts, providers, gateway or notifications.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-bridge-basics-'));
process.env.HOME = tmp;
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
const store = require('../src/store');
store.addProfile('claude', 'fixture', { shareSettings: false });
const state = store.load(); state.realBin.claude = process.execPath; store.save(state);
const { Engine } = require('../src/runtime/engine');
const auth = require('../src/runtime/bridge-auth');
const owner = { agentId: 'main', sessionKey: 'agent:main:discord:channel:fixture', sessionId: 'session-1', lifecycleRevision: 'epoch-1', deliveryTarget: { channel: 'discord', accountId: 'default', to: 'channel:fixture', threadId: null } };
const delegate = { kind: 'delegate', summary: 'read', reviews: [], delegations: [{ participantId: 'p1', goal: 'read fixture', resolvesTaskIds: [] }] };
let serial = 0;
function fixture() {
  const dir = path.join(tmp, String(++serial));
  let engine = new Engine(dir);
  const binding = engine.bindOpenClaw(owner);
  const spec = { requestId: 'basic', mainKind: 'openclaw', bindingId: binding.id, projectPath: tmp, goal: 'read', participants: [{ tool: 'claude', profileId: 'fixture' }] };
  const root = engine.submit(spec);
  return { dir, get e() { return engine; }, binding, root, spec, restart() { engine.db.close(); engine = new Engine(dir); }, close() { engine.db.close(); } };
}
function plan(f) {
  const pending = f.e.openClawPending().find(p => p.rootId === f.root.id);
  f.e.openClawDecide(f.root.id, owner, pending.attemptId, 1, delegate);
  return pending;
}
function childDone(f) {
  const a = f.e.attempts(f.root.id).find(a => a.role === 'child');
  a.state = 'running'; a.token = 'fixture-token'; f.e.db.put('attempt', a);
  f.e.consume(a, { attemptId: a.id, token: a.token, state: 'succeeded', result: { success: true, summary: 'read', artifacts: [] } });
  f.e.tick();
}
function ready(f) {
  plan(f); childDone(f);
  const p = f.e.openClawPending().find(p => p.rootId === f.root.id);
  const task = f.e.tasks(f.root.id)[0];
  const complete = { kind: 'complete', summary: 'reviewed', delegations: [], reviews: [{ taskId: task.id, resultVersion: task.resultVersion, decision: 'accepted', reason: 'checked fixture' }], finalResponse: 'done' };
  f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, complete);
  return { p, complete };
}
function settleSent(f, kind = 'final', version = 1) {
  const n = f.e.claimDelivery(f.root.id, kind, version, owner); assert(n);
  f.e.beginDelivery(f.root.id,kind,version,owner,n.claimToken);
  const receipt = auth.signDeliveryReceipt(f.dir, {deliveryId:n.id,rootId:n.rootId,kind,version,generation:n.generation,
    claimToken:n.claimToken,payloadHash:n.payloadHash,owner:n.owner,outcome:'sent',receiptVersion:1,
    channel:'discord',accountId:'default',destination:'channel:fixture',threadId:null,
    parts:[{messageId:'fixture-part-1',index:0,kind:'text'},{messageId:'fixture-part-2',index:1,kind:'text'}]});
  f.e.settleDelivery(receipt); return receipt;
}
const answer = (f, message = 'continue') => ({requestId:'answer-' + f.root.id,generation:1,inputVersion:f.e.root(f.root.id).inputRequest.version,message});
const cases = [];
const test = (name, run) => cases.push({ name, run });
test('submit, decision and acknowledgment are versioned and idempotent across restart', () => {
  const f = fixture(); try {
    assert.equal(f.e.submit(f.spec).id, f.root.id);
    assert.throws(() => f.e.submit({ ...f.spec, goal: 'different' }), /different content/);
    assert.throws(() => f.e.ack(f.root.id, 0, owner), {code:'DELIVERY_RECEIPT_REQUIRED'});
    const pending = plan(f); f.restart();
    f.e.openClawDecide(f.root.id, owner, pending.attemptId, 1, delegate);
    assert.equal(f.e.tasks(f.root.id).length, 1);
    assert.throws(() => f.e.openClawDecide(f.root.id, owner, pending.attemptId, 1, { ...delegate, summary: 'different' }), /Conflicting/);
    childDone(f);
    const p = f.e.openClawPending()[0], t = f.e.tasks(f.root.id)[0];
    f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, { kind: 'complete', summary: 'done', delegations: [], reviews: [{ taskId: t.id, resultVersion: 1, decision: 'accepted', reason: 'checked' }], finalResponse: 'done' });
    assert.throws(() => f.e.ack(f.root.id, 2, owner), {code:'DELIVERY_RECEIPT_REQUIRED'});
    assert.equal(f.e.root(f.root.id).finalDelivery, 'pending');
    assert.throws(() => f.e.ack(f.root.id, 1, owner), {code:'DELIVERY_RECEIPT_REQUIRED'});
    settleSent(f); f.e.ack(f.root.id, 1, owner); f.e.ack(f.root.id, 1, owner);
    assert.equal(f.e.db.events(f.root.id).filter(e => e.type === 'final_delivery_ack').length, 1);
  } finally { f.close(); }
});
test('cancel then reset still reaches cancelled and rejects late decisions', () => {
  const f = fixture(); try {
    const p = f.e.openClawPending()[0];
    f.e.cancel(f.root.id); f.e.suspendOpenClaw(f.binding.id, 'reset'); f.e.tick();
    assert.equal(f.e.root(f.root.id).status, 'cancelled');
    assert.equal(f.e.openClawPending().length, 0);
    assert.throws(() => f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, delegate), /mismatch|no longer pending/);
  } finally { f.close(); }
});
test('binding loss does not stop queued children or lose their results', () => {
  const f = fixture(); try {
    plan(f); f.e.suspendOpenClaw(f.binding.id, 'reset');
    let launched = 0;
    f.e.prepare = a => { launched++; a.state = 'running'; f.e.db.put('attempt', a); };
    f.e.tick(); assert.equal(launched, 1);
    childDone(f);
    assert.equal(f.e.root(f.root.id).status, 'awaiting_review');
    assert.equal(f.e.tasks(f.root.id)[0].result.summary, 'read');
    assert.equal(f.e.openClawPending().length, 0);
  } finally { f.close(); }
});
test('suspension preserves ready result but forbids local or revoked-owner delivery acknowledgment', () => {
  const f = fixture(); try {
    ready(f); f.e.suspendOpenClaw(f.binding.id, 'reset');
    assert.equal(f.e.root(f.root.id).status, 'ready');
    assert.equal(f.e.root(f.root.id).finalResponse, 'done');
    assert.throws(() => f.e.authorizeOpenClaw(f.root.id, owner), /mismatch/);
    assert.throws(() => f.e.ack(f.root.id, 1), /mismatch/);
    assert.throws(() => f.e.ack(f.root.id, 1, owner), /mismatch/);
    assert.equal(f.e.root(f.root.id).status, 'ready');
  } finally { f.close(); }
});
test('explicit same-session disable recovery never revives reset/delete revocation', () => {
  for (const reason of ['reset', 'delete', 'reset_or_missing']) { const f = fixture(); try {
    f.e.suspendOpenClaw(f.binding.id, 'disable');
    assert.equal(f.e.openClawPending().length, 0);
    assert.equal(f.e.bindOpenClaw(owner).id, f.binding.id);
    assert.equal(f.e.openClawPending().length, 1);
    f.e.suspendOpenClaw(f.binding.id, reason);
    f.e.suspendOpenClaw(f.binding.id, 'disable');
    assert.throws(() => f.e.bindOpenClaw(owner), /revoked/);
  } finally { f.close(); } }
});
test('complete-before-send survives restart as delivery-only work, never a new decision', () => {
  const f = fixture(); try {
    ready(f); f.restart();
    const p = f.e.openClawPending()[0];
    assert.equal(p?.kind, 'delivery'); assert.equal(p.finalVersion, 1);
    assert.equal(p.rootId, f.root.id);
    assert.throws(() => f.e.openClawWake(f.root.id, undefined, 'temporary outage', 1), /host delivery path/);
    assert.equal(f.e.root(f.root.id).deliveryWakeAttempts, undefined);
    assert.equal(f.e.root(f.root.id).finalDelivery, 'pending');
    assert.throws(() => f.e.ack(f.root.id, 1, owner), {code:'DELIVERY_RECEIPT_REQUIRED'});
    settleSent(f); f.restart();
    assert.equal(f.e.openClawPending()[0].noticeState, 'delivered');
    f.e.ack(f.root.id, 1, owner);
    assert.equal(f.e.openClawPending().length, 0);
  } finally { f.close(); }
});
test('missing binding ID cannot suspend any conversation', () => {
  const f = fixture(); try {
    const other = f.e.bindOpenClaw({ ...owner, sessionKey: 'agent:main:discord:channel:other' });
    assert.throws(() => f.e.suspendOpenClaw(undefined, 'reset'), /bindingId/);
    assert.equal(f.e.db.get('bridge', other.id).suspended, false);
    assert.equal(f.e.db.get('bridge', f.binding.id).suspended, false);
  } finally { f.close(); }
});
test('suspended coordinator rejects local continuation without creating unreachable attempts', () => {
  const f = fixture(); try {
    const p = f.e.openClawPending()[0];
    f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, { kind: 'needs_user', summary: 'input needed', reviews: [], delegations: [] });
    f.e.suspendOpenClaw(f.binding.id, 'disable');
    assert.throws(() => f.e.respond(f.root.id, answer(f)), /mismatch/);
    assert.equal(f.e.attempts(f.root.id).length, 1);
    f.e.bindOpenClaw(owner);
    assert.equal(f.e.root(f.root.id).inputRequest.reason, 'input needed');
    assert.throws(() => f.e.respond(f.root.id, answer(f)), /mismatch/);
    f.e.respond(f.root.id, answer(f), owner); assert.equal(f.e.openClawPending().length, 1);
  } finally { f.close(); }
});
test('OpenClaw coordinator instructions require tools and verified delivery, not CLI JSON output', () => {
  const f = fixture(); try {
    const instructions = f.e.get(f.root.id).coordinatorInstructions;
    assert.match(instructions, /action=decide/); assert.match(instructions, /host bridge exclusively delivers/); assert.match(instructions, /exact inputRequest.version/);
    assert.doesNotMatch(instructions, /Return only the requested JSON structure|Do not launch other agents or external messages/);
  } finally { f.close(); }
});

async function harness(f) {
  const { registerBridge } = await import('../plugins/openclaw/index.mjs');
  const h = { sessionId: owner.sessionId, lifecycleRevision: owner.lifecycleRevision, sends: [], events: [], wakes: 0, inject: async () => ({ id: 'injected', enqueued: true }) };
  const api = { logger: { warn() {} }, runtime: { agent: { session: { getSessionEntry: () => ({ sessionId: h.sessionId, lifecycleRevision:h.lifecycleRevision, delivery:{kind:'external',context:owner.deliveryTarget} }) } }, system: {
    enqueueSystemEvent(text, options) { h.events.push({ text, options }); }, requestHeartbeat() { h.wakes++; },
  } }, session: { workflow: { enqueueNextTurnInjection: input => h.inject(input) } }, registerTool(t) { h.tool = t; }, registerService(s) { h.service = s; }, lifecycle: { registerRuntimeLifecycle(l) { h.lifecycle = l; } } };
  const client = { ensureService: async () => {}, signDeliveryReceipt: p => auth.signDeliveryReceipt(f.dir,p), requestFromHost: async (method,p) => { const v=auth.assertHostRequest(f.e.hostReceiptKey,method,auth.hostRequest(f.dir,method,p)); return method === 'bridgeClaimDelivery' ? f.e.claimDelivery(v.id,v.kind,v.version,v.owner) : method === 'bridgeBeginDelivery' ? f.e.beginDelivery(v.id,v.kind,v.version,v.owner,v.claimToken) : f.e.settleDelivery(v.receipt); }, request: async (method, p = {}, options = {}) => {
    options.beforeWrite?.();
    if (h.failRequest) throw new Error('temporary socket outage');
    const e = f.e;
    if (method === 'bridgeBind') return e.bindOpenClaw(p);
    if (method === 'bridgePulse') return;
    if (method === 'bridgePending') return e.openClawPending();
    if (method === 'bridgeAllBindings') return e.db.all('bridge').filter(b => !b.suspended);
    if (method === 'bridgeSuspend') return e.suspendOpenClaw(p.bindingId, p.reason);
    if (method === 'bridgeWake') return e.openClawWake(p.id, p.attemptId, p.error, p.finalVersion);
    if (method === 'submit') return e.submit(p);
    e.authorizeOpenClaw(p.id, p.owner);
    if (method === 'bridgeQuery') return require('../src/runtime/query').queryReply(e.querySource(p.id, p.query), { ...p.query, action:'get' });
    if (method === 'bridgeGet') return e.get(p.id);
    if (method === 'bridgeDecide') return e.openClawDecide(p.id, p.owner, p.attemptId, p.generation, p.decision);
    if (method === 'bridgeAction') return e[p.action === 'ack_attention' ? 'ackAttention' : p.action](p.id, ['respond','resume'].includes(p.action) ? p.request : p.version, p.owner);
    throw new Error(`Unexpected method ${method}`);
  } };
  h.send = async params => {
    assert.equal(params.sessionId,owner.sessionId); assert.equal(params.lifecycleRevision,owner.lifecycleRevision);
    assert.deepEqual(params.target,owner.deliveryTarget);
    await h.beforeDispatch?.(params);
    await params.onPlatformSendDispatch(); params.assertCurrent();
    h.sends.push(params);
    const result = {status:'sent',deliveryReceiptVersion:1,idempotencyKey:params.idempotencyKey,target:params.target,sessionId:params.sessionId,lifecycleRevision:params.lifecycleRevision,
      receipt:{platformMessageIds:[`message-${h.sends.length}-1`,`message-${h.sends.length}-2`],sentAt:Date.now(),parts:[0,1].map(index=>({platformMessageId:`message-${h.sends.length}-${index+1}`,kind:'text',index,raw:{channel:'discord',target:{kind:'channel',id:'fixture'}}}))}};
    return h.transformReceipt ? h.transformReceipt(result) : result;
  };
  h.bridge = registerBridge(api, client, store, {sendSessionBoundMessageBatch:params=>h.send(params)}); h.bridge.startForTest();
  h.call = async (params, identity = owner) => { const reply = await h.tool.create({ ...identity, assertInvocationCurrent() {} }).execute('call', params); return { ...reply, details: JSON.parse(reply.content[0].text) }; };
  return h;
}
test('plugin happy path connects, submits, reviews and host sends before receipt-backed acknowledgment', async () => {
  const f = fixture(); try {
    const h = await harness(f);
    assert.equal((await h.call({ action: 'connect' })).details.binding.id, f.binding.id);
    const created = (await h.call({ action: 'submit', requestId: 'tool-submit', projectPath: tmp, goal: 'tool goal', participants: f.spec.participants })).details;
    const id = created.root.id, p = created.attempts[0];
    await h.call({ action: 'decide', id, attemptId: p.id, generation: 1, decision: delegate });
    const childFixture = { e: f.e, root: { id } }; childDone(childFixture);
    const detail = (await h.call({ action: 'get', id })).details;
    const t = detail.tasks[0], review = detail.attempts.find(a => a.state === 'external_wait');
    await h.call({ action: 'decide', id, attemptId: review.id, generation: 1, decision: { kind: 'complete', summary: 'done', delegations: [], reviews: [{ taskId: t.id, resultVersion: 1, decision: 'accepted', reason: 'checked' }], finalResponse: 'tool done' } });
    assert.equal((await h.call({ action: 'get', id })).details.root.finalDelivery, 'pending');
    await assert.rejects(h.call({ action:'ack',id,version:1 }),{code:'DELIVERY_RECEIPT_REQUIRED'});
    await h.bridge.poll(); assert.equal(h.sends.length,1);
    await h.call({ action: 'ack', id, version: 1 });
    assert.equal(f.e.root(id).status, 'completed');
    await h.bridge.poll(); assert.equal(h.sends.length,1);
  } finally { f.close(); }
});
test('all plugin task actions reject foreign agent, conversation and session owners', async () => {
  const f = fixture(); try {
    const h = await harness(f);
    const foreign = [{ ...owner, agentId: 'other', sessionKey: 'agent:other:discord:channel:fixture' }, { ...owner, sessionKey: 'agent:main:discord:channel:other' }, { ...owner, sessionId: 'other' }];
    for (const identity of foreign) for (const action of ['get', 'decide', 'cancel', 'respond', 'ack']) {
      await assert.rejects(h.call({ action, id: f.root.id, version: 1, message: 'x' }, identity), /mismatch|reset or removed/);
    }
    for (const identity of foreign) for (const view of ['summary', 'tasks', 'task', 'context', 'final']) {
      await assert.rejects(h.call({ action: 'get', view, id: f.root.id, taskId: 'any' }, identity), /mismatch|reset or removed/);
    }
    assert.equal(f.e.root(f.root.id).status, 'planning');
  } finally { f.close(); }
});
test('reset during awaited injection cannot wake replacement session', async () => {
  const f = fixture(); try {
    const h = await harness(f);
    h.inject = async () => { h.sessionId = 'replacement'; return { id: 'injected' }; };
    await h.bridge.poll(); assert.equal(h.events.length, 0); assert.equal(h.wakes, 0);
    const a = f.e.attempts(f.root.id)[0]; a.nextWakeAt = 0; f.e.db.put('attempt', a);
    await h.bridge.poll(); assert.equal(f.e.db.get('bridge', f.binding.id).suspended, true);
  } finally { f.close(); }
});
test('temporary missing session entry is retryable, not permanent revocation', async () => {
  const f = fixture(); try {
    const h = await harness(f); h.sessionId = undefined;
    await h.bridge.poll(); assert.equal(h.wakes, 0);
    assert.equal(f.e.db.get('bridge', f.binding.id).suspended, false);
    h.sessionId = owner.sessionId;
    await h.bridge.poll(); assert.equal(h.wakes, 1);
  } finally { f.close(); }
});
test('stop during injection and policy refusal send no event or heartbeat', async () => {
  for (const mode of ['stop', 'policy']) {
    const f = fixture(); try {
      const h = await harness(f);
      h.inject = async () => { if (mode === 'stop') h.service.stop(); return { id: mode === 'policy' ? '' : 'injected' }; };
      await h.bridge.poll(); assert.equal(h.events.length, 0); assert.equal(h.wakes, 0);
      assert.equal(f.e.root(f.root.id).finalDelivery, 'pending');
    } finally { f.close(); }
  }
});
test('transient bridge outage retries and lifecycle disable reconnects explicitly', async () => {
  const f = fixture(); try {
    const h = await harness(f); h.failRequest = true; await h.bridge.poll();
    assert.equal(h.wakes, 0); h.failRequest = false; await h.bridge.poll(); assert.equal(h.wakes, 1);
    await h.lifecycle.cleanup({ reason: 'disable' }); assert.equal(f.e.openClawPending().length, 0);
    await h.call({ action: 'connect' }); assert.equal(f.e.openClawPending().length, 1);
  } finally { f.close(); }
});
test('host delivery sends exact notice once and auto-acks receipt without a model wake', async () => {
  const f = fixture(); try {
    ready(f); const h = await harness(f);
    await h.bridge.poll();
    assert.equal(h.wakes,0); assert.equal(h.events.length,0); assert.equal(h.sends.length,1);
    assert.match(h.sends[0].idempotencyKey,/^switcher-[a-f0-9]{64}$/);
    assert.equal(h.sends[0].text,'done'); assert.equal(f.e.root(f.root.id).finalDelivery,'delivered');
    await h.bridge.poll(); assert.equal(h.sends.length,1);
    assert.equal(f.e.attempts(f.root.id).filter(a => a.role === 'main').length, 2);
  } finally { f.close(); }
});
test('same-session lifecycle rebind fences old owner and does not inject an old review', async () => {
  const f=fixture(); try {
    const h=await harness(f); h.lifecycleRevision='epoch-2'; let injections=0;
    h.inject=async()=>{injections++;return {id:'must-not-inject'};};
    f.e.bindOpenClaw({...owner,lifecycleRevision:'epoch-2'});
    assert.throws(()=>f.e.authorizeOpenClaw(f.root.id,owner),/binding mismatch/);
    await h.bridge.poll(); assert.equal(injections,0); assert.equal(h.wakes,0); assert.equal(h.events.length,0);
  } finally { f.close(); }
});
test('tool response replay exposes the original Q1 receipt without consuming Q2 or adding budget',async()=>{
  const f=fixture();try{
    const h=await harness(f),initial=f.e.openClawPending()[0];
    f.e.openClawDecide(f.root.id,owner,initial.attemptId,1,{kind:'needs_user',summary:'Q1',reviews:[],delegations:[]});
    const request={action:'respond',id:f.root.id,requestId:'stable-Q1',generation:1,inputVersion:1,message:'Q1 answer'};
    const first=(await h.call(request)).details;
    assert.deepEqual(first.inputResponseReceipt,{requestId:'stable-Q1',kind:'respond',generation:1,inputVersion:1});
    const pending=f.e.openClawPending().find(p=>p.kind==='review');
    f.e.openClawDecide(f.root.id,owner,pending.attemptId,1,{kind:'needs_user',summary:'Q2',reviews:[],delegations:[]});
    const before=f.e.root(f.root.id);
    for(const action of ['respond','resume']) await assert.rejects(h.call({...request,action,requestId:'late-'+action,...(action==='resume'?{extraRounds:1}: {})}),{code:'INPUT_REQUEST_CONFLICT'});
    const replay=(await h.call(request)).details;
    assert.deepEqual(replay.inputResponseReceipt,first.inputResponseReceipt);
    assert.equal(f.e.root(f.root.id).inputRequest.version,2);assert.equal(f.e.root(f.root.id).status,'needs_user');
    assert.equal(f.e.root(f.root.id).maxRounds,before.maxRounds);
  }finally{f.close();}
});
test('claim then Q1 consumption and Q2 creation before dispatch sends no obsolete question', async () => {
  const f=fixture(); try {
    const initial=f.e.openClawPending()[0];
    f.e.openClawDecide(f.root.id,owner,initial.attemptId,1,{kind:'needs_user',summary:'Q1',reviews:[],delegations:[]});
    const h=await harness(f);
    h.beforeDispatch=async()=>{
      f.e.respond(f.root.id,answer(f),owner);
      for(const a of f.e.attempts(f.root.id)){a.state='succeeded';a.processed=true;f.e.db.put('attempt',a);}
      f.e.db.transaction(()=>f.e.requestInput(f.e.root(f.root.id),{kind:'coordinator',reason:'Q2'}));
    };
    await h.bridge.poll();
    assert.equal(h.sends.length,0);assert.equal(h.wakes,0);assert.equal(f.e.root(f.root.id).inputRequest.version,2);
    const old=f.e.db.all('delivery').find(n=>n.kind==='attention'&&n.version===1);
    assert(['blocked','superseded'].includes(old.state),'definitively refused begin must settle without a sender or stranded claim');
    assert.equal(f.e.root(f.root.id).attentionDelivery,'pending');
  } finally { f.close(); }
});
test('host receipt wrong key, route, epoch or physical target never becomes a signed sent proof', async () => {
  const changes=[
    r=>({...r,idempotencyKey:'unrelated-send'}),r=>({...r,target:{...r.target,to:'channel:wrong'}}),
    r=>({...r,sessionId:'other'}),r=>({...r,lifecycleRevision:'epoch-2'}),
    r=>({...r,receipt:{...r.receipt,parts:r.receipt.parts.map(p=>({...p,raw:{channel:'discord',target:{kind:'channel',id:'wrong'}}}))}}),
    r=>({...r,receipt:{...r.receipt,parts:r.receipt.parts.map(p=>({...p,threadId:'wrong-thread'}))}}),
  ];
  for(const change of changes){const f=fixture();try{
    ready(f);const h=await harness(f);h.transformReceipt=change;
    await h.bridge.poll();assert.equal(h.sends.length,1);assert.equal(f.e.root(f.root.id).status,'ready');
    assert.equal(f.e.root(f.root.id).finalDelivery,'unknown');
    assert.throws(()=>f.e.ack(f.root.id,1,owner),{code:'DELIVERY_RECEIPT_REQUIRED'});
    f.restart();await h.bridge.poll();assert.equal(h.sends.length,1);assert.equal(h.wakes,0);
  }finally{f.close();}}
});
test('partial host delivery keeps known part receipt unknown across restart and never re-sends',async()=>{
  const f=fixture();try{
    ready(f);const h=await harness(f);
    h.transformReceipt=r=>({...r,status:'partial_failed',receipt:{...r.receipt,parts:r.receipt.parts.slice(0,1)}});
    await h.bridge.poll();assert.equal(f.e.root(f.root.id).finalDelivery,'unknown');
    const n=f.e.db.all('delivery').find(n=>n.kind==='final');assert.equal(n.receipt.statement.parts.length,1);
    f.restart();await h.bridge.poll();assert.equal(h.sends.length,1);assert.equal(f.e.root(f.root.id).status,'ready');
  }finally{f.close();}
});
test('OpenClaw decision storage failure rolls back and identical retry applies once', () => {
  const f = fixture(); try {
    const p = f.e.openClawPending()[0], put = f.e.db.put.bind(f.e.db);
    f.e.db.put = (kind, value) => { if (kind === 'task') throw new Error('injected storage failure'); return put(kind, value); };
    assert.throws(() => f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, delegate), /storage failure/);
    assert.equal(f.e.tasks(f.root.id).length, 0); assert.equal(f.e.root(f.root.id).round, 0);
    f.e.db.put = put; f.restart();
    f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, delegate);
    f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, delegate);
    assert.equal(f.e.tasks(f.root.id).length, 1);
  } finally { f.close(); }
});
(async () => {
  let failed = 0;
  for (const c of cases) {
    try { await c.run(); console.log(`PASS ${c.name}`); }
    catch (e) { failed++; console.error(`FAIL ${c.name}: ${e.stack}`); }
  }
  console.log(JSON.stringify({ passed: cases.length - failed, failed, total: cases.length, fixture: tmp }));
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
