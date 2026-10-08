'use strict';
// Real socket + service + runner + authenticated host receipt RPC; only provider/session APIs are fixtures.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
// macOS CI uses a long /var/folders TMPDIR; keep the Unix socket below its limit.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-svc-'));
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
  let diagnostics = '';
  service = spawn(process.execPath, [path.resolve(__dirname, '../src/runtime/service.js')], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  service.stderr.setEncoding('utf8');
  service.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-8192); });
  service.on('error', error => { diagnostics = error.message; });
  for (let i = 0; i < 100; i++) {
    try { if ((await client.request('health')).pid === service.pid) return; } catch {}
    if (service.exitCode !== null || service.signalCode !== null) break;
    await sleep(30);
  }
  throw new Error(`isolated service did not start: ${diagnostics || 'health timeout'}`);
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
  const owner = { agentId: 'main', sessionKey: 'agent:main:discord:channel:fixture', sessionId: 'session-1', lifecycleRevision:'epoch-1', deliveryTarget:{channel:'discord',accountId:'default',to:'channel:fixture',threadId:null} };
  const events = [], sends = [], warnings = []; let tool, wakes = 0, crashAfterSend = false;
  const api = { logger: { warn(message) { warnings.push(message); } }, runtime: { agent: { session: { getSessionEntry: () => ({ sessionId: owner.sessionId, lifecycleRevision:owner.lifecycleRevision, delivery:{kind:'external',context:owner.deliveryTarget} }) } }, system: {
    enqueueSystemEvent(text, options) { events.push({ text, options }); }, requestHeartbeat() { wakes++; },
  } }, session: { workflow: { enqueueNextTurnInjection: async () => ({ id: 'fixture-injection' }) } }, registerTool(t) { tool = t; }, registerService() {}, lifecycle: { registerRuntimeLifecycle() {} } };
  const sendSessionBoundMessageBatch = async params => {
    assert.equal(params.sessionId,owner.sessionId); assert.equal(params.lifecycleRevision,owner.lifecycleRevision); assert.deepEqual(params.target,owner.deliveryTarget);
    await params.onPlatformSendDispatch(); params.assertCurrent();
    sends.push(params);
    if(crashAfterSend) { crashAfterSend=false; await stop('SIGKILL'); await start(); }
    return {status:'sent',deliveryReceiptVersion:1,idempotencyKey:params.idempotencyKey,target:params.target,sessionId:params.sessionId,lifecycleRevision:params.lifecycleRevision,
      receipt:{platformMessageIds:[`sent-${sends.length}-1`,`sent-${sends.length}-2`],sentAt:Date.now(),parts:[0,1].map(index=>({platformMessageId:`sent-${sends.length}-${index+1}`,index,kind:'text',raw:{channel:'discord',target:{kind:'channel',id:'fixture'}}}))}};
  };
  const bridge = registerBridge(api, client, store, {sendSessionBoundMessageBatch}); bridge.startForTest();
  const call = async params => JSON.parse((await tool.create({ ...owner, assertInvocationCurrent() {} }).execute('fixture', params)).content[0].text);
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
  const taskPage = await call({ action: 'get', id, view: 'task', taskId: detail.tasks[0].id, resultVersion: 1 });
  assert.equal(taskPage.page.resultVersion, 1); assert.match(taskPage.page.text, /한글 결과 fixture-model/);
  const contextPage = await call({ action: 'get', id, view: 'context', generation: 1 });
  assert.match(contextPage.page.text, /한글 결과 읽기/);
  assert.equal(detail.root.participants[0].model, 'fixture-model');
  const review = detail.attempts.find(a => a.state === 'external_wait');
  const finalText = '한글 최종 결과 🦕\n'.repeat(3200);
  await call({ action: 'decide', id, attemptId: review.id, generation: 1, decision: { kind: 'complete', summary: '검토 완료', delegations: [], reviews: [{ taskId: detail.tasks[0].id, resultVersion: 1, decision: 'accepted', reason: 'fixture checked' }], finalResponse: finalText } });
  await stop('SIGKILL'); await start();
  const pending = await client.request('bridgePending');
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'delivery'); assert.equal(pending[0].finalVersion, 1);
  await assert.rejects(call({action:'ack',id,version:1}),{code:'DELIVERY_RECEIPT_REQUIRED'});
  const beforeDeliveryWakes=wakes, beforeDeliveryEvents=events.length;
  // Sender claimed durably; switcher dies after provider handoff but before its
  // signed aggregate receipt returns. The live host settles the same claim.
  crashAfterSend=true; await bridge.poll();
  assert.equal(wakes,beforeDeliveryWakes); assert.equal(events.length,beforeDeliveryEvents);
  assert.equal(sends.length,1); assert.equal(sends[0].text,finalText); assert.equal(warnings.length,0);
  detail = await call({ action: 'get', id });
  assert.equal(detail.root.status, 'completed'); assert.equal(detail.root.finalDelivery, 'delivered');
  let offset = 0, queryRevision, reconstructed = '', pages = 0;
  do {
    const reply = await call({ action: 'get', id, view: 'final', version: 1, offset, queryRevision });
    reconstructed += reply.page.text; offset = reply.page.nextOffset; queryRevision = reply.page.queryRevision; pages++;
  } while (offset !== null);
  assert.equal(reconstructed, finalText); assert(pages > 1, 'large Unicode final response crosses RPC and paged plugin transport intact');
  assert.equal(detail.root.deliveryWakeAttempts, undefined);
  await stop('SIGTERM'); await start();
  assert.equal((await client.request('bridgePending')).length,0);
  await bridge.poll(); assert.equal(sends.length,1); assert.equal(wakes,beforeDeliveryWakes);
  await assert.rejects(call({ action: 'ack', id, version: 2 }), /receipt|ready/);
  await call({ action: 'ack', id, version: 1 });
  assert.equal((await call({ action: 'get', id })).root.finalDelivery, 'delivered');
  assert.equal((await client.request('bridgePending')).length, 0);
  console.log('PASS real plugin RPC -> fixture child -> review -> SIGKILL before send and after handoff -> signed aggregate receipt -> automatic ack -> restart, no duplicate send or model wake');

  // A preflight failure must return to the owner conversation, not only to the
  // local OS notification. No provider is launched while the fixture is absent.
  const blockedRoot = await call({ action: 'submit', requestId: 'blocked-roundtrip', projectPath: tmp, goal: '준비 실패 후 복구', participants: [{ tool: 'claude', profileId: 'fixture' }] });
  const blockedId = blockedRoot.root.id, initial = blockedRoot.attempts[0];
  fs.renameSync(fake, fake + '.saved');
  await call({ action: 'decide', id: blockedId, attemptId: initial.id, generation: 1, decision: { kind: 'delegate', summary: 'prepare', reviews: [], delegations: [{ participantId: 'p1', goal: 'fixture', resolvesTaskIds: [] }] } });
  let blockedDetail;
  for (let i = 0; i < 100; i++) { blockedDetail = await call({ action: 'get', id: blockedId }); if (blockedDetail.root.status === 'needs_user') break; await sleep(100); }
  assert.equal(blockedDetail.root.status, 'needs_user');
  assert.equal(blockedDetail.tasks[0].state, 'blocked');
  assert.equal(blockedDetail.root.attentionVersion, 1); assert.equal(blockedDetail.root.attentionDelivery, 'pending');
  assert.equal((await client.request('bridgePending'))[0].kind, 'attention');
  await assert.rejects(call({action:'ack_attention',id:blockedId,version:1}),{code:'DELIVERY_RECEIPT_REQUIRED'});
  const beforeAttentionWakes=wakes, beforeAttentionEvents=events.length, beforeAttentionSends=sends.length;
  await bridge.poll();
  assert.equal(wakes,beforeAttentionWakes); assert.equal(events.length,beforeAttentionEvents); assert.equal(sends.length,beforeAttentionSends+1);
  assert.match(sends.at(-1).text,/질문 1/); assert.equal(sends.at(-1).sessionKey,owner.sessionKey);
  const foreign = tool.create({ ...owner, agentId: 'other', sessionKey: 'agent:other:fixture', assertInvocationCurrent() {} });
  await assert.rejects(foreign.execute('fixture', { action: 'ack_attention', id: blockedId, version: 1 }), /binding mismatch/);
  await assert.rejects(call({ action: 'ack_attention', id: blockedId, version: 2 }), /no longer pending/);
  await stop('SIGKILL'); await start(); await bridge.poll();
  assert.equal(wakes,beforeAttentionWakes); assert.equal(sends.length,beforeAttentionSends+1,'durable receipt prevents duplicate attention send after restart');
  // Duplicate ack joins the host-stored, signed fixture delivery receipt.
  await call({ action: 'ack_attention', id: blockedId, version: 1 });
  await call({ action: 'ack_attention', id: blockedId, version: 1 });
  blockedDetail = await call({ action: 'get', id: blockedId });
  assert.equal(blockedDetail.root.status, 'needs_user'); assert.equal(blockedDetail.root.finalVersion, 0);
  assert.equal(blockedDetail.root.attentionDelivery, 'delivered');
  assert.equal((await client.request('bridgePending')).length, 0);
  assert.equal((await client.request('get', { id: blockedId })).events.filter(event => event.type === 'attention_delivery_ack').length, 1);
  fs.renameSync(fake + '.saved', fake);
  await call({ action: 'resume', id: blockedId, requestId: 'bounded-user-recovery', generation:blockedDetail.root.generation, inputVersion:blockedDetail.root.inputRequest.version, message: '환경을 복구했으니 기존 작업을 이어가세요.', retryTaskIds: [blockedDetail.tasks[0].id] });
  await assert.rejects(call({ action: 'ack_attention', id: blockedId, version: 1 }), /no longer pending/);
  await assert.rejects(call({action:'resume',id:blockedId,requestId:'late-old-answer',generation:1,inputVersion:1,message:'late old answer',extraRounds:1,retryTaskIds:[]}),{code:'INPUT_REQUEST_CONFLICT'});
  for (let i = 0; i < 100; i++) { blockedDetail = await call({ action: 'get', id: blockedId }); if (blockedDetail.root.status === 'awaiting_review') break; await sleep(100); }
  assert.equal(blockedDetail.root.status, 'awaiting_review'); assert.equal(blockedDetail.tasks.length, 1);
  const resumedMain = blockedDetail.attempts.find(a=>a.state==='external_wait'), resumedTask = blockedDetail.tasks[0];
  await call({ action: 'decide', id: blockedId, attemptId: resumedMain.id, generation: 1, decision: { kind: 'complete', summary: '복구 확인', delegations: [], reviews: [{ taskId: resumedTask.id, resultVersion: 1, decision: 'accepted', reason: 'retried fixture reviewed' }], finalResponse: '복구 결과' } });
  await assert.rejects(call({ action: 'ack', id: blockedId, version: 1 }),{code:'DELIVERY_RECEIPT_REQUIRED'});
  const beforeFinalWake=wakes; await bridge.poll(); assert.equal(wakes,beforeFinalWake);
  await call({ action: 'ack', id: blockedId, version: 1 });
  assert.equal((await call({ action: 'get', id: blockedId })).root.status, 'completed');
  console.log('PASS preflight block -> receipt-backed owner attention without model wake -> restart/no duplicate -> bounded versioned resume -> stale reply rejection -> review -> host final delivery, with no duplicate child');
} finally { await stop('SIGTERM'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
