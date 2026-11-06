'use strict';
// Use the official non-inference /usage command. No OAuth implementation,
// credential reads, account switching, or per-model quota guesses here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const LIMIT = 1024 * 1024;
const safeText = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';

function parseReport(text, capturedAt = new Date().toISOString()) {
  let report;
  try { report = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw Error('공식 agy의 사용량 응답을 해석하지 못했습니다.'); }
  if (report?.status !== 'SUCCESS' || report.command?.name !== 'usage' || (report.num_turns != null && report.num_turns !== 0)) throw Error('공식 agy 사용량 조회가 완료되지 않았습니다. agy의 로그인 상태를 확인해 주세요.');
  const rawGroups = report.command.data?.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length > 64) throw Error('공유 한도 정보를 받지 못했습니다.');
  const groups = [];
  for (const raw of rawGroups) {
    if (!raw || raw.disabled === true || !Array.isArray(raw.buckets) || raw.buckets.length > 256) continue;
    const name = safeText(raw.name || raw.display_name) || '공유 한도';
    const buckets = new Map();
    for (const item of raw.buckets) {
      if (!item || item.disabled === true) continue;
      const id = safeText(item.id || item.bucket_id);
      const fraction = item.remaining_fraction;
      if (!id || typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const window = safeText(item.window);
      const label = window === 'weekly' ? '주간' : window === '5h' ? '5시간' : safeText(item.name) || window || id;
      const resetsAt = typeof item.reset_time === 'string' && Number.isFinite(Date.parse(item.reset_time)) ? Date.parse(item.reset_time) / 1000 : null;
      const bucket = { id, window, label, remainingPercent: fraction * 100, usedPercent: (1 - fraction) * 100, resetsAt };
      mergeBucket(buckets, bucket);
    }
    if (!buckets.size) continue;
    // Only a shared server bucket ID proves duplication. Equal percentages,
    // model-family prefixes, and equal reset times do not prove a shared pool.
    const matches = groups.filter(group => [...buckets.keys()].some(id => group.buckets.has(id)));
    const group = matches.shift() || { name, buckets: new Map() };
    if (!groups.includes(group)) groups.push(group);
    for (const other of matches) {
      for (const bucket of other.buckets.values()) mergeBucket(group.buckets, bucket);
      groups.splice(groups.indexOf(other), 1);
    }
    for (const bucket of buckets.values()) mergeBucket(group.buckets, bucket);
  }
  if (!groups.length) throw Error('현재 계정에서 측정된 사용량 한도를 제공하지 않습니다.');
  return { source: 'agy-cli', scope: 'shared-login', capturedAt, groups: groups.map(group => ({
    name: group.name === 'Gemini Models' ? 'Gemini' : group.name === 'Claude and GPT models' ? 'Claude·GPT' : group.name,
    buckets: [...group.buckets.values()].sort((a, b) => rank(a.window) - rank(b.window)),
  })) };
}
function rank(window) { return window === '5h' ? 0 : window === 'weekly' ? 1 : 2; }
function mergeBucket(buckets, bucket) {
  const old = buckets.get(bucket.id);
  if (old && old.window !== bucket.window) throw Error('공유 한도의 기간 정보가 서로 달라 표시하지 않았습니다.');
  // Keep the limiting observation and its own reset, never sum shared quotas.
  if (!old || bucket.remainingPercent < old.remainingPercent || (bucket.remainingPercent === old.remainingPercent && (bucket.resetsAt || 0) > (old.resetsAt || 0))) buckets.set(bucket.id, bucket);
}

function resolveCli(env = process.env) {
  const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  if (Object.hasOwn(env, 'ANTIGRAVITY_CLI_PATH')) {
    if (!path.isAbsolute(env.ANTIGRAVITY_CLI_PATH) || !executable(env.ANTIGRAVITY_CLI_PATH)) throw Error('ANTIGRAVITY_CLI_PATH의 공식 agy 실행 파일을 확인해 주세요.');
    return env.ANTIGRAVITY_CLI_PATH;
  }
  const candidates = process.platform === 'win32' ? [path.join(os.homedir(), '.local', 'bin', 'agy.exe')] : [path.join(os.homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(dir, process.platform === 'win32' ? 'agy.exe' : 'agy'));
  const file = candidates.find(executable);
  if (!file) throw Error('공식 agy CLI를 설치하고 로그인한 뒤 사용량을 조회해 주세요.');
  return file;
}

function runBounded(file, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('사용량 조회를 취소했습니다.')); return; }
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, failure = null, killer;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      }
    };
    const fail = message => { failure ||= Error(message); terminate(); };
    const abort = () => fail('사용량 조회를 취소했습니다.');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fail('사용량 조회 시간이 초과됐습니다. agy의 로그인·키체인 승인 상태를 확인해 주세요.'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > LIMIT) fail('공식 agy 응답이 너무 커 조회를 중단했습니다.'); else stdout += data; });
    // Do not expose CLI diagnostics: they can contain sign-in URLs or identity.
    child.stderr.on('data', data => { bytes += data.length; if (bytes > LIMIT) fail('공식 agy 응답이 너무 커 조회를 중단했습니다.'); });
    child.on('error', () => { failure ||= Error('공식 agy를 실행하지 못했습니다. 설치 경로를 확인해 주세요.'); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      terminate(); // only this owned process group; never an existing agy
      if (killer) killer.unref();
      if (failure) reject(failure);
      else if (code !== 0) reject(Error('공식 agy 사용량 조회에 실패했습니다. agy에서 로그인 상태를 확인해 주세요.'));
      else resolve(stdout);
    });
  });
}

async function fetchUsage({ executable, env = process.env, timeoutMs = 45000, signal } = {}) {
  const file = executable || resolveCli(env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-agy-usage-'));
  fs.chmodSync(dir, 0o700);
  try {
    // Passive refresh must never start browser OAuth or auto-update the CLI.
    const windows = process.platform === 'win32';
    for (const name of windows ? ['open.cmd', 'xdg-open.cmd', 'browser-blocked.cmd'] : ['open', 'xdg-open', 'browser-blocked']) fs.writeFileSync(path.join(dir, name), windows ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const probeEnv = { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', BROWSER: path.join(dir, windows ? 'browser-blocked.cmd' : 'browser-blocked'), PATH: dir + path.delimiter + (env.PATH || '') };
    const version = await runBounded(file, ['--version'], { cwd: dir, env: probeEnv, timeoutMs: 3000, signal });
    const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match || (Number(match[1]) < 1 || (Number(match[1]) === 1 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 11))))) throw Error('사용량 JSON 조회에는 agy 1.1.11 이상이 필요합니다.');
    return parseReport(await runBounded(file, ['-p', '/usage', '--output-format', 'json'], { cwd: dir, env: probeEnv, timeoutMs, signal }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { parseReport, fetchUsage, resolveCli };
