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
const owner = { agentId: 'main', sessionKey: 'agent:main:discord:channel:fixture', sessionId: 'session-1' };
const delegate = { kind: 'delegate', summary: 'read', reviews: [], delegations: [{ participantId: 'p1', goal: 'read fixture', resolvesTaskIds: [] }] };
let serial = 0;
function fixture() {
  const dir = path.join(tmp, String(++serial));
  let engine = new Engine(dir);
  const binding = engine.bindOpenClaw(owner);
  const spec = { requestId: 'basic', mainKind: 'openclaw', bindingId: binding.id, projectPath: tmp, goal: 'read', participants: [{ tool: 'claude', profileId: 'fixture' }] };
  const root = engine.submit(spec);
  return { get e() { return engine; }, binding, root, spec, restart() { engine.db.close(); engine = new Engine(dir); }, close() { engine.db.close(); } };
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
const cases = [];
const test = (name, run) => cases.push({ name, run });
test('submit, decision and acknowledgment are versioned and idempotent across restart', () => {
  const f = fixture(); try {
    assert.equal(f.e.submit(f.spec).id, f.root.id);
    assert.throws(() => f.e.submit({ ...f.spec, goal: 'different' }), /different content/);
    assert.throws(() => f.e.ack(f.root.id, 0), /not ready/);
    const pending = plan(f); f.restart();
    f.e.openClawDecide(f.root.id, owner, pending.attemptId, 1, delegate);
    assert.equal(f.e.tasks(f.root.id).length, 1);
    assert.throws(() => f.e.openClawDecide(f.root.id, owner, pending.attemptId, 1, { ...delegate, summary: 'different' }), /Conflicting/);
    childDone(f);
    const p = f.e.openClawPending()[0], t = f.e.tasks(f.root.id)[0];
    f.e.openClawDecide(f.root.id, owner, p.attemptId, 1, { kind: 'complete', summary: 'done', delegations: [], reviews: [{ taskId: t.id, resultVersion: 1, decision: 'accepted', reason: 'checked' }], finalResponse: 'done' });
    assert.throws(() => f.e.ack(f.root.id, 2), /not ready/);
    assert.equal(f.e.root(f.root.id).finalDelivery, 'pending');
    f.e.ack(f.root.id, 1); f.e.ack(f.root.id, 1);
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
test('suspension preserves ready result and local versioned delivery acknowledgment', () => {
  const f = fixture(); try {
    ready(f); f.e.suspendOpenClaw(f.binding.id, 'reset');
    assert.equal(f.e.root(f.root.id).status, 'ready');
    assert.equal(f.e.root(f.root.id).finalResponse, 'done');
    assert.throws(() => f.e.authorizeOpenClaw(f.root.id, owner), /mismatch/);
    f.e.ack(f.root.id, 1); assert.equal(f.e.root(f.root.id).status, 'completed');
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
    f.e.openClawWake(f.root.id, undefined, 'temporary outage', 1);
    assert.equal(f.e.root(f.root.id).deliveryWakeAttempts, 1);
    assert.equal(f.e.root(f.root.id).finalDelivery, 'pending');
    f.e.openClawWake(f.root.id, undefined, undefined, 2);
    assert.equal(f.e.root(f.root.id).deliveryWakeAttempts, 1);
    f.e.ack(f.root.id, 1);
    f.e.openClawWake(f.root.id, undefined, undefined, 1);
    assert.equal(f.e.root(f.root.id).deliveryWakeAttempts, 1);
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
    assert.throws(() => f.e.respond(f.root.id, 'continue'), /mismatch/);
    assert.equal(f.e.attempts(f.root.id).length, 1);
    f.e.bindOpenClaw(owner);
    assert.equal(f.e.root(f.root.id).inputRequest.reason, 'input needed');
    assert.throws(() => f.e.respond(f.root.id, 'continue'), /mismatch/);
    f.e.respond(f.root.id, 'continue', owner); assert.equal(f.e.openClawPending().length, 1);
  } finally { f.close(); }
});
test('OpenClaw coordinator instructions require tools and verified delivery, not CLI JSON output', () => {
  const f = fixture(); try {
    const instructions = f.e.get(f.root.id).coordinatorInstructions;
    assert.match(instructions, /action=decide/); assert.match(instructions, /action=ack/);
    assert.doesNotMatch(instructions, /Return only the requested JSON structure|Do not launch other agents or external messages/);
  } finally { f.close(); }
});

async function harness(f) {
  const { registerBridge } = await import('../plugins/openclaw/index.mjs');
  const h = { sessionId: owner.sessionId, events: [], wakes: 0, inject: async () => ({ id: 'injected', enqueued: true }) };
  const api = { logger: { warn() {} }, runtime: { agent: { session: { getSessionEntry: () => ({ sessionId: h.sessionId }) } }, system: {
    enqueueSystemEvent(text, options) { h.events.push({ text, options }); }, requestHeartbeat() { h.wakes++; },
  } }, session: { workflow: { enqueueNextTurnInjection: input => h.inject(input) } }, registerTool(t) { h.tool = t; }, registerService(s) { h.service = s; }, lifecycle: { registerRuntimeLifecycle(l) { h.lifecycle = l; } } };
  const client = { ensureService: async () => {}, request: async (method, p = {}, options = {}) => {
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
    if (method === 'bridgeAction') return e[p.action](p.id, p.action === 'respond' ? p.message : p.version);
    throw new Error(`Unexpected method ${method}`);
  } };
  h.bridge = registerBridge(api, client, store); h.bridge.startForTest();
  h.call = async (params, identity = owner) => { const reply = await h.tool.create({ ...identity, assertInvocationCurrent() {} }).execute('call', params); return { ...reply, details: JSON.parse(reply.content[0].text) }; };
  return h;
}
test('plugin happy path connects, submits, reviews and only acknowledges on explicit ack', async () => {
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
    await h.call({ action: 'ack', id, version: 1 });
    assert.equal(f.e.root(id).status, 'completed');
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
test('delivery wake has exact version and separate idempotency key, never auto-acknowledges', async () => {
  const f = fixture(); try {
    ready(f); const h = await harness(f); let injection;
    h.inject = async input => { injection = input; return { id: 'delivery-injection' }; };
    await h.bridge.poll();
    assert.equal(h.wakes, 1); assert.match(injection.idempotencyKey, /delivery/);
    assert.match(h.events[0].text, /finalVersion=1/);
    assert.match(h.events[0].text, /ambiguous/i);
    assert.match(h.events[0].options.contextKey, /delivery/);
    assert.equal(f.e.root(f.root.id).finalDelivery, 'pending');
    assert.equal(f.e.attempts(f.root.id).filter(a => a.role === 'main').length, 2);
  } finally { f.close(); }
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
