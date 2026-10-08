'use strict';
// Durable per-attempt runner. It outlives the service; never runs an attempt twice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launchEnv, validateBinding } = require('../launch/profile-resolver');
const { parseOutput } = require('../adapters/cli');
const { executionEnv } = require('./execution-policy');
const { STDOUT_LIMIT, STDERR_LIMIT, utf8Tail } = require('./output');
const CAPTURE_LIMIT = 4 * 1024 * 1024, STDERR_CAPTURE_LIMIT = 131072;
const dir = process.argv[2];
function save(name, value) {
  const file = path.join(dir, name), tmp = file + `.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const directory = fs.openSync(dir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch {}
}
(async () => {
  let child, timer, exitReceipt, processStarted = false, phase = 'preflight', cancelled = false, cancelAt = 0, outputOverflow = false, outputDecodeError = false, abortAt = 0;
  const claim = path.join(dir, 'claimed');
  try { fs.closeSync(fs.openSync(claim, 'wx', 0o600)); } catch { process.exitCode = 2; return; }
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  const resultBase = { attemptId: spec.attemptId, token: spec.token };
  try {
    if (fs.existsSync(path.join(dir, 'cancel.request'))) { save('result.json', { ...resultBase, state: 'cancelled', reason: 'cancelled_before_spawn' }); return; }
    validateBinding(spec.binding);
    const env = executionEnv(spec.invocation, launchEnv(spec.binding));
    delete env.ELECTRON_RUN_AS_NODE;
    // Do not leak service internals or delegate mutation authority through environment.
    delete env.CLI_ACCOUNTS_SOCKET;
    require('./research-policy').validateResearchInvocation(spec.binding, spec.invocation);
    child = spawn(spec.invocation.executable, spec.invocation.args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.once('spawn', () => { processStarted = true; phase = 'execution'; });
    const heartbeat = () => {
      save('live.json', { ...resultBase, runnerPid: process.pid, childPid: child.pid, at: Date.now(), lastOutputAt, lastProgressAt });
      save('terminal.json', { ...resultBase, at: lastOutputAt, stdout: utf8Tail(stdout, STDOUT_LIMIT), stderr: utf8Tail(stderr, STDERR_LIMIT), truncated: stdoutBytes > STDOUT_LIMIT || stderrBytes > STDERR_LIMIT });
    };
    let lastOutputAt = null, lastProgressAt = null, stdout = '', stderr = '', eventBuffer = '', stdoutBytes = 0, stderrBytes = 0;
    const stop = () => { if (child.pid) { try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); } catch {} } };
    const abortOutput = () => { abortAt ||= Date.now(); stop(); };
    timer = setInterval(() => {
      heartbeat();
      if (!cancelled && fs.existsSync(path.join(dir, 'cancel.request'))) { cancelled = true; cancelAt = Date.now(); stop(); }
      if ((cancelled || abortAt) && Date.now() - (cancelAt || abortAt) > 5000) {
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }, 1000);
    heartbeat();
    const capture = (isErr, data) => {
      lastOutputAt = Date.now();
      const bytes = Buffer.byteLength(data, 'utf8');
      if (isErr) { stderrBytes += bytes; stderr = utf8Tail(stderr + data, STDERR_CAPTURE_LIMIT); return; }
      stdoutBytes += bytes;
      if (spec.binding.tool === 'claude' && spec.invocation.args.includes('stream-json')) stdout = utf8Tail(stdout + data, CAPTURE_LIMIT);
      else if (stdoutBytes > CAPTURE_LIMIT) { outputOverflow = true; abortOutput(); return; }
      else stdout += data;
      if (!isErr && spec.binding.tool === 'codex') {
        eventBuffer += data; const lines = eventBuffer.split('\n'); eventBuffer = lines.pop();
        for (const line of lines) { try { const event = JSON.parse(line); if (['item.completed', 'turn.completed'].includes(event.type)) lastProgressAt = Date.now(); } catch {} }
      }
    };
    // Stdout carries authoritative structured results. Preserve split code
    // points, but never repair malformed bytes into a different success result.
    // Stderr is diagnostic only and may use replacement characters for display.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const decode = data => {
      if (outputDecodeError) return;
      let text;
      try { text = data === undefined ? decoder.decode() : decoder.decode(data, { stream: true }); }
      catch { outputDecodeError = true; abortOutput(); return; }
      if (text) capture(false, text);
    };
    child.stdout.on('data', data => { lastOutputAt = Date.now(); decode(data); });
    child.stdout.on('end', () => decode()); // EOF flush must precede child close.
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => capture(true, data));
    child.stdin.on('error', () => {});
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    child.stdin.end(spec.prompt);
    const exit = await ended;
    exitReceipt = exit;
    heartbeat(); // Preserve final activity even for executions shorter than 1s.
    // Do not release an account/worktree while descendants in our process group remain.
    const groupAlive = () => { if (process.platform === 'win32' || !child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    while (groupAlive()) {
      if (cancelled || abortAt) {
        if (Date.now() - (cancelAt || abortAt) > 5000) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        else stop();
      }
      await new Promise(r => setTimeout(r, 200));
    }
    fs.writeFileSync(path.join(dir, 'stdout.log'), stdout, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'stderr.log'), stderr, { mode: 0o600 });
    if (cancelled) save('result.json', { ...resultBase, state: 'cancelled', exit });
    else if (exit.code !== 0 || outputOverflow || outputDecodeError) save('result.json', { ...resultBase, state: 'failed', failurePhase: 'execution', processStarted, exit, reason: outputDecodeError ? 'invalid_stdout_utf8' : outputOverflow ? 'output_limit' : 'cli_exit' });
    else {
      phase = 'parse';
      const parsed = parseOutput(spec.binding.tool, stdout, spec.invocation);
      if (!parsed.sessionId) throw new Error('Missing CLI session receipt');
      if (JSON.stringify(parsed.result).length > 200000) throw new Error('Structured result JSON exceeds 200000 UTF-16 code units');
      if (spec.invocation.expectedSession && parsed.sessionId !== spec.invocation.expectedSession) throw new Error('Session receipt mismatch');
      save('result.json', { ...resultBase, state: 'succeeded', processStarted, exit, ...parsed });
    }
  } catch (e) {
    // A PID is already evidence of a launch even if an immediate storage error
    // happened before Node delivered the asynchronous spawn event.
    processStarted ||= !!child?.pid;
    clearInterval(timer);
    // A post-spawn preparation/storage fault must not release the account while
    // a silently running CLI or descendant can still modify its worktree.
    if (processStarted && child?.pid) {
      const target = process.platform === 'win32' ? child.pid : -child.pid;
      const alive = () => { try { process.kill(target, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
      if (alive()) {
        try { process.kill(target, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        const start = Date.now();
        while (alive() && Date.now() - start < 10000) {
          if (Date.now() - start > 5000) { try { process.kill(target, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (alive()) throw Error('Runner fault: process termination remains unconfirmed');
      }
    }
    save('result.json', { ...resultBase, state: processStarted ? 'failed' : 'blocked', failurePhase: processStarted && phase === 'preflight' ? 'execution' : phase, processStarted, ...(exitReceipt ? { exit: exitReceipt } : {}), reason: e.message, ...(e.code ? {code:e.code} : {}) });
  }
  finally { clearInterval(timer); }
})().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
