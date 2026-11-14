'use strict';
// Per-profile API keys. Fake executables and fake keys only; no live authentication.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-keys-')));
process.env.CLI_ACCOUNTS_ROOT = root;
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
const P = require('../src/paths');
const store = require('../src/store');
const FAKE_CLAUDE = 'sk-ant-fake-test-key-0000000000001234';
const FAKE_CODEX = 'sk-fake-codex-test-key-000000000005678';
try {
  const log = path.join(root, 'codex-calls.jsonl');
  const probe = path.join(root, 'probe');
  // Echoes env; for `login --with-api-key` records stdin; `login status` reports API key mode once logged in.
  fs.writeFileSync(probe, `#!${process.execPath}
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const marker=process.env.CODEX_HOME&&path.join(process.env.CODEX_HOME,'fake-auth');
if(a[0]==='login'&&a[1]==='--with-api-key'){const k=fs.readFileSync(0,'utf8').trim();fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({home:process.env.CODEX_HOME,k})+'\\n');fs.writeFileSync(marker,'x');process.exit(0)}
if(a[0]==='login'&&a[1]==='status'){if(marker&&fs.existsSync(marker)){console.log('Logged in using an API key - sk-***');process.exit(0)}process.exit(1)}
if(a[0]==='logout'){fs.rmSync(marker,{force:true});process.exit(0)}
console.log(JSON.stringify({args:a,anthropic:process.env.ANTHROPIC_API_KEY,openai:process.env.OPENAI_API_KEY,claude:process.env.CLAUDE_CONFIG_DIR,codex:process.env.CODEX_HOME}));
`, { mode: 0o755 });
  for (const tool of P.TOOLS) store.addProfile(tool, 'worker', { shareSettings: false });
  require('../src/wrappers').installShims();
  const state = store.load();
  for (const tool of P.TOOLS) state.realBin[tool] = probe;
  store.save(state);
  let checks = 0;
  for (const cli of [path.resolve(__dirname, '../src/cli.js'), path.join(P.LIB_DIR, 'cli.js')]) {
    const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: input ?? '', env: { ...process.env, ANTHROPIC_API_KEY: 'inherited-not-allowed', OPENAI_API_KEY: 'inherited-not-allowed' } });
    const delegate = (tool, profile) => { const r = run(['delegate', tool, '--profile', profile, '--', 'x']); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

    // Key on argv is refused and never stored.
    const argvKey = run(['apikey', 'set', 'claude', 'worker', FAKE_CLAUDE]);
    assert.notEqual(argvKey.status, 0); assert.equal(require('../src/api-keys').read('claude', 'worker'), null); checks++;

    // Claude: stored 0600, injected only into the registered profile.
    const set = run(['apikey', 'set', 'claude', 'worker'], FAKE_CLAUDE + '\n');
    assert.equal(set.status, 0, set.stderr);
    assert.ok(!set.stdout.includes(FAKE_CLAUDE) && !set.stderr.includes(FAKE_CLAUDE), 'key must not be printed');
    const file = path.join(root, 'api-keys', 'claude', 'worker');
    if (!P.IS_WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // The fake CLI is a shebang script; Windows cannot spawn it (pinned launch is unsupported there),
    // so Windows checks the store and console paths only.
    if (!P.IS_WIN) {
      assert.equal(delegate('claude', 'worker').anthropic, FAKE_CLAUDE);
      assert.equal(delegate('claude', 'default').anthropic, undefined);
      assert.equal(delegate('codex', 'worker').anthropic, undefined);
      assert.equal(delegate('codex', 'worker').openai, undefined);
      checks += 4;
    }
    const listing = JSON.parse(run(['list', '--json']).stdout);
    assert.equal(listing.accounts.find(a => a.tool === 'claude' && a.profileId === 'worker').apiKey, true);
    assert.equal(listing.accounts.find(a => a.tool === 'claude' && a.profileId === 'default').apiKey, false);
    assert.ok(!JSON.stringify(listing).includes(FAKE_CLAUDE)); checks++;
    const rm = run(['apikey', 'rm', 'claude', 'worker']);
    assert.equal(rm.status, 0, rm.stderr);
    assert.equal(fs.existsSync(file), false);
    if (P.IS_WIN) continue;
    assert.equal(delegate('claude', 'worker').anthropic, undefined); checks++;

    // Codex: official login --with-api-key via stdin, with that profile's CODEX_HOME.
    fs.rmSync(log, { force: true });
    const cset = run(['apikey', 'set', 'codex', 'worker'], FAKE_CODEX);
    assert.equal(cset.status, 0, cset.stderr);
    assert.ok(!cset.stdout.includes(FAKE_CODEX));
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls, [{ home: store.profileHome('codex', 'worker'), k: FAKE_CODEX }]); checks++;
    const status = JSON.parse(run(['apikey', 'status', '--json']).stdout);
    assert.equal(status.find(r => r.tool === 'codex' && r.profileId === 'worker').apiKey, true);
    assert.ok(!JSON.stringify(status).includes(FAKE_CODEX)); checks++;
    assert.equal(run(['apikey', 'rm', 'codex', 'worker']).status, 0);
    assert.notEqual(run(['apikey', 'rm', 'codex', 'worker']).status, 0, 'refuses to log out a non-API-key login'); checks++;
  }
  // Removing a profile removes its key.
  store.addProfile('claude', 'keyed', { shareSettings: false });
  require('../src/api-keys').write('claude', 'keyed', FAKE_CLAUDE);
  store.removeProfile('claude', 'keyed');
  assert.equal(require('../src/api-keys').read('claude', 'keyed'), null); checks++;
  console.log(`api-keys: ${checks} source/installed API key cases passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
