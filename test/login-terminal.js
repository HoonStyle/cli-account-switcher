'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/terminal.js'), 'utf8');
function fixture(platform, packaged, exists = true) {
  const win = platform === 'win32', paths = win ? path.win32 : path.posix;
  const root = win ? 'C:\\accounts' : '/tmp/accounts';
  const dir = win ? `C:\\App\\resources\\${packaged ? 'app.asar\\' : ''}src` : `/Applications/App.app/Contents/Resources/${packaged ? 'app.asar/' : ''}src`;
  const lib = paths.join(root, 'bin', 'lib');
  const calls = [];
  const context = { __dirname: dir, module: { exports: {} }, process: { platform }, require(id) {
    return { path: paths, fs: { existsSync: () => exists }, child_process: { spawn: (...args) => { calls.push(args); return { unref() {} }; } },
      './paths': { TOOLS: ['codex'], IS_WIN: win, ROOT: root, LIB_DIR: lib },
      './store': { load: () => ({ codex: { profiles: ['fixture'] } }), profileHome: () => '/fixture-home' },
      './launch/profile-resolver': { resolveProfile: (tool, profile) => { assert.equal(profile, 'fixture'); return {}; }, launchEnv: () => ({}) },
    }[id];
  } };
  vm.runInNewContext(source, context);
  const run = () => context.module.exports.openLoginTerminal('codex', '/fixture-home', false);
  if (!exists) { assert.throws(run, /Login runtime missing/); assert.equal(calls.length, 0); return; }
  run(); assert.equal(calls.length, 1);
  const command = calls[0][1].join(' ');
  assert(!command.includes('app.asar'), 'external Node must never execute a virtual ASAR path');
  assert(command.includes(paths.join(packaged ? lib : dir, 'launch', 'run.js')));
  assert(command.includes('fixture'), 'the selected account must stay pinned');
}
for (const platform of ['darwin', 'linux', 'win32']) {
  fixture(platform, true); fixture(platform, false); fixture(platform, true, false);
}
console.log('PASS: packaged/development login paths and missing-runtime failures on macOS/Linux/Windows');
