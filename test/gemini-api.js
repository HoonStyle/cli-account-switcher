'use strict';
// Gemini API category: isolated state, key files, env injection, model-list check parsing.
// Fake keys and a fake fetch only; no network and no real credentials.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-api-test-')));
process.env.CLI_ACCOUNTS_ROOT = root;
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
const P = require('../src/paths');
const store = require('../src/store');
const gemini = require('../src/gemini-api');
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const FAKE = 'AIzaSyFakeTestKey000000000000000000001234';
const OTHER = 'AIzaSyFakeTestKey000000000000000000009999';
let cases = 0;
function test(name, fn) { fn(); cases++; console.log('PASS ' + name); }
async function atest(name, fn) { await fn(); cases++; console.log('PASS ' + name); }
(async () => {
  try {
    test('category is separate from TOOLS, aliases gemini, starts empty', () => {
      assert.ok(!P.TOOLS.includes('gemini-api') && !P.TOOLS.includes('gemini'));
      assert.ok(P.PROVIDERS.includes('gemini-api'));
      assert.equal(gemini.ID, 'gemini-api'); assert.deepEqual(gemini.ALIASES, ['gemini']);
      assert.equal(require('../src/providers').find('gemini'), gemini);
      assert.deepEqual(store.load()['gemini-api'], { active: null, profiles: [] });
      assert.deepEqual(gemini.snapshot().accounts, []);
      assert.equal(gemini.snapshot().model, null);
      assert.throws(() => gemini.launchEnv(), /계정이 없습니다/);
    });
    test('add, active defaulting, rename, resolve by label, duplicate and invalid names', () => {
      assert.deepEqual(gemini.add('work'), { id: 'work', label: 'work' });
      assert.equal(store.load()['gemini-api'].active, 'work');
      gemini.add('개인');
      assert.throws(() => gemini.add('work'), /이미 있는/);
      assert.throws(() => gemini.add('bad/name'), /이름은/);
      assert.deepEqual(gemini.rename('개인', 'Personal'), { id: '개인', label: 'Personal' });
      assert.equal(gemini.resolve('Personal'), '개인');
      assert.throws(() => gemini.resolve('nope'), /없는 Gemini 계정/);
      assert.throws(() => gemini.rename('work', 'Personal'), /이미 쓰는/);
      assert.deepEqual(gemini.setActive('Personal'), { id: '개인' });
      gemini.setActive('work');
      // Other categories are untouched.
      assert.deepEqual(store.load().exaone, { active: null, profiles: [] });
      assert.deepEqual(store.load().claude.profiles, ['default']);
    });
    test('keys are stored 0600 per account, injected as Gemini and OpenAI variables for that account only', () => {
      assert.throws(() => gemini.launchEnv('work'), /API 키가 등록되지 않았습니다/);
      const r = gemini.setKey('work', FAKE + '\n');
      assert.equal(r.masked, '…1234'); assert.equal(r.warning, null);
      const file = path.join(root, 'api-keys', 'gemini-api', 'work');
      if (!P.IS_WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(file, 'utf8').trim(), FAKE);
      assert.equal(gemini.setKey('개인', 'sk-not-a-google-key-0000000000').warning, 'Gemini API 키는 보통 AIza 로 시작합니다');
      const base = { PATH: '/usr/bin', OPENAI_API_KEY: 'inherited', OPENAI_BASE_URL: 'https://other.example/v1', GEMINI_API_KEY: 'stale', GOOGLE_API_KEY: 'stale', GOOGLE_GENAI_USE_VERTEXAI: 'true', HOME: process.env.HOME };
      const { id, env } = gemini.launchEnv('work', base);
      assert.equal(id, 'work');
      assert.equal(env.GEMINI_API_KEY, FAKE); assert.equal(env.GOOGLE_API_KEY, FAKE); assert.equal(env.OPENAI_API_KEY, FAKE);
      assert.equal(env.OPENAI_BASE_URL, BASE); assert.equal(env.GEMINI_BASE_URL, BASE);
      assert.equal(env.GEMINI_MODEL, undefined); assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined, 'inherited Google variables are stripped');
      assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, process.env.HOME);
      assert.deepEqual(gemini.envNames(), ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']);
      assert.equal(gemini.launchEnv(undefined, base).env.GEMINI_API_KEY, FAKE);
      gemini.setKey('개인', OTHER);
      assert.equal(gemini.launchEnv('Personal', base).env.GEMINI_API_KEY, OTHER);
      const snap = gemini.snapshot();
      assert.equal(snap.keyHint, 'AIza…'); assert.equal(snap.checkPath, 'GET /v1beta/models');
      assert.deepEqual(snap.accounts.map((a) => [a.name, a.label, a.active, a.apiKey.apiKey, a.apiKey.masked]), [['work', 'work', true, true, '…1234'], ['개인', 'Personal', false, true, '…9999']]);
      assert.ok(!JSON.stringify(snap).includes(FAKE) && !JSON.stringify(snap).includes(OTHER), 'snapshot must not contain keys');
      assert.ok(!fs.readFileSync(P.STATE_FILE, 'utf8').includes(FAKE), 'state.json must not contain keys');
    });
    await atest('check lists gemini models with the x-goog-api-key header; errors are fixed text without the key', async () => {
      const calls = [];
      const fakeFetch = (status, body) => async (url, init) => {
        calls.push({ url, headers: init.headers });
        return { ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(body) };
      };
      const body = { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }, { name: 'models/text-embedding-004' }, { name: 'models/imagen-4.0-generate' }] };
      const ok = await gemini.check('work', { fetchImpl: fakeFetch(200, body), now: () => Date.UTC(2026, 10, 14, 15, 0, 0) });
      assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models');
      assert.equal(calls[0].headers['x-goog-api-key'], FAKE); assert.equal(calls[0].headers.Authorization, undefined);
      assert.equal(ok.ok, true); assert.deepEqual(ok.models, ['gemini-2.5-pro', 'gemini-2.5-flash']); assert.equal(ok.rateLimit, null);
      assert.equal(ok.checkedAt, '2026-11-14T15:00:00.000Z');
      assert.deepEqual(store.load()['gemini-api'].checks.work.models, ['gemini-2.5-pro', 'gemini-2.5-flash']);
      const denied = await gemini.check('work', { fetchImpl: fakeFetch(403, { error: { message: 'bad key ' + FAKE } }) });
      assert.equal(denied.ok, false); assert.equal(denied.error, 'API 키가 거부되었습니다');
      assert.ok(!JSON.stringify(denied).includes(FAKE) && !fs.readFileSync(P.STATE_FILE, 'utf8').includes(FAKE), 'error bodies and keys must not be recorded');
      assert.equal((await gemini.check('work', { fetchImpl: fakeFetch(429, {}) })).error, '요청 한도 초과 (429)');
      const down = await gemini.check('work', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
      assert.equal(down.error, '네트워크 오류'); assert.equal(gemini.snapshot().accounts[0].check.ok, false);
      gemini.setKey('work', FAKE);
      assert.equal(gemini.snapshot().accounts[0].check, null, 're-registering a key forgets the previous check');
    });
    await atest('run injects the account env into the child and reports its exit code', async () => {
      const probe = path.join(root, 'probe.js');
      fs.writeFileSync(probe, "require('fs').writeFileSync(process.argv[3], JSON.stringify({ g: process.env.GEMINI_API_KEY, o: process.env.OPENAI_API_KEY, b: process.env.OPENAI_BASE_URL })); process.exit(Number(process.argv[2] || 0));");
      const out = path.join(root, 'probe.out');
      const r = await gemini.run('work', [process.execPath, probe, '3', out]);
      assert.equal(r.code, 3); assert.equal(r.id, 'work');
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { g: FAKE, o: FAKE, b: BASE });
      await assert.rejects(gemini.run('work', ['/nonexistent/binary-xyz']), /실행 파일을 찾을 수 없습니다/);
      assert.throws(() => gemini.run('work', []), /사용법/);
    });
    test('remove deletes the key file and moves the active marker', () => {
      gemini.remove('work');
      assert.equal(fs.existsSync(path.join(root, 'api-keys', 'gemini-api', 'work')), false);
      assert.deepEqual(store.load()['gemini-api'].profiles, ['개인']); assert.equal(store.load()['gemini-api'].active, '개인');
    });
    // Console CLI through the real dispatcher (`gemini-api` and the `gemini` alias), from the source tree and the installed lib copy.
    gemini.remove('개인');
    require('../src/wrappers').installShims();
    for (const cli of [path.resolve(__dirname, '../src/cli.js'), path.join(P.LIB_DIR, 'cli.js')]) {
      await atest(`cli ${cli.startsWith(P.LIB_DIR) ? '(installed lib)' : '(src)'} add/apikey/list/env/run/rm with gemini alias`, async () => {
        const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: input ?? '', env: { ...process.env, OPENAI_API_KEY: 'inherited-not-allowed', GEMINI_API_KEY: 'inherited-not-allowed' } });
        const add = run(['gemini-api', 'add', 'team']); assert.equal(add.status, 0, add.stderr); assert.match(add.stdout, /추가됨: team/);
        const argvKey = run(['gemini', 'apikey', 'set', 'team', FAKE]); assert.notEqual(argvKey.status, 0); assert.ok(!fs.existsSync(path.join(root, 'api-keys', 'gemini-api', 'team')));
        const set = run(['gemini', 'apikey', 'set', 'team'], FAKE + '\n'); assert.equal(set.status, 0, set.stderr);
        assert.ok(!set.stdout.includes(FAKE) && !set.stderr.includes(FAKE), 'key must not be printed'); assert.match(set.stdout, /…1234/);
        const viaGeneric = run(['apikey', 'set', 'gemini', 'team'], OTHER + '\n'); assert.equal(viaGeneric.status, 0, viaGeneric.stderr); assert.match(viaGeneric.stdout, /…9999/);
        const list = run(['gemini', 'list']); assert.match(list.stdout, /Gemini API/); assert.match(list.stdout, /team\s+API 키 …9999/);
        const all = run(['list']); assert.match(all.stdout, /gemini-api:/); assert.match(all.stdout, /team/);
        const json = JSON.parse(run(['list', '--json']).stdout);
        const row = json.accounts.find((a) => a.tool === 'gemini-api' && a.profileId === 'team');
        assert.deepEqual(row, { tool: 'gemini-api', profileId: 'team', active: true, apiKey: true, delegable: false, baseUrl: BASE, model: null });
        assert.ok(!JSON.stringify(json).includes(OTHER));
        const status = run(['apikey', 'status']); assert.match(status.stdout, /gemini-api\s+team\s+API 키 …9999/);
        const env = run(['gemini-api', 'env', 'team']); assert.equal(env.status, 0, env.stderr); assert.match(env.stdout, /GEMINI_API_KEY/); assert.ok(!env.stdout.includes(OTHER));
        const probe = path.join(root, 'probe-cli.js');
        fs.writeFileSync(probe, "console.log(process.env.GEMINI_API_KEY + '|' + process.env.OPENAI_API_KEY + '|' + process.env.OPENAI_BASE_URL)");
        const ran = run(['gemini', 'run', 'team', '--', process.execPath, probe]); assert.equal(ran.status, 0, ran.stderr); assert.equal(ran.stdout.trim(), `${OTHER}|${OTHER}|${BASE}`);
        const viaRun = run(['run', 'gemini-api', '--profile', 'team', '--', process.execPath, probe]); assert.equal(viaRun.status, 0, viaRun.stderr); assert.equal(viaRun.stdout.trim(), `${OTHER}|${OTHER}|${BASE}`);
        const delegate = run(['delegate', 'gemini', '--profile', 'team', '--', 'x']); assert.notEqual(delegate.status, 0); assert.match(delegate.stderr, /위임 대상이 아닙니다/);
        const login = run(['login', 'gemini-api', 'team']); assert.notEqual(login.status, 0); assert.match(login.stderr, /로그인이 없습니다/);
        const rmKey = run(['gemini', 'apikey', 'rm', 'team']); assert.equal(rmKey.status, 0, rmKey.stderr); assert.match(rmKey.stdout, /제거됨/);
        assert.match(run(['gemini-api', 'list']).stdout, /\(API 키 없음\)/);
        const rm = run(['gemini', 'rm', 'team']); assert.equal(rm.status, 0, rm.stderr);
        assert.ok(!run(['gemini-api', 'list']).stdout.includes('team'));
      });
    }
    console.log(`PASS gemini-api category (${cases} cases)`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
