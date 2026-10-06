'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// Keep the initially absent default home stable when macOS TMPDIR is an alias.
// Explicit profile-symlink retargeting is exercised separately below.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-launch-')));
process.env.CLI_ACCOUNTS_ROOT = root;
process.env.HOME = path.join(root, 'user-home');
fs.mkdirSync(process.env.HOME);
const P = require('../src/paths');
const store = require('../src/store');
const { resolveProfile, validateBinding, launchEnv } = require('../src/launch/profile-resolver');
try {
  const probe = path.join(root, 'probe');
  fs.writeFileSync(probe, `#!${process.execPath}\nconsole.log(JSON.stringify({argv:process.argv.slice(2),home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY,other:process.env.CLAUDE_CONFIG_DIR}));\n`, { mode: 0o755 });
  store.addProfile('codex', 'work', { shareSettings: false });
  const state = store.load(); state.realBin.codex = probe; state.realBin.claude = probe; store.save(state);
  const defaultBinding = resolveProfile('codex');
  assert.equal(defaultBinding.home, P.DEFAULT_HOME.codex);
  const env = launchEnv(defaultBinding, { CODEX_HOME: '/wrong', CLAUDE_CONFIG_DIR: '/wrong', CODEX_PROFILE: 'work', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', PATH: process.env.PATH });
  assert.equal(env.CODEX_HOME, P.DEFAULT_HOME.codex); assert.equal(env.CLAUDE_CONFIG_DIR, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const claudeDefault = resolveProfile('claude', 'default');
  const claudeEnv = launchEnv(claudeDefault, { HOME: '/wrong', CLAUDE_CONFIG_DIR: '/wrong', CODEX_HOME: '/wrong', CLAUDE_CODE_OAUTH_TOKEN: 'secret' });
  assert.equal(claudeEnv.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(claudeEnv.HOME, P.HOME);
  assert.equal(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.throws(() => validateBinding(claudeDefault), /Missing bound profile home/);
  fs.mkdirSync(P.DEFAULT_HOME.claude);
  assert.deepEqual(validateBinding(claudeDefault), claudeDefault);
  // Same lexical profile path but a different symlink target is not the same account.
  store.addProfile('codex', 'linked', { shareSettings: false });
  const linkedHome = store.profileHome('codex', 'linked');
  fs.rmdirSync(linkedHome);
  const targetA = path.join(root, 'target-a'), targetB = path.join(root, 'target-b');
  fs.mkdirSync(targetA); fs.mkdirSync(targetB); fs.symlinkSync(targetA, linkedHome);
  const linked = resolveProfile('codex', 'linked'); assert.equal(linked.home, fs.realpathSync(targetA));
  fs.unlinkSync(linkedHome); fs.symlinkSync(targetB, linkedHome);
  assert.throws(() => validateBinding(linked), /binding changed/);
  const fixed = resolveProfile('codex', 'work');
  store.setActive('codex', 'work'); assert.equal(resolveProfile('codex').profileId, 'work');
  store.setActive('codex', 'default'); assert.deepEqual(validateBinding(fixed), fixed);
  assert.throws(() => resolveProfile('codex', '../escape'));
  assert.throws(() => resolveProfile('unknown'));
  assert.throws(() => resolveProfile('codex', 'work', { executable: '/missing' }));
  assert.throws(() => validateBinding({ ...fixed, home: '/wrong' }));
  fs.mkdirSync(P.BIN_DIR, { recursive: true });
  const shim = path.join(P.BIN_DIR, 'codex'); fs.writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  assert.throws(() => resolveProfile('codex', 'work', { executable: shim }));
  const alias = path.join(root, 'alias'); fs.symlinkSync(shim, alias);
  assert.throws(() => resolveProfile('codex', 'work', { executable: alias }));
  const args = ['$(touch nope)', 'a b', '; echo bad', '"quoted"'];
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../src/launch/run.js'), 'shim', 'codex', ...args], { encoding: 'utf8', env: { ...process.env, CODEX_PROFILE: 'work', CODEX_HOME: '/wrong', OPENAI_API_KEY: 'secret' } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout); assert.deepEqual(output.argv, args); assert.equal(output.home, fixed.home); assert.equal(output.key, undefined);
  // Installed CLI is self-contained; installation remains confined to the temporary root.
  require('../src/wrappers').installShims();
  const installedState = store.load(); installedState.realBin.codex = probe; store.save(installedState);
  for (const cli of [path.resolve(__dirname, '../src/cli.js'), path.join(P.LIB_DIR, 'cli.js')]) {
    const cliResult = spawnSync(process.execPath, [cli, 'run', 'codex', '--profile', 'work', '--', ...args], { encoding: 'utf8', env: process.env });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(cliResult.stdout).argv, args);
    const bad = spawnSync(process.execPath, [cli, 'run', 'codex', '--profile', '--'], { encoding: 'utf8', env: process.env });
    assert.notEqual(bad.status, 0);
  }
  const signalProbe = path.join(root, 'signal-probe');
  fs.writeFileSync(signalProbe, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`, { mode: 0o755 });
  installedState.realBin.codex = signalProbe; store.save(installedState);
  const signaled = spawnSync(process.execPath, [path.resolve(__dirname, '../src/cli.js'), 'run', 'codex', '--'], { env: process.env });
  assert.equal(signaled.signal, 'SIGTERM');
  installedState.realBin.codex = probe; store.save(installedState);
  fs.rmdirSync(fixed.home); assert.throws(() => validateBinding(fixed));
  console.log('profile launch: all checks passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
