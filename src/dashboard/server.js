'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { submission, text } = require('../runtime/submission');
const store = require('../store');
const client = require('../runtime/client');
const { isReadOnly } = require('../runtime/transport');
const { modelCatalog } = require('../model-catalog');
const { createFolderBrowser } = require('../project-folders');

function createDashboard({ port = 18473, publicOrigin, runtime = client, accountStore = store, catalog = modelCatalog, browseFolders = createFolderBrowser(), openclaw = require('./openclaw').createOpenClawMonitor() } = {}) {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('Public origin must be an HTTPS origin');
    origins.add(u.origin);
  }
  const hosts = new Set([...origins].map(o => new URL(o).host));
  const assets = new Map([['/', 'tasks.html'], ['/tasks.js', 'tasks.js'], ['/tasks-web.js', 'tasks-web.js']]);
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const rpc = async (method, params) => { await runtime.ensureService({ readOnly: isReadOnly(method) }); return runtime.request(method, params); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Untrusted host' });
      if (req.headers.origin && !origins.has(req.headers.origin)) return json(res, 403, { error: 'Cross-origin request refused' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const file = assets.get(url.pathname);
        let data = fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8');
        if (file === 'tasks.html') data = data.replace("connect-src 'none'", "connect-src 'self'").replace('<script src="tasks.js"', '<script src="tasks-web.js" defer></script><script src="tasks.js"');
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }); res.end(data); return;
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      // A custom same-origin header prevents cross-site forms and fetches from
      // invoking the local runtime; no CORS or arbitrary RPC endpoint is exposed.
      if (req.headers['x-cli-accounts'] !== 'dashboard') return json(res, 403, { error: 'Dashboard header required' });
      if (req.method === 'GET') {
        if (url.pathname === '/api/openclaw/tasks') return json(res, 200, await openclaw.list());
        const external = url.pathname.match(/^\/api\/openclaw\/tasks\/([^/]+)$/);
        if (external) return json(res, 200, await openclaw.get(text(decodeURIComponent(external[1]), 'OpenClaw record ID', 100)));
        if (url.pathname === '/api/folders') return json(res, 200, await browseFolders(url.searchParams.get('path') || ''));
        if (url.pathname === '/api/state') {
          const state = accountStore.load();
          const tools = Object.fromEntries(['codex', 'claude'].map(tool => [tool, { active: state[tool].active, profiles: state[tool].profiles.map(name => ({ name, label: accountStore.label(state, tool, name), models: catalog(tool, accountStore.profileHome(tool, name)) })) }]));
          return json(res, 200, { tools });
        }
        if (url.pathname === '/api/health') return json(res, 200, await rpc('health'));
        if (url.pathname === '/api/bindings') return json(res, 200, await rpc('bridgeBindings'));
        if (url.pathname === '/api/tasks') { await runtime.ensureService({ readOnly: true }); return json(res, 200, await runtime.readDashboardList()); }
        const taskDetail = url.pathname.match(/^\/api\/tasks\/([^/]+)\/details\/([^/]+)$/);
        if (taskDetail) {
          const id = text(decodeURIComponent(taskDetail[1]), 'task ID', 200), taskId = text(decodeURIComponent(taskDetail[2]), 'child task ID', 200);
          const resultVersion = Number(url.searchParams.get('resultVersion')), queryRevision = text(url.searchParams.get('queryRevision'), 'query revision', 200);
          if (!Number.isSafeInteger(resultVersion) || resultVersion < 0) throw Error('Invalid result version');
          return json(res, 200, await runtime.readQueryPages(id, { view:'task', taskId, resultVersion, queryRevision }));
        }
        const output = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attempts\/([^/]+)\/output$/);
        if (output) return json(res, 200, await rpc('output', { id: text(decodeURIComponent(output[1]), 'task ID', 200), attemptId: text(decodeURIComponent(output[2]), 'attempt ID', 200) }));
        const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (match) {
          const id = text(decodeURIComponent(match[1]), 'task ID', 200);
          await runtime.ensureService({ readOnly: true });
          return json(res, 200, await runtime.readDashboard(id));
        }
      } else if (req.method === 'POST') {
        if (!req.headers.origin || !origins.has(req.headers.origin)) return json(res, 403, { error: 'Same-origin POST required' });
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON required' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 65536) { json(res, 413, { error: 'Request too large' }); return; } chunks.push(chunk); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (url.pathname === '/api/tasks') return json(res, 200, await rpc('submit', submission(data, accountStore.load())));
        const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|respond|resume|ack)$/);
        if (match) {
          const id = text(decodeURIComponent(match[1]), 'task ID', 200), method = match[2];
          if (id.startsWith('oc-')) return json(res, 403, { error: 'OpenClaw 기록은 읽기 전용입니다.' });
          const params = { id };
          if (method === 'resume') params.request = data.request;
          if (method === 'respond') params.message = text(data.message, 'message');
          if (method === 'ack') { if (!Number.isInteger(data.version) || data.version < 1) throw Error('Invalid result version'); params.version = data.version; }
          return json(res, 200, await rpc(method, params));
        }
      }
      json(res, 404, { error: 'Unsupported dashboard route' });
    } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('listening', () => {
    if (port === 0) { const actual = server.address().port; for (const host of ['127.0.0.1', 'localhost']) { origins.add(`http://${host}:${actual}`); hosts.add(`${host}:${actual}`); } }
  });
  return server;
}
async function run(args) {
  let port = 18473, publicOrigin;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--public-origin') publicOrigin = args[++i];
    else throw Error('dashboard [--port 18473] [--public-origin https://host]');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid dashboard port');
  await client.ensureService({ readOnly: true });
  const server = createDashboard({ port, publicOrigin });
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`CLI Account Switch dashboard: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
module.exports = { createDashboard, run };
