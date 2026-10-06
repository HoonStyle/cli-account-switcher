'use strict';
// Read-only projection of the installed OpenClaw Gateway. No account-task
// submission, transcript-file reads, credentials, or model calls belong here.
const { execFile } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const METHODS = new Set(['sessions.list', 'sessions.preview', 'chat.history', 'audit.activity.list']);
const clean = (value, max = 3000) => typeof value === 'string' ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';
const textOf = m => clean(typeof m?.content === 'string' ? m.content : (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'), 6000);
const identity = row => 'oc-' + crypto.createHash('sha256').update(JSON.stringify([row.agentId, row.key, row.sessionId])).digest('hex').slice(0, 32);
function resolveCli() {
  const candidates = [process.env.CLI_ACCOUNTS_OPENCLAW_CLI, ...[...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.openclaw/bin')].filter(Boolean).map(dir => path.join(dir, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'))];
  return candidates.find(file => file && fs.existsSync(file));
}
function gatewayRead(method, params, { signal } = {}) {
  if (!METHODS.has(method)) return Promise.reject(Error('Unsupported OpenClaw read method'));
  const cli = resolveCli();
  if (!cli) return Promise.reject(Object.assign(Error('OpenClaw CLI not installed'), { code: 'ENOENT' }));
  // Use the CLI's existing authentication, never copy tokens into this app or browser.
  let executable = cli, args = ['gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--timeout', '8000'];
  // Windows command wrappers are not shell-executed. Resolve the npm entry point.
  if (/\.cmd$/i.test(cli)) {
    const entry = path.join(path.dirname(cli), 'node_modules/openclaw/openclaw.mjs');
    if (!fs.existsSync(entry)) return Promise.reject(Error('OpenClaw Node entry point unavailable'));
    executable = process.execPath; args = [entry, ...args];
  }
  return new Promise((resolve, reject) => execFile(executable, args, { signal, timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' } }, (error, stdout) => {
    if (error) return reject(Object.assign(Error('OpenClaw Gateway read failed'), { code: error.code }));
    try { resolve(JSON.parse(stdout)); } catch { reject(Error('Invalid OpenClaw Gateway response')); }
  }));
}
function stateOf(row) {
  if (row.hasActiveRun === true || row.status === 'running' || row.activeRunIds?.length) return 'running';
  if (['error', 'failed'].includes(row.status)) return 'failed';
  if (row.status === 'aborted' || row.abortedLastRun) return 'cancelled';
  if (['waiting', 'blocked', 'needs_user'].includes(row.status)) return 'waiting';
  if (row.status === 'done') return 'observed_ended'; // A turn ending is NOT goal completion.
  return 'observed_idle';
}
function projectRoot(row, preview) {
  const channel = clean(row.groupChannel || row.label || row.displayName || row.key, 160);
  const lastUser = [...(preview?.items || [])].reverse().find(m => m.role === 'user');
  return {
    id: identity(row), source: 'openclaw', readOnly: true, scope: 'session',
    goal: channel + (lastUser?.text ? ' · ' + clean(lastUser.text, 240) : ''),
    status: stateOf(row), createdAt: row.startedAt || row.lastInteractionAt || row.updatedAt,
    updatedAt: row.updatedAt, projectPath: clean(row.workspaceDir || row.projectPath, 500),
    coordinator: { tool: 'openclaw', agentId: row.agentId, label: channel, model: clean(row.model, 160) },
    external: { sessionKey: row.key, sessionId: row.sessionId, agentId: row.agentId, channel, lastInteractionAt: row.lastInteractionAt, hasActiveRun: row.hasActiveRun === true },
  };
}
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function nativeChildren(messages) {
  const calls = new Map(), children = new Map();
  const keyOf = m => m.__openclaw?.runId || 'historical';
  for (const m of messages) {
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'toolCall' && /(?:^|[.])(?:spawn_agent|followup_task)$/.test(b.name || '')) {
      let args = b.arguments || b.input || {};
      if (typeof args.arguments === 'string') args = parseJson(args.arguments) || {};
      calls.set(b.id, { args, name: b.name, at: m.timestamp, runId: keyOf(m) });
    }
    if (m.role !== 'toolResult' || m.isError) continue;
    const result = parseJson(textOf(m));
    if (/(?:^|[.])spawn_agent$/.test(m.toolName || '') && result?.task_name) {
      const call = calls.get(m.toolCallId), runId = call?.runId || keyOf(m), name = clean(result.task_name, 160), id = runId + ':' + name;
      children.set(id, { id, goal: name, state: 'observed_unknown', binding: { tool: 'openclaw', label: name, model: clean(call?.args?.model, 160) }, createdAt: call?.at || m.timestamp, updatedAt: m.timestamp, source: 'native', runId, evidence: 'spawn_receipt' });
    }
    if (/(?:^|[.])followup_task$/.test(m.toolName || '')) {
      const call = calls.get(m.toolCallId), target = clean(call?.args?.target, 160);
      if (target) for (const child of children.values()) if (child.runId === call.runId && (child.goal === target || child.goal === '/root/' + target)) {
        child.state = 'observed_unknown'; child.updatedAt = m.timestamp; child.evidence = 'followup_receipt'; delete child.recordedState;
      }
    }
    if (/(?:^|[.])list_agents$/.test(m.toolName || '') && Array.isArray(result?.agents)) for (const a of result.agents) {
      if (!a.agent_name || a.agent_name === '/root') continue;
      const id = keyOf(m) + ':' + a.agent_name, old = children.get(id);
      const terminal = { completed: 'observed_ended', done: 'observed_ended', failed: 'failed', cancelled: 'cancelled' }[a.agent_status];
      children.set(id, { ...old, id, goal: clean(a.agent_name, 160), binding: old?.binding || { tool: 'openclaw', label: clean(a.agent_name, 160) }, state: terminal || 'observed_unknown', createdAt: old?.createdAt || m.timestamp, updatedAt: m.timestamp, source: 'native', runId: keyOf(m), evidence: 'agent_list_snapshot', recordedState: clean(a.agent_status, 40) });
    }
  }
  return [...children.values()].slice(-40);
}
function projectDetail(row, history, previews, audit) {
  const root = projectRoot({ ...row, ...history.sessionInfo, key: row.key, sessionId: row.sessionId, agentId: row.agentId }, previews);
  const messages = history.messages || [], tasks = nativeChildren(messages);
  const conversation = [];
  for (const m of messages) {
    if (!['user', 'assistant'].includes(m.role) || ['analysis', 'thinking'].includes(m.channel)) continue;
    // Analysis/thinking, tool arguments and raw tool outputs are never projected.
    const value = textOf(m); if (!value) continue;
    if (conversation.at(-1)?.text === value && conversation.at(-1)?.role === m.role) continue;
    conversation.push({ id: m.__openclaw?.id, role: m.role, text: value, at: m.timestamp, runId: m.__openclaw?.runId });
  }
  const runs = new Map();
  for (const e of [...(audit?.events || [])].sort((a,b) => a.occurredAt-b.occurredAt)) {
    if (e.kind !== 'agent_run' || e.sessionId !== row.sessionId || !e.runId) continue;
    const run = runs.get(e.runId) || { id: e.runId, startedAt: e.occurredAt };
    if (e.action === 'agent.run.started') { run.startedAt = e.occurredAt; run.state = 'observed_unknown'; }
    else { run.endedAt = e.occurredAt; run.state = e.status === 'succeeded' ? 'observed_ended' : e.status === 'cancelled' ? 'cancelled' : e.status === 'failed' || e.status === 'timed_out' ? 'failed' : 'observed_unknown'; }
    runs.set(e.runId, run);
  }
  if (history.inFlightRun?.runId) {
    const f = history.inFlightRun, run = runs.get(f.runId) || { id: f.runId };
    run.state = 'running'; run.startedAt = f.startedAt || row.startedAt; runs.set(f.runId, run);
  }
  const activity = new Map();
  for (const group of history.activity || []) for (const a of group.items || []) {
    if (a.itemId) activity.set(a.itemId, { name: clean(a.name || a.title, 100), status: clean(a.status, 40) || 'unknown' });
  }
  return { root, tasks, attempts: [], events: [], external: {
    scope: 'session', conversation: conversation.slice(-30), runs: [...runs.values()].reverse().slice(0, 60),
    activity: [...activity.values()].slice(-20),
    partialHistory: !!history.hasMore || !!history.truncated || conversation.length > 30,
    partialRuns: !!audit?.nextCursor, auditUnavailable: !audit, checkedAt: Date.now(),
    delegationCoverage: 'recorded',
  } };
}
function createOpenClawMonitor({ read = gatewayRead, now = Date.now, ttl = 4000 } = {}) {
  let cached = null, lastAttempt = 0, pending = null, rows = new Map(), previews = new Map();
  const details = new Map(), detailPending = new Map();
  async function list() {
    if (cached && now() - lastAttempt < ttl) return cached;
    if (pending) return pending;
    pending = (async () => {
      lastAttempt = now();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
      const boundedRead = (method, params) => new Promise((resolve, reject) => {
        const abort = () => reject(Error('OpenClaw source deadline exceeded'));
        if (controller.signal.aborted) return abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => read(method, params, { signal: controller.signal })).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
      });
      try {
        const all = []; let offset = 0, more = false;
        for (let page = 0; page < 3; page++) {
          const data = await boundedRead('sessions.list', { limit: 100, offset, activeMinutes: 1440, includeDerivedTitles: false, includeLastMessage: false, excludeCron: true, excludeSystem: true, archived: false });
          all.push(...(data.sessions || [])); more = !!data.hasMore;
          if (!more || !Number.isInteger(data.nextOffset) || data.nextOffset <= offset) break;
          offset = data.nextOffset;
        }
        const next = new Map(all.filter(r => r.key && r.sessionId && r.agentId).map(r => [identity(r), r]));
        // Text previews are optional; a preview outage must not hide live states.
        const previewMap = new Map(); let previewUnavailable = false;
        for (let index = 0; index < all.length; index += 30) {
          try {
            const result = await boundedRead('sessions.preview', { keys: all.slice(index, index+30).map(r => r.key), limit: 6, maxChars: 300 });
            for (const p of result.previews || []) if (p.status === 'ok') previewMap.set(p.key, p);
          } catch { previewUnavailable = true; }
        }
        rows = next; previews = previewMap;
        for (const id of details.keys()) if (!rows.has(id)) details.delete(id);
        const roots = [...rows.values()].filter(r => !r.spawnedBy).map(row => projectRoot(row, previews.get(row.key)));
        cached = { status: 'ok', roots, checkedAt: now(), truncated: more, previewUnavailable, windowHours: 24 };
      } catch (error) {
        cached = { status: error.code === 'ENOENT' ? 'unavailable' : 'offline', roots: (cached?.roots || []).map(root => ({ ...root, status: 'observed_stale', external: { ...root.external, stale: true } })), checkedAt: cached?.checkedAt || null, windowHours: 24 };
      }
      clearTimeout(timer);
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function get(id) {
    if (!/^oc-[a-f0-9]{32}$/.test(id)) throw Error('Invalid OpenClaw record ID');
    const source = await list();
    if (source.status !== 'ok') throw Error('OpenClaw 연결을 확인해 주세요. 현재 상태는 확인되지 않았습니다.');
    const row = rows.get(id); if (!row) throw Error('현재 조회 범위에 없는 OpenClaw 기록입니다. 목록을 새로고침해 주세요.');
    if (details.has(id) && now()-details.get(id).at < ttl) return details.get(id).value;
    if (detailPending.has(id)) return detailPending.get(id);
    const request = (async () => {
      const [history, audit] = await Promise.all([
        read('chat.history', { sessionKey: row.key, agentId: row.agentId, limit: 500, maxBytes: 700000, maxChars: 2000 }),
        read('audit.activity.list', { sessionKey: row.key, agentId: row.agentId, kind: 'agent_run', limit: 120 }).catch(() => null),
      ]);
      if ((history.sessionId ?? history.sessionInfo?.sessionId) !== row.sessionId || !rows.has(id)) { lastAttempt = 0; throw Error('대화가 재설정되었습니다. 목록을 새로고침해 주세요.'); }
      const value = projectDetail(row, history, previews.get(row.key), audit);
      // Visible OpenClaw child sessions use their own authoritative roster state.
      for (const child of rows.values()) if (child.spawnedBy === row.key) value.tasks.push({ id: identity(child), goal: clean(child.label || child.displayName || child.key, 300), state: stateOf(child), source: 'session', binding: { tool: 'openclaw', label: child.agentId, model: child.model }, updatedAt: child.updatedAt, evidence: 'session_snapshot' });
      details.set(id, { at: now(), value }); return value;
    })().finally(() => detailPending.delete(id));
    detailPending.set(id, request); return request;
  }
  return { list, get };
}
module.exports = { createOpenClawMonitor, gatewayRead, projectRoot, projectDetail, nativeChildren, identity, stateOf };
