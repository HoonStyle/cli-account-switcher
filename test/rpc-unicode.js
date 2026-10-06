'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), assert = require('assert/strict');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-rpc-unicode-'));
process.env.HOME = tmp; process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS = '1';
const client = require('../src/runtime/client');
fs.mkdirSync(client.dir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function splitRequest(method, params, marker) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(client.socket); c.setEncoding('utf8'); let result = '';
    c.setTimeout(3000, () => c.destroy(new Error('split request timed out')));
    c.on('error', reject); c.on('data', chunk => { result += chunk; });
    c.on('end', () => { try { resolve(JSON.parse(result)); } catch (e) { reject(e); } });
    c.on('connect', () => {
      const bytes = Buffer.from(JSON.stringify({ method, params }) + '\n');
      const cut = bytes.indexOf(Buffer.from(marker)) + 1;
      c.write(bytes.subarray(0, cut)); setTimeout(() => c.end(bytes.subarray(cut)), 30);
    });
  });
}
let failed = 0;
async function test(name, run) { try { await run(); console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } }
(async () => {
  const expected = '가나다🙂한글 결과';
  const fake = net.createServer(c => c.once('data', () => {
    const bytes = Buffer.from(JSON.stringify({ result: expected }) + '\n');
    const cut = bytes.indexOf(Buffer.from('가')) + 1;
    c.write(bytes.subarray(0, cut)); setTimeout(() => c.end(bytes.subarray(cut)), 30);
  }));
  await new Promise(resolve => fake.listen(client.socket, resolve));
  try { await test('client preserves UTF-8 across split response bytes', async () => assert.equal(await client.request('fixture'), expected)); }
  finally { await new Promise(resolve => fake.close(resolve)); }
  const service = spawn(process.execPath, [path.resolve(__dirname, '../src/runtime/service.js')], { env: process.env, stdio: 'ignore' });
  try {
    let healthy = false;
    for (let i = 0; i < 100; i++) { try { if ((await client.request('health')).pid === service.pid) { healthy = true; break; } } catch {} await sleep(30); }
    assert(healthy, 'isolated service started');
    await test('real service preserves split UTF-8 request in durable binding', async () => {
      const owner = { agentId: 'main', sessionKey: 'agent:main:discord:channel:unicode', sessionId: expected };
      const response = await splitRequest('bridgeBind', owner, '가');
      assert.equal(response.result.sessionId, expected);
      assert.equal((await client.request('bridgeAllBindings'))[0].sessionId, expected);
    });
  } finally {
    if (service.exitCode === null) await new Promise(resolve => { service.once('exit', resolve); service.kill('SIGTERM'); });
  }
  console.log(JSON.stringify({ passed: 2 - failed, failed, total: 2 })); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
