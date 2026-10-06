'use strict';
// Real socket + service + runner; only the host wake API and provider are fixtures.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-openclaw-service-'));
process.env.HOME = tmp; process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const store = require('../src/store');
const fake = path.join(tmp, 'fixture-cli');
fs.writeFileSync(fake, `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1];
console.log(JSON.stringify({subtype:'success',is_error:false,session_id:session,structured_output:{success:true,summary:'한글 결과 '+args[args.indexOf('--model')+1],artifacts:[]}}));
});
`, { mode: 0o755 });
store.addProfile('claude', 'fixture', { shareSettings: false });
const state = store.load(); state.realBin.claude = fake; store.save(state);
const client = require('../src/runtime/client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let service;
async function start() {
  service = spawn(process.execPath, [path.resolve(__dirname, '../src/runtime/service.js')], { env: process.env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await client.request('health')).pid === service.pid) return; } catch {} await sleep(30); }
  throw new Error('isolated service did not start');
}
async function stop(signal) {
  const child = service;
  if (child?.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service stop timeout')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(signal);
  });
  service = null;
}
(async () => { try {
  await start();
  const { registerBridge } = await import('../plugins/openclaw/index.mjs');
  const owner = { agentId: 'main', sessionKey: 'agent:main:discord:channel:fixture', sessionId: 'session-1' };
  const events = []; let tool, wakes = 0;
  const api = { logger: { warn(message) { throw new Error(message); } }, runtime: { agent: { session: { getSessionEntry: () => ({ sessionId: owner.sessionId }) } }, system: {
    enqueueSystemEvent(text, options) { events.push({ text, options }); }, requestHeartbeat() { wakes++; },
  } }, session: { workflow: { enqueueNextTurnInjection: async () => ({ id: 'fixture-injection' }) } }, registerTool(t) { tool = t; }, registerService() {}, lifecycle: { registerRuntimeLifecycle() {} } };
  const bridge = registerBridge(api, client, store); bridge.startForTest();
  const call = async params => (await tool.create({ ...owner, assertInvocationCurrent() {} }).execute('fixture', params)).details;
  await call({ action: 'connect' });
  const created = await call({ action: 'submit', requestId: 'service-roundtrip', projectPath: tmp, goal: '한글 결과 읽기', participants: [{ tool: 'claude', profileId: 'fixture', model: 'fixture-model' }] });
  const id = created.root.id;
  await bridge.poll(); assert.equal(wakes, 1);
  const plan = created.attempts.find(a => a.state === 'external_wait');
  await call({ action: 'decide', id, attemptId: plan.id, generation: 1, decision: { kind: 'delegate', summary: '읽기', reviews: [], delegations: [{ participantId: 'p1', goal: '읽기', resolvesTaskIds: [] }] } });
  let detail;
  for (let i = 0; i < 100; i++) { detail = await call({ action: 'get', id }); if (detail.root.status === 'awaiting_review') break; await sleep(100); }
  assert.equal(detail.root.status, 'awaiting_review');
  assert.equal(detail.tasks[0].result.summary, '한글 결과 fixture-model');
  assert.equal(detail.root.participants[0].model, 'fixture-model');
  const review = detail.attempts.find(a => a.state === 'external_wait');
  await call({ action: 'decide', id, attemptId: review.id, generation: 1, decision: { kind: 'complete', summary: '검토 완료', delegations: [], reviews: [{ taskId: detail.tasks[0].id, resultVersion: 1, decision: 'accepted', reason: 'fixture checked' }], finalResponse: '한글 최종 결과' } });
  await stop('SIGKILL'); await start();
  const pending = await client.request('bridgePending');
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'delivery'); assert.equal(pending[0].finalVersion, 1);
  await bridge.poll(); assert.equal(wakes, 2); assert.match(events[1].text, /finalVersion=1/);
  detail = await call({ action: 'get', id });
  assert.equal(detail.root.status, 'ready'); assert.equal(detail.root.finalDelivery, 'pending');
  assert.equal(detail.root.deliveryWakeAttempts, 1);
  const nextWakeAt = detail.root.nextDeliveryWakeAt;
  await stop('SIGTERM'); await start();
  assert.equal((await client.request('bridgePending'))[0].nextWakeAt, nextWakeAt);
  await bridge.poll(); assert.equal(wakes, 2, 'durable retry backoff avoids immediate duplicate wake');
  await assert.rejects(call({ action: 'ack', id, version: 2 }), /not ready/);
  // Simulated consumer acknowledgment, not a claim of actual chat delivery.
  await call({ action: 'ack', id, version: 1 });
  assert.equal((await call({ action: 'get', id })).root.finalDelivery, 'delivered');
  assert.equal((await client.request('bridgePending')).length, 0);
  console.log('PASS real plugin RPC -> fixture child -> review -> SIGKILL restart -> delivery-only wake -> durable backoff -> explicit ack');
} finally { await stop('SIGTERM'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
