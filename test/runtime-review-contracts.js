'use strict';
// Deterministic review/commit fault tests: no CLI spawning, credentials, or model calls.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { randomUUID } = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-contracts-'));
process.env.HOME = tmp; process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
const { Engine } = require('../src/runtime/engine');
let clock = Date.now();
const e = new Engine(path.join(tmp, 'runtime'), { now: () => clock });
function setup() {
  const id = randomUUID(), binding = { tool: 'claude', profileId: 'fixture', home: tmp, executable: process.execPath };
  const root = { id, coordinator: binding, participants: [{ ...binding, id: 'p1' }], generation: 1, round: 0, maxRounds: 3, sessionId: 'parent', status: 'running', projectPath: tmp, goal: 'Resolve independent failures A and B', finalVersion: 0, finalDelivery: 'pending' };
  e.db.put('root', root); return root;
}
function task(root, id, state = 'failed') {
  const t = { id, rootId: root.id, goal: id, state, resultVersion: 1, result: { success: state === 'succeeded' }, review: null };
  e.db.put('task', t); return t;
}
function review(t, decision) { return { taskId: t.id, resultVersion: 1, decision, reason: 'Explicitly checked this task only' }; }
function main(root, output) {
  const a = { id: randomUUID(), rootId: root.id, role: 'main', purpose: 'review', state: 'running', token: randomUUID(), generation: 1, binding: root.coordinator };
  const result = { attemptId: a.id, token: a.token, state: 'succeeded', sessionId: 'parent', result: output };
  e.db.put('attempt', a); return { a, result };
}
function apply(root, output) { const m = main(root, output); e.consume(m.a, m.result); return m; }
function complete(reviews) { return { kind: 'complete', summary: 'done', delegations: [], reviews, finalResponse: 'all done' }; }
function delegate(reviews, ids) { return { kind: 'delegate', summary: 'Fix only referenced failures', reviews, delegations: [{ participantId: 'p1', goal: 'Fix A only, leave B unresolved', resolvesTaskIds: ids }], finalResponse: '' }; }
try {
  const r = setup(), a = task(r, 'A'), b = task(r, 'B');
  apply(r, delegate([review(a, 'rejected'), review(b, 'rejected')], ['A']));
  const fix = e.tasks(r.id).find(t => !['A', 'B'].includes(t.id));
  assert.deepEqual(e.db.get('task', 'A').followupIds, [fix.id]);
  assert(!e.db.get('task', 'B').followupIds, 'Unrelated rejected B must stay unresolved');
  fix.state = 'succeeded'; fix.resultVersion = 1; e.db.put('task', fix);
  apply(r, complete([review(fix, 'accepted')]));
  assert.equal(e.root(r.id).status, 'needs_user'); assert.equal(e.root(r.id).finalVersion, 0);
  assert.match(e.root(r.id).inputRequest.reason, /goal_not_fully_reviewed/);
  // Correct B independently, preserving already-resolved A's link.
  apply(r, { ...delegate([review(fix, 'accepted')], ['B']), delegations: [{ participantId: 'p1', goal: 'Fix B only', resolvesTaskIds: ['B'] }] });
  const fixB = e.tasks(r.id).find(t => t.resolvesTaskIds?.includes('B'));
  fixB.state = 'succeeded'; fixB.resultVersion = 1; e.db.put('task', fixB);
  apply(r, complete([review(fixB, 'accepted')]));
  assert.equal(e.root(r.id).status, 'ready');
  const prompt = e.prompt(e.root(r.id), { role: 'main' });
  assert(prompt.includes('"followupIds"') && prompt.includes('"resolvesTaskIds"'));
  console.log('PASS independent failures require explicit corrective links; all linked repairs permit completion');

  const other = setup(); task(other, 'foreign', 'succeeded');
  const invalid = setup(), bad = task(invalid, 'bad');
  apply(invalid, delegate([review(bad, 'rejected')], ['foreign']));
  assert.equal(e.root(invalid.id).status, 'needs_user'); assert.equal(e.tasks(invalid.id).length, 1);
  assert.match(e.root(invalid.id).inputRequest.reason, /invalid_followup_reference/);
  console.log('PASS cross-root followup references are rejected atomically');

  // Throw at the last transactional write, after in-memory root/attempt mutations.
  const retry = setup(); const output = delegate([], []); const m = main(retry, output);
  const originalEvent = e.db.event.bind(e.db); let injected = false;
  e.db.event = (id, type, body) => { if (id === retry.id && type === 'main_processed' && !injected) { injected = true; throw new Error('injected database commit boundary'); } return originalEvent(id, type, body); };
  assert.throws(() => e.consume(m.a, m.result), /injected database/); e.db.event = originalEvent;
  const rolledBack = e.root(retry.id);
  assert.equal(rolledBack.round, 0); assert(!rolledBack.lastAppliedMain); assert.equal(e.tasks(retry.id).length, 0);
  assert(!e.db.get('attempt', m.a.id).processed, 'Durable receipt must remain replayable');
  e.consume(e.db.get('attempt', m.a.id), m.result);
  assert.equal(e.root(retry.id).round, 1); assert.equal(e.tasks(retry.id).length, 1); assert(e.db.get('attempt', m.a.id).processed);
  e.consume(e.db.get('attempt', m.a.id), m.result); assert.equal(e.tasks(retry.id).length, 1);
  console.log('PASS transactional storage failure rolls back completely and durable result replay applies once');

  // Broken OS notification must not convert a committed final result to needs_user.
  const noticeRoot = setup(), done = task(noticeRoot, 'done', 'succeeded');
  e.attention = () => { throw new Error('notification backend unavailable'); };
  apply(noticeRoot, complete([review(done, 'accepted')])); e.flushNotices();
  assert.equal(e.root(noticeRoot.id).status, 'ready'); assert.equal(e.root(noticeRoot.id).finalVersion, 1);
  let notice = e.db.all('notice').find(n => n.rootId === noticeRoot.id);
  assert.equal(notice.state, 'retrying');
  e.attention = () => {}; clock = notice.nextAt + 1; e.flushNotices();
  notice = e.db.get('notice', notice.id); assert.equal(notice.state, 'dispatched');
  assert.equal(e.root(noticeRoot.id).status, 'ready'); assert.equal(e.root(noticeRoot.id).finalDelivery, 'pending');
  console.log('PASS notification failure retries independently without changing final result or acknowledging delivery');
} finally { e.db.close(); }
