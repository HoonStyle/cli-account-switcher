'use strict';
// No real account data: isolated CRUD, shims and console CLI smoke test.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-accounts-smoke-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
const P = require('../src/paths'), store = require('../src/store'), wrappers = require('../src/wrappers');
try {
  const r = store.addProfile('claude', 'work', { shareSettings: false });
  assert(fs.existsSync(r.home));
  assert.throws(() => store.addProfile('claude', 'work'));
  assert.throws(() => store.addProfile('codex', 'bad name!'));
  store.addProfile('codex', 'personal', { shareSettings: false });
  store.setActive('claude', 'work');
  assert.equal(store.load().claude.active, 'work');
  assert.equal(store.load().codex.active, 'default');
  const inst = wrappers.installShims();
  assert(fs.existsSync(path.join(inst.binDir, P.IS_WIN ? 'claude.cmd' : 'claude')));
  const s = store.load(); s.realBin = { claude: process.execPath, codex: process.execPath }; store.save(s);
  assert.equal(require('../src/claude').inspect(r.home).loggedIn, false);
  assert.equal(require('../src/codex').inspect(store.profileHome('codex', 'personal')).loggedIn, false);
  assert.equal(fs.readFileSync(path.join(P.ACTIVE_DIR, 'claude'), 'utf8').trim(), 'work');
  const cli = (...a) => execFileSync(process.execPath, [path.join(P.LIB_DIR, 'cli.js'), ...a], { encoding: 'utf8', env: process.env });
  assert(/\* work/.test(cli('list', 'claude')));
  cli('use', 'codex', 'personal'); assert.equal(store.load().codex.active, 'personal');
  assert(/기록 없음/.test(cli('usage', 'codex', 'default')));
  assert(/login claude/.test(cli('login', 'claude', 'work')));
  if (!P.IS_WIN) {
    const probe = path.join(tmp, 'probe.sh');
    fs.writeFileSync(probe, '#!/bin/sh\necho "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"\n', { mode: 0o755 });
    s.realBin.claude = probe; store.save(s);
    const out = execFileSync('/bin/sh', [path.join(P.BIN_DIR, 'claude')], { encoding: 'utf8', env: process.env });
    // Pinned launch canonicalizes profile homes; macOS /tmp and /var are aliases.
    assert.equal(out.trim(), `CLAUDE_CONFIG_DIR=${fs.realpathSync(r.home)}`);
  }
  store.rename('claude', 'work', 'Work account');
  assert.equal(store.resolve('claude', 'Work account'), 'work');
  store.removeProfile('claude', 'work', { deleteFiles: true });
  assert(!fs.existsSync(r.home)); assert.equal(store.load().claude.active, 'default');
  console.log('PASS isolated CRUD, rename, shim installation/launch, CLI usage/login');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
