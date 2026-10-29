'use strict';
// Runs only while the tray app is running. Never changes the globally selected profile.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lockfile = require('proper-lockfile');
const rpc = require('./codex-reset-credits');
const WINDOW_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;
const POLL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3; // Initial request included; persisted per account/credit on this device.
const RETRY_MS = 60 * 1000;
const STATE = 'reset-auto-use-state.json';
const LOG = 'reset-auto-use.jsonl';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function redemptionKey(creditId) {
  // Same credit => same UUID on every device/profile. Do not include local paths.
  const bytes = Buffer.from(hash(`cli-account-switch:expiry-reset:v1:${creditId}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const stamp = now => new Date(now).toISOString();
const succeeded = outcome => outcome === 'reset' || outcome === 'alreadyRedeemed';
function readState(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, STATE), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { attempts: {} }; throw Error('리셋권 자동 사용 기록을 읽을 수 없습니다'); }
}
function saveState(home, state) {
  const file = path.join(home, STATE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file);
}
function appendLog(home, event) {
  fs.appendFileSync(path.join(home, LOG), JSON.stringify(event) + '\n', { mode: 0o600 });
}
function loggedAttempts(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, LOG), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return new Map(); throw e; }
  const attempts = new Map();
  for (const line of text.split('\n').filter(line => line.trim())) {
    const event = JSON.parse(line);
    if (event.event === 'attempt' && typeof event.credit === 'string') {
      const prior = attempts.get(event.credit) || { count: 0, lastRequestedAt: 0 };
      attempts.set(event.credit, { count: prior.count + 1, lastRequestedAt: Math.max(prior.lastRequestedAt, Date.parse(event.requestedAt || event.attemptedAt) || 0) });
    }
  }
  return attempts;
}
function limits(value) {
  const window = w => w ? { usedPercent: Number.isFinite(w.usedPercent) ? w.usedPercent : null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null } : null;
  return { primary: window(value?.primary), secondary: window(value?.secondary) };
}
function resetObserved(before, after) {
  const pairs = ['primary', 'secondary'].map(k => [before?.[k]?.usedPercent, after?.[k]?.usedPercent]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  return pairs.length ? pairs.some(([a, b]) => b < a) : null;
}
function availableCredits(details, now) {
  return (Array.isArray(details?.credits?.credits) ? details.credits.credits : []).filter(c =>
    c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id.trim() &&
    Number.isSafeInteger(c.expiresAt) && c.expiresAt * 1000 > now && c.expiresAt * 1000 <= 8640000000000000
  ).sort((a, b) => a.expiresAt - b.expiresAt);
}
function createAutoUse(store, options = {}) {
  const read = options.readDetails || rpc.readDetails, consume = options.consume || rpc.consume;
  const record = options.recordDetails || rpc.recordDetails;
  const now = options.now || Date.now;
  const onChange = options.onChange || (() => {});
  const notices = new Map();
  const settingChanges = new Map();
  let running = false, stopped = false;
  const setting = profile => store.load().codex?.resetCreditAutoUse?.[profile];
  const enabled = profile => setting(profile)?.enabled === true && store.load().codex.profiles.includes(profile);
  const notice = (profile, status, text, extra = {}) => { notices.set(profile, { status, text, ...extra }); onChange(); };
  const valid = (profile, config) => !stopped && enabled(profile) && setting(profile)?.revision === config.revision;
  function stopAtLimit(home, profile, key, attempt, state) {
    if (!attempt.limitReachedAt) {
      attempt.limitReachedAt = stamp(now());
      const result = { event: 'stopped', reason: 'attemptLimit', profile, credit: key, idempotencyKey: attempt.idempotencyKey,
        attemptCount: attempt.attemptCount, maxAttempts: MAX_ATTEMPTS, stoppedAt: attempt.limitReachedAt,
        attemptedAt: attempt.attemptedAt, usedAt: null, apiOutcome: attempt.outcome === 'pending' ? 'unknown' : attempt.outcome,
        serverResetAcknowledged: attempt.outcome === 'pending' ? null : false, resetConfirmed: attempt.outcome === 'pending' ? null : false };
      appendLog(home, result); state.lastResult = result; saveState(home, state);
    }
    notice(profile, 'stopped', `자동 사용 ${MAX_ATTEMPTS}회 제한 도달 · 추가 요청 중단`);
  }
  function summary(profile) {
    let last = null;
    try { last = readState(store.profileHome('codex', profile)).lastResult || null; } catch {}
    return { enabled: enabled(profile), ...(notices.get(profile) || {}), lastResult: last };
  }
  async function setEnabled(profile, on) {
    const state = store.load();
    if (!state.codex.profiles.includes(profile) || typeof on !== 'boolean') throw Error('계정 또는 옵션이 올바르지 않습니다');
    const change = crypto.randomUUID();
    settingChanges.set(profile, change);
    if (!on) {
      state.codex.resetCreditAutoUse = { ...state.codex.resetCreditAutoUse, [profile]: { enabled: false, revision: crypto.randomUUID() } };
      store.save(state); notice(profile, 'off', '자동 사용 꺼짐'); return;
    }
    const home = store.profileHome('codex', profile);
    const details = await read(home);
    if (settingChanges.get(profile) !== change) return;
    if (!details.accountKey) throw Error('ChatGPT 계정을 확인할 수 없습니다');
    const current = store.load();
    if (!current.codex.profiles.includes(profile)) throw Error('계정이 제거되었습니다');
    current.codex.resetCreditAutoUse = { ...current.codex.resetCreditAutoUse, [profile]: { enabled: true, accountKey: details.accountKey, revision: crypto.randomUUID() } };
    record(home, details, now()); store.save(current);
    notice(profile, 'waiting', '만료 10분 전 자동 사용 켜짐');
    // The first tick refreshes even when an earlier opt-in left a future polling time.
    return tick(true);
  }
  function verify(home, profile, key, attempt, details, state) {
    const after = limits(details.rateLimits), verifiedAt = stamp(now());
    const result = { event: 'verification', profile, credit: key, idempotencyKey: attempt.idempotencyKey,
      attemptCount: attempt.attemptCount,
      attemptedAt: attempt.attemptedAt, usedAt: attempt.usedAt, acknowledgedAt: attempt.acknowledgedAt, verifiedAt, apiOutcome: attempt.outcome,
      serverResetAcknowledged: true, resetConfirmed: resetObserved(attempt.before, after), before: attempt.before, after };
    // Do not label an accepted request as an observed reset when the follow-up read failed.
    appendLog(home, result); attempt.needsVerification = false; state.lastResult = result; saveState(home, state);
    return result;
  }
  async function runProfile(profile, force) {
    const config = setting(profile);
    if (!valid(profile, config)) return;
    const home = store.profileHome('codex', profile);
    let release, compromised = false;
    try {
      // Established cross-process lock; stale processes are recovered by the library.
      release = await lockfile.lock(home, { lockfilePath: path.join(home, 'reset-auto-use.lock'), stale: 60000, update: 10000, retries: 0, onCompromised: () => { compromised = true; } });
    } catch (e) {
      if (e.code !== 'ELOCKED') notice(profile, 'error', '자동 사용 기록에 접근할 수 없습니다');
      return;
    }
    try {
      const state = readState(home);
      if (!force && state.nextCheckAt > now()) return;
      const details = await read(home);
      if (!valid(profile, config)) return;
      if (details.accountKey !== config.accountKey) {
        await setEnabled(profile, false); notice(profile, 'accountChanged', '로그인 계정 변경 · 자동 사용을 다시 켜주세요'); return;
      }
      record(home, details, now());
      state.attempts ||= {};
      for (const [key, attempt] of Object.entries(state.attempts)) {
        if (attempt.needsVerification && succeeded(attempt.outcome) && attempt.accountKey === config.accountKey) verify(home, profile, key, attempt, details, state);
      }
      const credits = availableCredits(details, now());
      const due = credits.filter(c => c.expiresAt * 1000 - now() <= WINDOW_MS);
      // A lost successful response may have removed the credit from the available list.
      // Reconcile that exact persisted request, never substitute another available credit.
      for (const attempt of Object.values(state.attempts)) {
        if (attempt.accountKey === config.accountKey && attempt.outcome === 'pending' && attempt.creditId && !due.some(c => c.id === attempt.creditId)) {
          due.unshift({ id: attempt.creditId, expiresAt: attempt.expiresAt, reconcile: true });
        }
      }
      state.nextCheckAt = Math.min(now() + POLL_MS, ...credits.map(c => Math.max(now() + TICK_MS, c.expiresAt * 1000 - WINDOW_MS)));
      let legacyAttempts, limited = false;
      for (const credit of due) {
        const key = hash(`${config.accountKey}:${credit.id}`), previous = state.attempts[key];
        if (succeeded(previous?.outcome)) continue;
        // Older versions stored only the latest attempt. Recover their total from the audit log.
        // A saved legacy attempt without a log still reserves one request (crash before append).
        const hasCount = Number.isSafeInteger(previous?.attemptCount) && previous.attemptCount >= 0;
        const hasNext = Number.isFinite(previous?.nextAttemptAt);
        const legacy = hasCount && hasNext ? null : (legacyAttempts ||= loggedAttempts(home)).get(key);
        const attemptCount = hasCount ? previous.attemptCount : Math.max(legacy?.count || 0, previous ? 1 : 0);
        const nextAttemptAt = hasNext ? previous.nextAttemptAt : attemptCount ? Math.max(legacy?.lastRequestedAt || 0, Date.parse(previous?.attemptedAt) || 0) + RETRY_MS : 0;
        if (previous) { previous.attemptCount = attemptCount; previous.nextAttemptAt = nextAttemptAt; }
        if (attemptCount >= MAX_ATTEMPTS) {
          const attempt = previous || { accountKey: config.accountKey, creditId: credit.id, idempotencyKey: redemptionKey(credit.id), expiresAt: credit.expiresAt, outcome: 'pending', attemptCount };
          state.attempts[key] = attempt;
          stopAtLimit(home, profile, key, attempt, state); limited = true; continue;
        }
        // Forced startup/resume/opt-in checks may refresh reads, but never bypass the retry interval.
        if (nextAttemptAt > now()) { state.nextCheckAt = Math.min(state.nextCheckAt, nextAttemptAt); continue; }
        const check = () => !compromised && valid(profile, config) && (credit.reconcile || (credit.expiresAt * 1000 > now() && credit.expiresAt * 1000 - now() <= WINDOW_MS));
        if (!check()) break;
        // One logical redemption per credit, including retries and other devices.
        const attempt = previous?.outcome === 'pending' ? previous : {
          accountKey: config.accountKey, creditId: credit.id, idempotencyKey: redemptionKey(credit.id), attemptedAt: stamp(now()),
          expiresAt: credit.expiresAt, before: limits(details.rateLimits), outcome: 'pending',
        };
        attempt.attemptCount = attemptCount + 1;
        attempt.nextAttemptAt = now() + RETRY_MS;
        state.attempts[key] = attempt; state.nextCheckAt = attempt.nextAttemptAt;
        saveState(home, state); // Reserve the count and idempotency BEFORE any network mutation.
        appendLog(home, { event: 'attempt', profile, credit: key, idempotencyKey: attempt.idempotencyKey, attemptCount: attempt.attemptCount, attemptedAt: attempt.attemptedAt, requestedAt: stamp(now()), expiresAt: stamp(credit.expiresAt * 1000), before: attempt.before });
        let outcome;
        try {
          outcome = await consume(home, { creditId: credit.id, idempotencyKey: attempt.idempotencyKey }, { expectedAccountKey: config.accountKey, beforeSend: check });
        } catch {
          const result = { event: 'result', profile, credit: key, idempotencyKey: attempt.idempotencyKey, attemptCount: attempt.attemptCount, attemptedAt: attempt.attemptedAt, respondedAt: stamp(now()), apiOutcome: 'unknown', resetConfirmed: null, error: '사용 결과 미확인' };
          appendLog(home, result); state.lastResult = result; saveState(home, state);
          if (attempt.attemptCount >= MAX_ATTEMPTS) stopAtLimit(home, profile, key, attempt, state);
          else notice(profile, 'error', '사용 결과 미확인 · 재확인 예정');
          return;
        }
        attempt.outcome = outcome;
        // alreadyRedeemed does not reveal when/where the original redemption occurred.
        attempt.usedAt = outcome === 'reset' ? stamp(now()) : null;
        attempt.acknowledgedAt = stamp(now());
        attempt.needsVerification = succeeded(outcome);
        if (attempt.needsVerification) state.nextCheckAt = now() + TICK_MS;
        const result = { event: 'result', profile, credit: key, idempotencyKey: attempt.idempotencyKey,
          attemptCount: attempt.attemptCount,
          attemptedAt: attempt.attemptedAt, usedAt: attempt.usedAt, acknowledgedAt: attempt.acknowledgedAt, respondedAt: stamp(now()), apiOutcome: outcome,
          serverResetAcknowledged: succeeded(outcome), resetConfirmed: succeeded(outcome) ? null : false,
          before: attempt.before, after: null };
        state.lastResult = result; saveState(home, state); appendLog(home, result);
        // Always re-read server limits, even after a non-consuming response.
        try {
          const after = await read(home);
          if (after.accountKey !== config.accountKey || !valid(profile, config)) throw Error('Account changed');
          record(home, after, now());
          if (succeeded(outcome)) {
            const verified = verify(home, profile, key, attempt, after, state);
            notice(profile, 'used', (outcome === 'alreadyRedeemed' ? '이미 처리된 사용 확인' : '자동 사용 완료') + (verified.resetConfirmed ? ' · 초기화 확인' : ' · 초기화 미확인'), { lastUsedAt: attempt.usedAt });
          } else notice(profile, 'waiting', outcome === 'nothingToReset' ? '초기화할 한도 없음 · 재확인 예정' : '사용 가능한 리셋권 없음');
        } catch {
          notice(profile, 'error', succeeded(outcome) ? '사용 완료 · 초기화 확인 대기' : '한도 재조회 실패 · 재확인 예정');
        }
        if (!succeeded(outcome) && attempt.attemptCount >= MAX_ATTEMPTS) stopAtLimit(home, profile, key, attempt, state);
        // Re-evaluate with fresh limits on the next tick; never redeem a batch on one snapshot.
        return;
      }
      saveState(home, state);
      if (!limited) notice(profile, 'waiting', credits.length ? '만료 10분 전 자동 사용 대기' : '만료 시각이 확인된 리셋권 없음');
    } finally { await release().catch(() => {}); }
  }
  async function tick(force = false) {
    if (running || stopped) return;
    running = true;
    try {
      for (const profile of store.load().codex.profiles) {
        if (!enabled(profile)) continue;
        try { await runProfile(profile, force); }
        catch { notice(profile, 'error', '자동 사용 확인 실패 · 다음 확인 때 재시도'); }
      }
    } finally { running = false; }
  }
  function start(timers = globalThis, powerMonitor) {
    stopped = false;
    const timer = timers.setInterval(() => tick(), TICK_MS);
    const resume = () => tick(true);
    powerMonitor?.on('resume', resume);
    tick(true);
    return () => { stopped = true; timers.clearInterval(timer); powerMonitor?.removeListener('resume', resume); };
  }
  return { setEnabled, summary, tick, start };
}
module.exports = { createAutoUse, availableCredits, resetObserved, redemptionKey, WINDOW_MS, TICK_MS, MAX_ATTEMPTS, RETRY_MS, STATE, LOG };
