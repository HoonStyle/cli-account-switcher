'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const EMPTY = () => ({
  version: 1,
  claude: { active: 'default', profiles: ['default'] },
  codex: { active: 'default', profiles: ['default'] },
  // API-key provider categories (api-provider.js): no default account, no profile homes.
  exaone: { active: null, profiles: [] },
  'gemini-api': { active: null, profiles: [] },
  realBin: {},
  statusLineOriginal: null,
  apiFetch: false, // optional server-side usage lookup
  usageMode: 'used', // 'used' | 'remaining' — how percentages are displayed
  density: 'compact', // 'compact' (one line per account) | 'comfortable' (two lines)
  zoom: 1, // UI scale: 1 | 1.1 | 1.25 | 1.5
});

function setSetting(key, value) {
  const state = load();
  state[key] = value;
  save(state);
  return state;
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(P.STATE_FILE, 'utf8'));
    const base = EMPTY();
    const merged = { ...base, ...s };
    for (const t of [...P.TOOLS, ...(P.PROVIDERS || [])]) merged[t] = { ...base[t], ...(s[t] || {}) };
    return merged;
  } catch {
    return EMPTY();
  }
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function save(state) {
  fs.mkdirSync(P.ROOT, { recursive: true, mode: 0o700 });
  fs.mkdirSync(P.ACTIVE_DIR, { recursive: true });
  writeAtomic(P.STATE_FILE, JSON.stringify(state, null, 2));
  // Plain-text mirrors so the shell shims can read them with cat / set /p.
  for (const tool of P.TOOLS) {
    writeAtomic(path.join(P.ACTIVE_DIR, tool), state[tool].active + '\n');
    writeAtomic(path.join(P.ACTIVE_DIR, tool + '.real'), ((state.realBin || {})[tool] || '') + '\n');
  }
}

// Any letters/digits (Korean included), plus . _ - and spaces inside; no path separators or leading dot.
function validName(name) {
  return typeof name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,40}$/u.test(name) && !/[\\/:*?"<>|]/.test(name) && name.trim() === name;
}

// Home directory a profile resolves to. "default" = the tool's own home, no env override.
function profileHome(tool, name) {
  if (name === 'default') return P.DEFAULT_HOME[tool];
  return path.join(P.PROFILES_DIR[tool], name);
}

// Codex reconciles these plugin paths against each account's own ChatGPT install list and
// deletes entries that list lacks. Shared across accounts, they make accounts remove and
// reinstall each other's connector plugins every few minutes, which also changes the skill
// list in Codex instructions and re-injects the whole instruction block into long threads.
// Keep them per profile; everything else under plugins/ stays linked to the default home.
const CODEX_PER_PROFILE_PLUGIN_PATHS = ['.remote-plugin-install-staging', path.join('cache', 'openai-curated-remote')];

function linkDir(from, to) {
  fs.symlinkSync(from, to, P.IS_WIN ? 'junction' : undefined);
}

// Build (or top up) a real plugins/ directory whose shared entries link to `srcPlugins` and
// whose per-profile paths are real directories. Idempotent: existing entries are left alone.
function linkCodexPlugins(srcPlugins, dstPlugins) {
  const linked = [];
  if (fs.existsSync(dstPlugins) && fs.lstatSync(dstPlugins).isSymbolicLink()) return linked;
  fs.mkdirSync(dstPlugins, { recursive: true, mode: 0o700 });
  const perProfile = new Set(CODEX_PER_PROFILE_PLUGIN_PATHS);
  const walk = (rel) => {
    const src = path.join(srcPlugins, rel);
    for (const entry of fs.readdirSync(src)) {
      const childRel = rel ? path.join(rel, entry) : entry;
      if (perProfile.has(childRel)) continue;
      const to = path.join(dstPlugins, childRel);
      // Descend into a parent of a per-profile path; link everything else whole.
      if (CODEX_PER_PROFILE_PLUGIN_PATHS.some((p) => p.startsWith(childRel + path.sep))) {
        fs.mkdirSync(to, { recursive: true, mode: 0o700 });
        walk(childRel);
        continue;
      }
      if (fs.existsSync(to) || isLink(to)) continue;
      const from = path.join(srcPlugins, childRel);
      if (fs.statSync(from).isDirectory()) linkDir(from, to);
      else fs.symlinkSync(from, to);
      linked.push(path.join('plugins', childRel));
    }
  };
  if (fs.existsSync(srcPlugins)) walk('');
  for (const rel of CODEX_PER_PROFILE_PLUGIN_PATHS) fs.mkdirSync(path.join(dstPlugins, rel), { recursive: true, mode: 0o700 });
  return linked;
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function linkShared(tool, home) {
  const src = P.configDir(tool, P.DEFAULT_HOME[tool]);
  const dst = P.configDir(tool, home);
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  const linked = [];
  for (const item of P.SHARE_ALLOWLIST[tool]) {
    const from = path.join(src, item);
    const to = path.join(dst, item);
    if (tool === 'codex' && item === 'plugins') {
      if (fs.existsSync(from) && !fs.existsSync(to)) linked.push(...linkCodexPlugins(from, to));
      continue;
    }
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    const isDir = fs.statSync(from).isDirectory();
    try {
      fs.symlinkSync(from, to, P.IS_WIN ? (isDir ? 'junction' : 'file') : undefined);
      linked.push(item);
    } catch (e) {
      // Windows file symlinks need privileges; fall back to a one-time copy for files.
      if (!isDir) {
        fs.copyFileSync(from, to);
        linked.push(item + ' (copied)');
      }
    }
  }
  return linked;
}

const isAscii = (s) => /^[\x20-\x7E]*$/.test(s);

// folder: 'same'   → folder id = name (must be a valid path segment)
//         'random' → folder id = acct-xxxxxx, name kept as display label
//         'auto'   → 'same' for ASCII names, 'random' otherwise (keeps paths ASCII on Windows)
function addProfile(tool, name, { shareSettings = true, folder = 'auto' } = {}) {
  if (!validName(name)) throw new Error('이름은 글자·숫자·공백·._- 만, 41자 이내 (앞뒤 공백 불가)');
  const state = load();
  if (state[tool].profiles.includes(name) || state[tool].profiles.some((p) => label(state, tool, p) === name)) throw new Error('이미 있는 계정 이름입니다');
  const mode = folder === 'auto' ? (isAscii(name) ? 'same' : 'random') : folder;
  let id = name;
  if (mode === 'random') {
    do { id = 'acct-' + require('crypto').randomBytes(3).toString('hex'); }
    while (state[tool].profiles.includes(id) || fs.existsSync(profileHome(tool, id)));
  }
  const home = profileHome(tool, id);
  fs.mkdirSync(P.configDir(tool, home), { recursive: true, mode: 0o700 });
  const linked = shareSettings ? linkShared(tool, home) : [];
  state[tool].profiles.push(id);
  if (id !== name) state[tool].labels = { ...(state[tool].labels || {}), [id]: name };
  save(state);
  return { id, label: name, home, linked };
}

function removeProfile(tool, nameOrLabel, { deleteFiles = false } = {}) {
  const state = load();
  const name = resolve(tool, nameOrLabel, state);
  if (name === 'default') throw new Error('기본 계정은 삭제할 수 없습니다');
  state[tool].profiles = state[tool].profiles.filter((p) => p !== name);
  if (state[tool].labels) delete state[tool].labels[name];
  if (tool === 'codex' && state.codex.resetCreditAutoUse) delete state.codex.resetCreditAutoUse[name];
  if (state.apiMeta) delete state.apiMeta[`${tool}/${name}`];
  if (state[tool].active === name) state[tool].active = 'default';
  save(state);
  require('./api-keys').remove(tool, name);
  if (deleteFiles) fs.rmSync(profileHome(tool, name), { recursive: true, force: true });
}

// Profile ids (folder names) are immutable because paths are baked into env vars and, on
// macOS, into Claude's Keychain item name. Display names live in state[tool].labels instead.
function label(state, tool, id) {
  const l = state[tool].labels && state[tool].labels[id];
  return l || id;
}

// Accept either the id or the current label; returns the id.
function resolve(tool, nameOrLabel, state = load()) {
  if (state[tool].profiles.includes(nameOrLabel)) return nameOrLabel;
  const hit = state[tool].profiles.find((id) => label(state, tool, id) === nameOrLabel);
  if (!hit) throw new Error(`없는 계정입니다: ${nameOrLabel}`);
  return hit;
}

function rename(tool, nameOrLabel, newLabel) {
  if (!validName(newLabel)) throw new Error('이름은 글자·숫자·공백·._- 만, 41자 이내 (앞뒤 공백 불가)');
  const state = load();
  const id = resolve(tool, nameOrLabel, state);
  const taken = state[tool].profiles.some((p) => p !== id && (p === newLabel || label(state, tool, p) === newLabel));
  if (taken) throw new Error('이미 쓰는 이름입니다');
  state[tool].labels = { ...(state[tool].labels || {}) };
  if (newLabel === id) delete state[tool].labels[id]; else state[tool].labels[id] = newLabel;
  save(state);
  return { id, label: newLabel };
}

function setActive(tool, name) {
  const state = load();
  const id = resolve(tool, name, state);
  state[tool].active = id;
  save(state);
  return state;
}

module.exports = { load, save, validName, profileHome, addProfile, removeProfile, setActive, setSetting, label, resolve, rename, linkCodexPlugins, CODEX_PER_PROFILE_PLUGIN_PATHS };
