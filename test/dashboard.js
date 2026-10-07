'use strict';
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { createFolderBrowser, chooseProjectFolder } = require('../src/project-folders');
const folderHome = fs.mkdtempSync(path.join(os.tmpdir(), 'project-folders-'));
fs.mkdirSync(path.join(folderHome, '한글 프로젝트 #1'));
fs.mkdirSync(path.join(folderHome, '.hidden'));
fs.writeFileSync(path.join(folderHome, 'not-a-directory.txt'), 'fixture');
fs.symlinkSync(path.dirname(folderHome), path.join(folderHome, 'outside'));
function rawPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
}
const { createDashboard } = require('../src/dashboard/server');
const calls = [];
const accountStore = { load: () => ({ codex: { active: 'fixture', profiles: ['fixture'] }, claude: { active: 'default', profiles: ['default'] }, secret: 'must-not-leak' }), label: (_s, _t, id) => id, profileHome: (tool,id) => `/fixture/${tool}/${id}` };
let legacyService = false;
const runtime = { ensureService: async options => { if (legacyService && !options?.readOnly) throw Error('ERR_TASK_PROTOCOL_MISMATCH'); }, request: async (method, params) => { calls.push({ method, params }); return { method, params, status: 'ok' }; } };
runtime.readDashboard = id => runtime.request('dashboard', { id });
runtime.readDashboardList = () => runtime.request('dashboardList');
runtime.readQueryPages = (id, query) => runtime.request('query', { id, query });
const server = createDashboard({ port: 0, runtime, accountStore, catalog: (tool,home) => [{id:tool+'-model',label:home}], browseFolders: createFolderBrowser({home:folderHome,extraRoots:[]}), publicOrigin: 'https://fixture.example' });
(async () => { try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-CLI-Accounts': 'dashboard', Origin: base, 'Content-Type': 'application/json' };
  let folders=await (await fetch(base+'/api/folders',{headers})).json();
  assert.deepEqual(folders.folders.map(f=>f.name),['한글 프로젝트 #1']);assert.equal(folders.parent,null);
  const selected=folders.folders[0].path;
  folders=await (await fetch(base+'/api/folders?path='+encodeURIComponent(selected),{headers})).json();assert.equal(folders.path,selected);assert.equal(folders.folders.length,0);
  for(const value of [path.dirname(folderHome),path.join(folderHome,'outside'),path.join(folderHome,'not-a-directory.txt'),'relative','/missing'])assert.equal((await fetch(base+'/api/folders?path='+encodeURIComponent(value),{headers})).status,400);
  assert.equal((await fetch(base+'/api/folders')).status,403);
  assert.equal((await fetch(base+'/api/folders',{headers:{...headers,Origin:'https://attacker.invalid'}})).status,403);
  const owner={id:'fixture'};let options;
  const dialog={showOpenDialog:async(w,o)=>{assert.equal(w,owner);options=o;return {canceled:false,filePaths:[selected]}}};
  assert.equal(await chooseProjectFolder(dialog,owner,selected),selected);assert.equal(options.defaultPath,selected);assert.deepEqual(options.properties,['openDirectory']);
  assert.equal(await chooseProjectFolder({showOpenDialog:async()=>({canceled:true,filePaths:[]})},owner,''),null);
  const page = await fetch(base); assert.equal(page.status, 200); const html = await page.text();
  assert(html.includes('tasks-web.js')); assert(html.includes("connect-src 'self'"));
  assert.equal((await fetch(base + '/tasks-web.js')).status, 200);
  const state = await (await fetch(base + '/api/state', { headers })).json();
  assert.deepEqual(Object.keys(state), ['tools']); assert(!JSON.stringify(state).includes('must-not-leak'));
  assert.deepEqual(state.tools.codex.profiles[0].models,[{id:'codex-model',label:'/fixture/codex/fixture'}]);
  const output=await (await fetch(base+'/api/tasks/root/attempts/attempt/output',{headers})).json();
  assert.equal(output.method,'output');assert.deepEqual(output.params,{id:'root',attemptId:'attempt'});
  const exact = await (await fetch(base+'/api/tasks/root/details/child?resultVersion=1&queryRevision=revision',{headers})).json();
  assert.equal(exact.method,'query');assert.deepEqual(exact.params,{id:'root',query:{view:'task',taskId:'child',resultVersion:1,queryRevision:'revision'}});
  assert.equal((await fetch(base+'/api/tasks/root/details/child?resultVersion=1&queryRevision=revision')).status,403);
  assert.equal((await fetch(base+'/api/tasks/root/details/child?resultVersion=-1&queryRevision=revision',{headers})).status,400);
  assert.equal((await fetch(base+'/api/tasks/root/attempts/attempt/output')).status,403);
  const spec = { requestId: 'http-fixture', mainTool: 'codex', mainModel: 'main-model', projectPath: '/fixture/project', goal: '한글 모델 선택', permission: 'read-only', participants: [{ tool: 'claude', profileId: 'default', model: 'child-model' }] };
  let response = await fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify(spec) });
  assert.equal(response.status, 200); const received = await response.json();
  assert.equal(received.params.mainModel, 'main-model'); assert.equal(received.params.participants[0].model, 'child-model'); assert.equal(received.params.goal, spec.goal);
  for (const action of ['cancel', 'respond', 'ack']) {
    response = await fetch(base + '/api/tasks/fixture/' + action, { method: 'POST', headers, body: JSON.stringify({ message: '한글 추가 지시', version: 1 }) }); assert.equal(response.status, 200);
  }
  const before = calls.length;
  for (const bad of [
    { headers: { ...headers, Origin: 'https://attacker.invalid' } },
    { headers: { ...headers, Host: 'attacker.invalid' } },
    { headers: { Origin: base, 'Content-Type': 'application/json' } },
    { headers: { ...headers, Origin: '' } },
    { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } },
  ]) assert.equal(await rawPost(base + '/api/tasks', bad.headers, JSON.stringify(spec)), 403, JSON.stringify(bad));
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/rpc', { method: 'POST', headers, body: '{"method":"bridgeBind"}' })).status, 404);
  assert.equal((await fetch(base + '/api/tasks/fixture/cancel', { headers })).status, 404);
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ ...spec, mainModel: '--help' }) })).status, 400);
  assert.equal(calls.length, before, 'rejected requests must not mutate the runtime');
  legacyService = true;
  for (const route of ['/api/health', '/api/tasks', '/api/tasks/root', '/api/tasks/root/attempts/attempt/output']) {
    assert.equal((await fetch(base + route, { headers })).status, 200, 'legacy service remains inspectable');
  }
  const beforeLegacyMutation = calls.length;
  const refused = await fetch(base + '/api/tasks/fixture/cancel', { method: 'POST', headers, body: '{}' });
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /PROTOCOL_MISMATCH/);
  assert.equal(calls.length, beforeLegacyMutation, 'incompatible mutation is never dispatched');
  console.log('PASS HTTP assets/accounts, models, folder selection/cancel/Unicode/symlink boundaries, host/origin/header guards and narrow RPC');
} finally { await new Promise(r => server.close(r)); } })().catch(e => { console.error(e); process.exitCode = 1; });
