'use strict';
// State/notification contracts over isolated records. No profiles, models or runners.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { randomUUID } = require('crypto');
const { Engine } = require('../src/runtime/engine');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-contracts-'));
let now = Date.now(), e = new Engine(tmp, { now: () => now });
const owner = { agentId: 'fixture', sessionKey: 'agent:fixture:channel:fixture', sessionId: 'session' };
const b = e.bindOpenClaw(owner);
const coordinator = { tool: 'openclaw', bindingId: b.id, ...owner };
function root() { const r = { id: randomUUID(), coordinator, participants: [], goal: 'fixture', projectPath: tmp, permission: 'read-only', executionPolicy: 'edit-only', generation: 1, status: 'running', attention: null, round: 1, maxRounds: 3, finalVersion: 0 }; e.saveRoot(r); return r; }
function child(r, state = 'running') {
  const t = { id: randomUUID(), rootId: r.id, state: 'queued', goal: 'fixture', resultVersion: 0, review: null, binding: { tool: 'claude', home: tmp } };
  const a = { id: randomUUID(), rootId: r.id, taskId: t.id, binding: { tool: 'claude', home: tmp }, role: 'child', generation: 1, state, token: randomUUID(), createdAt: now, startedAt: now };
  a.dir = path.join(tmp, a.id); fs.mkdirSync(a.dir);
  e.db.put('task', t); e.db.put('attempt', a); return { t, a };
}
const done = a => e.consume(a, { attemptId: a.id, token: a.token, state: 'succeeded', result: { success: true, summary: 'done', artifacts: [] } });
const blocked = a => e.consume(a, { attemptId: a.id, token: a.token, state: 'blocked', failurePhase: 'preflight', processStarted: false, reason: 'fixture missing' });
(async () => { try {
  const { projectQuery } = await import('../plugins/openclaw/task-query.mjs');
  for (const activity of ['running', 'quiet', 'unknown']) {
    const r = root(), { a } = child(r);
    a.startedAt = now - 400000; e.db.put('attempt', a);
    fs.writeFileSync(path.join(a.dir, 'live.json'), JSON.stringify({ attemptId: a.id, token: a.token, childPid: 99999999, at: now - (activity === 'unknown' ? 20000 : 1), lastOutputAt: now - (activity === 'quiet' ? 400000 : 1) }));
    const observed = e.get(r.id), card = projectQuery(observed).tasks[0];
    assert.equal(card.state, observed.tasks[0].observation.executionState); assert.equal(card.activity, activity); assert.equal(card.ledgerState, 'queued');
    const data = JSON.parse(projectQuery(observed, { action: 'get', view: 'task', taskId: observed.tasks[0].id }).page.text);
    assert.equal(data.state, card.state); assert.equal(data.activity, activity);
    const prompt = e.prompt(r, { role: 'main', id: 'fixture-main', generation: 1 });
    assert(prompt.includes(`"activity":"${activity}"`));
    done(a); e.tick();
    assert.equal(projectQuery(e.get(r.id)).tasks[0].state, 'succeeded');
  }
  for (const warning of ['progress_gap', 'runner_unknown', 'slot_wait', 'spawn_ambiguous', 'receipt_conflict']) {
    const r = root(), { a } = child(r); e.mark(r, `${warning}:${a.id}`); done(a); e.tick();
    const actual = e.root(r.id); assert.equal(actual.status, 'awaiting_review'); assert.equal(actual.attention, null);
  }
  for (const warning of ['progress_gap:another-child', 'runner_unknown:another-child', 'openclaw_binding_disable', 'cancel_confirmation_overdue']) {
    const r = root(), { a } = child(r); e.mark(r, warning); done(a); assert.equal(e.root(r.id).attention, warning);
  }
  const legacy = root(), old = child(legacy); done(old.a); e.mark(e.root(legacy.id), `progress_gap:${old.a.id}`); e.tick(); assert.equal(e.root(legacy.id).attention, null);
  console.log('PASS UI/tool/context execution-state parity and attempt-scoped warning cleanup, including older terminal records');

  const r = root(), { a } = child(r, 'starting'); blocked(a);
  const attention = e.openClawPending().find(p => p.rootId === r.id);
  assert.equal(attention.kind, 'attention'); assert.equal(attention.attentionVersion, 1);
  e.openClawWake(r.id, undefined, 'fixture wake failure', undefined, 1);
  const retryAt = e.root(r.id).nextAttentionWakeAt;
  assert.equal(e.get(r.id).root.observation.errors.find(x => x.kind === 'attention_wake').message, 'fixture wake failure');
  e.db.close(); e = new Engine(tmp, { now: () => now });
  assert.equal(e.openClawPending().find(p => p.rootId === r.id).nextWakeAt, retryAt);
  assert.throws(() => e.ackAttention(r.id, 1, { ...owner, agentId: 'foreign' }), /binding mismatch/);
  assert.throws(() => e.ackAttention(r.id, 2, owner), /no longer pending/);
  e.ackAttention(r.id, 1, owner); e.ackAttention(r.id, 1, owner);
  assert.equal(e.root(r.id).status, 'needs_user'); assert.equal(e.root(r.id).finalVersion, 0);
  assert(!e.openClawPending().some(p => p.rootId === r.id));
  assert.equal(e.db.events(r.id).filter(x => x.type === 'attention_delivery_ack').length, 1);
  let changed = e.root(r.id);
  e.db.transaction(() => e.requestInput(changed, { kind: 'coordinator', reason: 'different blocker', sourceAttemptId: 'next-main' }));
  assert.equal(e.root(r.id).attentionVersion, 2); assert.equal(e.root(r.id).attentionDelivery, 'pending');
  assert.throws(() => e.ackAttention(r.id, 1, owner), /no longer pending/);
  e.openClawWake(r.id, undefined, undefined, undefined, 1); assert.equal(e.root(r.id).attentionWakeAttempts, undefined);
  e.suspendOpenClaw(b.id, 'disable'); assert(!e.openClawPending().some(p => p.rootId === r.id));
  assert.throws(() => e.ackAttention(r.id, 2, owner), /binding mismatch/);
  e.bindOpenClaw(owner); assert(e.openClawPending().some(p => p.rootId === r.id));
  e.cancel(r.id); e.tick(); assert(!e.openClawPending().some(p => p.rootId === r.id));
  assert.equal(e.root(r.id).attentionDelivery, 'superseded');
  const oldRoot = root(); oldRoot.status = 'needs_user'; oldRoot.attention = 'legacy blocked'; e.db.put('root', oldRoot); e.tick();
  assert.equal(e.openClawPending().find(p => p.rootId === oldRoot.id).attentionVersion, 1);
  assert.equal(e.root(oldRoot.id).inputRequest.reason, 'legacy blocked');
  console.log('PASS durable attention version/backoff, exact owner ack without completion, reissue, stale receipts, disable/reconnect/cancel and legacy upgrade');

  const concurrent = root(), first = child(concurrent, 'starting'), other = child(concurrent, 'starting');
  blocked(first.a);
  const requested = e.root(concurrent.id).inputRequest;
  fs.writeFileSync(path.join(other.a.dir, 'result.json'), JSON.stringify({ attemptId: other.a.id, token: 'foreign', state: 'succeeded' }));
  e.tick();
  assert.match(e.root(concurrent.id).attention, /receipt_conflict/);
  assert.deepEqual(e.root(concurrent.id).inputRequest, requested);
  assert.equal(e.get(concurrent.id).root.observation.attentionReason, requested.reason);
  fs.writeFileSync(path.join(other.a.dir, 'result.json'), JSON.stringify({ attemptId: other.a.id, token: other.a.token, state: 'succeeded', result: { success: true, summary: 'done', artifacts: [] } }));
  e.tick();
  assert.equal(e.root(concurrent.id).attention, null);
  assert.deepEqual(e.root(concurrent.id).inputRequest, requested);
  assert.equal(e.root(concurrent.id).attentionVersion, 1);
  assert(e.openClawPending().some(p => p.rootId === concurrent.id && p.kind === 'attention'));
  e.ackAttention(concurrent.id, 1, owner);
  assert.equal(e.root(concurrent.id).status, 'needs_user');
  console.log('PASS unrelated bad/valid receipts cannot replace, acknowledge, supersede or clear a user-input request');

  const cumulative = root(), one = child(cumulative, 'starting'), two = child(cumulative, 'starting');
  blocked(one.a); const firstRequest = e.root(cumulative.id).inputRequest;
  e.ackAttention(cumulative.id, firstRequest.version, owner);
  blocked(two.a); const secondRequest = e.root(cumulative.id).inputRequest;
  assert.equal(secondRequest.reason, firstRequest.reason);
  assert.equal(secondRequest.version, firstRequest.version + 1);
  assert.equal(secondRequest.blockedTasks.length, 2);
  assert.notEqual(secondRequest.fingerprint, firstRequest.fingerprint);
  assert.throws(() => e.ackAttention(cumulative.id, firstRequest.version, owner), /no longer pending/);
  assert(e.openClawPending().some(p => p.rootId === cumulative.id && p.attentionVersion === secondRequest.version));
  e.db.transaction(() => e.requestInput(e.root(cumulative.id), secondRequest));
  assert.deepEqual(e.root(cumulative.id).inputRequest, secondRequest, 'Identical request replay must keep its immutable identity');
  e.db.transaction(() => e.requestInput(e.root(cumulative.id), { ...secondRequest, summary: 'same reason, additional user instructions' }));
  assert.equal(e.root(cumulative.id).attentionVersion, secondRequest.version + 1);
  assert.equal(e.root(cumulative.id).inputRequest.reason, firstRequest.reason);
  console.log('PASS same-message failures accumulate blocking identities, exact replay stays stable, summary updates reissue a version');

  const literal = root(), completed = child(literal); done(completed.a); e.tick();
  const main = e.openClawPending().find(p => p.rootId === literal.id && p.kind === 'review');
  const question = `progress_gap:${completed.a.id}`;
  e.openClawDecide(literal.id, owner, main.attemptId, 1, { kind: 'needs_user', summary: question, delegations: [], reviews: [{ taskId: completed.t.id, resultVersion: 1, decision: 'accepted', reason: 'checked' }] });
  const literalRequest = e.root(literal.id).inputRequest;
  e.tick(); e.db.close(); e = new Engine(tmp, { now: () => now }); e.tick();
  assert.deepEqual(e.root(literal.id).inputRequest, literalRequest);
  assert.equal(e.get(literal.id).root.observation.attentionReason, question);
  assert(e.openClawPending().some(p => p.rootId === literal.id && p.kind === 'attention'));
  assert.equal(e.root(literal.id).attention, null);
  const acknowledgedLegacy = root(); Object.assign(acknowledgedLegacy, { status: 'needs_user', attention: question, attentionVersion: 7, attentionDelivery: 'delivered', nextAttentionWakeAt: now + 10000 });
  e.db.put('root', acknowledgedLegacy); e.tick();
  assert.equal(e.root(acknowledgedLegacy.id).inputRequest.reason, question);
  assert.equal(e.root(acknowledgedLegacy.id).attentionVersion, 7);
  assert.equal(e.root(acknowledgedLegacy.id).attentionDelivery, 'delivered');
  assert.equal(e.root(acknowledgedLegacy.id).nextAttentionWakeAt, now + 10000);
  assert(!e.openClawPending().some(p => p.rootId === acknowledgedLegacy.id));
  console.log('PASS coordinator text is never parsed as diagnostics, requests survive restart, legacy delivery/version/backoff are preserved');

  for (const clockDelta of [0, -10000]) {
    const retryRoot = root(), initial = child(retryRoot, 'starting'); blocked(initial.a);
    now += clockDelta;
    e.resume(retryRoot.id, { requestId: randomUUID(), message: 'Explicit retry', retryTaskIds: [initial.t.id] }, owner);
    let task = e.db.get('task', initial.t.id), attempt = e.db.get('attempt', task.currentAttemptId);
    assert.equal(attempt.retryOf, initial.a.id);
    assert.equal(e.get(retryRoot.id).tasks[0].observation.latestAttemptId, attempt.id);
    assert.equal(e.get(retryRoot.id).tasks[0].observation.executionState, 'queued');
    attempt.state = 'starting'; attempt.token = randomUUID(); e.db.put('attempt', attempt);
    blocked(attempt);
    e.resume(retryRoot.id, { requestId: randomUUID(), message: 'Second explicit retry', retryTaskIds: [initial.t.id] }, owner);
    task = e.db.get('task', initial.t.id); const next = e.db.get('attempt', task.currentAttemptId);
    assert.equal(next.retryOf, attempt.id, 'Retry validation and display use the same current attempt identity');
    next.state = 'running'; e.db.put('attempt', next);
    assert.equal(e.get(retryRoot.id).tasks[0].observation.executionState, 'running');
    // Older records have no pointer: retain ledger order, not max(createdAt).
    delete task.currentAttemptId; e.db.put('task', task);
    assert.equal(e.get(retryRoot.id).tasks[0].observation.latestAttemptId, next.id);
    assert.equal(e.get(retryRoot.id).tasks[0].observation.executionState, 'running');
    done(next);
  }
  console.log('PASS identical/backward clocks cannot resurrect old attempts; retry and observation share durable identity with legacy ledger-order fallback');

  let notices = 0;
  e.attention = () => { notices++; throw Error('fixture OS notification failed'); };
  const notificationRoot = root(), notified = child(notificationRoot, 'starting'); blocked(notified.a);
  e.flushNotices(); const failedNotice = e.db.all('notice').find(n => n.rootId === notificationRoot.id);
  assert.equal(failedNotice.state, 'retrying');
  const requestBeforeAck = e.root(notificationRoot.id).inputRequest;
  e.ackAttention(notificationRoot.id, 1, owner);
  assert.equal(e.db.get('notice', failedNotice.id).state, 'superseded');
  now = failedNotice.nextAt + 1; const sentBefore = notices; e.flushNotices();
  assert.equal(notices, sentBefore, 'Chat delivery acknowledgment suppresses pending OS retries');
  assert.deepEqual(e.root(notificationRoot.id).inputRequest, requestBeforeAck);
  assert.equal(e.root(notificationRoot.id).status, 'needs_user');
  const migratable = root(); migratable.status = 'needs_user'; migratable.attention = 'legacy unversioned notice'; e.db.put('root', migratable);
  e.db.put('notice', { id: 'old-input-notice', rootId: migratable.id, reason: migratable.attention, state: 'pending', attempts: 0, nextAt: now });
  e.attention = r => { if (r.id === migratable.id) notices++; };
  const beforeMigration = notices; e.tick();
  assert.equal(notices, beforeMigration + 1);
  assert.equal(e.db.get('notice', 'old-input-notice').state, 'superseded');
  const pendingRoot = root(), pendingChild = child(pendingRoot, 'starting'); blocked(pendingChild.a);
  let finishNotification;
  e.attention = r => r.id === pendingRoot.id ? new Promise((_resolve, reject) => { finishNotification = reject; }) : undefined;
  e.flushNotices(); e.ackAttention(pendingRoot.id, 1, owner);
  finishNotification(Error('late OS failure')); await Promise.resolve();
  assert.equal(e.db.all('notice').find(n => n.rootId === pendingRoot.id).state, 'superseded');
  console.log('PASS chat ack suppresses pending/in-flight OS retries; legacy migration replaces rather than duplicates unversioned notices');
} finally { e.db.close(); } })().catch(error => { console.error(error); process.exitCode = 1; });
