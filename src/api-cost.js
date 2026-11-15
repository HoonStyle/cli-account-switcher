'use strict';
// Month-to-date organization spend for API-key accounts, read with a separate *admin* key.
// Plain API keys cannot read billing data on either platform; the official cost endpoints need:
//   claude → Anthropic Admin API key (sk-ant-admin…): GET /v1/organizations/cost_report (USD, cents as decimal strings)
//   codex  → OpenAI Admin key (sk-admin-…):          GET /v1/organization/costs (USD numbers)
// Neither endpoint reports a prepaid balance, so this module only reports spend. Admin keys are
// stored 0600 under <ROOT>/api-keys/admin/<tool>/<profileId>, never sent anywhere else, never
// placed in state/snapshots/logs (only a masked tail), and never accepted on argv.
const fs = require('fs');
const path = require('path');
const apiKeys = require('./api-keys');

const DIR = path.join(apiKeys.DIR, 'admin');
const CACHE = path.join(DIR, 'cost-cache.json');
const TIMEOUT_MS = 15000;
const MAX_PAGES = 10;
const STALE_MS = 30 * 60e3; // automatic refresh at most every 30 minutes per account

const PROVIDERS = {
  claude: { org: 'Anthropic', keyHint: 'sk-ant-admin…', prefix: /^sk-ant-admin/, warning: '관리자 키(sk-ant-admin…)가 아니면 조직 admin/owner 계정의 워크스페이스 미지정 키여야 조회됩니다', fetchMonth: anthropicMonth },
  codex: { org: 'OpenAI', keyHint: 'sk-admin-…', prefix: /^sk-admin-/, warning: 'OpenAI 관리자 키는 보통 sk-admin- 으로 시작합니다', fetchMonth: openaiMonth },
};

function validId(id) {
  return typeof id === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,40}$/u.test(id) && !/[\\/:*?"<>|]/.test(id) && id.trim() === id;
}
function adminFile(tool, id) {
  if (!PROVIDERS[tool]) throw new Error(`사용 금액 조회는 claude·codex API 키 계정 전용입니다: ${tool}`);
  if (!validId(id)) throw new Error('Invalid profile ID');
  return path.join(DIR, tool, id);
}
function readKey(tool, id) {
  if (!PROVIDERS[tool] || !validId(id)) return null;
  try { return fs.readFileSync(adminFile(tool, id), 'utf8').trim() || null; } catch { return null; }
}
function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [apiKeys.DIR, DIR, dir]) { try { fs.chmodSync(d, 0o700); } catch {} }
}
function setKey(tool, id, raw) {
  const key = apiKeys.normalize(raw);
  const file = adminFile(tool, id);
  secureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  dropCache(tool, id); // a new key may belong to another organization
  return { masked: apiKeys.mask(key), warning: PROVIDERS[tool].prefix.test(key) ? null : PROVIDERS[tool].warning };
}
function removeKey(tool, id) {
  let removed = false;
  try { fs.unlinkSync(adminFile(tool, id)); removed = true; } catch {}
  dropCache(tool, id);
  return { removed };
}

function readCache() { try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; } }
function writeCache(cache) {
  secureDir(DIR);
  const tmp = `${CACHE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CACHE);
}
function dropCache(tool, id) { const c = readCache(); if (c[`${tool}/${id}`]) { delete c[`${tool}/${id}`]; writeCache(c); } }

// Calendar month in UTC: both platforms bucket costs by UTC day.
function monthStart(now) { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function monthLabel(now) { const d = new Date(now); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

async function getJson(fetchImpl, url, headers) {
  let res;
  try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new Error(e?.name === 'TimeoutError' ? '시간 초과' : '네트워크 오류'); }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    // Only the status and the provider's error *type* leave this function, never the body text.
    const type = body?.error?.type || body?.error?.code || '';
    throw new Error(`HTTP ${res.status}${/^[a-z_]{1,60}$/.test(type) ? ' ' + type : ''}`);
  }
  if (!body || !Array.isArray(body.data)) throw new Error('응답 형식이 올바르지 않습니다');
  return body;
}

async function anthropicMonth(key, now, fetchImpl) {
  const base = 'https://api.anthropic.com/v1/organizations/cost_report';
  const headers = { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  let cents = 0, page = null, pages = 0;
  do {
    const q = new URLSearchParams({ starting_at: monthStart(now).toISOString(), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const body = await getJson(fetchImpl, `${base}?${q}`, headers);
    for (const bucket of body.data) for (const r of bucket.results || []) {
      if (r.currency && String(r.currency).toUpperCase() !== 'USD') throw new Error(`지원하지 않는 통화 ${String(r.currency).slice(0, 8)}`);
      const v = Number(r.amount); // USD cents as a decimal string
      if (Number.isFinite(v)) cents += v;
    }
    page = body.has_more ? body.next_page : null;
  } while (page && ++pages < MAX_PAGES);
  if (page) throw new Error('페이지가 너무 많습니다');
  return cents / 100;
}

async function openaiMonth(key, now, fetchImpl) {
  const base = 'https://api.openai.com/v1/organization/costs';
  const headers = { Authorization: `Bearer ${key}` };
  let usd = 0, page = null, pages = 0;
  do {
    const q = new URLSearchParams({ start_time: String(Math.floor(monthStart(now).getTime() / 1000)), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const body = await getJson(fetchImpl, `${base}?${q}`, headers);
    for (const bucket of body.data) for (const r of bucket.results || []) {
      const a = r.amount;
      if (!a) continue;
      if (a.currency && String(a.currency).toLowerCase() !== 'usd') throw new Error(`지원하지 않는 통화 ${String(a.currency).slice(0, 8)}`);
      const v = Number(a.value);
      if (Number.isFinite(v)) usd += v;
    }
    page = body.has_more ? body.next_page : null;
  } while (page && ++pages < MAX_PAGES);
  if (page) throw new Error('페이지가 너무 많습니다');
  return usd;
}

// ---- Local spend and estimated balance (Claude Code sessions on this machine) ----
// The statusline hook (wrappers.statusLineHookSource) writes <configDir>/switcher-spend/<session>.json with
// cost increases per 10-minute UTC bucket ("YYYY-MM-DDTHH:M"). Plain API keys cannot read balance or spend,
// so a balance entered from the Console Billing page minus this local spend gives an estimate.
const SPEND_DIR = 'switcher-spend';
const BALANCE = path.join(apiKeys.DIR, '..', 'spend', 'balance.json');
const MAX_SESSIONS = 5000;
const bucketStart = (key) => Date.parse(`${key}0:00Z`); // "2026-11-15T10:3" -> 10:30Z
function localSpend(configDir, { now = Date.now(), sinceMs = null } = {}) {
  if (!configDir) return null;
  const dir = path.join(configDir, SPEND_DIR);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^[A-Za-z0-9-]{8,80}\.json$/.test(n)).slice(0, MAX_SESSIONS); } catch { return null; }
  if (!names.length) return null;
  const month = monthLabel(now), since = sinceMs == null ? null : sinceMs - (sinceMs % 600000);
  let monthUsd = 0, sinceUsd = 0, sessions = 0, updatedAt = null;
  for (const n of names) {
    let rec; try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!rec || typeof rec.buckets !== 'object') continue;
    let used = false;
    for (const [k, v] of Object.entries(rec.buckets)) {
      const amount = Number(v), at = bucketStart(k);
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(at)) continue;
      if (k.slice(0, 7) === month) { monthUsd += amount; used = true; }
      if (since != null && at >= since) sinceUsd += amount;
    }
    if (used) sessions += 1;
    if (typeof rec.updatedAt === 'string' && (!updatedAt || rec.updatedAt > updatedAt)) updatedAt = rec.updatedAt;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { monthUsd: r2(monthUsd), sinceUsd: r2(sinceUsd), sessions, updatedAt };
}
function readBalances() { try { const b = JSON.parse(fs.readFileSync(BALANCE, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch { return {}; } }
function writeBalances(b) {
  fs.mkdirSync(path.dirname(BALANCE), { recursive: true, mode: 0o700 });
  const tmp = `${BALANCE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, BALANCE);
}
function setBalance(tool, id, raw, now = Date.now()) {
  if (tool !== 'claude') throw new Error('잔액 추정은 Claude API 키 계정만 지원합니다 (이 PC의 Claude Code 사용 금액으로 차감)');
  if (!validId(id)) throw new Error('Invalid profile ID');
  const text = String(raw ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new Error('잔액은 0 이상의 USD 금액으로 입력하세요 (예: 48.20)');
  const b = readBalances(); b[`${tool}/${id}`] = { baseUsd: Number(text), at: new Date(now).toISOString() }; writeBalances(b);
  return b[`${tool}/${id}`];
}
function clearBalance(tool, id) { const b = readBalances(); const had = Boolean(b[`${tool}/${id}`]); delete b[`${tool}/${id}`]; if (had) writeBalances(b); return { removed: had }; }

const inflight = new Map();
// Refresh one account. force=false skips when the cached value for this month is newer than maxAgeMs.
async function refresh(tool, id, { force = false, now = Date.now(), maxAgeMs = STALE_MS, fetchImpl = globalThis.fetch } = {}) {
  const key = readKey(tool, id);
  if (!key) return 'skip: 관리자 키 없음';
  const slot = `${tool}/${id}`;
  const cached = readCache()[slot];
  if (!force && cached?.month === monthLabel(now) && !cached.error && now - Date.parse(cached.capturedAt) < maxAgeMs) return 'skip: 최신';
  if (inflight.has(slot)) return inflight.get(slot);
  const job = (async () => {
    const at = new Date(now).toISOString();
    try {
      const amount = await PROVIDERS[tool].fetchMonth(key, now, fetchImpl);
      const c = readCache(); c[slot] = { month: monthLabel(now), amountUsd: Math.round(amount * 100) / 100, capturedAt: at, checkedAt: at, error: null }; writeCache(c);
      return 'ok';
    } catch (e) {
      const c = readCache(); const prev = c[slot];
      // Keep the last good amount (marked stale by error) unless the month rolled over.
      c[slot] = { ...(prev && prev.month === monthLabel(now) ? prev : { month: monthLabel(now), amountUsd: null, capturedAt: null }), checkedAt: at, error: String(e.message || e).slice(0, 120) };
      writeCache(c);
      return c[slot].error;
    }
  })().finally(() => inflight.delete(slot));
  inflight.set(slot, job);
  return job;
}

// Every claude/codex profile that has an admin key; sequential to stay polite to both APIs.
async function refreshAll(state, opts = {}) {
  const out = {};
  for (const tool of Object.keys(PROVIDERS)) for (const id of state?.[tool]?.profiles || []) {
    if (!readKey(tool, id)) continue;
    out[`${tool}/${id}`] = await refresh(tool, id, opts);
  }
  return out;
}

function snapshot(tool, id, now = Date.now(), { configDir = null } = {}) {
  if (!PROVIDERS[tool]) return null;
  const key = readKey(tool, id);
  const c = readCache()[`${tool}/${id}`];
  const current = c && c.month === monthLabel(now) ? c : null;
  const base = tool === 'claude' ? readBalances()[`${tool}/${id}`] : null;
  const local = tool === 'claude' ? localSpend(configDir, { now, sinceMs: base ? Date.parse(base.at) : null }) : null;
  const balance = base && Number.isFinite(base.baseUsd) ? { baseUsd: base.baseUsd, at: base.at, spentSinceUsd: local ? local.sinceUsd : 0,
    estimateUsd: Math.round((base.baseUsd - (local ? local.sinceUsd : 0)) * 100) / 100 } : null;
  return { adminKey: Boolean(key), masked: apiKeys.mask(key), org: PROVIDERS[tool].org, keyHint: PROVIDERS[tool].keyHint, month: monthLabel(now),
    amountUsd: key && current ? current.amountUsd : null, capturedAt: key && current ? current.capturedAt : null, error: key && current ? current.error : null, pending: inflight.has(`${tool}/${id}`),
    local: local ? { monthUsd: local.monthUsd, sessions: local.sessions, updatedAt: local.updatedAt } : null, balance };
}

module.exports = { setKey, removeKey, refresh, refreshAll, snapshot, readKey, monthStart, monthLabel, localSpend, setBalance, clearBalance, PROVIDERS, DIR, STALE_MS, SPEND_DIR };
