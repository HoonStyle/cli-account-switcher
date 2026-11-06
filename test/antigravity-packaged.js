'use strict';
// ELECTRON_RUN_AS_NODE=1 <built app binary> this-file <app.asar>
// Never invoke the app normally with a script argument: that launches production main.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-packaged-'));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.CLI_ACCOUNTS_ROOT = path.join(root, 'accounts');
process.env.SHELL = '/bin/sh';
delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR;
const archive = path.resolve(process.argv[2]);
try {
  const pkg = require(path.join(archive, 'package.json'));
  assert.equal(pkg.dependencies['@napi-rs/keyring'], '2.1.2');
  assert.equal(typeof require(path.join(archive, 'node_modules/@napi-rs/keyring')).AsyncEntry, 'function');
  for (const cpu of ['arm64', 'x64']) {
    const binary = path.join(archive + '.unpacked', 'node_modules/@napi-rs/keyring-darwin-' + cpu, 'keyring.darwin-' + cpu + '.node');
    execFileSync('/usr/bin/lipo', ['-verify_arch', cpu === 'x64' ? 'x86_64' : 'arm64', binary]);
  }
  require(path.join(archive, 'src/wrappers')).installShims();
  const lib = path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/lib');
  assert.equal(typeof require(path.join(lib, 'node_modules/@napi-rs/keyring')).AsyncEntry, 'function');
  const listed = JSON.parse(execFileSync(process.execPath, [path.join(lib, 'cli.js'), 'antigravity', 'list', '--json'], { env: process.env, encoding: 'utf8' }));
  assert.deepEqual(listed.accounts, []); assert.equal(listed.current, null);
  assert(!fs.existsSync(path.join(process.env.CLI_ACCOUNTS_ROOT, 'bin/agy')), 'no shared-login PATH hijack');
  console.log('PASS universal ASAR: both CPU bindings, ARM native load, extracted standalone CLI with dependencies; no real credential access');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
