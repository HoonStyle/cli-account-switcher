'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Engine, alive } = require('./engine');
const { dir, socket } = require('./client');
const { REQUEST_LIMIT, RESPONSE_LIMIT, PROTOCOL_VERSION, HELLO_METHOD, TRANSPORT, isReadOnly, protocolMismatch, requestTooLarge } = require('./transport');
const { queryReply, LOCAL_QUERY_OPTIONS, projectDashboard, projectDashboardList } = require('./query');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const lock = path.join(dir, 'service.lock');
// Serialize stale-lock inspection as well as acquisition. A crashed recovery guard
// is deliberately fail-closed: inspect/remove it manually, never steal a live lock.
const guard = lock + '.guard';
let guardFd;
try { guardFd = fs.openSync(guard, 'wx', 0o600); }
catch { console.error('Service startup/recovery guard occupied; inspect runtime lock state'); process.exit(1); }
try {
  if (fs.existsSync(lock)) {
    const prior = (() => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { return null; } })();
    if (!prior || alive(prior.pid)) throw new Error('Service lock occupied/ambiguous');
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); fs.fsyncSync(fd); fs.closeSync(fd);
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { fs.closeSync(guardFd); fs.unlinkSync(guard); }
if (process.exitCode) process.exit(process.exitCode);
if (process.platform !== 'win32' && fs.existsSync(socket)) fs.unlinkSync(socket);
const engine = new Engine(dir, { attention: r => {
  console.error(`attention ${r.id}: ${r.status === 'needs_user' && r.inputRequest ? r.inputRequest.reason : r.attention}`);
  if (process.platform === 'darwin' && !process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS) {
    return new Promise((resolve, reject) => {
      const child = spawn('osascript', ['-e', 'display notification "작업 관리 화면에서 대기·오류를 확인하세요." with title "CLI Account Switch"'], { stdio: 'ignore', timeout: 10000 });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('macOS notification dispatch failed')));
    });
  }
} });
let timer, stopping = false;
const methods = {
  health: () => ({ status: 'ok', pid: process.pid, version: 1, appVersion: require('../edition.json').version, edition: require('../edition.json').name, transport: TRANSPORT, capabilities: { claude: 'requires-runtime-verification', codex: 'requires-runtime-verification', openclaw: 'plugin-bridge', managedDepth: 1, modelSelection: true, artifactInputs: true, boundedResume: true, claudeBuildTest: true, attentionDelivery: true } }),
  bridgeBind: p => engine.bindOpenClaw(p), bridgePulse: () => engine.db.put('meta', { id: 'bridge-health', at: engine.now() }),
  bridgeAllBindings: () => engine.db.all('bridge').filter(b => !b.suspended),
  bridgeBindings: () => engine.now() - (engine.db.get('meta', 'bridge-health')?.at || 0) < 15000 ? engine.db.all('bridge').filter(b => !b.suspended) : [],
  bridgePending: () => engine.openClawPending(), bridgeWake: p => engine.openClawWake(p.id, p.attemptId, p.error, p.finalVersion, p.attentionVersion),
  bridgeSuspend: p => engine.suspendOpenClaw(p.bindingId, p.reason),
  bridgeGet: p => { engine.authorizeOpenClaw(p.id, p.owner); return engine.get(p.id); },
  bridgeQuery: p => {
    engine.authorizeOpenClaw(p.id, p.owner);
    const query = { ...p.query, action: 'get' };
    return queryReply(engine.querySource(p.id, query), query, { edition: require('../edition.json').name, dataRoot: require('../paths').ROOT });
  },
  query: p => { const query = { ...p.query, action: 'get' }; return queryReply(engine.querySource(p.id, query), query, {}, LOCAL_QUERY_OPTIONS); },
  dashboard: p => projectDashboard(engine.querySource(p.id, { view: 'dashboard' })),
  dashboardList: () => projectDashboardList(engine.list()),
  bridgeDecide: p => engine.openClawDecide(p.id, p.owner, p.attemptId, p.generation, p.decision),
  bridgeAction: p => { engine.authorizeOpenClaw(p.id, p.owner); if (!['cancel', 'respond', 'resume', 'ack', 'ack_attention'].includes(p.action)) throw new Error('Invalid bridge action'); return engine[p.action === 'ack_attention' ? 'ackAttention' : p.action](p.id, p.action === 'respond' ? p.message : p.action === 'resume' ? p.request : p.version, p.owner); },
  submit: p => engine.submit(p), list: () => engine.list(), get: p => engine.get(p.id), output: p => engine.output(p.id, p.attemptId),
  cancel: p => engine.cancel(p.id), respond: p => engine.respond(p.id, p.message), resume: p => engine.resume(p.id, p.request), ack: p => engine.ack(p.id, p.version),
};
const server = net.createServer(connection => {
  let chunks = [], bytes = 0, handled = false, negotiated = false;
  connection.setTimeout(10000, () => connection.destroy()); connection.on('error', () => {});
  const reject = error => {
    handled = true; chunks = [];
    connection.end(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.maxBytes ? { details: { requestBytes: error.requestBytes, responseBytes: error.responseBytes, maxBytes: error.maxBytes } } : {}) }) + '\n');
  };
  connection.on('data', data => {
    // A connection permits hello + exactly one action. Negotiation cannot leak
    // across sockets/restarts; legacy mutation requests fail before dispatch.
    while (!handled && data.length) {
      const newline = data.indexOf(10);
      const frame = newline < 0 ? data : data.subarray(0, newline + 1);
      bytes += frame.length;
      if (bytes > REQUEST_LIMIT) { reject(requestTooLarge(bytes)); return; }
      chunks.push(frame);
      if (newline < 0) return;
      data = data.subarray(newline + 1);
      try {
        // Invalid UTF-8 must not be repaired into different mutation data.
        const { method, params } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
        chunks = []; bytes = 0;
        if (method === HELLO_METHOD) {
          if (negotiated || params?.protocolVersion !== PROTOCOL_VERSION) throw protocolMismatch();
          negotiated = true;
          connection.write(JSON.stringify({ result: TRANSPORT }) + '\n');
          continue;
        }
        if (!isReadOnly(method) && !negotiated) throw protocolMismatch();
        if (!Object.hasOwn(methods, method)) throw new Error('Unknown task method');
        const result = methods[method](params || {});
        const response = JSON.stringify({ result }) + '\n', responseBytes = Buffer.byteLength(response);
        if (responseBytes > RESPONSE_LIMIT) {
          const error = new Error(`Response too large: ${responseBytes} bytes exceeds the ${RESPONSE_LIMIT}-byte RPC limit. Use dashboard/dashboardList or bounded query/bridgeQuery views instead of aggregate get/list. ${isReadOnly(method) ? 'Read data was not returned as a complete result.' : 'The action may already have been applied. Inspect the existing task; do not blindly retry the mutation.'}`);
          error.code = 'ERR_TASK_RESPONSE_TOO_LARGE'; error.responseBytes = responseBytes; error.maxBytes = RESPONSE_LIMIT; throw error;
        }
        handled = true;
        connection.end(response);
      } catch (error) { reject(error); }
    }
  });
});
function tick() { try { engine.tick(); } catch (e) { console.error('tick error:', e.message); } }
server.listen(socket, () => { if (process.platform !== 'win32') fs.chmodSync(socket, 0o600); tick(); timer = setInterval(tick, 1000); });
function stop() {
  if (stopping) return; stopping = true; clearInterval(timer);
  server.close(() => { engine.db.close(); try { fs.unlinkSync(lock); } catch {} process.exit(0); });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
