'use strict';
// Real isolated sockets and runner processes; never contacts a model provider.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');
// realpath adds /private on macOS; reserve space for accounts/runtime/service.sock.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')));
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const client = require('../src/runtime/client');
const { REQUEST_LIMIT, TRANSPORT, HELLO_METHOD, PROTOCOL_VERSION } = require('../src/runtime/transport');
const { attemptOutput, STDOUT_LIMIT, STDERR_LIMIT } = require('../src/runtime/output');
const { Engine } = require('../src/runtime/engine');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wire = (method, params) => Buffer.from(JSON.stringify({ method, params }) + '\n');
function padded(method, params, size) {
  const value = { ...params, padding: '' };
  const remaining = size - wire(method, value).length;
  assert(remaining >= 0);
  value.padding = '한😀'.repeat(Math.floor(remaining / 7)) + 'x'.repeat(remaining % 7);
  assert.equal(wire(method, value).length, size);
  return value;
}
function rawRequest(buffer, split) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(client.socket);
    connection.setEncoding('utf8');
    let text = '', settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      connection.destroy();
      if (error) return reject(error);
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    };
    connection.setTimeout(5000, () => finish(new Error('Raw socket response timed out')));
    connection.on('error', finish);
    connection.on('data', chunk => { text += chunk; if (text.includes('\n')) finish(); });
    connection.on('end', () => finish());
    connection.on('connect', () => {
      if (!split) connection.end(buffer);
      else {
        connection.write(buffer.subarray(0, split));
        setTimeout(() => { if (!settled) connection.end(buffer.subarray(split)); }, 30);
      }
    });
  });
}
async function legacyServer(check) {
  fs.mkdirSync(client.dir, { recursive: true });
  const received = [];
  const fake = net.createServer(connection => connection.once('data', data => {
    const { method } = JSON.parse(data); received.push(method);
    connection.end(JSON.stringify(method === HELLO_METHOD ? { error: 'Unknown task method' } : { result: method === 'list' ? [] : { status: 'ok', version: 1, pid: 1234 } }) + '\n');
  }));
  await new Promise(resolve => fake.listen(client.socket, resolve));
  try { await check(received); } finally { await new Promise(resolve => fake.close(resolve)); }
}
function pendingDecisionFixture() {
  const engine = new Engine(client.dir);
  try {
    const owner = { agentId: 'transport-fixture', sessionKey: 'agent:transport-fixture:test', sessionId: 'fixture-session' };
    const link = engine.bindOpenClaw(owner);
    const binding = { tool: 'claude', home: tmp, profileId: 'fixture', executable: process.execPath };
    const root = { id: randomUUID(), goal: 'fixture', projectPath: tmp, permission: 'read-only', executionPolicy: 'edit-only', coordinator: { tool: 'openclaw', bindingId: link.id, ...owner }, participants: [{ id: 'p1', ...binding }], generation: 1, status: 'running', round: 1, maxRounds: 3, finalVersion: 0, finalDelivery: 'pending', createdAt: Date.now() };
    engine.saveRoot(root);
    const task = { id: randomUUID(), rootId: root.id, goal: 'fixture child', binding, generation: 1, state: 'queued', resultVersion: 0, review: null };
    const attempt = { id: randomUUID(), rootId: root.id, taskId: task.id, role: 'child', binding, generation: 1, state: 'running', token: randomUUID(), createdAt: Date.now(), startedAt: Date.now() };
    engine.db.put('task', task); engine.db.put('attempt', attempt);
    engine.consume(attempt, { attemptId: attempt.id, token: attempt.token, state: 'succeeded', result: { success: true, summary: 'done', artifacts: [] } });
    engine.tick();
    const main = engine.attempts(root.id).find(a => a.state === 'external_wait');
    assert(main);
    return { id: root.id, owner, attemptId: main.id, generation: 1, decision: { kind: 'complete', summary: '검토 완료', delegations: [], reviews: [{ taskId: task.id, resultVersion: 1, decision: 'accepted', reason: 'fixture checked' }], finalResponse: '검토'.repeat(14000) } };
  } finally { engine.db.close(); }
}
const fake = path.join(tmp, 'fake-cli');
fs.writeFileSync(fake, '#!' + process.execPath + '\n' + String.raw`
const fs = require('fs');
const args = process.argv.slice(2), after = key => args[args.indexOf(key) + 1];
const claude = args.includes('--output-format'), session = claude ? after('--session-id') : 'fixture-session';
const result = { success: true, summary: '한글😀', artifacts: ['결과/😀.txt'] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function split(stream, text) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length;) {
    let end = i + 1;
    if (bytes[i] < 128) while (end < bytes.length && bytes[end] < 128) end++;
    stream.write(bytes.subarray(i, end));
    if (bytes[i] >= 128) await sleep(15);
    i = end;
  }
}
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', async () => {
  if (input === 'ring') {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '한😀'.repeat(650000) }] } }) + '\n');
    process.stderr.write('한😀'.repeat(30000));
  }
  if (input === 'overflow') {
    process.stdout.write('한'.repeat(Math.floor(4 * 1024 * 1024 / 3) + 1));
    return;
  }
  const text = claude
    ? JSON.stringify({ type: 'result', subtype: 'success', session_id: session, structured_output: result }) + '\n'
    : JSON.stringify({ type: 'thread.started', thread_id: session }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n';
  if (input === 'invalid-byte') {
    const bytes = Buffer.from(text); bytes[bytes.indexOf(Buffer.from('한'))] = 255;
    process.stdout.write(bytes); return;
  }
  if (input === 'incomplete-eof') {
    process.stdout.write(text); process.stdout.write(Buffer.from([0xe3, 0x81])); return;
  }
  if (input === 'invalid-ignore-term') {
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
    process.stdout.write(Buffer.from([255])); return;
  }
  if (input.startsWith('file-')) {
    const bytes = Buffer.from(JSON.stringify(result));
    if (input === 'file-invalid') bytes[bytes.indexOf(Buffer.from('한'))] = 255;
    fs.writeFileSync(after('-o'), input === 'file-incomplete' ? Buffer.concat([bytes, Buffer.from([0xe3, 0x81])]) : bytes);
  }
  if (input === 'stderr-invalid') { process.stdout.write(text); process.stderr.write(Buffer.from([255])); return; }
  await Promise.all([split(process.stdout, text), split(process.stderr, '오류😀 끝\n')]);
});
`, { mode: 0o755 });
function runner(tool, mode) {
  const store = require('../src/store');
  if (!store.load()[tool].profiles.includes('transport-fixture')) store.addProfile(tool, 'transport-fixture', { shareSettings: false });
  const state = store.load(); state.realBin[tool] = fake; store.save(state);
  const binding = require('../src/launch/profile-resolver').resolveProfile(tool, 'transport-fixture');
  const dir = path.join(tmp, tool + '-' + mode); fs.mkdirSync(dir);
  const invocation = require('../src/adapters/cli').buildInvocation({ binding, role: 'child', permission: 'read-only', cwd: tmp, dir });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ attemptId: 'transport-fixture', token: 'fixture-token', binding, invocation, cwd: tmp, prompt: mode }));
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../src/runtime/runner.js'), dir], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return { result: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'))), live: JSON.parse(fs.readFileSync(path.join(dir, 'live.json'))), terminal: JSON.parse(fs.readFileSync(path.join(dir, 'terminal.json'))), stdout: fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8'), stderr: fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8') };
}
function cleanUnicode(text) { assert(!text.includes('\ufffd'), 'valid UTF-8 must not be replaced'); assert.equal(text, Buffer.from(text).toString('utf8'), 'no partial surrogate pair'); }
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('oversized client request is rejected before connect/write with byte metadata', async () => {
    let guarded = false;
    await assert.rejects(client.request('health', padded('health', {}, REQUEST_LIMIT + 1), { beforeWrite() { guarded = true; } }), error => {
      assert.equal(error.code, 'ERR_TASK_REQUEST_TOO_LARGE');
      assert.equal(error.requestBytes, REQUEST_LIMIT + 1); assert.equal(error.maxBytes, REQUEST_LIMIT);
      assert.match(error.message, /No action was applied/); return true;
    });
    assert.equal(guarded, false);
    assert.equal(fs.existsSync(client.socket), false);
  });
  await test('new client keeps legacy diagnostics readable but never sends a mutation to an old service', async () => {
    await legacyServer(async received => {
      assert.equal((await client.request('health')).status, 'ok');
      assert.deepEqual(await client.request('list'), []);
      assert.equal((await client.ensureService({ readOnly: true })).status, 'ok');
      await assert.rejects(client.ensureService(), { code: 'ERR_TASK_PROTOCOL_MISMATCH' });
      for (const method of ['bridgePulse', 'bridgeDecide', 'submit']) {
        await assert.rejects(client.request(method, {}), error => {
          assert.equal(error.code, 'ERR_TASK_PROTOCOL_MISMATCH');
          assert.match(error.message, /No action was applied/); assert.match(error.message, /Existing executions are preserved/); return true;
        });
      }
      assert(received.every(method => ['health', 'list', HELLO_METHOD].includes(method)));
    });
  });
  const payload = pendingDecisionFixture();
  const service = spawn(process.execPath, [path.resolve(__dirname, '../src/runtime/service.js')], { env: process.env, stdio: 'ignore' });
  const exited = new Promise(resolve => service.once('exit', resolve));
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await client.request('health')).pid === service.pid) { ready = true; break; } } catch {} await sleep(30); }
    assert(ready, 'isolated service started');
    await test('client/server agree on whole-frame limits and accept max-1 and max UTF-8 bytes', async () => {
      const health = await client.request('health');
      assert.deepEqual(health.transport, TRANSPORT);
      for (const size of [REQUEST_LIMIT - 1, REQUEST_LIMIT]) {
        assert.equal((await client.request('health', padded('health', {}, size))).status, 'ok');
        const bytes = wire('health', padded('health', {}, size));
        const split = bytes.indexOf(Buffer.from('한')) + 1;
        assert.equal((await rawRequest(bytes, split)).result.status, 'ok');
      }
    });
    await test('new service rejects legacy/wrong-version mutations and malformed UTF-8 without state changes', async () => {
      const owner = { agentId: 'wire-fixture', sessionKey: 'agent:wire-fixture:test', sessionId: '한글' };
      const before = await client.request('bridgeAllBindings');
      const legacy = await rawRequest(wire('bridgeBind', owner));
      assert.equal(legacy.code, 'ERR_TASK_PROTOCOL_MISMATCH'); assert.match(legacy.error, /No action was applied/);
      const wrong = await rawRequest(wire(HELLO_METHOD, { protocolVersion: PROTOCOL_VERSION - 1 }));
      assert.equal(wrong.code, 'ERR_TASK_PROTOCOL_MISMATCH');
      const invalid = wire('bridgeBind', owner); invalid[invalid.indexOf(Buffer.from('한'))] = 255;
      const bad = await rawRequest(invalid); assert.equal(bad.code, 'ERR_ENCODING_INVALID_ENCODED_DATA');
      assert.deepEqual(await client.request('bridgeAllBindings'), before);
    });
    await test('authority is rechecked after same-socket handshake before any mutation is written', async () => {
      const before = await client.request('bridgeAllBindings'); let checks = 0;
      await assert.rejects(client.request('bridgeBind', { agentId: 'revoked', sessionKey: 'agent:revoked:test', sessionId: 'fixture' }, { beforeWrite() { if (++checks === 2) throw new Error('fixture authority revoked during handshake'); } }), /revoked during handshake/);
      assert.equal(checks, 2); assert.deepEqual(await client.request('bridgeAllBindings'), before);
    });
    await test('raw oversize requests receive structured errors with and without newline', async () => {
      const bytes = wire('health', padded('health', {}, REQUEST_LIMIT + 1));
      for (const request of [bytes, Buffer.concat([bytes.subarray(0, -1), Buffer.from('xx')])]) {
        const result = await rawRequest(request);
        assert.equal(result.code, 'ERR_TASK_REQUEST_TOO_LARGE');
        assert.equal(result.details.maxBytes, REQUEST_LIMIT);
        assert(result.details.requestBytes > REQUEST_LIMIT);
        assert.match(result.error, /No action was applied/);
      }
      // One request per connection: an extra frame cannot invalidate the first.
      const result = await rawRequest(Buffer.concat([wire('health', {}), Buffer.alloc(REQUEST_LIMIT + 1, 120)]));
      assert.equal(result.result.status, 'ok');
    });
    await test('rejected decisions preserve pending work; >64KiB Korean final saves and reads exactly', async () => {
      const oversized = { ...payload, decision: { ...payload.decision, finalResponse: '한'.repeat(REQUEST_LIMIT) } };
      await assert.rejects(client.request('bridgeDecide', oversized), { code: 'ERR_TASK_REQUEST_TOO_LARGE' });
      const rejected = await rawRequest(wire('bridgeDecide', oversized));
      assert.equal(rejected.code, 'ERR_TASK_REQUEST_TOO_LARGE');
      const before = await client.request('bridgeGet', { id: payload.id, owner: payload.owner });
      assert.equal(before.root.finalVersion, 0);
      assert.equal(before.attempts.find(a => a.id === payload.attemptId).state, 'external_wait');
      assert(wire('bridgeDecide', payload).length > 65536);
      assert.equal((await client.request('bridgeDecide', payload)).status, 'ready');
      const after = await client.request('bridgeGet', { id: payload.id, owner: payload.owner });
      assert.equal(after.root.finalVersion, 1); assert.equal(after.root.finalResponse, payload.decision.finalResponse);
    });
  } finally {
    if (service.exitCode === null) { service.kill('SIGTERM'); await exited; }
  }
  await test('a later service restart cannot reuse a cached compatibility decision', async () => {
    await legacyServer(async received => {
      await assert.rejects(client.request('bridgePulse'), { code: 'ERR_TASK_PROTOCOL_MISMATCH' });
      assert.deepEqual(received, [HELLO_METHOD]);
    });
  });
  await test('real Claude/Codex runners preserve split Korean, emoji, stderr and artifact paths', () => {
    for (const tool of ['claude', 'codex']) {
      const output = runner(tool, 'split');
      assert.equal(output.result.state, 'succeeded');
      assert.equal(output.result.result.summary, '한글😀');
      assert.deepEqual(output.result.result.artifacts, ['결과/😀.txt']);
      assert.equal(output.stderr, '오류😀 끝\n');
      assert.equal(output.terminal.stderr, output.stderr);
      for (const text of [output.stdout, output.stderr, output.terminal.stdout, output.terminal.stderr]) cleanUnicode(text);
      if (tool === 'codex') assert(output.live.lastProgressAt > 0);
    }
  });
  await test('stream rings and terminal tails remain byte bounded without cutting Unicode', () => {
    const output = runner('claude', 'ring');
    assert.equal(output.result.state, 'succeeded'); assert.equal(output.result.result.summary, '한글😀');
    assert(output.terminal.truncated);
    assert(Buffer.byteLength(output.stdout) <= 4 * 1024 * 1024);
    assert(Buffer.byteLength(output.stderr) <= 131072);
    assert(Buffer.byteLength(output.terminal.stdout) <= STDOUT_LIMIT);
    assert(Buffer.byteLength(output.terminal.stderr) <= STDERR_LIMIT);
    for (const text of [output.stdout, output.stderr, output.terminal.stdout, output.terminal.stderr]) cleanUnicode(text);
  });
  await test('malformed or incomplete authoritative stdout can never produce a success receipt', () => {
    for (const tool of ['claude', 'codex']) for (const mode of ['invalid-byte', 'incomplete-eof']) {
      const output = runner(tool, mode);
      assert.equal(output.result.state, 'failed'); assert.equal(output.result.reason, 'invalid_stdout_utf8');
      assert.equal(output.result.failurePhase, 'execution'); assert.equal(output.result.processStarted, true);
      assert.equal(output.result.result, undefined); cleanUnicode(output.stdout);
    }
    const diagnostic = runner('claude', 'stderr-invalid');
    assert.equal(diagnostic.result.state, 'succeeded'); assert.equal(diagnostic.result.result.summary, '한글😀');
    assert.equal(diagnostic.stderr, '\ufffd', 'Diagnostic-only stderr permits replacement text');
  });
  await test('Codex authoritative result file rejects bad UTF-8 instead of falling back to valid stdout', () => {
    for (const mode of ['file-invalid', 'file-incomplete']) {
      const output = runner('codex', mode);
      assert.equal(output.result.state, 'failed'); assert.match(output.result.reason, /Invalid UTF-8 in Codex result file/);
      assert.equal(output.result.failurePhase, 'parse'); assert.equal(output.result.processStarted, true);
      assert.equal(output.result.result, undefined);
    }
    const valid = runner('codex', 'file-valid');
    assert.equal(valid.result.state, 'succeeded'); assert.equal(valid.result.result.summary, '한글😀');
  });
  await test('invalid-output termination escalates and records failure only after the child exits', () => {
    const startedAt = Date.now(), output = runner('claude', 'invalid-ignore-term');
    assert(Date.now() - startedAt >= 5000, 'TERM-ignoring child needs the grace period');
    assert.equal(output.result.state, 'failed'); assert.equal(output.result.reason, 'invalid_stdout_utf8');
    assert.equal(output.result.exit.signal, 'SIGKILL');
    assert.throws(() => process.kill(output.live.childPid, 0), { code: 'ESRCH' });
  });
  await test('non-stream stdout limit counts UTF-8 bytes rather than JS characters', () => {
    const output = runner('codex', 'overflow');
    assert.equal(output.result.state, 'failed'); assert.equal(output.result.reason, 'output_limit');
    assert(Buffer.byteLength(output.stdout) <= 4 * 1024 * 1024); cleanUnicode(output.stdout);
  });
  await test('legacy output logs and older terminal snapshots retain Unicode-safe bounded tails', () => {
    const attempt = { id: 'output-fixture', token: 'fixture-token', state: 'succeeded', dir: path.join(client.dir, 'attempts', 'output-fixture') };
    fs.mkdirSync(attempt.dir, { recursive: true });
    fs.writeFileSync(path.join(attempt.dir, 'stdout.log'), '한😀'.repeat(20000));
    fs.writeFileSync(path.join(attempt.dir, 'stderr.log'), '한'.repeat(6000));
    const legacy = attemptOutput(client.dir, attempt);
    assert(legacy.truncated); cleanUnicode(legacy.stdout); cleanUnicode(legacy.stderr);
    assert(Buffer.byteLength(legacy.stdout) <= STDOUT_LIMIT); assert(Buffer.byteLength(legacy.stderr) <= STDERR_LIMIT);
    fs.writeFileSync(path.join(attempt.dir, 'terminal.json'), JSON.stringify({ attemptId: attempt.id, token: attempt.token, stdout: '😀'.repeat(40000) + '끝', stderr: '한'.repeat(6000), truncated: false }));
    const snapshot = attemptOutput(client.dir, attempt);
    assert(snapshot.truncated); cleanUnicode(snapshot.stdout); cleanUnicode(snapshot.stderr);
    assert(snapshot.stdout.endsWith('끝'));
    assert(Buffer.byteLength(snapshot.stdout) <= STDOUT_LIMIT); assert(Buffer.byteLength(snapshot.stderr) <= STDERR_LIMIT);
  });
  console.log(JSON.stringify({ passed, failed: 0, total: 15 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
