'use strict';
// Isolated ledger and runner receipts only: no account reads or CLI invocation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/runtime/engine');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observation-'));
const now = 1000000;
const engine = new Engine(dir, { now: () => now, staleMs: 30000, maxActive: 2 });
const binding = { tool: 'claude', home: '/isolated/account-a' };
function root(id, status = 'running') {
  const r = { id, status, coordinator: binding, attention: null, finalDelivery: 'pending', createdAt: now - 60000 };
  engine.db.put('root', r); return r;
}
function child(r, id, state, extra = {}) {
  const t = { id: 'task-' + id, rootId: r.id, state: 'queued', resultVersion: 0, review: null, ...extra.task };
  const a = { id, rootId: r.id, taskId: t.id, role: 'child', state, binding, token: 'receipt-' + id,
    createdAt: now - 60000, startedAt: ['queued', 'external_wait'].includes(state) ? undefined : now - 50000, ...extra.attempt };
  engine.db.put('task', t); engine.db.put('attempt', a); return a;
}
function live(a, changes = {}) {
  a.dir = path.join(dir, a.id); fs.mkdirSync(a.dir, { recursive: true }); engine.db.put('attempt', a);
  fs.writeFileSync(path.join(a.dir, 'live.json'), JSON.stringify({ attemptId: a.id, token: a.token, at: now - 500, lastOutputAt: null, lastProgressAt: null, ...changes }));
}
try {
  const running = root('running'), a = child(running, 'active', 'running');
  live(a);
  const before = JSON.stringify(engine.db.all('attempt'));
  let detail = engine.get(running.id);
  assert.equal(detail.tasks[0].state, 'queued', 'persisted state remains backwards compatible');
  assert.equal(detail.tasks[0].observation.executionState, 'running');
  assert.equal(detail.tasks[0].observation.latestAttemptId, a.id);
  assert.equal(detail.tasks[0].observation.activity, 'quiet');
  assert.equal(detail.tasks[0].observation.heartbeatStatus, 'fresh');
  assert.equal(detail.tasks[0].observation.lastOutputAt, null);
  assert.equal(detail.tasks[0].observation.error, null, 'silence is not failure');
  assert.equal(detail.root.observation.counts.running, 1);
  assert.equal(detail.root.observation.counts.failed, 0);
  assert.equal(detail.root.observation.requiresAttention, false);
  assert.equal(detail.tasks[0].observation.elapsedMs, 50000);
  assert.equal(JSON.stringify(engine.db.all('attempt')), before, 'GET must not mutate execution records');
  live(a, { lastOutputAt: now - 1000 });
  assert.equal(engine.get(running.id).tasks[0].observation.activity, 'running');
  assert.equal(engine.list().find(r => r.id === running.id).observation.lastOutputAt, now - 1000);
  live(a, { at: now - 11000, lastOutputAt: now - 12000 });
  detail = engine.get(running.id);
  assert.equal(detail.tasks[0].observation.activity, 'unknown');
  assert.equal(detail.tasks[0].observation.quiet, false, 'stale heartbeat is not quiet execution');
  assert.equal(detail.root.observation.counts.unknown, 1);
  assert.equal(detail.root.observation.requiresAttention, true);
  live(a, { token: 'wrong-token' });
  assert.equal(engine.get(running.id).tasks[0].observation.heartbeatAt, null, 'foreign receipt is ignored');
  live(a, { attemptId: 'wrong-attempt' });
  assert.equal(engine.get(running.id).tasks[0].observation.heartbeatAt, null);
  console.log('PASS effective delegation state, live/quiet/stale distinction and receipt identity');

  const queued = root('queued'), q = child(queued, 'queue-a', 'queued');
  detail = engine.get(queued.id);
  assert.equal(detail.tasks[0].observation.waitReason, 'account_busy');
  assert.equal(detail.tasks[0].observation.heartbeatStatus, 'not_applicable');
  assert.equal(detail.root.observation.counts.queued, 1);
  q.binding = { tool: 'codex', home: '/isolated/account-b' }; engine.db.put('attempt', q);
  assert.equal(engine.get(queued.id).tasks[0].observation.waitReason, 'scheduler');
  child(root('occupied'), 'occupied', 'starting', { attempt: { binding: { tool: 'codex', home: '/isolated/account-c' } } });
  assert.equal(engine.get(queued.id).tasks[0].observation.waitReason, 'capacity');
  queued.status = 'needs_user'; engine.db.put('root', queued);
  assert.equal(engine.get(queued.id).tasks[0].observation.waitReason, 'root_paused');
  console.log('PASS queued wait reasons distinguish account, capacity, scheduler and paused root');

  const failed = root('failed');
  child(failed, 'failed-attempt', 'failed', { task: { state: 'failed', result: { success: false, summary: 'cli_exit' } }, attempt: { endedAt: now - 500, result: { state: 'failed', reason: 'cli_exit', exit: { code: 9, signal: null } } } });
  detail = engine.get(failed.id);
  assert.equal(detail.tasks[0].observation.error.exitCode, 9);
  assert.equal(detail.root.observation.errors[0].attemptId, 'failed-attempt');
  assert.equal(detail.root.observation.counts.failed, 1);
  assert.equal(detail.root.observation.counts.reviewPending, 1);
  assert.equal(detail.root.observation.requiresAttention, true);
  assert.equal(detail.tasks[0].observation.elapsedMs, 49500);
  const semantic = root('semantic-failure');
  child(semantic, 'semantic-attempt', 'succeeded', { task: { state: 'failed', result: { success: false, summary: 'Could not verify artifact' } }, attempt: { endedAt: now, result: { state: 'succeeded' } } });
  assert.equal(engine.get(semantic.id).tasks[0].observation.error.message, 'Could not verify artifact');
  assert.equal(engine.get(semantic.id).root.observation.counts.failed, 1);
  console.log('PASS exit error and unsuccessful child result remain explicit failures');

  const ready = root('ready', 'ready'); ready.finalVersion = 1; engine.db.put('root', ready);
  child(ready, 'done', 'succeeded', { task: { state: 'succeeded', review: { decision: 'accepted' } }, attempt: { endedAt: now } });
  detail = engine.get(ready.id);
  assert.equal(detail.root.observation.phase, 'ready');
  assert.equal(detail.root.observation.deliveryStatus, 'pending');
  assert.equal(detail.root.observation.counts.succeeded, 1);
  assert.equal(detail.root.observation.counts.reviewPending, 0);
  engine.ack(ready.id, 1);
  assert.equal(engine.get(ready.id).root.observation.phase, 'completed');
  assert.equal(engine.get(ready.id).root.observation.deliveryStatus, 'delivered');
  console.log('PASS ready answer is not delivered completion until versioned acknowledgment');

  const external = root('external', 'awaiting_review');
  external.coordinator = { tool: 'openclaw' }; external.participants = []; engine.db.put('root', external);
  engine.db.put('attempt', { id: 'external-main', rootId: external.id, role: 'main', state: 'external_wait', binding: external.coordinator, lastWakeError: 'Wake unavailable', createdAt: now });
  detail = engine.get(external.id);
  assert.equal(detail.attempts[0].observation.waitReason, 'coordinator');
  assert.equal(detail.attempts[0].observation.error.kind, 'coordinator_wake');
  assert.equal(detail.root.observation.counts.total, 0, 'coordinator is not counted as delegation');
  assert.equal(detail.root.observation.requiresAttention, true);
  engine.openClawWake(external.id, 'external-main', null);
  assert.equal(engine.get(external.id).attempts[0].observation.error, null, 'successful wake clears a previous transport error');
  console.log('PASS OpenClaw wait and wake failure have separate evidence');
} finally { engine.db.close(); }
console.log('runtime observation checks passed:', dir);

// Scheduler regression: keep this separate from presentation fixtures so no
// queued attempt can launch while exercising reconciliation.
const recovery = new Engine(path.join(dir, 'recovery'), { now: () => now, staleMs: 300000 });
try {
  const r = { id: 'recovery', status: 'running', coordinator: binding, attention: null };
  recovery.db.put('root', r);
  const a = { id: 'claude-live', rootId: r.id, role: 'child', taskId: 'recovery-task', binding, state: 'running', token: 'live-recovery', startedAt: now - 600000, createdAt: now - 600000, dir: path.join(dir, 'recovery-receipt') };
  recovery.db.put('attempt', a);
  recovery.db.put('task', { id: a.taskId, rootId: r.id, state: 'queued', review: null });
  fs.mkdirSync(a.dir);
  const receipt = changes => fs.writeFileSync(path.join(a.dir, 'live.json'), JSON.stringify({ attemptId: a.id, token: a.token, childPid: 12345, at: now - 1000, lastOutputAt: now - 1000, lastProgressAt: null, ...changes }));
  const attention = reason => { const current = recovery.root(r.id); current.attention = reason; recovery.db.put('root', current); };
  receipt({}); recovery.tick();
  assert.equal(recovery.root(r.id).attention, null, 'Claude output after >5 minutes must not require Codex-only progress events');
  receipt({ lastOutputAt: now - 400000 }); recovery.tick();
  assert.equal(recovery.root(r.id).attention, `progress_gap:${a.id}`);
  assert.equal(recovery.attempts(r.id)[0].state, 'running', 'silence never changes execution to failure');
  receipt({}); recovery.tick();
  assert.equal(recovery.root(r.id).attention, null, 'new output clears only this attempt output-gap attention');
  receipt({ at: now - 20000 }); recovery.tick();
  assert.equal(recovery.root(r.id).attention, `runner_unknown:${a.id}`);
  assert.equal(recovery.attempts(r.id)[0].state, 'unknown');
  receipt({}); recovery.tick();
  assert.equal(recovery.root(r.id).attention, null, 'fresh heartbeat clears its unknown-runner attention');
  assert.equal(recovery.attempts(r.id)[0].state, 'running');
  attention(`runner_unknown:${a.id}`);
  receipt({ lastOutputAt: null }); recovery.tick();
  assert.equal(recovery.root(r.id).attention, `progress_gap:${a.id}`, 'heartbeat recovery without output must retain the separate output warning');
  for (const reason of ['main_result: invalid_main_result', 'openclaw_binding_disable', 'progress_gap:other-attempt', 'runner_unknown:other-attempt']) {
    attention(reason); receipt({}); recovery.tick();
    assert.equal(recovery.root(r.id).attention, reason, 'recovery must not clear another reason or attempt');
    receipt({ lastOutputAt: null }); recovery.tick();
    assert.equal(recovery.root(r.id).attention, reason, 'quiet telemetry must not overwrite unrelated attention');
    receipt({ at: now - 20000 }); recovery.tick();
    assert.equal(recovery.root(r.id).attention, reason, 'missing heartbeat must not overwrite unrelated attention');
  }
  assert(recovery.db.events(r.id).some(e => e.type === 'attention_cleared' && e.body.reason === `progress_gap:${a.id}`));
  console.log('PASS provider-neutral output gaps, exact recovery, and preservation of unrelated attention');
} finally { recovery.db.close(); }
