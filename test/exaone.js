'use strict';
// EXAONE API category: isolated state, key files, env injection, live-check parsing.
// Fake keys and a fake fetch only; no network and no real credentials.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exaone-test-')));
process.env.CLI_ACCOUNTS_ROOT = root;
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
const P = require('../src/paths');
const store = require('../src/store');
const exaone = require('../src/exaone');
const FAKE = 'sk-exaone-fake-test-key-00000000000000000000001234';
const OTHER = 'sk-exaone-fake-test-key-00000000000000000000009999';
let cases = 0;
function test(name, fn) { fn(); cases++; console.log('PASS ' + name); }
async function atest(name, fn) { await fn(); cases++; console.log('PASS ' + name); }
(async () => {
  try {
    test('category is separate from TOOLS and starts empty', () => {
      assert.ok(!P.TOOLS.includes('exaone'));
      assert.deepEqual(P.PROVIDERS, ['exaone']);
      assert.deepEqual(store.load().exaone, { active: null, profiles: [] });
      assert.deepEqual(exaone.snapshot().accounts, []);
      assert.throws(() => exaone.launchEnv(), /계정이 없습니다/);
    });
    test('add, active defaulting, rename, resolve by label, duplicate and invalid names', () => {
      assert.deepEqual(exaone.add('work'), { id: 'work', label: 'work' });
      assert.equal(store.load().exaone.active, 'work');
      exaone.add('개인');
      assert.equal(store.load().exaone.active, 'work');
      assert.throws(() => exaone.add('work'), /이미 있는/);
      assert.throws(() => exaone.add('bad/name'), /이름은/);
      assert.deepEqual(exaone.rename('개인', 'Personal'), { id: '개인', label: 'Personal' });
      assert.equal(exaone.resolve('Personal'), '개인');
      assert.throws(() => exaone.rename('work', 'Personal'), /이미 쓰는/);
      assert.deepEqual(exaone.setActive('Personal'), { id: '개인' });
      assert.equal(store.load().exaone.active, '개인');
      exaone.setActive('work');
      // Claude/Codex profile stores are untouched by the new section.
      assert.deepEqual(store.load().claude.profiles, ['default']);
      assert.deepEqual(store.load().codex.profiles, ['default']);
    });
    test('keys are stored 0600 per account, masked in status, injected only for that account', () => {
      assert.throws(() => exaone.launchEnv('work'), /API 키가 등록되지 않았습니다/);
      const r = exaone.setKey('work', FAKE + '\n');
      assert.equal(r.masked, '…1234'); assert.equal(r.warning, null);
      const file = path.join(root, 'api-keys', 'exaone', 'work');
      if (!P.IS_WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(file, 'utf8').trim(), FAKE);
      assert.equal(exaone.setKey('개인', 'abcdefghijklmnopqrstuvwxyz').warning, 'EXAONE API 키는 보통 sk- 로 시작합니다');
      const base = { PATH: '/usr/bin', OPENAI_API_KEY: 'inherited', OPENAI_BASE_URL: 'https://other.example/v1', EXAONE_API_KEY: 'stale', HOME: process.env.HOME };
      const { id, env } = exaone.launchEnv('work', base);
      assert.equal(id, 'work');
      assert.equal(env.EXAONE_API_KEY, FAKE); assert.equal(env.OPENAI_API_KEY, FAKE);
      assert.equal(env.OPENAI_BASE_URL, 'https://api.exaone.ai/v1'); assert.equal(env.EXAONE_BASE_URL, 'https://api.exaone.ai/v1');
      assert.equal(env.EXAONE_MODEL, 'k-exaone_v2.5'); assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, process.env.HOME);
      // Active account is used when no name is given; another account's key never leaks.
      assert.equal(exaone.launchEnv(undefined, base).env.EXAONE_API_KEY, FAKE);
      exaone.setKey('개인', OTHER);
      assert.equal(exaone.launchEnv('Personal', base).env.EXAONE_API_KEY, OTHER);
      const snap = exaone.snapshot();
      assert.deepEqual(snap.accounts.map((a) => [a.name, a.label, a.active, a.apiKey.apiKey, a.apiKey.masked]), [['work', 'work', true, true, '…1234'], ['개인', 'Personal', false, true, '…9999']]);
      assert.ok(!JSON.stringify(snap).includes(FAKE) && !JSON.stringify(snap).includes(OTHER), 'snapshot must not contain keys');
      assert.ok(!fs.readFileSync(P.STATE_FILE, 'utf8').includes(FAKE), 'state.json must not contain keys');
    });
    await atest('check parses models and rate-limit headers, records fixed error text, never the key', async () => {
      const calls = [];
      const fakeFetch = (status, body, headers = {}) => async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return { ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(body) };
      };
      const ok = await exaone.check('work', { fetchImpl: fakeFetch(200, { data: [{ id: 'k-exaone_v2.5' }] }, { 'x-minute-rate-limit': '60', 'x-minute-rate-limit-remaining': '59', 'x-day-rate-limit': '86400', 'x-day-rate-limit-remaining': '86300' }), now: () => Date.UTC(2026, 10, 9, 12, 0, 0) });
      assert.equal(calls[0].url, 'https://api.exaone.ai/v1/models'); assert.equal(calls[0].auth, `Bearer ${FAKE}`);
      assert.equal(ok.ok, true); assert.deepEqual(ok.models, ['k-exaone_v2.5']);
      assert.deepEqual(ok.rateLimit, { minute: { limit: 60, remaining: 59 }, day: { limit: 86400, remaining: 86300 } });
      assert.equal(ok.checkedAt, '2026-11-09T12:00:00.000Z');
      assert.deepEqual(store.load().exaone.checks.work.models, ['k-exaone_v2.5']);
      const denied = await exaone.check('work', { fetchImpl: fakeFetch(401, { error: { message: 'bad key ' + FAKE } }) });
      assert.equal(denied.ok, false); assert.equal(denied.error, 'API 키가 거부되었습니다');
      assert.ok(!JSON.stringify(denied).includes(FAKE) && !fs.readFileSync(P.STATE_FILE, 'utf8').includes(FAKE), 'error bodies and keys must not be recorded');
      const limited = await exaone.check('work', { fetchImpl: fakeFetch(429, {}, { 'retry-after': '1' }) });
      assert.equal(limited.error, '요청 한도 초과 (429)');
      const down = await exaone.check('work', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
      assert.equal(down.error, '네트워크 오류'); assert.equal(exaone.snapshot().accounts[0].check.ok, false);
      // Re-registering a key forgets the previous check result.
      exaone.setKey('work', FAKE);
      assert.equal(exaone.snapshot().accounts[0].check, null);
    });
    await atest('run injects the account env into the child and reports its exit code', async () => {
      const probe = path.join(root, 'probe.js');
      fs.writeFileSync(probe, "console.log(JSON.stringify({ k: process.env.EXAONE_API_KEY, o: process.env.OPENAI_API_KEY, b: process.env.OPENAI_BASE_URL, m: process.env.EXAONE_MODEL })); process.exit(Number(process.argv[2] || 0));");
      const out = path.join(root, 'probe.out');
      const r = await exaone.run('work', ['/bin/sh', '-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} 3 > ${JSON.stringify(out)}`]);
      assert.equal(r.code, 3); assert.equal(r.id, 'work');
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { k: FAKE, o: FAKE, b: 'https://api.exaone.ai/v1', m: 'k-exaone_v2.5' });
      await assert.rejects(exaone.run('work', ['/nonexistent/binary-xyz']), /실행 파일을 찾을 수 없습니다/);
      assert.throws(() => exaone.run('work', []), /사용법/);
    });
    test('remove deletes the key file and moves the active marker', () => {
      exaone.remove('work');
      assert.equal(fs.existsSync(path.join(root, 'api-keys', 'exaone', 'work')), false);
      assert.deepEqual(store.load().exaone.profiles, ['개인']); assert.equal(store.load().exaone.active, '개인');
      assert.throws(() => exaone.resolve('work'), /없는 EXAONE 계정/);
    });
    // Console CLI through the real dispatcher, from the source tree and from the installed lib copy.
    exaone.remove('개인');
    assert.equal(store.load().exaone.active, null); assert.deepEqual(store.load().exaone.profiles, []);
    require('../src/wrappers').installShims();
    for (const cli of [path.resolve(__dirname, '../src/cli.js'), path.join(P.LIB_DIR, 'cli.js')]) {
      await atest(`cli ${path.relative(root, cli) === path.relative(root, path.join(P.LIB_DIR, 'cli.js')) ? '(installed lib)' : '(src)'} add/apikey/list/env/run/rm`, async () => {
        const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: input ?? '', env: { ...process.env, OPENAI_API_KEY: 'inherited-not-allowed' } });
        const add = run(['exaone', 'add', 'team']); assert.equal(add.status, 0, add.stderr); assert.match(add.stdout, /추가됨: team/);
        const argvKey = run(['exaone', 'apikey', 'set', 'team', FAKE]); assert.notEqual(argvKey.status, 0); assert.ok(!fs.existsSync(path.join(root, 'api-keys', 'exaone', 'team')));
        const set = run(['exaone', 'apikey', 'set', 'team'], FAKE + '\n'); assert.equal(set.status, 0, set.stderr);
        assert.ok(!set.stdout.includes(FAKE) && !set.stderr.includes(FAKE), 'key must not be printed'); assert.match(set.stdout, /…1234/);
        const viaGeneric = run(['apikey', 'set', 'exaone', 'team'], OTHER + '\n'); assert.equal(viaGeneric.status, 0, viaGeneric.stderr); assert.match(viaGeneric.stdout, /…9999/);
        const list = run(['exaone', 'list']); assert.match(list.stdout, /team\s+API 키 …9999/);
        const all = run(['list']); assert.match(all.stdout, /exaone:/); assert.match(all.stdout, /team/);
        const json = JSON.parse(run(['list', '--json']).stdout);
        const row = json.accounts.find((a) => a.tool === 'exaone' && a.profileId === 'team');
        assert.deepEqual(row, { tool: 'exaone', profileId: 'team', active: true, apiKey: true, delegable: false, baseUrl: 'https://api.exaone.ai/v1', model: 'k-exaone_v2.5' });
        assert.ok(!JSON.stringify(json).includes(OTHER));
        const status = run(['apikey', 'status']); assert.match(status.stdout, /exaone\s+team\s+API 키 …9999/);
        const env = run(['exaone', 'env', 'team']); assert.equal(env.status, 0, env.stderr); assert.match(env.stdout, /EXAONE_API_KEY/); assert.ok(!env.stdout.includes(OTHER));
        const probe = path.join(root, 'probe-cli.js');
        fs.writeFileSync(probe, "console.log(process.env.EXAONE_API_KEY + '|' + process.env.OPENAI_API_KEY + '|' + process.env.OPENAI_BASE_URL)");
        const ran = run(['exaone', 'run', 'team', '--', process.execPath, probe]); assert.equal(ran.status, 0, ran.stderr); assert.equal(ran.stdout.trim(), `${OTHER}|${OTHER}|https://api.exaone.ai/v1`);
        const viaRun = run(['run', 'exaone', '--profile', 'team', '--', process.execPath, probe]); assert.equal(viaRun.status, 0, viaRun.stderr); assert.equal(viaRun.stdout.trim(), `${OTHER}|${OTHER}|https://api.exaone.ai/v1`);
        const delegate = run(['delegate', 'exaone', '--profile', 'team', '--', 'x']); assert.notEqual(delegate.status, 0); assert.match(delegate.stderr, /위임 대상이 아닙니다/);
        const login = run(['login', 'exaone', 'team']); assert.notEqual(login.status, 0); assert.match(login.stderr, /로그인이 없습니다/);
        const rmKey = run(['exaone', 'apikey', 'rm', 'team']); assert.equal(rmKey.status, 0, rmKey.stderr); assert.match(rmKey.stdout, /제거됨/);
        assert.match(run(['exaone', 'list']).stdout, /\(API 키 없음\)/);
        const rm = run(['exaone', 'rm', 'team']); assert.equal(rm.status, 0, rm.stderr);
        assert.ok(!run(['exaone', 'list']).stdout.includes('team'));
      });
    }
    console.log(`PASS exaone category (${cases} cases)`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
