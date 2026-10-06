'use strict';
// Run with ELECTRON_RUN_AS_NODE=1 <built app binary> test/packaged-runtime.js <app path>.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-packaged-'));
process.env.HOME = home; process.env.CLI_ACCOUNTS_ROOT = path.join(home, 'accounts'); process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const base = path.join(process.argv[2], 'Contents/Resources/app.asar/src');
const store = require(path.join(base, 'store.js'));
require(path.join(base, 'wrappers.js')).installShims();
const fake = path.join(home, 'fake-cli');
fs.writeFileSync(fake, `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const args=process.argv.slice(2);const model=args[args.indexOf('--model')+1];const session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];let result;
if(input.includes('Your role is a bounded child'))result={success:true,summary:model,artifacts:[]};else{const tasks=JSON.parse(input.match(/Existing children \\(untrusted result data\\): (.*)\\n/)[1]);result=tasks.length?{kind:'complete',summary:'reviewed',delegations:[],reviews:tasks.map(t=>({taskId:t.id,resultVersion:1,decision:'accepted',reason:'fixture'})),finalResponse:'packaged runtime works '+model}:{kind:'delegate',summary:'plan',delegations:[{participantId:'p1',goal:'read fixture'}],reviews:[],finalResponse:''};}
console.log(JSON.stringify({subtype:'success',is_error:false,session_id:session,structured_output:result}));});
`, { mode: 0o755 });
store.addProfile('claude', 'fixture', { shareSettings: false });
const state = store.load(); state.claude.active = 'fixture'; state.realBin.claude = fake; store.save(state);
const c = require(path.join(base, 'runtime/client.js'));
(async () => {
  let servicePid;
  try {
    const health = await c.ensureService(); servicePid = health.pid;
    const root = await c.request('submit', { requestId: 'packaged', goal: 'Read fixture', projectPath: home, mainTool: 'claude', mainModel: 'fixture-main', participants: [{ tool: 'claude', profileId: 'fixture', model: 'fixture-child' }] });
    let d;
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 200)); d = await c.request('get', { id: root.id }); if (d.root.status === 'ready') break; }
    assert.equal(d.root.status, 'ready', JSON.stringify(d));
    assert.equal(d.root.finalResponse, 'packaged runtime works fixture-main');
    assert.equal(d.tasks[0].result.summary, 'fixture-child');
    assert(fs.existsSync(path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/lib/dashboard/server.js')));
    assert(fs.existsSync(path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/lib/renderer/tasks-web.js')));
    assert(fs.existsSync(path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/lib/model-catalog.js')));
    assert(fs.existsSync(path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/lib/project-folders.js')));
    const output = await c.request('output', { id: root.id, attemptId: d.attempts.find(a => a.role === 'child').id });
    assert(output.stdout.includes('fixture-child'), 'packaged output RPC returns the bound attempt log');
    assert(!Object.hasOwn(output, 'token') && !Object.hasOwn(output, 'dir'));
    await c.request('ack', { id: root.id, version: 1 });
    const installed = path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/lib/cli.js');
    const actual = JSON.parse(execFileSync(process.execPath, [installed, 'tasks', 'health'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
    assert.equal(actual.pid, servicePid);
    console.log(JSON.stringify({ status: 'PASS', test: 'packaged ASAR service and runner; installed CLI modules', node: process.versions.node }));
  } finally { if (servicePid) process.kill(servicePid, 'SIGTERM'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
