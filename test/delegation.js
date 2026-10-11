'use strict';
// No real accounts, credentials, model requests, or running services are used.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-')));
process.env.CLI_ACCOUNTS_ROOT = root;
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
const P = require('../src/paths');
const store = require('../src/store');
try {
  const probe = path.join(root, 'probe');
  fs.writeFileSync(probe, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,home:process.env.HOME,key:process.env.OPENAI_API_KEY,token:process.env.CLAUDE_CODE_OAUTH_TOKEN}));process.exitCode=Number(process.argv[2])||0;\n`, { mode: 0o755 });
  for (const tool of P.TOOLS) store.addProfile(tool, 'worker', { shareSettings: false });
  require('../src/wrappers').installShims();
  const state = store.load();
  for (const tool of P.TOOLS) state.realBin[tool] = probe;
  store.save(state);
  const before = fs.readFileSync(P.STATE_FILE, 'utf8');
  const active = P.TOOLS.map(t => fs.readFileSync(path.join(P.ACTIVE_DIR, t), 'utf8'));
  let checks = 0;
  for (const cli of [path.resolve(__dirname, '../src/cli.js'), path.join(P.LIB_DIR, 'cli.js')]) {
    const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '/wrong', CLAUDE_CONFIG_DIR: '/wrong', CODEX_PROFILE: 'wrong', CLAUDE_PROFILE: 'wrong', OPENAI_API_KEY: 'not-a-real-key', CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token' } });
    const listing = run(['list', '--json']);
    assert.equal(listing.status, 0, listing.stderr);
    const route = JSON.parse(listing.stdout);
    assert.equal(route.installation.dataRoot, root);
    assert.equal(route.execution.fallbackToActive, false);
    assert.equal(route.accounts.length, 4);
    for (const tool of P.TOOLS) {
      for (const profile of ['worker', 'default']) {
        const args = ['0', 'a b', '$(not-executed)', '--model', 'requested-model'];
        const result = run(['delegate', tool, '--profile', profile, '--', ...args]);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.args, args);
        assert.equal(output.key, undefined); assert.equal(output.token, undefined);
        assert.equal(output[tool], tool === 'claude' && profile === 'default' ? undefined : store.profileHome(tool, profile));
        assert.equal(output[tool === 'claude' ? 'codex' : 'claude'], undefined);
        if (tool === 'claude' && profile === 'default') assert.equal(output.home, P.HOME);
        checks++;
      }
      for (const options of [[], ['--profile'], ['--profile', 'missing'], ['--profile', '../escape']]) {
        const rejected = run(['delegate', tool, ...options, '--', '0']);
        assert.notEqual(rejected.status, 0); assert.equal(rejected.stdout, ''); checks++;
      }
      const failed = run(['delegate', tool, '--profile', 'worker', '--', '17']);
      assert.equal(failed.status, 17); // Failure is returned, never retried on active account.
      assert.equal(failed.stdout.trim().split('\n').length, 1); checks++;
    }
  }
  assert.equal(fs.readFileSync(P.STATE_FILE, 'utf8'), before);
  assert.deepEqual(P.TOOLS.map(t => fs.readFileSync(path.join(P.ACTIVE_DIR, t), 'utf8')), active);
  console.log(`delegation: ${checks} source/installed Claude/Codex launch cases passed; state and active accounts unchanged`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
