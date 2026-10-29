'use strict';
const path = require('path');
const fs = require('fs');
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
  // System Node cannot read Electron ASAR archives. Use the runtime extracted
  // by installShims at app startup; never redirect a login to another profile.
  const packaged = /(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/.test(__dirname);
  const runner = path.join(packaged ? P.LIB_DIR : __dirname, 'launch', 'run.js');
  if (!fs.existsSync(runner)) throw new Error('Login runtime missing. Reinstall CLI wrappers and retry.');
  if (P.IS_WIN) {
    // cmd metacharacters in filesystem paths cannot be forwarded safely through start.
    if (/["% !&|<>^\r\n]/.test(id) || /["%!&|<>^\r\n]/.test(runner)) throw new Error('Use CLI login for this Windows profile path');
    // These arguments are cmd syntax, not CRT argv. Node's default Windows quoting
    // turns the nested quotes into literal backslash-quotes in the runner path.
    // Keep the validated command verbatim, give START an explicit empty title,
    // and disable cmd AutoRun in both shells. START supplies the interactive console.
    const command = `start "" cmd.exe /d /k node "${runner}" login ${tool} "${id}"`;
    spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      env: { ...env, CLI_ACCOUNTS_ROOT: P.ROOT }, windowsVerbatimArguments: true,
      detached: true, stdio: 'ignore', windowsHide: false,
    }).unref();
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
