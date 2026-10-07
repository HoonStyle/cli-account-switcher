'use strict';
// Real service/RPC, synthetic terminal receipts only. No provider, user account,
// production configuration, or production runtime is read or started.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process'), { createHash } = require('crypto');
// Leave room for macOS CI's /private/var/folders TMPDIR and Unix socket limit.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const { Engine } = require('../src/runtime/engine');
const client = require('../src/runtime/client');
const { RESPONSE_LIMIT } = require('../src/runtime/transport');
const { LOCAL_QUERY_OPTIONS, MAX_DASHBOARD_BYTES } = require('../src/runtime/query');
const { DatabaseSync } = require('node:sqlite');
const net = require('net');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const owner = { agentId: 'fixture', sessionKey: 'agent:fixture:aggregate', sessionId: 'fixture-session' };
let service, engine = new Engine(client.dir);
let phase = 'loading query projector';
const startedAt = Date.now();
function checkpoint(name) {
  phase = name;
  console.log(`query fixture: ${phase} (${Date.now() - startedAt}ms)`);
}
const deadline = setTimeout(() => {
  console.error(`Query fixture deadline exceeded during ${phase}`);
  // This child is owned by this isolated fixture, never a production service.
  service?.kill('SIGKILL');
  process.exit(1);
}, 120000);
function ledgerDigest() {
  const db = new DatabaseSync(path.join(client.dir, 'tasks.sqlite'), { readOnly: true });
  try {
    const hash = createHash('sha256');
    for (const table of ['records', 'requests', 'events']) hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    return hash.digest('hex');
  } finally { db.close(); }
}
async function settleNotices() {
  // The independent service tick dispatches the final OS-notice fixture. Drain
  // that authorized mutation before checking that paging itself changes nothing.
  const db = new DatabaseSync(path.join(client.dir, 'tasks.sqlite'), { readOnly: true });
  try {
    for (let i = 0; i < 100; i++) {
      const notices = db.prepare("SELECT body FROM records WHERE kind='notice'").all().map(row => JSON.parse(row.body));
      if (notices.every(n => !['pending', 'retrying'].includes(n.state))) return;
      await sleep(30);
    }
    throw Error('Fixture notices failed to settle');
  } finally { db.close(); }
}
async function start() {
  let diagnostics = '';
  service = spawn(process.execPath, [path.resolve(__dirname, '../src/runtime/service.js')], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  service.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8192); });
  service.on('error', error => { diagnostics = error.message; });
  for (let i = 0; i < 100; i++) {
    try { if ((await client.request('health')).pid === service.pid) return; } catch {}
    if (service.exitCode !== null || service.signalCode !== null) throw Error(`Isolated service exited (${service.exitCode ?? service.signalCode}): ${diagnostics}`);
    await sleep(30);
  }
  throw Error(`Isolated service startup timed out: ${diagnostics}`);
}
async function stop() {
  if (service?.exitCode === null && service.signalCode === null) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated service stop timed out')), 5000);
    service.once('exit', () => { clearTimeout(timer); resolve(); }); service.kill('SIGTERM');
  });
}
async function legacyFallbackContracts() {
  const calls = []; let rejection = null;
  const legacy = net.createServer(connection => {
    let buffer = ''; connection.setEncoding('utf8'); connection.on('error', () => {});
    connection.on('data', data => {
      buffer += data; if (!buffer.includes('\n')) return;
      const { method } = JSON.parse(buffer.split('\n')[0]); calls.push(method);
      const response = rejection ? { error: rejection } : method === 'get' ? { result: { root: { id: 'legacy' } } } : method === 'list' ? { result: [{ id: 'legacy' }] } : { error: 'Unknown task method' };
      connection.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise((resolve, reject) => { legacy.once('error', reject); legacy.listen(client.socket, resolve); });
  try {
    assert.deepEqual(await client.readDashboard('legacy'), { root: { id: 'legacy' } });
    assert.deepEqual(await client.readDashboardList(), [{ id: 'legacy' }]);
    assert.deepEqual(calls, ['dashboard', 'get', 'dashboardList', 'list']);
    for (const error of ['Unknown task method.', 'Response too large', 'Fixture dashboard budget exceeded']) {
      rejection = error; calls.length = 0;
      await assert.rejects(client.readDashboard('legacy'), failure => failure.message === error);
      await assert.rejects(client.readDashboardList(), failure => failure.message === error);
      assert.deepEqual(calls, ['dashboard', 'dashboardList'], 'Only the exact legacy unknown-method response permits an unprojected fallback');
    }
    rejection = null; calls.length = 0;
    await assert.rejects(client.readQueryPages('legacy', { view: 'final' }), /Unknown task method/);
    assert.deepEqual(calls, ['query'], 'Paged full-content reads never fall back to unsafe aggregate data');
  } finally { await new Promise(resolve => legacy.close(resolve)); }
}
(async () => { try {
  const { projectQuery, MAX_REPLY_BYTES } = await import('../plugins/openclaw/task-query.mjs');
  checkpoint('seeding isolated ledger');
  const binding = engine.bindOpenClaw(owner);
  const participant = { id: 'p1', tool: 'claude', home: path.join(tmp, 'unused-profile'), executable: process.execPath };
  const root = { id: 'aggregate', coordinator: { tool: 'openclaw', bindingId: binding.id, ...owner }, participants: [participant], permission: 'read-only', executionPolicy: 'edit-only', projectPath: tmp, goal: 'bounded aggregate fixture', generation: 1, status: 'running', attention: null, round: 3, maxRounds: 3, finalVersion: 0 };
  engine.saveRoot(root);
  const expectedSummaries = [];
  for (let i = 0; i < 12; i++) {
    const result = { success: true, summary: '한'.repeat(189990) + `글😀끝${i}`, artifacts: [] };
    assert(JSON.stringify(result).length < 200000, 'Each result satisfies the runner structured-result cap');
    expectedSummaries.push(result.summary);
    const task = { id: `task-${i}`, rootId: root.id, goal: 'bounded fixture', binding: participant, state: 'queued', resultVersion: 0, review: null, currentAttemptId: `attempt-${i}` };
    const attempt = { id: task.currentAttemptId, rootId: root.id, taskId: task.id, binding: participant, role: 'child', generation: 1, state: 'starting', token: `token-${i}`, createdAt: Date.now(), startedAt: Date.now() };
    engine.db.put('task', task); engine.db.put('attempt', attempt);
    engine.consume(attempt, { attemptId: attempt.id, token: attempt.token, state: 'succeeded', result });
  }
  engine.tick();
  // Every final report is individually valid; their root-list aggregate exceeds
  // transport limits unless list projection happens on the service side too.
  for (let i = 0; i < 18; i++) {
    const id = `completed-${i}`, attemptId = `${id}-attempt`, taskId = `${id}-task`;
    engine.saveRoot({ ...root, id, status: 'completed', finalVersion: 1, finalDelivery: 'delivered', finalResponse: '끝'.repeat(190000), summary: `completed fixture ${i}` });
    engine.db.put('task', { id: taskId, rootId: id, goal: 'completed fixture', binding: participant, state: 'succeeded', resultVersion: 1, currentAttemptId: attemptId, result: { success: true, summary: 'checked', artifacts: [] }, review: { decision: 'accepted', resultVersion: 1, reason: 'checked' } });
    engine.db.put('attempt', { id: attemptId, rootId: id, taskId, role: 'child', binding: participant, state: 'succeeded', processed: true });
  }
  const rawListBytes = bytes({ result: engine.list() }) + 1;
  assert(rawListBytes > RESPONSE_LIMIT);
  const snapshot = engine.get(root.id), rawWireBytes = bytes({ result: snapshot }) + 1;
  assert.equal(snapshot.tasks.length, 12); assert.equal(snapshot.root.status, 'awaiting_review');
  assert(rawWireBytes > RESPONSE_LIMIT, 'Aggregate must reproduce the old unpaged RPC failure');
  const contextSource = engine.querySource(root.id, { view: 'context' });
  const review = snapshot.attempts.find(a => a.role === 'main' && a.state === 'external_wait');
  const originalPrompt = engine.prompt, originalEvents = engine.db.eventsTail;
  engine.prompt = () => { throw Error('Bounded non-context query built a main prompt'); };
  engine.db.eventsTail = () => { throw Error('Bounded query materialized event history'); };
  for (const view of ['summary', 'tasks', 'task', 'final']) engine.querySource(root.id, { view, taskId: 'task-0' });
  engine.prompt = originalPrompt; engine.db.eventsTail = originalEvents;
  engine.db.close(); engine = null;
  checkpoint('starting isolated service');
  await start();
  checkpoint('reading bounded task pages');
  let queries = 0, maxEnvelopeBytes = 0;
  async function query(params = {}, queryOwner = owner) {
    const response = await client.request('bridgeQuery', { id: root.id, owner: queryOwner, query: { action: 'get', ...params } });
    const size = bytes(response); maxEnvelopeBytes = Math.max(maxEnvelopeBytes, size); queries++;
    assert(size <= MAX_REPLY_BYTES, `Source-side tool envelope exceeded budget: ${size}`);
    assert(Array.isArray(response.content));
    return JSON.parse(response.content[0].text);
  }
  async function reconstruct(params) {
    let page = (await query(params)).page, text = '';
    const revision = page.queryRevision;
    for (;;) {
      assert.equal(page.queryRevision, revision); text += page.text;
      if (page.nextOffset === null) { assert.equal(page.done, true); break; }
      page = (await query({ ...params, offset: page.nextOffset, queryRevision: revision })).page;
    }
    assert.equal(Array.from(text).length, page.total);
    return text;
  }
  const beforeReads = ledgerDigest();
  const summary = await query();
  assert.equal(summary.root.status, 'awaiting_review'); assert.equal(summary.taskPage.total, 12);
  assert.equal(summary.tasks.length, 4); assert(summary.tasks.every(t => t.result.summaryTruncated));
  const taskIds = []; let cards = await query({ view: 'tasks' });
  for (;;) {
    taskIds.push(...cards.tasks.map(t => t.id));
    if (cards.taskPage.nextOffset === null) break;
    cards = await query({ view: 'tasks', offset: cards.taskPage.nextOffset, queryRevision: cards.taskPage.queryRevision });
  }
  assert.deepEqual(taskIds, Array.from({ length: 12 }, (_, i) => `task-${i}`));
  await assert.rejects(query({ view: 'task', taskId: 'task-0', resultVersion: 2 }), /Stale resultVersion/);
  await assert.rejects(query({ view: 'task', taskId: 'not-in-this-root' }), /Unknown taskId/);
  await assert.rejects(query({}, { ...owner, agentId: 'foreign', sessionKey: 'agent:foreign:fixture' }), /binding mismatch/);
  await assert.rejects(query({}, { ...owner, sessionId: 'old-session' }), /binding mismatch/);
  const firstTaskPage = (await query({ view: 'task', taskId: 'task-0', resultVersion: 1 })).page;
  const restored = JSON.parse(await reconstruct({ view: 'task', taskId: 'task-0', resultVersion: 1 }));
  assert.equal(restored.result.summary, expectedSummaries[0]); assert.equal(restored.result.success, true);
  assert.equal(restored.id, 'task-0'); assert(!JSON.stringify(restored).includes('token-0'));
  const firstContext = await query({ view: 'context' });
  checkpoint('reading context and dashboard');
  for (const offset of [0, Math.floor(firstContext.page.total / 2), Math.max(0, firstContext.page.total - 1200)]) {
    const params = { action: 'get', view: 'context', offset, queryRevision: firstContext.page.queryRevision };
    const actual = await query(params), expected = projectQuery(contextSource, params);
    assert.deepEqual(actual.page, expected.page);
  }
  const dashboard = await client.readDashboard(root.id);
  assert(bytes(dashboard) <= MAX_DASHBOARD_BYTES);
  assert.equal(dashboard.schema, 'account-tasks-dashboard-v1'); assert.equal(dashboard.tasks.length, 12);
  assert.equal(dashboard.coordinatorInstructions, undefined);
  assert(dashboard.tasks.every(t => t.detailsTruncated && t.result.summaryTruncated && Array.from(t.result.summary).length <= 1200));
  assert(dashboard.attempts.every(a => !a.token && !a.result?.result));
  assert.equal(dashboard.tasks[0].detailRevision, firstTaskPage.queryRevision);
  const dashboardList = await client.readDashboardList();
  assert.equal(dashboardList.length, 19); assert(bytes(dashboardList) <= MAX_DASHBOARD_BYTES);
  assert(dashboardList.every(item => item.detailsProjected && !Object.hasOwn(item, 'finalResponse')));
  assert.equal(dashboardList.filter(item => item.status === 'completed').length, 18);
  const localEnvelope = await client.request('query', { id: root.id, query: { view: 'task', taskId: 'task-0', resultVersion: 1 } });
  assert(bytes(localEnvelope) <= LOCAL_QUERY_OPTIONS.maxReplyBytes);
  const localPage = JSON.parse(localEnvelope.content[0].text).page;
  assert.equal(Array.from(localPage.text).length, 65536); assert(localPage.nextOffset);
  assert.deepEqual(await client.readQueryPages(root.id, { view: 'task', taskId: 'task-0', resultVersion: 1, queryRevision: dashboard.tasks[0].detailRevision }), restored);
  const fullContext = await client.readQueryPages(root.id, { view: 'context', queryRevision: firstContext.page.queryRevision });
  assert.equal(fullContext.coordinatorInstructions, contextSource.coordinatorInstructions);
  assert.equal(fullContext.goal, root.goal);
  await assert.rejects(client.readQueryPages(root.id, { view: 'task', taskId: 'task-0', queryRevision: '0'.repeat(64) }), /Query changed/);
  assert.equal(ledgerDigest(), beforeReads, 'Summary/task/context paging and rejected foreign queries are read-only');
  console.log(`PASS ${rawWireBytes}-byte valid aggregate served through bounded summary/task/context queries; exact full Unicode task reconstruction and owner guards`);
  console.log(`PASS local 65536-character task/context reconstruction, compact dashboard detail, and ${rawListBytes}-byte root list projected to ${bytes(dashboardList)} bytes`);

  const finalResponse = '한글😀 결과\n'.repeat(22000);
  checkpoint('reviewing and reading final pages');
  await client.request('bridgeDecide', { id: root.id, owner, attemptId: review.id, generation: 1, decision: { kind: 'complete', summary: 'fixture reviewed', delegations: [], reviews: taskIds.map(taskId => ({ taskId, resultVersion: 1, decision: 'accepted', reason: 'fixture reviewed' })), finalResponse } });
  await assert.rejects(query({ view: 'context', offset: firstContext.page.nextOffset, queryRevision: firstContext.page.queryRevision }), /Query changed/);
  await assert.rejects(query({ view: 'task', taskId: 'task-0', resultVersion: 1, offset: firstTaskPage.nextOffset, queryRevision: firstTaskPage.queryRevision }), /Query changed/);
  const refreshed = await query({ view: 'context' }); assert.notEqual(refreshed.page.queryRevision, firstContext.page.queryRevision);
  await assert.rejects(query({ view: 'final', version: 2 }), /Stale finalVersion/);
  await settleNotices();
  const beforeFinalRead = ledgerDigest();
  assert.equal(await reconstruct({ view: 'final', version: 1 }), finalResponse);
  assert.equal(await client.readQueryPages(root.id, { view: 'final', version: 1 }), finalResponse);
  const finalDashboard = await client.readDashboard(root.id);
  assert(bytes(finalDashboard) <= MAX_DASHBOARD_BYTES); assert.equal(finalDashboard.root.finalResponse, finalResponse);
  assert.equal((await query()).root.finalDelivery, 'pending', 'Retrieval must never acknowledge user-facing delivery');
  assert.equal(ledgerDigest(), beforeFinalRead);
  console.log(`PASS changed task/context revisions force restart, exact full Unicode final reconstruction without ack; ${queries} bounded responses, largest ${maxEnvelopeBytes} bytes`);
  await stop(); await legacyFallbackContracts();
  checkpoint('finished');
  console.log('PASS dashboard detail/list fallback only on exact legacy unknown method; budget/transport errors and full-content query failures never fall back');
} finally {
  clearTimeout(deadline);
  if (engine) engine.db.close();
  await stop(); fs.rmSync(tmp, { recursive: true, force: true });
} })().catch(error => { console.error(error); process.exitCode = 1; });
