'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const cp = require('child_process'), Module = require('module');
const base = path.resolve(__dirname, '..');
const edition = require('../src/edition.json');
assert.equal(edition.name, 'distribution'); assert.equal(edition.directUsageApi, false);
assert.equal(edition.credentialMetadata, false);
for (const name of ['usage-api.js', 'claude-cred.js', 'codex-identity.js', 'gemini.js', 'claude-refresh.js']) {
  assert(!fs.existsSync(path.join(base, 'src', name)), `${name} must not ship`);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-boundary-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp; delete process.env.CLI_ACCOUNTS_ROOT;
process.env.CLAUDE_CONFIG_DIR = '/wrong-account'; process.env.CODEX_HOME = '/wrong-account';
process.env.ANTHROPIC_API_KEY = 'fixture'; process.env.OPENAI_API_KEY = 'fixture';
const P = require('../src/paths'), store = require('../src/store');
const exec = cp.execFileSync, read = fs.readFileSync, load = Module._load;
const calls = [], handlers = {}, credentialReads = [];
let loginSucceeded = true;
try {
  assert.equal(P.ROOT, path.join(tmp, '.cli-accounts-distribution'));
  const a = store.addProfile('claude', 'team', { shareSettings: false });
  const b = store.addProfile('codex', 'team', { shareSettings: false });
  const s = store.load(); s.realBin = { claude: process.execPath, codex: process.execPath }; s.apiFetch = true; store.save(s);
  cp.execFileSync = (bin, args, opts) => {
    if (args.join(' ') === 'auth status') {
      if (!loginSucceeded) throw new Error('Not logged in');
      calls.push({ tool: 'claude', env: opts.env });
      return JSON.stringify({ loggedIn: true, email: 'test@example.invalid', subscriptionType: 'pro' });
    }
    if (args.join(' ') === 'login status') { if (!loginSucceeded) throw new Error('Not logged in'); calls.push({ tool: 'codex', env: opts.env }); return ''; }
    throw new Error('No external commands allowed by fixture');
  };
  fs.readFileSync = (file, ...args) => {
    if (/(?:auth\.json|\.credentials\.json|\.claude\.json|oauth_creds\.json)$/.test(String(file))) { credentialReads.push(String(file)); throw new Error('Credential read rejected'); }
    return read(file, ...args);
  };
  const claude = require('../src/claude'), codex = require('../src/codex');
  assert.equal(claude.inspect(a.home).loggedIn, true);
  assert.equal(codex.inspect(b.home).loggedIn, true);
  assert.equal(codex.inspect(b.home).email, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, a.home);
  assert.equal(calls[1].env.CODEX_HOME, fs.realpathSync(b.home));
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[1].env.OPENAI_API_KEY, undefined);
  claude.inspect(P.DEFAULT_HOME.claude);
  assert.equal(calls.at(-1).env.CLAUDE_CONFIG_DIR, undefined);
  fs.writeFileSync(path.join(a.home, 'usage-cache.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } }));
  assert.equal(claude.inspect(a.home).usage.fiveHour.usedPercent, 12);
  const rollouts = path.join(b.home, 'sessions'); fs.mkdirSync(rollouts);
  fs.writeFileSync(path.join(rollouts, 'fixture.jsonl'), JSON.stringify({ timestamp: '2026-10-05T00:00:00Z', payload: { rate_limits: { primary: { used_percent: 23 } } } }));
  assert.equal(codex.inspect(b.home).usage.primary.usedPercent, 23);
  loginSucceeded = false; claude.invalidate(a.home); codex.invalidate(b.home);
  assert.equal(claude.inspect(a.home).loggedIn, false); assert.equal(codex.inspect(b.home).loggedIn, false);
  assert.deepEqual(credentialReads, []);
  const wrappers = require('../src/wrappers'); wrappers.installShims();
  assert(fs.existsSync(path.join(P.LIB_DIR, 'official-auth.js')));
  assert(!fs.existsSync(path.join(P.LIB_DIR, 'usage-api.js')));
  const launcher = read(path.join(P.BIN_DIR, P.IS_WIN ? 'cli-accounts.cmd' : 'cli-accounts'), 'utf8');
  assert(launcher.includes('.cli-accounts-distribution'));
  Module._load = function(id, parent, isMain) {
    if (id === 'electron') return { app: { whenReady: () => new Promise(() => {}), on() {} }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
    return load.call(this, id, parent, isMain);
  };
  require('../src/main');
  const snapshot = handlers.state();
  assert.equal(snapshot.apiFetch, false); assert.equal(snapshot.directUsageApi, false);
} finally { cp.execFileSync = exec; fs.readFileSync = read; Module._load = load; }
(async () => {
  try {
    for (const [name, args] of [['setApiFetch', [null, true]], ['setApiInterval', [null, 1]], ['apiRefresh', []], ['apiRefreshOne', [null, 'codex', 'team']]]) {
      await assert.rejects(async () => handlers[name](...args), /로컬 사용량/);
    }
    for (const args of [['api', 'on'], ['usage', '--api']]) {
      const r = cp.spawnSync(process.execPath, [path.join(P.LIB_DIR, 'cli.js'), ...args], { encoding: 'utf8', env: process.env });
      assert.equal(r.status, 1); assert.match(r.stderr, /로컬 사용량/); assert(!r.stderr.includes('Cannot find module'));
    }
    const help = exec(process.execPath, [path.join(P.LIB_DIR, 'cli.js')], { encoding: 'utf8', env: process.env });
    assert(!help.includes('--api')); assert(!help.includes('api   '));
    console.log('PASS distribution boundary: excluded modules, isolated roots/shims, official auth/env/cache, local usage, forged setting, IPC and CLI rejection');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
