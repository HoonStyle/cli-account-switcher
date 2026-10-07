'use strict';
// Presentation-only snapshots. Never infer failure from silence, nor write these
// derived values back to the ledger or use them to release execution slots.
const fs = require('fs');
const path = require('path');
const active = new Set(['starting', 'running', 'unknown']);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const ended = new Set([...terminal, 'blocked']);
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;
const latestTime = values => Math.max(0, ...values.filter(Number.isFinite)) || null;
function liveReceipt(a) {
  if (!a.dir || !a.token) return null;
  try {
    const live = JSON.parse(fs.readFileSync(path.join(a.dir, 'live.json'), 'utf8'));
    return live.attemptId === a.id && live.token === a.token ? live : null;
  } catch { return null; }
}
function error(kind, message, exit) {
  return { kind, message: String(message || kind).slice(0, 1000), exitCode: exit?.code ?? null, signal: exit?.signal ?? null };
}
// Attempts arrive in durable ledger insertion order. Wall-clock timestamps are
// telemetry, never execution identity: they can tie or move backward on resume.
function currentTaskAttempt(task, attempts) {
  const candidates = attempts.filter(a => a.taskId === task.id && a.rootId === task.rootId);
  return task.currentAttemptId ? candidates.find(a => a.id === task.currentAttemptId) || null : candidates.at(-1) || null;
}
function attemptObservation(a, root, allAttempts, { now, staleMs, maxActive }) {
  const live = liveReceipt(a), heartbeatAt = timestamp(live?.at);
  const lastOutputAt = timestamp(live?.lastOutputAt), lastProgressAt = timestamp(live?.lastProgressAt);
  const isActive = active.has(a.state);
  const heartbeatStatus = !isActive ? 'not_applicable' : !heartbeatAt ? 'unavailable' : now - heartbeatAt < 10000 ? 'fresh' : 'stale';
  // A fresh heartbeat proves runner liveness, not model progress. Quiet means
  // output has not arrived recently; it is a warning, never an execution error.
  const quiet = isActive && a.state !== 'unknown' && heartbeatStatus === 'fresh' && now - (lastOutputAt || a.startedAt || now) > staleMs;
  let activity = a.state;
  if (isActive && (heartbeatStatus === 'stale' || (heartbeatStatus === 'unavailable' && now - (a.startedAt || a.createdAt || now) > 10000))) activity = 'unknown';
  else if (quiet) activity = 'quiet';
  let waitReason = null;
  if (a.state === 'queued') {
    const occupied = allAttempts.filter(other => active.has(other.state));
    if (['needs_user', 'cancel_requested', 'cancelled', 'completed', 'ready'].includes(root.status)) waitReason = 'root_paused';
    else if (occupied.some(other => other.binding?.tool === a.binding?.tool && other.binding?.home === a.binding?.home)) waitReason = 'account_busy';
    else if (occupied.length >= maxActive) waitReason = 'capacity';
    else waitReason = 'scheduler';
  } else if (a.state === 'external_wait') waitReason = 'coordinator';
  const failure = a.state === 'blocked' ? error('preflight', a.result?.reason || 'Preparation failed') : a.state === 'failed' ? error('execution', a.result?.reason || (a.result?.state === 'succeeded' ? 'invalid_child_result' : 'Execution failed; see attempt logs'), a.result?.exit)
    : a.state === 'external_wait' && a.lastWakeError ? error('coordinator_wake', a.lastWakeError) : null;
  const startedAt = timestamp(a.startedAt), endedAt = timestamp(a.endedAt);
  return { state: a.state, activity, heartbeatStatus, heartbeatAt, lastOutputAt, lastProgressAt, quiet,
    waitReason, error: failure, createdAt: timestamp(a.createdAt), startedAt, endedAt,
    elapsedMs: startedAt && (!ended.has(a.state) || endedAt) ? Math.max(0, (endedAt || now) - startedAt) : null };
}
function observe(root, tasks, attempts, allAttempts, options) {
  const observedAttempts = attempts.map(a => ({ ...a, observation: attemptObservation(a, root, allAttempts, options) }));
  const observedTasks = tasks.map(t => {
    const last = currentTaskAttempt(t, observedAttempts);
    const executionState = terminal.has(t.state) ? t.state : last?.observation.state || t.state;
    const failure = executionState === 'failed' ? last?.observation.error || error('task_result', t.result?.summary || 'Task reported failure') : last?.observation.error || null;
    return { ...t, observation: { ...(last?.observation || {}), state: executionState, executionState,
      activity: terminal.has(executionState) ? executionState : last?.observation.activity || executionState,
      latestAttemptId: last?.id || null, reviewDecision: t.review?.decision || null, error: failure } };
  });
  const counts = { total: tasks.length, queued: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, cancelled: 0, unknown: 0, reviewPending: 0 };
  for (const t of observedTasks) {
    const state = t.observation.activity === 'unknown' ? 'unknown' : t.observation.executionState;
    const key = ['starting', 'running'].includes(state) ? 'running' : state;
    if (Object.hasOwn(counts, key)) counts[key]++;
    if (terminal.has(t.state) && !t.review) counts.reviewPending++;
  }
  const errors = observedTasks.filter(t => t.observation.error).map(t => ({ taskId: t.id, attemptId: t.observation.latestAttemptId, ...t.observation.error }));
  for (const a of observedAttempts.filter(a => a.role === 'main' && a.observation.error)) errors.push({ attemptId: a.id, ...a.observation.error });
  if (root.lastDeliveryWakeError) errors.push(error('delivery_wake', root.lastDeliveryWakeError));
  if (root.status === 'needs_user' && root.attentionDelivery === 'pending' && root.lastAttentionWakeError) errors.push(error('attention_wake', root.lastAttentionWakeError));
  const observation = { phase: root.status, counts, activeAttemptIds: attempts.filter(a => active.has(a.state)).map(a => a.id),
    heartbeatAt: latestTime(observedAttempts.map(a => a.observation.heartbeatAt)),
    lastOutputAt: latestTime(observedAttempts.map(a => a.observation.lastOutputAt)),
    errors, requiresAttention: !!root.attention || root.status === 'needs_user' || counts.unknown > 0 ||
      (!['ready', 'completed', 'cancelled'].includes(root.status) && (observedTasks.some(t => t.observation.error && !t.review) || observedAttempts.some(a => a.state === 'external_wait' && a.observation.error))),
    attentionReason: (root.status === 'needs_user' ? root.inputRequest?.reason : null) || root.attention || null, deliveryStatus: root.finalDelivery || 'pending', observedAt: options.now };
  return { root: { ...root, observation }, tasks: observedTasks, attempts: observedAttempts };
}
module.exports = { observe, currentTaskAttempt };
