'use strict';
const assert = require('assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');
const { createManager, parseCredential, runningProcesses, SERVICE } = require('../src/antigravity');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
const credential = (email, suffix = '') => JSON.stringify({ token: { access_token: 'fixture-access-' + suffix, refresh_token: 'fixture-refresh-' + email }, id_token: 'header.' + Buffer.from(JSON.stringify({ sub: email, email })).toString('base64url') + '.fixture' });
const first = credential('first@example.invalid'), second = credential('second@example.invalid');
// macOS go-keyring stores the JSON inside a tagged base64 envelope. Native
// keychain readers return that envelope, not go-keyring's decoded JSON.
const keyringBase64 = value => 'go-keyring-base64:' + Buffer.from(value, 'utf8').toString('base64');
const keyringHex = value => 'go-keyring-encoded:' + Buffer.from(value, 'utf8').toString('hex');
let cases = 0;
function fixture(name, { file = true } = {}) {
  const dir = path.join(tmp, name), values = new Map([['gemini/antigravity', first]]);
  const tokenFile = path.join(dir, 'official-token');
  fs.mkdirSync(dir, { recursive: true });
  if (file) fs.writeFileSync(tokenFile, first, { mode: 0o600 });
  let pids = [], fault = null;
  const vault = { get: async (s, a) => values.get(`${s}/${a}`) ?? null,
    set: async (s, a, raw) => { if (fault) await fault(s, a, raw); values.set(`${s}/${a}`, raw); },
    remove: async (s, a) => values.delete(`${s}/${a}`) };
  const opts = { root: path.join(dir, 'registry'), common: path.join(dir, 'shared'), tokenFile, vault, processes: () => pids };
  const manager = createManager(opts);
  const setLive = raw => { values.set('gemini/antigravity', raw); if (file) fs.writeFileSync(tokenFile, raw); };
  return { dir, values, tokenFile, vault, opts, manager, setLive, busy: value => pids = value, fail: fn => fault = fn };
}
async function seed(f) { await f.manager.save('개인'); f.setLive(second); await f.manager.save('work'); f.setLive(first); }
async function test(name, fn) { await fn(); cases++; console.log('PASS ' + name); }
(async () => {
  await test('strict local identity, malformed credentials never echo secrets', async () => {
    assert.equal(parseCredential(first).email, 'first@example.invalid');
    for (const raw of ['super-secret', '{}', '{"token":{"access_token":"super-secret"}}']) assert.throws(() => parseCredential(raw), e => !e.message.includes('super-secret'));
  });
  await test('official macOS keyring envelopes decode without weakening credential validation', async () => {
    // Field names/types observed in agy 1.4.12; all values below are synthetic.
    const official = JSON.stringify({ token: { access_token: 'fixture-access', token_type: 'Bearer', refresh_token: 'fixture-refresh', expiry: '2030-01-01T00:00:00Z', expires_in: 3600 }, auth_method: 'consumer', id_token_email: 'first@example.invalid' });
    assert.deepEqual(parseCredential(keyringBase64(official)), parseCredential(first));
    for (const encode of [keyringBase64, keyringHex]) {
      assert.deepEqual(parseCredential(encode(first)), parseCredential(first));
      for (const raw of [encode('not-json-secret'), encode('{}'), encode(encode(first))]) {
        assert.throws(() => parseCredential(raw), e => /인증 형식/.test(e.message) && !e.message.includes('secret'));
      }
    }
    for (const raw of ['go-keyring-base64:!!!!', keyringBase64(first) + '!', 'go-keyring-encoded:abc', 'go-keyring-encoded:zz', Buffer.from(first).toString('base64')]) {
      assert.throws(() => parseCredential(raw), /인증 형식/);
    }
  });
  await test('encoded keyring login checks, saves and switches with plain JSON fallback', async () => {
    const f = fixture('encoded-keyring');
    const set = raw => { f.values.set('gemini/antigravity', keyringBase64(raw)); fs.writeFileSync(f.tokenFile, raw); };
    set(first);
    assert.equal((await f.manager.check()).current.email, 'first@example.invalid');
    await f.manager.save('개인'); set(second); await f.manager.save('work'); set(first);
    await f.manager.activate('work');
    assert.equal(f.values.get('gemini/antigravity'), keyringBase64(second), 'preserve the exact official keyring envelope');
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), second, 'file fallback must contain JSON, never the keyring envelope');
    await f.manager.activate('개인');
    assert.equal(f.values.get('gemini/antigravity'), keyringBase64(first));
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), first);
    const rename = fs.renameSync; let failed = false;
    fs.renameSync = (from, to) => { if (to === f.tokenFile && !failed) { failed = true; throw Error('fixture write fault'); } return rename(from, to); };
    try { await assert.rejects(f.manager.activate('work'), /기존 인증을 복원/); } finally { fs.renameSync = rename; }
    assert.equal(f.values.get('gemini/antigravity'), keyringBase64(first), 'rollback restores original physical keyring bytes');
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), first);
  });
  await test('save/list do not change shared auth; metadata contains no credential', async () => {
    const f = fixture('save'); await f.manager.save('개인');
    assert.equal(f.values.get('gemini/antigravity'), first);
    const metadata = fs.readFileSync(path.join(f.opts.root, 'registry.json'), 'utf8');
    assert(!metadata.includes('fixture-access')); assert(!metadata.includes('refresh_token'));
    assert(!JSON.stringify(f.manager.snapshot()).includes('fixture-refresh'));
    assert.equal(createManager(f.opts).snapshot().current, null, 'do not infer live login from saved metadata');
  });
  await test('switch updates keyring and existing fallback with readback', async () => {
    const f = fixture('switch'); await seed(f);
    const result = await f.manager.activate('work');
    assert.equal(result.current.email, 'second@example.invalid');
    assert.equal(f.values.get('gemini/antigravity'), second); assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), second);
    assert.equal(fs.existsSync(path.join(f.opts.common, 'transaction.json')), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.tokenFile).mode & 0o777, 0o600); // Windows reports no POSIX mode
  });
  await test('keyring-only installs never gain plaintext credential files', async () => {
    const f = fixture('keyring-only', { file: false }); await seed(f); await f.manager.activate('work'); assert(!fs.existsSync(f.tokenFile));
  });
  await test('running Antigravity prevents any auth mutation', async () => {
    const f = fixture('running'); await seed(f); f.busy([42]); const before = [...f.values];
    await assert.rejects(f.manager.activate('work'), /모두 종료/);
    assert.deepEqual([...f.values], before); assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), first);
  });
  await test('drift, missing vault account and unknown account fail closed', async () => {
    const f = fixture('drift'); await seed(f); fs.writeFileSync(f.tokenFile, second);
    await assert.rejects(f.manager.activate('work'), /계정이 다릅니다/); f.setLive(first);
    await assert.rejects(f.manager.activate('missing'), /정확한 이름/);
    for (const k of f.values.keys()) if (k.startsWith(SERVICE) && k.endsWith(parseCredential(second).id)) f.values.delete(k);
    await assert.rejects(f.manager.activate('work'), /인증 형식/); assert.equal(f.values.get('gemini/antigravity'), first);
  });
  await test('partial write failure restores both stores and clears journal', async () => {
    const f = fixture('rollback'); await seed(f);
    const rename = fs.renameSync; let failed = false;
    fs.renameSync = (from, to) => { if (to === f.tokenFile && !failed) { failed = true; throw Error('fixture write fault'); } return rename(from, to); };
    try { await assert.rejects(f.manager.activate('work'), /기존 인증을 복원/); } finally { fs.renameSync = rename; }
    assert.equal(f.values.get('gemini/antigravity'), first); assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), first);
    assert(!fs.existsSync(path.join(f.opts.common, 'transaction.json')));
  });
  await test('failed rollback is recoverable across manager restart', async () => {
    const f = fixture('recovery'); await seed(f);
    let writes = 0; f.fail((s, a) => { if (s === 'gemini' && ++writes >= 1) throw Error('secret backend diagnostic'); });
    await assert.rejects(f.manager.activate('work'), /인증 복구가 필요/);
    assert(f.manager.snapshot().recoveryRequired);
    await assert.rejects(f.manager.save('other'), /전환 복구/);
    f.fail(null); const reopened = createManager(f.opts); await reopened.recover();
    assert.equal(f.values.get('gemini/antigravity'), first); assert(!reopened.snapshot().recoveryRequired);
  });
  await test('refresh token changes are preserved when returning to a saved account', async () => {
    const f = fixture('refresh'); await seed(f); const refreshed = credential('first@example.invalid', 'new'); f.setLive(refreshed);
    await f.manager.activate('work'); await f.manager.activate('개인'); assert.equal(f.values.get('gemini/antigravity'), refreshed);
  });
  await test('cross-edition concurrent switches share one lock', async () => {
    const f = fixture('concurrent'); await seed(f); let unblock, entered;
    const inside = new Promise(resolve => entered = resolve), held = new Promise(resolve => unblock = resolve);
    f.fail(async (s, a) => { if (a === 'previous-shared-keyring') { entered(); await held; } });
    const pending = f.manager.activate('work'); await inside;
    const other = createManager({ ...f.opts, root: path.join(f.dir, 'other-edition') });
    await assert.rejects(other.save('second-edition'), /다른 Antigravity 계정 작업/);
    unblock(); await pending;
  });
  await test('removing saved account does not log out live account', async () => {
    const f = fixture('remove'); await seed(f); await f.manager.remove('개인'); assert.equal(f.values.get('gemini/antigravity'), first);
  });
  await test('CLI advertises shared support and rejects unconfirmed or pinned activation', async () => {
    const cli = path.resolve(__dirname, '../src/cli.js');
    const env = { ...process.env, CLI_ACCOUNTS_ROOT: path.join(tmp, 'cli') };
    const list = spawnSync(process.execPath, [cli, 'list', 'agy', '--json'], { env, encoding: 'utf8' });
    assert.equal(list.status, 0); assert.equal(JSON.parse(list.stdout).mode, 'shared-login');
    const denied = spawnSync(process.execPath, [cli, 'use', 'agy', 'work'], { env, encoding: 'utf8' });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /--shared-login/);
    const pinned = spawnSync(process.execPath, [cli, 'run', 'agy', '--profile', 'work', '--', '-p', 'fixture'], { env, encoding: 'utf8' });
    assert.equal(pinned.status, 1); assert.match(pinned.stderr, /Unsupported tool/);
  });
  if (process.platform === 'darwin') await test('real OS process inspection detects an agy-named process', async () => {
    const exe = path.join(tmp, 'agy'); fs.copyFileSync('/bin/sleep', exe); fs.chmodSync(exe, 0o700);
    const child = spawn(exe, ['30'], { stdio: 'ignore' });
    try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); assert(runningProcesses().includes(child.pid)); }
    finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  });
  console.log(`Antigravity: ${cases} cases passed; no live credentials accessed.`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
