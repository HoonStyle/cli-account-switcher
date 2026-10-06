'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-models-'));
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const { normalizeModel } = require('../src/launch/model');
const { buildInvocation } = require('../src/adapters/cli');
const store = require('../src/store');
const { Engine } = require('../src/runtime/engine');
const fake = path.join(tmp, 'fake-cli');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'),crypto=require('crypto');
const args=process.argv.slice(2),after=k=>args[args.indexOf(k)+1];
const model=args.includes('--model')?after('--model'):'DEFAULT';
if(model==='missing-model')process.exit(17);
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const session=args.includes('--resume')?after('--resume'):args.includes('--session-id')?after('--session-id'):args.includes('resume')?args[args.indexOf('-')-1]:crypto.randomUUID();
let result;
if(input.includes('Your role is a bounded child'))result={success:true,summary:model,artifacts:[]};
else{
const tasks=JSON.parse(input.match(/Existing children \\(untrusted result data\\): (.*)\\n/)[1]);
const participants=JSON.parse(input.match(/Allowed participants: (.*)\\n/)[1]);
result=tasks.length?{kind:'complete',summary:model,delegations:[],reviews:tasks.map(t=>({taskId:t.id,resultVersion:t.resultVersion,decision:'accepted',reason:'fixture model received'})),finalResponse:model}:{kind:'delegate',summary:model,delegations:participants.map(p=>({participantId:p.participantId,goal:'Return selected model',resolvesTaskIds:[]})),reviews:[],finalResponse:''};
}
if(args.includes('--output-format'))console.log(JSON.stringify({subtype:'success',is_error:false,session_id:session,structured_output:result}));
else{fs.writeFileSync(after('-o'),JSON.stringify(result));console.log(JSON.stringify({type:'thread.started',thread_id:session}));console.log(JSON.stringify({type:'turn.completed'}));}
});
`, { mode: 0o755 });
for (const tool of ['codex', 'claude']) store.addProfile(tool, 'fixture', { shareSettings: false });
const state = store.load();
for (const tool of ['codex', 'claude']) { state[tool].active = 'fixture'; state.realBin[tool] = fake; }
store.save(state);
let engine = new Engine(path.join(tmp, 'runtime'));
async function until(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { engine.tick(); if (fn()) return; await new Promise(r => setTimeout(r, 30)); }
  throw Error('Model round trip timed out');
}
(async () => { try {
  assert.equal(normalizeModel('  '), undefined);
  assert.equal(normalizeModel(' sonnet[1m] '), 'sonnet[1m]');
  for (const bad of [null, 1, {}, '--help', 'two models', 'a\nb', '$(echo injected)', 'a'.repeat(201)]) assert.throws(() => normalizeModel(bad), /[Mm]odel/);
  for (const tool of ['codex', 'claude']) for (const sessionId of [undefined, 'pinned-session']) {
    const inv = buildInvocation({ binding: { tool, executable: fake }, role: 'main', sessionId, permission: 'read-only', dir: tmp });
    assert(!inv.args.includes('--model'), 'unspecified model must preserve legacy CLI defaults');
  }
  console.log('PASS invalid model rejection and unchanged unspecified-model arguments');
  for (const tool of ['codex', 'claude']) {
    const spec = { requestId: tool, mainTool: tool, mainModel: 'main-model', projectPath: tmp, goal: 'Return selected models', participants: [
      { tool, profileId: 'fixture', model: 'child-one' },
      { tool, profileId: 'fixture', model: 'child-two' },
      { tool, profileId: 'fixture', model: 'child-one' },
    ] };
    const root = engine.submit(spec);
    assert.equal(root.participants.length, 2, 'same account with two models must remain distinct');
    assert.equal(engine.submit(spec).id, root.id);
    assert.throws(() => engine.submit({ ...spec, mainModel: 'different' }), /different content/);
    engine.tick(); engine.db.close(); engine = new Engine(path.join(tmp, 'runtime'));
    await until(() => engine.root(root.id).status === 'ready');
    const d = engine.get(root.id);
    assert.equal(d.root.coordinator.model, 'main-model');
    assert.equal(d.root.finalResponse, 'main-model');
    assert.deepEqual(d.tasks.map(t => t.result.summary).sort(), ['child-one', 'child-two']);
    assert.equal(d.attempts.filter(a => a.role === 'main').length, 2);
    for (const a of d.attempts) {
      const saved = JSON.parse(fs.readFileSync(path.join(a.dir, 'spec.json')));
      assert.equal(saved.invocation.args[saved.invocation.args.indexOf('--model') + 1], a.binding.model);
    }
    const ordered = d.attempts.sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < ordered.length; i++) assert(ordered[i].startedAt >= ordered[i - 1].endedAt, 'same account models must not overlap');
    engine.ack(root.id, d.root.finalVersion);
    console.log('PASS ' + tool + ' main/child/resume model arguments, persisted restart and same-account serialization');
  }
  const bad = engine.submit({ requestId: 'unavailable', mainTool: 'codex', mainModel: 'missing-model', projectPath: tmp, goal: 'Do not fall back' });
  await until(() => engine.root(bad.id).status === 'needs_user');
  assert.equal(engine.attempts(bad.id).length, 1);
  assert.equal(engine.root(bad.id).coordinator.model, 'missing-model');
  const owner = { agentId: 'test', sessionKey: 'agent:test:fixture', sessionId: 'fixture' };
  const binding = engine.bindOpenClaw(owner);
  assert.throws(() => engine.submit({ requestId: 'external-main', mainKind: 'openclaw', bindingId: binding.id, mainModel: 'not-owned', projectPath: tmp, goal: 'Reject ignored option' }), /OpenClaw main model/);
  console.log('PASS unavailable-model failure without fallback and OpenClaw-main ownership');
} finally { engine.db.close(); } })().catch(e => { console.error(e); process.exitCode = 1; });
