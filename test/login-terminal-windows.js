'use strict';
// Executes the production terminal launcher against Windows' real CMD/START/Node
// parsers. A fixture runner records argv then exits; no real login is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP: native Windows terminal regression'); process.exit(0); }
const sourcePath = process.argv[2] || path.join(__dirname, '../src/terminal.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-login-'));
const root = path.join(dir, '계정 폴더');
const lib = path.join(root, 'bin', 'lib');
const runner = path.join(lib, 'launch', 'run.js');
fs.mkdirSync(path.dirname(runner), { recursive: true });
fs.writeFileSync(runner, `const fs = require('node:fs');
fs.writeFileSync(process.env.SWITCHER_LOGIN_RECEIPT, JSON.stringify({
  argv: process.argv.slice(1), parentPid: process.ppid,
  root: process.env.CLI_ACCOUNTS_ROOT,
  stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY)
})); process.exit(0);`);
async function check(tool, profile) {
  const receipt = path.join(dir, tool + '-' + profile + '.json');
  const profileHome = path.join(root, tool, profile);
  const env = { ...process.env, SWITCHER_LOGIN_RECEIPT: receipt };
  delete env.NODE_OPTIONS;
  delete env.CLI_ACCOUNTS_ROOT;
  let child, spawnError, observed;
  const context = { __dirname: 'C:\\Program Files\\Fixture\\resources\\app.asar\\src',
    module: { exports: {} }, process, require(id) {
      return { path, fs, child_process: { spawn(...args) {
        child = cp.spawn(...args); child.once('error', e => { spawnError = e; });
        return child;
      } }, './paths': { TOOLS: ['claude', 'codex'], IS_WIN: true, ROOT: root, LIB_DIR: lib },
      './store': { load: () => ({ [tool]: { profiles: [profile] } }), profileHome: () => profileHome },
      './launch/profile-resolver': { resolveProfile: (t, id) => {
        assert.equal(t, tool); assert.equal(id, profile); return {};
      }, launchEnv: () => env } }[id];
    } };
  vm.runInNewContext(source, context);
  try {
    context.module.exports.openLoginTerminal(tool, profileHome, profile === 'default');
    const until = Date.now() + 8000;
    while (!fs.existsSync(receipt) && !spawnError && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    if (spawnError) throw spawnError;
    assert(fs.existsSync(receipt), `Node did not start through the login terminal (outer exit=${child?.exitCode})`);
    observed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.deepEqual(observed.argv, [runner, 'login', tool, profile], 'CMD must preserve the selected runner and profile exactly');
    assert.equal(observed.root, root, 'custom installation root must remain pinned');
    assert.equal(observed.stdinIsTTY, true, 'login needs interactive terminal input');
    assert.equal(observed.stdoutIsTTY, true, 'login needs interactive terminal output');
    console.log(`PASS: ${tool}/${profile} — real CMD quoting, Unicode/spaces, pinned root, interactive console`);
  } finally {
    // Only close consoles identified by this uniquely generated fixture path.
    if (observed?.parentPid) cp.spawnSync('taskkill.exe', ['/PID', String(observed.parentPid), '/F'], { windowsHide: true, stdio: 'ignore' });
    else {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    }
    if (child && child.exitCode === null) child.kill();
  }
}
(async () => {
  for (const tool of ['claude', 'codex']) for (const profile of ['default', 'fixture']) await check(tool, profile);
})().catch(e => { console.error(e); process.exitCode = 1; });
