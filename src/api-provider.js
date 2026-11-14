'use strict';
// API-key provider categories (EXAONE, Gemini API). Each provider is OpenAI-compatible and
// has no CLI home to isolate, so it sits beside Claude/Codex as its own category and is never
// a member of paths.TOOLS: not pinned, shimmed, or delegated. Keys are stored by api-keys
// (0600 files) and injected only into commands launched for the selected account. Keys are
// never printed, logged, or kept in state.json.
//
// create(config) returns one provider module. Config:
//   id          state section / api-keys folder / CLI command (e.g. 'exaone', 'gemini-api')
//   aliases     extra CLI command names (e.g. ['gemini'])
//   label       UI label ('EXAONE API'); shortName is used in messages ('EXAONE')
//   baseUrl     OpenAI-compatible base URL injected as OPENAI_BASE_URL
//   model       default model name injected as <PREFIX>_MODEL, or null when the tool picks
//   docs        documentation URL opened from the panel
//   strip       RegExp of inherited variable names removed before injection
//   env(key, p) variables for a child process (values); envNames lists the names
//   keyWarning  { pattern, text } non-fatal hint when a key does not look like the provider's
//   check       { url(p), headers(key), models(body), rateLimits(headers) } live connectivity probe
const { spawn } = require('child_process');
const store = require('./store');
const keys = require('./api-keys');

const CHECK_TIMEOUT_MS = 8000;
const NAME_RULE = '이름은 글자·숫자·공백·._- 만, 41자 이내 (앞뒤 공백 불가)';

function create(config) {
  const ID = config.id, LABEL = config.label, SHORT = config.shortName || config.label;
  const BASE_URL = config.baseUrl, MODEL = config.model || null, DOCS = config.docs;
  const CLI = `cli-accounts ${ID}`;
  const provider = { ID, LABEL, SHORT, BASE_URL, MODEL, DOCS, ALIASES: config.aliases || [], KEY_HINT: config.keyHint || null };

  function label(state, id) { return (state[ID].labels && state[ID].labels[id]) || id; }

  // Accept either the id or the current label; returns the id.
  function resolve(nameOrLabel, state = store.load()) {
    if (state[ID].profiles.includes(nameOrLabel)) return nameOrLabel;
    const hit = state[ID].profiles.find((id) => label(state, id) === nameOrLabel);
    if (!hit) throw new Error(`없는 ${SHORT} 계정입니다: ${nameOrLabel}`);
    return hit;
  }

  // The active account is used when no name is given. Throws when no account exists.
  function selected(nameOrLabel, state = store.load()) {
    if (nameOrLabel != null && nameOrLabel !== '') return resolve(nameOrLabel, state);
    if (!state[ID].active) throw new Error(`${SHORT} 계정이 없습니다. ${CLI} add <name> 으로 추가하세요.`);
    return state[ID].active;
  }

  function add(name) {
    if (!store.validName(name)) throw new Error(NAME_RULE);
    const state = store.load();
    if (state[ID].profiles.includes(name) || state[ID].profiles.some((p) => label(state, p) === name)) throw new Error('이미 있는 계정 이름입니다');
    state[ID].profiles.push(name);
    if (!state[ID].active) state[ID].active = name;
    store.save(state);
    return { id: name, label: name };
  }

  function remove(nameOrLabel) {
    const state = store.load();
    const id = resolve(nameOrLabel, state);
    state[ID].profiles = state[ID].profiles.filter((p) => p !== id);
    if (state[ID].labels) delete state[ID].labels[id];
    if (state[ID].checks) delete state[ID].checks[id];
    if (state[ID].active === id) state[ID].active = state[ID].profiles[0] || null;
    store.save(state);
    keys.remove(ID, id);
    return { id };
  }

  function rename(nameOrLabel, newLabel) {
    if (!store.validName(newLabel)) throw new Error(NAME_RULE);
    const state = store.load();
    const id = resolve(nameOrLabel, state);
    const taken = state[ID].profiles.some((p) => p !== id && (p === newLabel || label(state, p) === newLabel));
    if (taken) throw new Error('이미 쓰는 이름입니다');
    state[ID].labels = { ...(state[ID].labels || {}) };
    if (newLabel === id) delete state[ID].labels[id]; else state[ID].labels[id] = newLabel;
    store.save(state);
    return { id, label: newLabel };
  }

  function setActive(nameOrLabel) {
    const state = store.load();
    const id = resolve(nameOrLabel, state);
    state[ID].active = id;
    store.save(state);
    return { id };
  }

  function forgetCheck(id) {
    const state = store.load();
    if (state[ID].checks && state[ID].checks[id]) { delete state[ID].checks[id]; store.save(state); }
  }

  // Register a key for an existing account. The raw value comes from stdin/hidden input/UI, never argv.
  function setKey(nameOrLabel, raw) {
    const id = resolve(nameOrLabel);
    const key = keys.normalize(raw);
    const r = keys.write(ID, id, key);
    forgetCheck(id);
    const warning = config.keyWarning && !config.keyWarning.pattern.test(key) ? config.keyWarning.text : null;
    return { id, masked: r.masked, warning };
  }

  function removeKey(nameOrLabel) {
    const id = resolve(nameOrLabel);
    const r = keys.unregister(ID, id);
    forgetCheck(id);
    return { id, removed: r.removed };
  }

  function missingKey(id) { return new Error(`${SHORT} / ${id}: API 키가 등록되지 않았습니다 (${CLI} apikey set ${id})`); }

  // Environment for a command run as this account. Only the selected account's key is present.
  function launchEnv(nameOrLabel, baseEnv = process.env) {
    const id = selected(nameOrLabel);
    const key = keys.read(ID, id);
    if (!key) throw missingKey(id);
    const env = {};
    for (const [k, v] of Object.entries(baseEnv)) if (!config.strip.test(k)) env[k] = v;
    for (const [k, v] of Object.entries(config.env(key, provider))) if (v != null) env[k] = v;
    return { id, env };
  }

  // Variables the child receives, without values; for display and documentation.
  function envNames() { return Object.entries(config.env('x', provider)).filter(([, v]) => v != null).map(([k]) => k); }

  // Run any OpenAI-compatible tool (agent CLI, script, curl) as this account.
  function run(nameOrLabel, argv, { cwd } = {}) {
    if (!Array.isArray(argv) || !argv.length) throw new Error(`사용법: ${CLI} run [name] -- <command> [args...]`);
    const { id, env } = launchEnv(nameOrLabel);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: 'inherit', shell: false });
      const handlers = ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => { try { child.kill(signal); } catch {} }]);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const cleanup = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
      child.once('error', (e) => { cleanup(); reject(e.code === 'ENOENT' ? new Error(`실행 파일을 찾을 수 없습니다: ${argv[0]}`) : e); });
      child.once('exit', (code, signal) => { cleanup(); resolvePromise({ id, code: code == null ? 1 : code, signal }); });
    });
  }

  // Live connectivity check (model listing). Error text is fixed wording; response bodies
  // and the key are never recorded. The result (no secrets) is kept in state.json for the UI.
  async function check(nameOrLabel, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const id = selected(nameOrLabel);
    const key = keys.read(ID, id);
    if (!key) throw missingKey(id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    let result;
    try {
      const r = await fetchImpl(config.check.url(provider), { headers: { ...config.check.headers(key), Accept: 'application/json' }, signal: controller.signal });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      const rateLimit = config.check.rateLimits ? config.check.rateLimits(r.headers) : null;
      if (!r.ok) {
        const error = r.status === 401 || r.status === 403 ? 'API 키가 거부되었습니다' : r.status === 429 ? '요청 한도 초과 (429)' : `HTTP ${r.status}`;
        result = { ok: false, status: r.status, error, models: [], rateLimit };
      } else {
        const models = (config.check.models(body) || []).filter((m) => typeof m === 'string').slice(0, 20);
        result = { ok: true, status: r.status, error: null, models, rateLimit };
      }
    } catch (e) {
      result = { ok: false, status: null, error: e && e.name === 'AbortError' ? '응답 시간 초과' : '네트워크 오류', models: [], rateLimit: null };
    } finally { clearTimeout(timer); }
    result.checkedAt = new Date(now()).toISOString();
    const state = store.load();
    state[ID].checks = { ...(state[ID].checks || {}), [id]: result };
    store.save(state);
    return { id, ...result };
  }

  function snapshot(state = store.load()) {
    const s = state[ID];
    return {
      mode: 'api-key', id: ID, label: LABEL, shortName: SHORT, baseUrl: BASE_URL, model: MODEL, docs: DOCS, envNames: envNames(), active: s.active,
      checkPath: config.check.describe || '', keyHint: provider.KEY_HINT,
      accounts: s.profiles.map((id) => ({ name: id, label: label(state, id), active: id === s.active, apiKey: keys.status(ID, id), check: (s.checks || {})[id] || null })),
    };
  }

  return Object.assign(provider, { label, resolve, selected, add, remove, rename, setActive, setKey, removeKey, launchEnv, envNames, run, check, snapshot });
}

function num(value) { const n = Number(value); return value != null && Number.isFinite(n) ? n : null; }

// Header-based rate limits of the form x-<window>-rate-limit(-remaining).
function windowRateLimits(windows) {
  return (headers) => {
    const out = {};
    for (const window of windows) {
      const limit = headers.get(`x-${window}-rate-limit`), remaining = headers.get(`x-${window}-rate-limit-remaining`);
      if (limit != null || remaining != null) out[window] = { limit: num(limit), remaining: num(remaining) };
    }
    return Object.keys(out).length ? out : null;
  };
}

module.exports = { create, windowRateLimits, NAME_RULE };
