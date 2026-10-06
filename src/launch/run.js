'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../paths');
const { resolveProfile, launchEnv } = require('./profile-resolver');
function main(args) {
  let [mode, tool, ...argv] = args;
  let profile;
  let options = {};
  if (mode === 'shim') {
    profile = process.env[`${tool.toUpperCase()}_PROFILE`];
    if (!profile) { try { profile = fs.readFileSync(path.join(P.ACTIVE_DIR, tool), 'utf8').trim(); } catch {} }
    try { options.executable = fs.readFileSync(path.join(P.ACTIVE_DIR, `${tool}.real`), 'utf8').trim() || undefined; } catch {}
  } else if (mode === 'login') { profile = argv.shift(); argv = tool === 'codex' ? ['login'] : ['auth', 'login']; }
  else throw new Error('Unknown launch mode');
  const binding = resolveProfile(tool, profile, options);
  return execute(binding, argv);
}

function execute(binding, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(binding.executable, argv, { env: launchEnv(binding), stdio: 'inherit', shell: false });
    const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
    child.once('error', e => { cleanup(); reject(e); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (signal) {
        // Re-raise after removing forwarders so callers observe the original signal.
        process.kill(process.pid, signal);
      } else process.exitCode = code == null ? 1 : code;
      resolve({ code, signal });
    });
  });
}

async function runCommand(args) {
  const [tool, ...rest] = args;
  let profile;
  let offset = 0;
  if (rest[0] === '--profile') {
    if (!rest[1] || rest[1] === '--') throw new Error('--profile requires an account ID');
    profile = rest[1]; offset = 2;
  }
  if (rest[offset] !== '--') throw new Error('Usage: run <tool> [--profile id] -- <literal args>');
  return execute(resolveProfile(tool, profile), rest.slice(offset + 1));
}
if (require.main === module) {
  Promise.resolve().then(() => main(process.argv.slice(2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { main, runCommand };
