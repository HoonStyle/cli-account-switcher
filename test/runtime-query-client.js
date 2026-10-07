'use strict';
// Actual socket replies exercise the client read contract independently of the
// service projector: malformed pages must never become partial review evidence.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const assert = require('assert/strict');
process.env.CLI_ACCOUNTS_ROOT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'query-client-')), 'accounts');
const client = require('../src/runtime/client');
const { queryReply, LOCAL_QUERY_OPTIONS } = require('../src/runtime/query');
fs.mkdirSync(client.dir, { recursive: true });
const value = { root: { id: 'root', generation: 1, goal: '원래 목표', status: 'ready', finalVersion: 2, finalDelivery: 'pending', finalResponse: '정확한 결과😀'.repeat(60), participants: [] },
  tasks: [{ id: 'task', rootId: 'root', generation: 1, state: 'succeeded', resultVersion: 1, goal: '검토 목표', result: { success: true, summary: '한글😀 증거'.repeat(90), artifacts: ['결과/😀.txt'] } }],
  attempts: [], coordinatorInstructions: '완전한 원문'.repeat(60) };
let responder, requests = [];
const server = net.createServer(connection => {
  let text = '';
  connection.setEncoding('utf8'); connection.on('error', () => {});
  connection.on('data', chunk => {
    text += chunk; if (!text.includes('\n')) return;
    const request = JSON.parse(text); requests.push(request);
    let response;
    try { response = responder(request); } catch (error) { response = { error: error.message }; }
    connection.end(JSON.stringify(response) + '\n');
  });
});
function source(request) { assert.equal(request.method, 'query'); return { result: queryReply(value, request.params.query, {}, LOCAL_QUERY_OPTIONS) }; }
function reset(fn) { requests = []; responder = fn; }
function poison(fn) {
  let seen = 0;
  reset(request => {
    const response = source(request);
    if (++seen === 2) {
      const projected = JSON.parse(response.result.content[0].text); fn(projected);
      response.result.content[0].text = JSON.stringify(projected);
    }
    return response;
  });
}
const taskQuery = { view: 'task', taskId: 'task', resultVersion: 1, limit: 64 };
(async () => {
  await new Promise(resolve => server.listen(client.socket, resolve));
  try {
    reset(source);
    const task = await client.readQueryPages('root', taskQuery);
    assert.deepEqual(task.result, value.tasks[0].result);
    assert(requests.length > 1);
    assert(requests.slice(1).every(r => r.params.query.generation === 1 && r.params.query.resultVersion === 1 && /^[a-f0-9]{64}$/.test(r.params.query.queryRevision)));
    reset(source);
    const context = await client.readQueryPages('root', { view: 'context', limit: 64 });
    assert.equal(context.goal, value.root.goal); assert.equal(context.coordinatorInstructions, value.coordinatorInstructions);
    reset(source);
    assert.equal(await client.readQueryPages('root', { view: 'final', version: 2, limit: 64 }), value.root.finalResponse);
    console.log('PASS exact Unicode task/context/final reconstruction pins identity, versions and revision');

    const mismatches = [
      p => p.id = 'other', p => p.generation++, p => p.page.total++, p => p.page.offset--,
      p => p.page.queryRevision = 'f'.repeat(64), p => p.page.resultVersion++, p => p.page.taskId = 'other',
      p => p.page.encoding = 'text', p => p.page.unit = 'bytes', p => p.page.nextOffset++, p => p.page.done = true,
    ];
    for (const mismatch of mismatches) {
      poison(mismatch);
      await assert.rejects(client.readQueryPages('root', taskQuery), /Inconsistent task query page/);
      assert.equal(requests.length, 2, 'A mismatch cannot trigger an automatic restart');
    }
    poison(p => p.finalVersion++);
    await assert.rejects(client.readQueryPages('root', { view: 'final', limit: 64 }), /Inconsistent task query page/);
    // Keep page lengths/cursors intact: only full-source verification catches it.
    poison(p => p.page.text = 'X' + Array.from(p.page.text).slice(1).join(''));
    await assert.rejects(client.readQueryPages('root', taskQuery), /Inconsistent task query page/);
    reset(source);
    await assert.rejects(client.readQueryPages('root', { ...taskQuery, queryRevision: 'f'.repeat(64) }), /Query changed/);
    assert.equal(requests.length, 1);
    reset(source);
    await assert.rejects(client.readQueryPages('root', { ...taskQuery, limit: 0 }), /limit must be positive/);
    console.log('PASS identity/cursor/total/encoding/revision/version/hash mismatch rejects partial evidence without retry');

    const legacy = { root: { id: 'legacy' }, tasks: [] };
    reset(({ method }) => method === 'dashboard' ? { error: 'Unknown task method' } : { result: legacy });
    assert.deepEqual(await client.readDashboard('legacy'), legacy);
    assert.deepEqual(requests.map(r => r.method), ['dashboard', 'get']);
    reset(({ method }) => method === 'dashboardList' ? { error: 'Unknown task method' } : { result: [legacy.root] });
    assert.deepEqual(await client.readDashboardList(), [legacy.root]);
    assert.deepEqual(requests.map(r => r.method), ['dashboardList', 'list']);
    for (const message of ['Response too large', 'Unknown root task', 'query failed']) {
      reset(() => ({ error: message }));
      await assert.rejects(client.readDashboard('legacy'), { message }); assert.equal(requests.length, 1);
      reset(() => ({ error: message }));
      await assert.rejects(client.readDashboardList(), { message }); assert.equal(requests.length, 1);
    }
    console.log('PASS dashboard compatibility fallback is limited to an explicit Unknown task method');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
