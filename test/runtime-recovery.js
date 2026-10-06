'use strict';
// Real Git staging, deterministic engine receipts: no model or CLI runner calls.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { randomUUID } = require('crypto'), { execFileSync } = require('child_process');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-recovery-')));
process.env.HOME = path.join(tmp, 'home'); process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts'); fs.mkdirSync(process.env.HOME);
const store = require('../src/store'); const { resolveProfile } = require('../src/launch/profile-resolver');
store.addProfile('claude', 'fixture', { shareSettings: false });
const state = store.load(); state.realBin.claude = process.execPath; store.save(state);
const binding = { ...resolveProfile('claude', 'fixture'), id: 'p1' };
const { Engine } = require('../src/runtime/engine');
const project = path.join(tmp, 'repo'); fs.mkdirSync(project);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(project, 'init'); fs.writeFileSync(path.join(project, 'code.cs'), 'baseline'); git(project, 'add', '.');
git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
const commit = git(project, 'rev-parse', 'HEAD');
const e = new Engine(path.join(tmp, 'runtime'));
function root(options = {}) {
  const r = { id: randomUUID(), coordinator: binding, participants: [binding], permission: 'workspace-write', projectPath: project, commit, generation: 1, round: 3, maxRounds: 3, status: 'needs_user', goal: 'fixture', sessionId: 'session', ...options };
  e.db.put('root', r); return r;
}
function task(r, options = {}) { const t = { id: randomUUID(), rootId: r.id, binding, goal: 'fixture', state: 'blocked', resultVersion: 0, review: null, ...options }; e.db.put('task', t); return t; }
function attempt(r, t, options = {}) { const a = { id: randomUUID(), rootId: r.id, taskId: t?.id, role: t ? 'child' : 'main', binding, generation: 1, state: 'blocked', token: randomUUID(), processed: true, result: { state: 'blocked', failurePhase: 'preflight', processStarted: false, reason: 'missing SDK' }, ...options }; e.db.put('attempt', a); return a; }
function request(t, options = {}) { return { requestId: randomUUID(), extraRounds: 0, retryTaskIds: t ? [t.id] : [], message: 'User authorized recovery', ...options }; }
function blockAgain(r, t) { const a = e.attempts(r.id).at(-1); a.state = 'starting'; a.token = randomUUID(); a.processed = false; e.db.put('attempt', a); e.consume(a, { attemptId: a.id, token: a.token, state: 'blocked', failurePhase: 'preflight', processStarted: false, reason: 'still missing SDK' }); }
try {
  const r = root(), t = task(r), old = attempt(r, t), req = request(t);
  e.resume(r.id, req); assert.equal(e.root(r.id).round, 3); assert.equal(e.root(r.id).maxRounds, 3);
  assert.equal(e.tasks(r.id).length, 1); assert.equal(e.attempts(r.id).length, 2); assert.equal(e.db.get('task', t.id).preflightRetries, 1);
  assert.deepEqual(e.db.get('attempt', old.id), old);
  e.resume(r.id, req); assert.equal(e.attempts(r.id).length, 2);
  assert.throws(() => e.resume(r.id, { ...req, message: 'changed' }), /Conflicting/);
  blockAgain(r, t); e.resume(r.id, request(t)); blockAgain(r, t);
  assert.throws(() => e.resume(r.id, request(t)), /retry limit/);
  assert.equal(e.root(r.id).round, 3); assert.equal(e.db.get('task', t.id).resultVersion, 0);
  console.log('PASS same-task bounded retries preserve terminal history and rounds; replay is exactly once');

  const extension = root({ maxRounds: 7 });
  e.resume(extension.id, request(null, { extraRounds: 3 })); assert.equal(e.root(extension.id).maxRounds, 10); assert.equal(e.attempts(extension.id)[0].purpose, 'continuation');
  const upgrade = root({ executionPolicy: 'edit-only' });
  e.resume(upgrade.id, request(null, { executionPolicy: 'build-test' }));
  assert.equal(e.root(upgrade.id).executionPolicy, 'build-test'); assert.equal(e.root(upgrade.id).maxRounds, 3); assert.equal(e.attempts(upgrade.id)[0].purpose, 'continuation');
  for (const extraRounds of [-1, 4, 0.5]) assert.throws(() => e.resume(root().id, request(null, { extraRounds })), /limits/);
  assert.throws(() => e.resume(root({ maxRounds: 9 }).id, request(null, { extraRounds: 2 })), /total round/);
  assert.throws(() => e.resume(root({ permission: 'read-only' }).id, request(null, { executionPolicy: 'build-test' })), /workspace-write/);
  for (const status of ['completed', 'cancelled', 'ready']) assert.throws(() => e.resume(root({ status }).id, request(null)), /not waiting/);
  for (const status of ['unknown', 'starting', 'running', 'queued', 'external_wait']) {
    const busy = root(); attempt(busy, null, { state: status });
    assert.throws(() => e.resume(busy.id, request(null)), /pending or ambiguous/);
  }
  const all = root(), a = task(all), b = task(all); attempt(all, a); attempt(all, b);
  assert.throws(() => e.resume(all.id, request(a)), /all and only/);
  assert.throws(() => e.respond(all.id, 'continue'), /bounded resume/);
  const ambiguous = root(), at = task(ambiguous); attempt(ambiguous, at, { result: { state: 'blocked', failurePhase: 'preflight', processStarted: true } });
  assert.throws(() => e.resume(ambiguous.id, request(at)), /proven preflight/);
  console.log('PASS round caps, terminal/pending roots, explicit all-task retry and ambiguous receipt rejection');

  const owner = { agentId: 'owner', sessionKey: 'agent:owner:fixture', sessionId: 'session' };
  const bridge = e.bindOpenClaw(owner), oc = root({ coordinator: { tool: 'openclaw', bindingId: bridge.id, ...owner } });
  assert.throws(() => e.respond(oc.id, 'continue'), /binding mismatch/);
  assert.throws(() => e.resume(oc.id, request(null)), /binding mismatch/);
  assert.throws(() => e.resume(oc.id, request(null), { ...owner, sessionId: 'foreign' }), /binding mismatch/);
  const ocRequest = request(null, { extraRounds: 1, executionPolicy: 'build-test' }); e.resume(oc.id, ocRequest, owner);
  assert.equal(e.attempts(oc.id)[0].state, 'external_wait'); assert.equal(e.root(oc.id).executionPolicy, 'build-test');
  assert(e.db.events(oc.id).some(event => event.type === 'root_resumed' && event.body.actor.agentId === 'owner'));
  assert.throws(() => e.resume(oc.id, ocRequest, { ...owner, agentId: 'foreign' }), /binding mismatch/);
  e.suspendOpenClaw(bridge.id, 'revoked'); assert.throws(() => e.resume(oc.id, ocRequest, owner), /binding mismatch/);
  console.log('PASS explicit owner authorization before replay and audited opt-in policy extension');

  const paused = root({ status: 'running' }), p1 = task(paused, { state: 'queued' }), p2 = task(paused, { state: 'queued' });
  const pa = attempt(paused, p1, { state: 'starting', processed: false }), pb = attempt(paused, p2, { state: 'queued', processed: false });
  assert.throws(() => e.consume(pa, { attemptId: pa.id, token: pa.token, state: 'blocked', processStarted: true, failurePhase: 'preflight' }), /Ambiguous/);
  assert.throws(() => e.consume({ ...pa, state: 'running', processStarted: true }, { attemptId: pa.id, token: pa.token, state: 'blocked', processStarted: false, failurePhase: 'preflight' }), /Ambiguous/);
  e.consume(pa, { attemptId: pa.id, token: pa.token, state: 'blocked', processStarted: false, failurePhase: 'preflight', reason: 'SDK missing' });
  assert.equal(e.root(paused.id).status, 'needs_user'); assert.equal(e.db.get('attempt', pb.id).result.reason, 'root_preflight_pause');
  e.resume(paused.id, request(null, { retryTaskIds: [p1.id, p2.id] }));
  assert.equal(e.db.get('task', p1.id).preflightRetries, 1); assert.equal(e.db.get('task', p2.id).preflightRetries || 0, 0);
  console.log('PASS nonterminal blocked receipt and sibling pause without retry charge');

  const sourceRoot = root({ round: 0, status: 'running' });
  const sourceDir = path.join(tmp, 'source'); git(project, 'worktree', 'add', '--detach', sourceDir, commit);
  fs.writeFileSync(path.join(sourceDir, 'code.cs'), 'implementation'); fs.writeFileSync(path.join(sourceDir, 'new.cs'), 'new implementation');
  const sourceTask = task(sourceRoot, { state: 'succeeded', resultVersion: 1, cwd: sourceDir, review: { decision: 'accepted' } });
  const inputs = [{ taskId: sourceTask.id, resultVersion: 1, paths: ['code.cs', 'new.cs'] }];
  assert.throws(() => e.validateInputs(root(), inputs), /artifact_source/);
  assert.throws(() => e.validateInputs(sourceRoot, [{ ...inputs[0], resultVersion: 2 }]), /artifact_source/);
  const writer = attempt(sourceRoot, sourceTask, { state: 'unknown' }); assert.throws(() => e.validateInputs(sourceRoot, inputs), /active_writer/);
  writer.state = 'succeeded'; e.db.put('attempt', writer);
  fs.mkdirSync(path.join(sourceDir,'.build-cache')); fs.writeFileSync(path.join(sourceDir,'.build-cache','package'), 'generated');
  const cacheTask=task(sourceRoot,{state:'queued',cwd:sourceDir}), cacheAttempt=attempt(sourceRoot,cacheTask,{state:'starting',processed:false});
  e.consume(cacheAttempt,{attemptId:cacheAttempt.id,token:cacheAttempt.token,state:'succeeded',result:{success:true,summary:'fixture',artifacts:[]}});
  assert(!e.db.get('task',cacheTask.id).changes.files.some(file=>file.startsWith('.build-cache')));
  const reviewedCache=e.db.get('task',cacheTask.id); reviewedCache.review={decision:'accepted'}; e.db.put('task',reviewedCache);
  const main = { id: randomUUID(), generation: 1, result: { sessionId: 'session' } };
  e.db.transaction(() => e.applyMain(sourceRoot, main, { kind: 'delegate', summary: 'approved selected inputs', delegations: [{ participantId: 'p1', goal: 'repair', resolvesTaskIds: [], inputs }], reviews: [], finalResponse: '' }));
  const followup = e.tasks(sourceRoot.id).find(t => t.id !== sourceTask.id && t.id !== cacheTask.id), followupAttempt = e.attempts(sourceRoot.id).find(a => a.taskId === followup.id);
  // Stop deterministically at adapter validation, after capture and stage but before spawn.
  followupAttempt.binding = { ...binding, model: '--invalid' };
  assert.throws(() => e.prepare(followupAttempt), /model identifier/);
  const staged = e.db.get('task', followup.id);
  assert.equal(fs.readFileSync(path.join(staged.cwd, 'code.cs'), 'utf8'), 'implementation');
  assert.equal(fs.readFileSync(path.join(staged.cwd, 'new.cs'), 'utf8'), 'new implementation');
  assert(staged.inputSnapshot.hash); assert(!e.db.events(sourceRoot.id).some(event => event.type === 'spawn_intent'));
  assert(e.prompt(sourceRoot, { role: 'child', taskId: staged.id }).includes(staged.inputSnapshot.hash));
  assert.throws(() => e.prepare(followupAttempt), /model identifier/);
  console.log('PASS explicit source/version/active-writer validation and immutable inheritance before any spawn');

  const isolated = new Engine(path.join(tmp, 'isolated-runtime'));
  try {
    const ir = { ...root({ status: 'running' }), id: randomUUID() };
    isolated.db.put('root', ir);
    const it = { id: randomUUID(), rootId: ir.id, state: 'queued', resultVersion: 0, binding, goal: 'fixture' };
    const ia = { id: randomUUID(), rootId: ir.id, taskId: it.id, role: 'child', state: 'queued', binding: { ...binding, executable: '/absent/cli' }, createdAt: Date.now() };
    const conflictRoot={...ir,id:randomUUID()}, conflictTask={...it,id:randomUUID(),rootId:conflictRoot.id};
    const conflictAttempt={...ia,id:randomUUID(),rootId:conflictRoot.id,taskId:conflictTask.id,binding:{...binding,home:binding.home+'-other'},state:'starting',token:randomUUID(),startedAt:Date.now()};
    conflictAttempt.dir=path.join(tmp,'conflict-attempt');fs.mkdirSync(conflictAttempt.dir);
    fs.writeFileSync(path.join(conflictAttempt.dir,'result.json'),JSON.stringify({attemptId:conflictAttempt.id,token:'invalid',state:'blocked',processStarted:false,failurePhase:'preflight'}));
    isolated.db.put('root',conflictRoot);isolated.db.put('task',conflictTask);isolated.db.put('attempt',conflictAttempt);
    isolated.db.put('task', it); isolated.db.put('attempt', ia); isolated.tick();
    assert.equal(isolated.db.get('attempt',conflictAttempt.id).state,'unknown');assert.match(isolated.root(conflictRoot.id).attention,/receipt_conflict/);
    const raceRoot={...ir,id:randomUUID()},raceTask={...it,id:randomUUID(),rootId:raceRoot.id};const raceAttempt={...conflictAttempt,id:randomUUID(),rootId:raceRoot.id,taskId:raceTask.id,state:'starting',dir:path.join(tmp,'race-attempt')};fs.mkdirSync(raceAttempt.dir);
    isolated.db.put('root',raceRoot);isolated.db.put('task',raceTask);isolated.db.put('attempt',raceAttempt);
    fs.writeFileSync(path.join(raceAttempt.dir,'live.json'),JSON.stringify({attemptId:raceAttempt.id,token:raceAttempt.token,at:Date.now()}));isolated.tick();assert.equal(isolated.db.get('attempt',raceAttempt.id).state,'starting');
    fs.writeFileSync(path.join(raceAttempt.dir,'result.json'),JSON.stringify({attemptId:raceAttempt.id,token:raceAttempt.token,state:'blocked',processStarted:false,failurePhase:'preflight',reason:'ENOENT'}));isolated.tick();assert.equal(isolated.db.get('task',raceTask.id).state,'blocked');
    assert.equal(isolated.root(ir.id).status, 'needs_user'); assert.equal(isolated.db.get('task', it.id).state, 'blocked');
    assert.equal(isolated.db.get('task', it.id).resultVersion, 0); assert.equal(isolated.attempts(ir.id).length, 1);
    isolated.tick(); assert.equal(isolated.attempts(ir.id).length, 1); assert(!isolated.db.events(ir.id).some(ev => ev.type === 'spawn_intent'));
    assert.equal(isolated.root(ir.id).round, 3);
    console.log('PASS actual preparation failure blocks without model spawn or automatic retry');
  } finally { isolated.db.close(); }
} finally { e.db.close(); }
