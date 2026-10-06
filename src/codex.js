'use strict';
// Codex inspection. Distribution identity uses official CLI login status. Usage comes
// from the newest rollout JSONL under <home>/sessions, which Codex writes on
// every response as a token_count event carrying rate_limits.
const fs = require('fs');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function identity(home) {
  return require('./edition.json').credentialMetadata
    ? require('./codex-identity').identity(home)
    : require('./official-auth').codexIdentity(home);
}

// Newest N rollout files by mtime under sessions/YYYY/MM/DD/*.jsonl
function newestRollouts(home, limit = 5) {
  const root = path.join(home, 'sessions');
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { out.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.p);
}

function tailText(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// usage-cache.json is written by the optional API fetch (same field names as rollouts).
function cachedUsage(home) {
  const j = readJson(path.join(home, 'usage-cache.json'));
  const rl = j && j.rate_limits;
  if (!rl) return null;
  const win = (w) => (w ? { usedPercent: w.used_percent ?? null, resetsAt: w.resets_at ?? null, windowMinutes: w.window_minutes ?? null } : null);
  return { capturedAt: j.captured_at || null, primary: win(rl.primary), secondary: win(rl.secondary), planType: rl.plan_type || null, limitReached: rl.rate_limit_reached_type || null, source: j.source || 'cache' };
}

function usage(home) {
  const local = rolloutUsage(home);
  const cached = cachedUsage(home);
  if (local && cached) return new Date(cached.capturedAt) > new Date(local.capturedAt) ? cached : local;
  return cached || local;
}

function rolloutUsage(home) {
  let latest = null;
  for (const file of newestRollouts(home)) {
    let lines;
    try { lines = tailText(file).split('\n').filter((l) => l.includes('"rate_limits"')); }
    catch { continue; } // A rotated/deleted file must not hide other sessions.
    for (let i = lines.length - 1; i >= 0; i--) {
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      const rl = j.payload && j.payload.rate_limits;
      if (!rl || (!rl.primary && !rl.secondary)) continue;
      const win = (w) => (w ? { usedPercent: w.used_percent ?? null, resetsAt: w.resets_at ?? null, windowMinutes: w.window_minutes ?? null } : null);
      const candidate = {
        capturedAt: j.timestamp || null,
        primary: win(rl.primary),
        secondary: win(rl.secondary),
        planType: rl.plan_type || null,
        limitReached: rl.rate_limit_reached_type || null,
        source: path.basename(file),
      };
      // File mtime can change due to other events; compare usage timestamps.
      if (!latest || (Date.parse(candidate.capturedAt) || 0) > (Date.parse(latest.capturedAt) || 0)) latest = candidate;
    }
  }
  return latest;
}

function inspect(home) {
  const cache = readJson(path.join(home, 'usage-cache.json'));
  return { ...identity(home), usage: usage(home), credits: normalizeCredits(cache?.credits, cache?.captured_at), resetCredits: require('./codex-reset-credits').readCached(home), home };
}

function normalizeCredits(c, capturedAt) {
  if (!c || typeof c !== 'object') return null;
  const value = c.balance;
  const balance = (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? String(value) : null;
  return { balance, hasCredits: typeof c.has_credits === 'boolean' ? c.has_credits : null, unlimited: c.unlimited === true, capturedAt: capturedAt || null };
}
module.exports = { inspect, normalizeCredits, invalidate: require('./official-auth').invalidate };
