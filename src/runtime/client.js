'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const { REQUEST_LIMIT, RESPONSE_LIMIT, PROTOCOL_VERSION, HELLO_METHOD, isReadOnly, assertTransport, protocolMismatch, requestTooLarge } = require('./transport');
const P = require('../paths');
const dir = path.join(P.ROOT, 'runtime');
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\cli-accounts-${createHash('sha256').update(P.ROOT).digest('hex').slice(0, 20)}` : path.join(dir, 'service.sock');
function request(method, params = {}, options = {}) {
  return new Promise((resolve, reject) => {
    // Validate before opening a connection, and serialize only once so the
    // checked bytes are exactly the ones written after the ownership guard.
    const request = JSON.stringify({ method, params }) + '\n';
    const requestBytes = Buffer.byteLength(request, 'utf8');
    if (requestBytes > REQUEST_LIMIT) return reject(requestTooLarge(requestBytes));
    const mutation = !isReadOnly(method);
    const connection = net.createConnection(socket); let buffer = '', bytes = 0, done = false, negotiated = !mutation;
    connection.setEncoding('utf8');
    const finish = (err, result) => { if (done) return; done = true; connection.destroy(); err ? reject(err) : resolve(result); };
    connection.setTimeout(10000, () => finish(new Error('Task service timeout')));
    connection.on('error', e => finish(e));
    connection.on('connect', () => { try {
      options.beforeWrite?.();
      connection.write(mutation ? JSON.stringify({ method: HELLO_METHOD, params: { protocolVersion: PROTOCOL_VERSION } }) + '\n' : request);
    } catch (e) { finish(e); } });
    connection.on('data', chunk => {
      buffer += chunk; bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > RESPONSE_LIMIT) return finish(new Error('Response too large'));
      if (buffer.includes('\n')) { try {
        const r = JSON.parse(buffer.split('\n')[0]);
        if (!negotiated) {
          if (r.error) throw protocolMismatch();
          assertTransport(r.result);
          // No cached PID/health promise can authorize a different socket after
          // a service restart. Authority is checked again after negotiation.
          options.beforeWrite?.();
          negotiated = true; buffer = ''; bytes = 0;
          connection.write(request);
          return;
        }
        const error = r.error ? new Error(r.error) : null;
        if (error && typeof r.code === 'string') error.code = r.code;
        if (error && r.details) {
          if (Number.isSafeInteger(r.details.requestBytes)) error.requestBytes = r.details.requestBytes;
          if (Number.isSafeInteger(r.details.responseBytes)) error.responseBytes = r.details.responseBytes;
          if (Number.isSafeInteger(r.details.maxBytes)) error.maxBytes = r.details.maxBytes;
        }
        finish(error, r.result);
      } catch (e) { finish(e); } }
    });
    connection.on('end', () => { if (!done) finish(!negotiated ? protocolMismatch() : new Error('Task service closed without response; if a mutation was sent, its outcome is unknown. Read the existing task before retrying.')); });
  });
}
let starting;
async function ensureService(options = {}) {
  // Diagnostic callers may inspect an existing legacy service, or start the
  // bundled service if absent. This never relaxes request()'s mutation gate.
  const checkedHealth = health => { if (options.readOnly !== true) assertTransport(health.transport); return health; };
  try { return checkedHealth(await request('health')); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  if (starting) return checkedHealth(await starting);
  starting = (async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(dir, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, 'service.js')], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.on('error', () => {}); child.unref(); fs.closeSync(fd);
    for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 100)); try { return await request('health'); } catch {} }
    throw new Error('Task service could not start. Requires Node with node:sqlite; inspect runtime/service.log');
  })();
  try { return checkedHealth(await starting); } finally { starting = null; }
}
async function readDashboard(id) {
  try { return await request('dashboard', { id }); }
  catch (error) {
    // Only a genuinely older service lacks the read model. Never hide a new
    // query error (or an oversized reply) behind another aggregate read.
    if (error.message !== 'Unknown task method') throw error;
    return request('get', { id });
  }
}
async function readDashboardList() {
  try { return await request('dashboardList'); }
  catch (error) {
    if (error.message !== 'Unknown task method') throw error;
    return request('list');
  }
}
async function readQueryPages(id, query = {}) {
  const view = query.view;
  if (!['task', 'context', 'final'].includes(view) || (query.offset !== undefined && query.offset !== 0)) throw Error('Full reconstruction requires task/context/final at offset=0');
  const pieces = [], pinned = { ...query, action: 'get', offset: 0, limit: query.limit ?? 65536 };
  let revision, total, generation, resultVersion, finalVersion, offset = 0;
  const invalid = () => { throw Error('Inconsistent task query page; discard partial data and read a fresh summary. No mutation was retried.'); };
  do {
    const reply = await request('query', { id, query: pinned });
    const content = reply?.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0].type !== 'text') invalid();
    const value = JSON.parse(content[0].text), page = value.page;
    if (value.schema !== 'account-tasks-query-v1' || value.id !== id || value.view !== view || !page || page.encoding !== (view === 'final' ? 'text' : 'json') || page.unit !== 'Unicode code points' || typeof page.text !== 'string' || !/^[a-f0-9]{64}$/.test(page.queryRevision) || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset) invalid();
    if (offset === 0) {
      revision = page.queryRevision; total = page.total; generation = value.generation;
      resultVersion = page.resultVersion; finalVersion = value.finalVersion;
      if ((query.queryRevision !== undefined && query.queryRevision !== revision) || (query.generation !== undefined && query.generation !== generation) || (view === 'task' && (page.taskId !== query.taskId || !Number.isSafeInteger(resultVersion) || (query.resultVersion !== undefined && query.resultVersion !== resultVersion))) || (view === 'final' && (!Number.isSafeInteger(finalVersion) || finalVersion < 1 || (query.version !== undefined && query.version !== finalVersion)))) invalid();
      Object.assign(pinned, { queryRevision: revision, generation });
      if (view === 'task') pinned.resultVersion = resultVersion;
      if (view === 'final') pinned.version = finalVersion;
    } else if (revision !== page.queryRevision || total !== page.total || generation !== value.generation || (view === 'task' && (page.taskId !== query.taskId || page.resultVersion !== resultVersion)) || (view === 'final' && value.finalVersion !== finalVersion)) invalid();
    const length = Array.from(page.text).length, end = offset + length;
    if (end > total || length > pinned.limit || page.done !== (end === total) || page.nextOffset !== (end < total ? end : null) || (end < total && !length)) invalid();
    pieces.push(page.text); offset = end; pinned.offset = end;
    if (page.done) break;
  } while (offset < total);
  const source = pieces.join('');
  if (createHash('sha256').update(source).digest('hex') !== revision) invalid();
  return view === 'final' ? source : JSON.parse(source);
}
module.exports = { request, ensureService, readDashboard, readDashboardList, readQueryPages, dir, socket };
