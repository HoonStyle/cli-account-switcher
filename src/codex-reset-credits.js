'use strict';
// Read-only official RPC. Never persist raw response rows or opaque redemption IDs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const CACHE = 'reset-credits-cache.json';
const SOURCE = 'codex-app-server';
const inflight = new Map();
const generations = new Map();
function empty() { return { availableCount: null, nearestExpiry: null, capturedAt: null, checkedAt: null, status: 'unqueried', stale: false, lastError: null, source: SOURCE }; }
function normalize(raw, capturedAt) {
  const count = raw?.availableCount;
  const expiries = (Array.isArray(raw?.credits) ? raw.credits : []).filter(c => c?.status === 'available' && Number.isSafeInteger(c.expiresAt) && c.expiresAt > 0 && c.expiresAt * 1000 <= 8640000000000000).map(c => c.expiresAt);
  return { ...empty(), availableCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
    nearestExpiry: expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : typeof raw?.nearestExpiry === 'string' && Number.isFinite(Date.parse(raw.nearestExpiry)) ? new Date(raw.nearestExpiry).toISOString() : null,
    capturedAt: Number.isSafeInteger(count) && count >= 0 ? capturedAt : null,
    checkedAt: capturedAt, status: Number.isSafeInteger(count) && count >= 0 ? 'available' : 'unavailable' };
}
function readCached(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, CACHE), 'utf8'));
    const v = normalize(raw, raw.capturedAt);
    v.nearestExpiry = typeof raw.nearestExpiry === 'string' && Number.isFinite(Date.parse(raw.nearestExpiry)) ? raw.nearestExpiry : null;
    v.checkedAt = typeof raw.checkedAt === 'string' ? raw.checkedAt : null;
    v.status = ['available', 'unavailable', 'error'].includes(raw.status) ? raw.status : 'unqueried';
    v.lastError = v.status === 'error' ? '리셋 크레딧 조회 실패' : null;
    v.stale = v.status === 'error' || (v.availableCount !== null && (!v.capturedAt || !Number.isFinite(Date.parse(v.capturedAt)) || Date.now() - Date.parse(v.capturedAt) > 30 * 60000 || (v.nearestExpiry && Date.parse(v.nearestExpiry) <= Date.now())));
    return v;
  } catch { return empty(); }
}
function write(home, value) {
  const file = path.join(home, CACHE), tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function invalidate(home) {
  // A completed re-login may replace the account within the same profile home.
  // Fence any old in-flight read so it cannot repopulate the new account's cache.
  generations.set(home, (generations.get(home) || 0) + 1);
  inflight.delete(home);
  write(home, empty());
}
function bindingFor(home) {
  const store = require('./store');
  const canonical = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const profile = store.load().codex.profiles.find(p => canonical(store.profileHome('codex', p)) === canonical(home));
  if (!profile) throw Error('Unknown profile');
  return require('./launch/profile-resolver').resolveProfile('codex', profile);
}
function readOfficial(home, opts = {}) {
  const binding = (opts.bindingFor || bindingFor)(home);
  const env = require('./launch/profile-resolver').launchEnv(binding);
  return new Promise((resolve, reject) => {
    const child = (opts.spawn || spawn)(binding.executable, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '', bytes = 0, done = false;
    const timer = setTimeout(() => finish(Error('RPC timeout')), opts.timeoutMs || 15000);
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); child.stdin.end(); child.kill(); err ? reject(Error('리셋 크레딧 조회 실패')) : resolve(value); };
    const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
    child.on('error', () => finish(Error('RPC process error')));
    child.on('exit', () => { if (!done) finish(Error('RPC exited')); });
    child.stdin.on('error', () => finish(Error('RPC stdin error')));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish(Error('RPC output limit'));
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0 && !done) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(Error('RPC initialize failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish(Error('RPC read failed'));
          finish(null, normalize(msg.result?.rateLimitResetCredits, null));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'switch-reset-credit-reader', version: '1.0.0' }, capabilities: { experimentalApi: true } } });
  });
}
async function refresh(home, opts = {}) {
  if (inflight.has(home)) return inflight.get(home);
  const generation = generations.get(home) || 0;
  const run = (async () => {
    const previous = readCached(home), now = opts.now ?? Date.now();
    const floor = opts.mode === 'force' ? 10000 : opts.mode === 'auto' ? (opts.intervalMs || 30 * 60000) : 5 * 60000;
    if (previous.checkedAt && now - Date.parse(previous.checkedAt) < (previous.status === 'error' ? Math.max(floor, 5 * 60000) : floor)) return previous;
    const at = new Date(now).toISOString();
    let value;
    try { value = normalize(await (opts.readOfficial || readOfficial)(home), at); }
    catch { value = { ...previous, checkedAt: at, status: 'error', stale: true, lastError: '리셋 크레딧 조회 실패' }; }
    if ((generations.get(home) || 0) !== generation) return readCached(home);
    write(home, value);
    return value;
  })();
  inflight.set(home, run);
  try { return await run; } finally { if (inflight.get(home) === run) inflight.delete(home); }
}
module.exports = { readCached, refresh, normalize, readOfficial, invalidate, CACHE };
