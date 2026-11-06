'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { parseReport, fetchUsage, resolveCli } = require('../src/antigravity-usage');
const { createManager } = require('../src/antigravity');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-test-'));
const bucket = (id, remaining_fraction = 1, window = 'weekly') => ({ id, window, remaining_fraction, reset_time: '2030-01-07T00:00:00Z' });
const report = groups => ({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups } } });
const weekly = report([{ name: 'Gemini Models', buckets: [bucket('gemini-weekly')] }, { name: 'Claude and GPT models', buckets: [bucket('3p-weekly')] }]);
let count = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); count++; }
(async () => {
  await test('real report shape: two independent weekly pools remain two despite identical numbers and reset', () => {
    const result = parseReport(weekly);
    assert.deepEqual(result.groups.map(g => [g.name, g.buckets.length]), [['Gemini', 1], ['Claude·GPT', 1]]);
    assert.equal(result.groups[0].buckets[0].remainingPercent, 100);
    assert(result.groups.every(g => g.buckets.every(b => b.window === 'weekly')));
    assert.equal(result.scope, 'shared-login'); assert(!Object.hasOwn(result, 'email'));
  });
  await test('shared bucket IDs render once; keep the limiting observation and its own reset, never sum', () => {
    const groups = [{ name: 'Claude and GPT models', buckets: [bucket('3p-weekly', .6), bucket('3p-5h', .5, '5h')] }, { name: 'Claude variant', buckets: [{ ...bucket('3p-weekly', .4), reset_time: '2030-01-08T00:00:00Z' }] }, { name: 'GPT variant', buckets: [bucket('3p-5h', .8, '5h')] }];
    const result = parseReport(report(groups)); assert.equal(result.groups.length, 1);
    assert.deepEqual(result.groups[0].buckets.map(b => [b.id, b.remainingPercent]), [['3p-5h', 50], ['3p-weekly', 40]]);
    assert.equal(result.groups[0].buckets[1].resetsAt, Date.parse('2030-01-08T00:00:00Z') / 1000);
  });
  await test('separate Argon and unknown server groups are preserved, not merged by family or values', () => {
    const result = parseReport(report([...weekly.command.data.groups, { name: 'Gemini 4 Argon', buckets: [bucket('argon-weekly')] }]));
    assert.equal(result.groups.length, 3); assert.equal(result.groups[2].name, 'Gemini 4 Argon');
  });
  await test('unknown, disabled, out-of-range, null and string fractions never become 100% or zero', () => {
    for (const remaining_fraction of [null, undefined, '1', -1, 2, NaN]) assert.throws(() => parseReport(report([{ name: 'Gemini Models', buckets: [{ ...bucket('g'), remaining_fraction }] }])));
    assert.throws(() => parseReport(report([{ name: 'Disabled', buckets: [{ ...bucket('g'), disabled: true }] }])));
    assert.throws(() => parseReport(report([{ name: 'Disabled group', disabled: true, buckets: [bucket('g')] }])));
    assert.throws(() => parseReport(report([{ name: 'Conflict', buckets: [bucket('same', .5), bucket('same', .5, '5h')] }])));
  });
  await test('successful usage only; model responses and credential-bearing diagnostics are rejected without echo', () => {
    for (const value of ['secret-raw-token', { ...weekly, status: 'ERROR' }, { ...weekly, num_turns: 1 }, { ...weekly, command: { name: 'models' } }]) assert.throws(() => parseReport(value), e => !e.message.includes('secret-raw-token'));
  });
  await test('manager coalesces clicks, does not touch keyring, blocks switch while querying, retains old values on failure', async () => {
    let calls = 0, finish, fail = false;
    const manager = createManager({ root: path.join(tmp, 'root'), common: path.join(tmp, 'common'), vault: { get() { throw Error('keyring must not be read'); } }, processes: () => [], usageFetcher: async () => { calls++; if (fail) throw Error('synthetic quota failure'); await new Promise(r => finish = r); return parseReport(weekly); } });
    const a = manager.refreshUsage(), b = manager.refreshUsage(); assert.equal(a, b);
    assert.equal(manager.snapshot().usagePending, true);
    while (!finish) await new Promise(r => setTimeout(r, 10));
    await assert.rejects(manager.activate('unused'), /다른 Antigravity 계정 작업/);
    finish(); assert.equal((await a).usage.groups.length, 2); assert.equal(calls, 1); assert.equal(manager.snapshot().usagePending, false);
    fail = true; await assert.rejects(manager.refreshUsage(), /synthetic quota/);
    assert.equal(manager.snapshot().usage.groups.length, 2); assert.match(manager.snapshot().usageError, /synthetic/);
  });
  await test('explicit CLI override is authoritative, never silently uses another executable', () => {
    assert.throws(() => resolveCli({ ANTIGRAVITY_CLI_PATH: '/not-installed/agy', PATH: process.env.PATH }), /ANTIGRAVITY_CLI_PATH/);
  });
  if (process.platform !== 'win32') {
    const exe = path.join(tmp, 'agy');
    const make = body => fs.writeFileSync(exe, '#!' + process.execPath + '\n' + body, { mode: 0o700 });
    await test('real child launch uses fixed non-inference arguments, updater/browser guards, and private disposable cwd', async () => {
      make(`const fs=require('fs'),assert=require('assert/strict');if(process.argv[2]==='--version'){console.log('agy 1.4.12');process.exit(0)}assert.deepEqual(process.argv.slice(2),['-p','/usage','--output-format','json']);assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE,'true');assert(fs.existsSync(process.env.BROWSER));assert.equal(fs.statSync(process.cwd()).mode&0o777,0o700);fs.writeFileSync(${JSON.stringify(path.join(tmp, 'cwd'))},process.cwd());console.log(${JSON.stringify(JSON.stringify(weekly))});`);
      const result = await fetchUsage({ executable: exe }); assert.equal(result.groups.length, 2);
      assert(!fs.existsSync(fs.readFileSync(path.join(tmp, 'cwd'), 'utf8')));
    });
    await test('old CLI cannot treat /usage as an inference prompt', async () => {
      make(`if(process.argv[2]==='--version')console.log('1.1.10');else require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'unsafe-print'))},'bad');`);
      await assert.rejects(fetchUsage({ executable: exe }), /1.1.11/); assert(!fs.existsSync(path.join(tmp, 'unsafe-print')));
    });
    await test('timeouts terminate owned probe, preserve unrelated agy, and do not leak stderr', async () => {
      const pidFile = path.join(tmp, 'pid');
      make(`if(process.argv[2]==='--version'){console.log('1.4.12');process.exit(0)}if(process.argv[2]!=='unrelated'){require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('secret-refresh-token')}setInterval(()=>{},1000);`);
      const unrelated = require('child_process').spawn(exe, ['unrelated'], { stdio: 'ignore' });
      try {
        await assert.rejects(fetchUsage({ executable: exe, timeoutMs: 250 }), e => /초과/.test(e.message) && !e.message.includes('secret'));
        const pid = Number(fs.readFileSync(pidFile)); assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
      } finally { unrelated.kill(); }
    });
    await test('bounded output and nonzero exit diagnostics stay private', async () => {
      make(`if(process.argv[2]==='--version'){console.log('1.4.12');process.exit(0)}process.stdout.write('x'.repeat(1100000));setTimeout(()=>{},5000);`);
      await assert.rejects(fetchUsage({ executable: exe }), /너무 커/);
      make(`if(process.argv[2]==='--version'){console.log('1.4.12');process.exit(0)}console.error('secret-signin-url');process.exit(1);`);
      await assert.rejects(fetchUsage({ executable: exe }), e => !e.message.includes('secret-signin'));
    });
  }
  console.log(`${count} Antigravity usage checks passed`);
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true })).catch(e => { console.error(e); process.exitCode = 1; });
