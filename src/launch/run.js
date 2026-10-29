'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const processGroup = require('./process-group');
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
    // Interactive/login terminals keep their foreground process group. Only
    // bounded noninteractive work owns a group that can be stopped as a unit.
    const ownedGroup = process.platform !== 'win32' && (binding.tool === 'codex' ? argv[0] === 'exec' : argv.includes('-p') || argv.includes('--print'));
    const parentPid = process.ppid;
    const child = spawn(binding.executable, argv, { env: launchEnv(binding), cwd, stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], shell: false, detached: ownedGroup });
    let forwardedSignal, killTimer, parentWatch;
    const groupAlive = () => { if (!ownedGroup || !child.pid) return false; return processGroup.groupAlive(child.pid); };
    const signalChild = signal => { if (!child.pid) return; try { ownedGroup ? processGroup.signalGroup(child.pid, signal) : child.kill(signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const requestStop = signal => {
      forwardedSignal ||= signal;
      signalChild(signal);
      if (ownedGroup && !killTimer) killTimer = setTimeout(() => signalChild('SIGKILL'), 5000);
    };
    if (input !== undefined) { child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); }); child.stdin.end(input); }
    const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => requestStop(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    // A foreground direct delegation has no durable service to own it after
    // its launcher disappears. Managed tasks use their separate runner instead.
    if (ownedGroup) { parentWatch = setInterval(() => { if (process.ppid !== parentPid && !forwardedSignal) requestStop('SIGTERM'); }, 250); parentWatch.unref(); }
    const cleanup = () => { clearTimeout(killTimer); clearInterval(parentWatch); for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
    child.once('error', e => { cleanup(); reject(e); });
    child.once('exit', async (code, signal) => {
      let orphaned = false;
      const sleep = ms => new Promise(done => setTimeout(done, ms));
      try {
        const drainUntil = Date.now() + 1000;
        while (groupAlive() && !forwardedSignal && Date.now() < drainUntil) await sleep(50);
        if (groupAlive()) {
          orphaned = !forwardedSignal;
          signalChild('SIGTERM');
          const stopAt = Date.now();
          while (groupAlive() && Date.now() - stopAt < 10000) {
            if (Date.now() - stopAt >= 5000) signalChild('SIGKILL');
            await sleep(50);
          }
          if (groupAlive()) throw Error('Delegated process termination remains unconfirmed');
        }
        cleanup();
        if (orphaned) console.error('Delegated CLI exited with live descendants; remaining task processes were terminated.');
        const finalSignal = forwardedSignal || signal;
        if (finalSignal) {
          // Re-raise only after owned descendants have stopped.
          // Keep the event loop alive until the signal is delivered; otherwise
          // Node can drain this async exit handler and report code 0 first.
          setTimeout(() => process.exit(128 + require('os').constants.signals[finalSignal]), 1000);
          process.kill(process.pid, finalSignal);
        } else process.exitCode = code == null ? 1 : (code || (orphaned ? 1 : 0));
        resolve({ code: process.exitCode ?? code, signal: finalSignal });
      } catch (error) { cleanup(); reject(error); }
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
