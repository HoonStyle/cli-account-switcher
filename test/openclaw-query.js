'use strict';
const assert = require('node:assert/strict');
(async () => {
  const { projectQuery, queryReply, MAX_REPLY_BYTES } = await import('../plugins/openclaw/task-query.mjs');
  const large = '한글 🦕 줄바꿈\n"인용"\\\t'.repeat(4000);
  const value = { root: { id: 'root', goal: large, summary: 'Old 3/3 exhausted', round: 3, maxRounds: 6, generation: 1, status: 'awaiting_review', participants: [{ id: 'p1', tool: 'claude', profileId: 'fixture', token: 'SECRET' }], finalVersion: 1, finalDelivery: 'pending', finalResponse: large },
    tasks: Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, rootId: 'root', goal: `goal${i}`, state: 'succeeded', resultVersion: 1, binding: { id: 'p1', token: 'SECRET' }, result: { success: true, summary: large, artifacts: ['result.md'] }, review: { decision: 'accepted', resultVersion: 1, reason: large } })),
    attempts: [...Array.from({ length: 100 }, (_, i) => ({ id: `old${i}`, role: 'main', state: 'succeeded', result: large, token: 'SECRET' })), { id: 'pending', role: 'main', state: 'external_wait', generation: 1, input: 'New continuation', token: 'SECRET' }], coordinatorInstructions: `Contract\n${large}`, events: [{ text: large }] };
  const before = JSON.stringify(value);
  function reply(params) {
    const result = queryReply(value, { action: 'get', ...params });
    const wire = JSON.stringify(result);
    assert(Buffer.byteLength(wire) <= MAX_REPLY_BYTES);
    assert(!wire.includes('SECRET'));
    assert.deepEqual(Object.keys(result.details), ['schema']);
    return JSON.parse(result.content[0].text);
  }
  const summary = reply({});
  assert.equal(summary.attempts.length, 1); assert.equal(summary.attempts[0].id, 'pending');
  assert.equal(summary.root.remainingRounds, 3); assert.equal(summary.root.maxRounds, 6);
  assert.equal(summary.tasks.length, 4); assert.equal(summary.taskPage.total, 11);
  assert(summary.root.goalTruncated); assert(summary.tasks[0].result.summaryTruncated);
  const ids = []; let offset = 0, queryRevision;
  do { const p = reply({ view: 'tasks', offset, queryRevision }); ids.push(...p.tasks.map(t => t.id)); offset = p.taskPage.nextOffset; queryRevision = p.taskPage.queryRevision; } while (offset !== null);
  assert.deepEqual(ids, value.tasks.map(t => t.id));
  function reconstruct(params) {
    let offset = 0, queryRevision, output = '', pages = 0;
    do { const p = reply({ ...params, offset, queryRevision }).page; output += p.text; offset = p.nextOffset; queryRevision = p.queryRevision; pages++; } while (offset !== null);
    assert(pages > 1); return output;
  }
  const task = JSON.parse(reconstruct({ view: 'task', taskId: 't0', resultVersion: 1 }));
  assert.deepEqual(task.result, value.tasks[0].result); assert.equal(task.review.reason, large);
  const context = JSON.parse(reconstruct({ view: 'context', generation: 1 }));
  assert.equal(context.goal, large); assert.equal(context.pending[0].input, 'New continuation'); assert.equal(context.coordinatorInstructions, value.coordinatorInstructions);
  assert.equal(reconstruct({ view: 'final', version: 1 }), large);
  for (const params of [{ view: 'task', taskId: 'missing' }, { view: 'task', taskId: 't0', resultVersion: 2 }, { view: 'context', generation: 2 }, { view: 'final', version: 2 }, { view: 'context', offset: 1 }, { view: 'tasks', offset: 4 }, { view: 'context', limit: 1201 }, { view: 'tasks', limit: 5 }, { view: 'context', offset: -1 }, { view: 'unknown' }]) assert.throws(() => reply(params));
  for (const params of [{ view: 'context' }, { view: 'task', taskId: 't0' }, { view: 'final' }]) {
    const first = reply(params).page;
    assert.throws(() => reply({ ...params, offset: first.nextOffset, queryRevision: 'outdated' }), /Query changed/);
  }
  assert.equal(JSON.stringify(value), before, 'projection never mutates ledger data');
  const mutation = queryReply(value.root, { action: 'decide', view: 'invalid', offset: -1 });
  assert.equal(JSON.parse(mutation.content[0].text).root.status, 'awaiting_review');
  assert.equal(JSON.parse(mutation.content[0].text).observationIncluded, false);
  assert.equal(JSON.parse(mutation.content[0].text).counts, undefined, 'root-only mutation receipt must not falsely report zero children');
  // JSON escaping can expand ASCII to six bytes; the envelope itself is bounded.
  value.root.finalResponse = '\u0000'.repeat(5000);
  reply({ view: 'final' });
  value.root.participants[0].profileId = large;
  const omitted = reply({}); assert.equal(omitted.responseOmitted, true); assert.equal(omitted.pending[0].id, 'pending');
  console.log('PASS bounded oversized summary, pending contract IDs, exact Unicode result/context/final reconstruction, task-list pagination, version guards, token exclusion, no mutation, escaped payload budget');
})().catch(error => { console.error(error); process.exitCode = 1; });
