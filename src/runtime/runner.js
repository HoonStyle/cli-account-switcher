'use strict';
// Durable per-attempt runner. It outlives the service; never runs an attempt twice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launchEnv, validateBinding } = require('../launch/profile-resolver');
const { parseOutput } = require('../adapters/cli');
const { STDOUT_LIMIT, STDERR_LIMIT } = require('./output');
const dir = process.argv[2];
function save(name, value) {
  const file = path.join(dir, name), tmp = file + `.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const directory = fs.openSync(dir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch {}
}
(async () => {
  let child, timer, cancelled = false, cancelAt = 0, outputOverflow = false;
  const claim = path.join(dir, 'claimed');
  try { fs.closeSync(fs.openSync(claim, 'wx', 0o600)); } catch { process.exitCode = 2; return; }
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  const resultBase = { attemptId: spec.attemptId, token: spec.token };
  try {
    if (fs.existsSync(path.join(dir, 'cancel.request'))) { save('result.json', { ...resultBase, state: 'cancelled', reason: 'cancelled_before_spawn' }); return; }
    validateBinding(spec.binding);
    const env = launchEnv(spec.binding);
    delete env.ELECTRON_RUN_AS_NODE;
    // Do not leak service internals or delegate mutation authority through environment.
    delete env.CLI_ACCOUNTS_SOCKET;
    child = spawn(spec.invocation.executable, spec.invocation.args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const heartbeat = () => {
      save('live.json', { ...resultBase, runnerPid: process.pid, childPid: child.pid, at: Date.now(), lastOutputAt, lastProgressAt });
      save('terminal.json', { ...resultBase, at: lastOutputAt, stdout: stdout.slice(-STDOUT_LIMIT), stderr: stderr.slice(-STDERR_LIMIT), truncated: stdout.length > STDOUT_LIMIT || stderr.length > STDERR_LIMIT });
    };
    let lastOutputAt = null, lastProgressAt = null, stdout = '', stderr = '', eventBuffer = '';
    const stop = () => { if (child.pid) { try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); } catch {} } };
    timer = setInterval(() => {
      heartbeat();
      if (!cancelled && fs.existsSync(path.join(dir, 'cancel.request'))) { cancelled = true; cancelAt = Date.now(); stop(); }
      if (cancelled && Date.now() - cancelAt > 5000) {
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }, 1000);
    heartbeat();
    const capture = (isErr, data) => {
      lastOutputAt = Date.now();
      if (!isErr && spec.binding.tool === 'codex') {
        eventBuffer += data.toString(); const lines = eventBuffer.split('\n'); eventBuffer = lines.pop();
        for (const line of lines) { try { const event = JSON.parse(line); if (['item.completed', 'turn.completed'].includes(event.type)) lastProgressAt = Date.now(); } catch {} }
      }
      if (isErr) stderr = (stderr + data.toString()).slice(-131072);
      else if (spec.binding.tool === 'claude' && spec.invocation.args.includes('stream-json')) stdout = (stdout + data.toString()).slice(-4 * 1024 * 1024);
      else if (stdout.length + data.length > 4 * 1024 * 1024) { outputOverflow = true; stop(); }
      else stdout += data.toString();
    };
    child.stdout.on('data', d => capture(false, d)); child.stderr.on('data', d => capture(true, d));
    child.stdin.on('error', () => {});
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    child.stdin.end(spec.prompt);
    const exit = await ended;
    heartbeat(); // Preserve final activity even for executions shorter than 1s.
    // Do not release an account/worktree while descendants in our process group remain.
    const groupAlive = () => { if (process.platform === 'win32' || !child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    while (groupAlive()) {
      if (cancelled) {
        if (Date.now() - cancelAt > 5000) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        else stop();
      }
      await new Promise(r => setTimeout(r, 200));
    }
    fs.writeFileSync(path.join(dir, 'stdout.log'), stdout, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'stderr.log'), stderr, { mode: 0o600 });
    if (cancelled) save('result.json', { ...resultBase, state: 'cancelled', exit });
    else if (exit.code !== 0 || outputOverflow) save('result.json', { ...resultBase, state: 'failed', exit, reason: outputOverflow ? 'output_limit' : 'cli_exit' });
    else {
      const parsed = parseOutput(spec.binding.tool, stdout, spec.invocation);
      if (!parsed.sessionId) throw new Error('Missing CLI session receipt');
      if (JSON.stringify(parsed.result).length > 200000) throw new Error('Structured result exceeds 200KB limit');
      if (spec.invocation.expectedSession && parsed.sessionId !== spec.invocation.expectedSession) throw new Error('Session receipt mismatch');
      save('result.json', { ...resultBase, state: 'succeeded', exit, ...parsed });
    }
  } catch (e) { save('result.json', { ...resultBase, state: 'failed', reason: e.message }); }
  finally { clearInterval(timer); }
})().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
