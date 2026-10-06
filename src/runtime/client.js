'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const P = require('../paths');
const dir = path.join(P.ROOT, 'runtime');
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\cli-accounts-${createHash('sha256').update(P.ROOT).digest('hex').slice(0, 20)}` : path.join(dir, 'service.sock');
function request(method, params = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket); let buffer = '', bytes = 0, done = false;
    connection.setEncoding('utf8');
    const finish = (err, result) => { if (done) return; done = true; connection.destroy(); err ? reject(err) : resolve(result); };
    connection.setTimeout(10000, () => finish(new Error('Task service timeout')));
    connection.on('error', e => finish(e));
    connection.on('connect', () => { try { options.beforeWrite?.(); connection.write(JSON.stringify({ method, params }) + '\n'); } catch (e) { finish(e); } });
    connection.on('data', chunk => {
      buffer += chunk; bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 8 * 1024 * 1024) return finish(new Error('Response too large'));
      if (buffer.includes('\n')) { try { const r = JSON.parse(buffer.split('\n')[0]); finish(r.error ? new Error(r.error) : null, r.result); } catch (e) { finish(e); } }
    });
    connection.on('end', () => { if (!done) finish(new Error('Task service closed without response')); });
  });
}
let starting;
async function ensureService() {
  try { return await request('health'); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  if (starting) return starting;
  starting = (async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(dir, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, 'service.js')], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.on('error', () => {}); child.unref(); fs.closeSync(fd);
    for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 100)); try { return await request('health'); } catch {} }
    throw new Error('Task service could not start. Requires Node with node:sqlite; inspect runtime/service.log');
  })();
  try { return await starting; } finally { starting = null; }
}
module.exports = { request, ensureService, dir, socket };
