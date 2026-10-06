'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Engine, alive } = require('./engine');
const { dir, socket } = require('./client');
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
  console.error(`attention ${r.id}: ${r.attention}`);
  if (process.platform === 'darwin' && !process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS) {
    return new Promise((resolve, reject) => {
      const child = spawn('osascript', ['-e', 'display notification "작업 관리 화면에서 대기·오류를 확인하세요." with title "CLI Account Switch"'], { stdio: 'ignore', timeout: 10000 });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('macOS notification dispatch failed')));
    });
  }
} });
let timer, stopping = false;
const methods = {
  health: () => ({ status: 'ok', pid: process.pid, version: 1, appVersion: require('../edition.json').version, edition: require('../edition.json').name, capabilities: { claude: 'requires-runtime-verification', codex: 'requires-runtime-verification', openclaw: 'plugin-bridge', managedDepth: 1, modelSelection: true } }),
  bridgeBind: p => engine.bindOpenClaw(p), bridgePulse: () => engine.db.put('meta', { id: 'bridge-health', at: engine.now() }),
  bridgeAllBindings: () => engine.db.all('bridge').filter(b => !b.suspended),
  bridgeBindings: () => engine.now() - (engine.db.get('meta', 'bridge-health')?.at || 0) < 15000 ? engine.db.all('bridge').filter(b => !b.suspended) : [],
  bridgePending: () => engine.openClawPending(), bridgeWake: p => engine.openClawWake(p.id, p.attemptId, p.error, p.finalVersion),
  bridgeSuspend: p => engine.suspendOpenClaw(p.bindingId, p.reason),
  bridgeGet: p => { engine.authorizeOpenClaw(p.id, p.owner); return engine.get(p.id); },
  bridgeDecide: p => engine.openClawDecide(p.id, p.owner, p.attemptId, p.generation, p.decision),
  bridgeAction: p => { engine.authorizeOpenClaw(p.id, p.owner); if (!['cancel', 'respond', 'ack'].includes(p.action)) throw new Error('Invalid bridge action'); return engine[p.action](p.id, p.action === 'respond' ? p.message : p.version); },
  submit: p => engine.submit(p), list: () => engine.list(), get: p => engine.get(p.id), output: p => engine.output(p.id, p.attemptId),
  cancel: p => engine.cancel(p.id), respond: p => engine.respond(p.id, p.message), ack: p => engine.ack(p.id, p.version),
};
const server = net.createServer(connection => {
  let buffer = '', bytes = 0, handled = false;
  connection.setEncoding('utf8');
  connection.setTimeout(10000, () => connection.destroy()); connection.on('error', () => {});
  connection.on('data', data => {
    if (handled) return;
    buffer += data; bytes += Buffer.byteLength(data, 'utf8'); if (bytes > 65536) return connection.destroy();
    if (!buffer.includes('\n')) return;
    handled = true;
    let response;
    try {
      const { method, params } = JSON.parse(buffer.split('\n')[0]);
      if (!Object.hasOwn(methods, method)) throw new Error('Unknown task method');
      response = { result: methods[method](params || {}) };
    } catch (e) { response = { error: e.message }; }
    connection.end(JSON.stringify(response) + '\n');
  });
});
function tick() { try { engine.tick(); } catch (e) { console.error('tick error:', e.message); } }
server.listen(socket, () => { if (process.platform !== 'win32') fs.chmodSync(socket, 0o600); tick(); timer = setInterval(tick, 1000); });
function stop() {
  if (stopping) return; stopping = true; clearInterval(timer);
  server.close(() => { engine.db.close(); try { fs.unlinkSync(lock); } catch {} process.exit(0); });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
