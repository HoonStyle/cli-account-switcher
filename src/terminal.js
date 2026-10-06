'use strict';
const path = require('path');
const { spawn } = require('child_process');
const P = require('./paths');
const store = require('./store');
const { resolveProfile, launchEnv } = require('./launch/profile-resolver');
function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function openLoginTerminal(tool, home, isDefault) {
  if (!P.TOOLS.includes(tool)) throw new Error('Unsupported login tool');
  const state = store.load();
  const id = isDefault ? 'default' : state[tool].profiles.find(p => store.profileHome(tool, p) === home);
  if (!id || store.profileHome(tool, id) !== home) throw new Error('Unknown login profile home');
  const binding = resolveProfile(tool, id);
  const env = launchEnv(binding);
  // Pass only a validated profile ID through the terminal; the runner resolves the real
  // executable directly, so an active-account shim can never redirect a login.
  const runner = path.join(__dirname, 'launch', 'run.js');
  if (P.IS_WIN) {
    // cmd metacharacters in filesystem paths cannot be forwarded safely through start.
    if (/["% !&|<>^\r\n]/.test(id) || /["%!&|<>^\r\n]/.test(runner)) throw new Error('Use CLI login for this Windows profile path');
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `node "${runner}" login ${tool} "${id}"`], { env, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else {
    const line = ['node', runner, 'login', tool, id].map(shellQuote).join(' ');
    // Terminal.app does not inherit this process's environment. Pin the root explicitly.
    const command = `CLI_ACCOUNTS_ROOT=${shellQuote(P.ROOT)} ${line}`;
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
      spawn('osascript', ['-e', script], { env, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', 'sh', '-c', command], { env, detached: true, stdio: 'ignore' }).unref();
    }
  }
}
module.exports = { openLoginTerminal };
