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

function execute(binding, argv, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binding.executable, argv, { env: launchEnv(binding), cwd, stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], shell: false });
    if (input !== undefined) { child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); }); child.stdin.end(input); }
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

async function runCommand(args, { requireProfile = false } = {}) {
  const [tool, ...rest] = args;
  let profile, contextFile;
  let offset = 0;
  while (rest[offset] === '--profile' || rest[offset] === '--context') {
    const flag = rest[offset++], value = rest[offset++];
    if (!value || value === '--') throw new Error(`${flag} requires a value`);
    if (flag === '--profile') { if (profile) throw Error('Duplicate --profile'); profile = value; }
    else { if (contextFile) throw Error('Duplicate --context'); contextFile = value; }
  }
  if (requireProfile && !profile) throw new Error('Delegation requires --profile <id>; inspect cli-accounts list --json in the intended installation. Never use/switch the active account or substitute another profile.');
  if (rest[offset] !== '--') throw new Error('Usage: run <tool> [--profile id] -- <literal args>');
  const binding = resolveProfile(tool, profile), literal = rest.slice(offset + 1);
  if (!contextFile) return execute(binding, literal);
  if (!profile) throw Error('--context requires an explicit --profile');
  if (tool === 'codex' ? literal[0] !== 'exec' : !literal.includes('-p') && !literal.includes('--print')) throw Error('--context requires a noninteractive Codex exec or Claude --print invocation');
  const payload = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  if (typeof payload.goal !== 'string' || !payload.goal.trim() || payload.goal.length > 10000 || !path.isAbsolute(payload.projectPath || '')) throw Error('Context file requires goal and absolute projectPath');
  const { captureContext, materializeContext, contextPrompt, contextReceipt } = require('../runtime/context');
  const id = require('crypto').randomUUID(), dir = path.join(P.ROOT, 'runtime', 'direct-context', id);
  const receipt = captureContext({ context: payload.context, binding, projectPath: payload.projectPath, destination: path.join(dir, 'snapshot.json') });
  const contextDir = materializeContext(receipt, path.join(dir, 'files'));
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ id, ...contextReceipt(receipt) }), { mode: 0o600 });
  // stdin is the native CLI prompt transport. Preserve piped task text too.
  let piped = ''; process.stdin.setEncoding('utf8');
  if (!process.stdin.isTTY) for await (const data of process.stdin) { piped += data; if (Buffer.byteLength(piped) > 1024 * 1024) throw Error('Piped prompt exceeds 1 MiB'); }
  const input = `Goal: ${payload.goal}\n${contextPrompt(receipt, contextDir)}\n${piped}`;
  console.error(`Context receipt: ${path.join(dir, 'receipt.json')} (explicit-snapshot; not a managed task ID)`);
  if (tool === 'claude') literal.push('--add-dir', contextDir);
  return execute(binding, literal, { input, cwd: payload.projectPath });
}
if (require.main === module) {
  Promise.resolve().then(() => main(process.argv.slice(2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { main, runCommand };
