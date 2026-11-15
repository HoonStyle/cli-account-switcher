'use strict';
// Month-to-date organization spend via admin keys, with a mocked fetch (no network, no real keys).
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-cost-'));
process.env.CLI_ACCOUNTS_ROOT = root;
const cost = require('../src/api-cost');

const ANTHROPIC_KEY = 'sk-ant-admin01-' + 'a'.repeat(40) + 'WXYZ';
const OPENAI_KEY = 'sk-admin-' + 'b'.repeat(40) + 'QRST';
const NOW = Date.parse('2026-11-15T09:30:00Z');
const calls = [];
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let mode = 'ok';
async function fakeFetch(url, init) {
  const u = new URL(url);
  calls.push({ host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers });
  if (mode === 'fail') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'echo ' + (init.headers['x-api-key'] || init.headers.Authorization) } });
  if (mode === 'network') throw new TypeError('fetch failed');
  if (u.host === 'api.anthropic.com') {
    // Cents as decimal strings across two pages.
    if (!u.searchParams.get('page')) return json(200, { data: [{ starting_at: '2026-11-01T00:00:00Z', results: [{ currency: 'USD', amount: '1050.5' }, { currency: 'USD', amount: '200' }] }], has_more: true, next_page: 'page_2' });
    return json(200, { data: [{ starting_at: '2026-11-02T00:00:00Z', results: [{ currency: 'USD', amount: '49.5' }] }], has_more: false, next_page: null });
  }
  if (u.host === 'api.openai.com') {
    if (!u.searchParams.get('page')) return json(200, { object: 'page', data: [{ object: 'bucket', results: [{ object: 'organization.costs.result', amount: { value: 3.25, currency: 'usd' } }, { amount: { value: 0.005, currency: 'usd' } }] }], has_more: true, next_page: 'p2' });
    return json(200, { object: 'page', data: [{ object: 'bucket', results: [{ amount: { value: 1.75, currency: 'usd' } }, { amount: null }] }], has_more: false });
  }
  throw new Error('unexpected host ' + u.host);
}

(async () => {
  const state = { claude: { profiles: ['default', 'exp_api'] }, codex: { profiles: ['victor_api', 'hoonlim'] } };
  // No admin key: no request, nothing cached.
  assert.equal(await cost.refresh('claude', 'exp_api', { now: NOW, fetchImpl: fakeFetch }), 'skip: 관리자 키 없음');
  assert.deepEqual(await cost.refreshAll(state, { now: NOW, fetchImpl: fakeFetch }), {});
  assert.equal(calls.length, 0);
  assert.equal(cost.snapshot('claude', 'exp_api', NOW).adminKey, false);

  // Storage: 0600 file outside snapshots; wrong prefix warns but is accepted.
  const set = cost.setKey('claude', 'exp_api', ANTHROPIC_KEY);
  assert.deepEqual(set, { masked: '…WXYZ', warning: null });
  const file = path.join(root, 'api-keys', 'admin', 'claude', 'exp_api');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'api-keys', 'admin')).mode & 0o777, 0o700);
  assert.equal(cost.setKey('codex', 'victor_api', 'sk-proj-' + 'c'.repeat(30)).warning, 'OpenAI 관리자 키는 보통 sk-admin- 으로 시작합니다');
  cost.setKey('codex', 'victor_api', OPENAI_KEY);
  assert.throws(() => cost.setKey('exaone', 'x', ANTHROPIC_KEY), /claude·codex/);
  assert.throws(() => cost.setKey('claude', '../evil', ANTHROPIC_KEY), /Invalid profile ID/);
  assert.throws(() => cost.setKey('claude', 'exp_api', 'short'), /길이/);

  // Anthropic: admin header + version, month start in UTC, 31 daily buckets, pagination, cents → USD.
  assert.equal(await cost.refresh('claude', 'exp_api', { now: NOW, fetchImpl: fakeFetch }), 'ok');
  const a = calls.filter((c) => c.host === 'api.anthropic.com');
  assert.equal(a.length, 2);
  assert.equal(a[0].path, '/v1/organizations/cost_report');
  assert.equal(a[0].query.starting_at, '2026-11-01T00:00:00.000Z'); assert.equal(a[0].query.bucket_width, '1d'); assert.equal(a[0].query.limit, '31');
  assert.equal(a[0].headers['x-api-key'], ANTHROPIC_KEY); assert.ok(a[0].headers['anthropic-version']);
  assert.equal(a[1].query.page, 'page_2');
  let snap = cost.snapshot('claude', 'exp_api', NOW);
  assert.equal(snap.amountUsd, 13); assert.equal(snap.month, '2026-11'); assert.equal(snap.masked, '…WXYZ'); assert.equal(snap.error, null); assert.equal(snap.org, 'Anthropic');

  // OpenAI: bearer admin key, unix month start, pagination, null amounts skipped, rounding to cents.
  assert.equal(await cost.refresh('codex', 'victor_api', { now: NOW, fetchImpl: fakeFetch }), 'ok');
  const o = calls.filter((c) => c.host === 'api.openai.com');
  assert.equal(o.length, 2); assert.equal(o[0].path, '/v1/organization/costs');
  assert.equal(o[0].query.start_time, String(Date.parse('2026-11-01T00:00:00Z') / 1000)); assert.equal(o[0].query.limit, '31');
  assert.equal(o[0].headers.Authorization, `Bearer ${OPENAI_KEY}`); assert.equal(o[1].query.page, 'p2');
  assert.equal(cost.snapshot('codex', 'victor_api', NOW).amountUsd, 5.01);

  // Freshness: automatic refresh skips within 30 minutes, force refetches; refreshAll only touches keyed accounts.
  const before = calls.length;
  assert.equal(await cost.refresh('claude', 'exp_api', { now: NOW + 60e3, fetchImpl: fakeFetch }), 'skip: 최신');
  assert.equal(calls.length, before);
  assert.deepEqual(await cost.refreshAll(state, { now: NOW + 31 * 60e3, fetchImpl: fakeFetch }), { 'claude/exp_api': 'ok', 'codex/victor_api': 'ok' });

  // Failure keeps the last amount but marks the error; the provider's message (which may echo input) is dropped.
  mode = 'fail';
  const err = await cost.refresh('claude', 'exp_api', { force: true, now: NOW + 40 * 60e3, fetchImpl: fakeFetch });
  assert.equal(err, 'HTTP 401 authentication_error');
  snap = cost.snapshot('claude', 'exp_api', NOW + 40 * 60e3);
  assert.equal(snap.amountUsd, 13); assert.equal(snap.error, 'HTTP 401 authentication_error');
  mode = 'network';
  assert.equal(await cost.refresh('codex', 'victor_api', { force: true, now: NOW, fetchImpl: fakeFetch }), '네트워크 오류');

  // New month: previous month's amount is not shown as this month's.
  assert.equal(cost.snapshot('claude', 'exp_api', Date.parse('2026-12-01T00:10:00Z')).amountUsd, null);

  // No key material in the cache file, snapshots or errors.
  const cache = fs.readFileSync(path.join(root, 'api-keys', 'admin', 'cost-cache.json'), 'utf8');
  for (const text of [cache, JSON.stringify(cost.snapshot('claude', 'exp_api', NOW)), JSON.stringify(cost.snapshot('codex', 'victor_api', NOW))]) {
    assert(!text.includes(ANTHROPIC_KEY) && !text.includes(OPENAI_KEY) && !text.includes('aaaaaaaaaa') && !text.includes('bbbbbbbbbb'), 'no key material');
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'api-keys', 'admin', 'cost-cache.json')).mode & 0o777, 0o600);

  // Removing the key removes its cached spend.
  assert.deepEqual(cost.removeKey('claude', 'exp_api'), { removed: true });
  assert.equal(fs.existsSync(file), false);
  snap = cost.snapshot('claude', 'exp_api', NOW);
  assert.equal(snap.adminKey, false); assert.equal(snap.amountUsd, null);
  assert(!JSON.parse(fs.readFileSync(path.join(root, 'api-keys', 'admin', 'cost-cache.json'), 'utf8'))['claude/exp_api']);

  // Statusline hook: cumulative session cost becomes per-bucket increases per session file; other payload fields are dropped.
  const { spawnSync } = require('child_process');
  const wrappers = require('../src/wrappers');
  const hookFile = path.join(root, 'hook.js'); fs.writeFileSync(hookFile, wrappers.statusLineHookSource());
  const cfg = path.join(root, 'claude-config'); fs.mkdirSync(cfg);
  const feed = (payload) => { const r = spawnSync(process.execPath, [hookFile], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLI_ACCOUNTS_ROOT: root }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  feed({ session_id: 'sess-aaaa1111', cost: { total_cost_usd: 0.5 }, rate_limits: { five_hour: { used_percentage: 3 } }, transcript_path: '/secret/path', workspace: { current_dir: '/secret' } });
  feed({ session_id: 'sess-aaaa1111', cost: { total_cost_usd: 1.25 } });
  feed({ session_id: 'sess-aaaa1111', cost: { total_cost_usd: 1.25 } }); // unchanged: no write needed
  feed({ session_id: 'sess-aaaa1111', cost: { total_cost_usd: 0.2 } });  // lower total = new segment
  feed({ session_id: 'sess-bbbb2222', cost: { total_cost_usd: 0.3 } });
  feed({ session_id: '../escape', cost: { total_cost_usd: 9 } });
  feed({ session_id: 'sess-cccc3333', cost: { total_cost_usd: 'NaN' } });
  const spendDir = path.join(cfg, cost.SPEND_DIR);
  assert.deepEqual(fs.readdirSync(spendDir).sort(), ['sess-aaaa1111.json', 'sess-bbbb2222.json']);
  const rec = JSON.parse(fs.readFileSync(path.join(spendDir, 'sess-aaaa1111.json'), 'utf8'));
  assert.equal(rec.last, 0.2); assert.equal(Object.values(rec.buckets).reduce((a, b) => a + b, 0).toFixed(2), '1.45');
  assert(!JSON.stringify(rec).includes('secret'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(spendDir, 'sess-aaaa1111.json')).mode & 0o777, 0o600);
  assert(fs.existsSync(path.join(cfg, require('../src/paths').USAGE_CACHE_NAME)), 'rate_limits caching unchanged');
  let local = cost.localSpend(cfg);
  assert.equal(local.monthUsd, 1.75); assert.equal(local.sessions, 2);
  assert.equal(cost.localSpend(cfg, { sinceMs: Date.now() + 20 * 60e3 }).sinceUsd, 0);
  assert.equal(cost.localSpend(path.join(root, 'missing')), null);

  // Balance: validated USD input, estimate = entered balance − this machine's spend since the entry's 10-minute bucket.
  for (const bad of ['abc', '-1', '1.234', '', '99999999']) assert.throws(() => cost.setBalance('claude', 'exp_api', bad), /USD/, bad);
  assert.throws(() => cost.setBalance('codex', 'victor_api', '10'), /Claude API 키 계정만/);
  assert.deepEqual(cost.setBalance('claude', 'exp_api', '$1,234.50').baseUsd, 1234.5);
  let s2 = cost.snapshot('claude', 'exp_api', Date.now(), { configDir: cfg });
  assert.equal(s2.local.monthUsd, 1.75); assert.equal(s2.balance.baseUsd, 1234.5); assert.equal(s2.balance.spentSinceUsd, 1.75); assert.equal(s2.balance.estimateUsd, 1232.75);
  assert.equal(cost.snapshot('codex', 'victor_api', Date.now(), { configDir: cfg }).balance, null);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'spend', 'balance.json')).mode & 0o777, 0o600);
  feed({ session_id: 'sess-bbbb2222', cost: { total_cost_usd: 2.3 } });
  assert.equal(cost.snapshot('claude', 'exp_api', Date.now(), { configDir: cfg }).balance.estimateUsd, 1230.75);
  assert.deepEqual(cost.clearBalance('claude', 'exp_api'), { removed: true });
  assert.equal(cost.snapshot('claude', 'exp_api', Date.now(), { configDir: cfg }).balance, null);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS api-cost: admin-key storage 0600, Anthropic cost_report and OpenAI costs month-to-date with pagination, 30-minute freshness, error retention without key echo, month rollover, removal; statusline session-cost buckets, local month spend, balance entry and estimate');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
