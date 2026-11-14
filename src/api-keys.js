'use strict';
// Per-profile API keys, kept separate from subscription logins.
//   claude: stored here (0600 file under <ROOT>/api-keys/claude/<profileId>) and injected
//           as ANTHROPIC_API_KEY only into processes launched for that exact profile.
//   exaone: stored the same way under <ROOT>/api-keys/exaone/<profileId>; exaone.js injects
//           it as EXAONE_API_KEY / OPENAI_API_KEY into commands run for that account.
//   codex:  handed to the official `codex login --with-api-key` (stdin) with that profile's
//           CODEX_HOME, so Codex keeps it in its own credential store. Nothing is stored here.
// Keys are never accepted on argv and never printed.
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const DIR = path.join(P.ROOT, 'api-keys');
// Tools whose keys this module stores itself (file-backed).
const FILE_TOOLS = new Set(['claude', 'exaone']);

function validId(id) {
  return typeof id === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,40}$/u.test(id) && !/[\\/:*?"<>|]/.test(id) && id.trim() === id;
}
function keyFile(tool, profileId) {
  if (!FILE_TOOLS.has(tool)) throw new Error(`API 키 파일은 claude·exaone 전용입니다: ${tool}`);
  if (!validId(profileId)) throw new Error('Invalid profile ID');
  return path.join(DIR, tool, profileId);
}

function normalize(raw) {
  const key = String(raw ?? '').trim();
  if (!key) throw new Error('API 키가 비어 있습니다');
  if (/\s/.test(key)) throw new Error('API 키에 공백이나 줄바꿈이 있습니다');
  if (key.length < 16 || key.length > 1024) throw new Error('API 키 길이가 올바르지 않습니다');
  return key;
}

function mask(key) { return key ? `…${key.slice(-4)}` : null; }

function read(tool, profileId) {
  if (!FILE_TOOLS.has(tool) || !validId(profileId)) return null;
  try { return fs.readFileSync(keyFile(tool, profileId), 'utf8').trim() || null; } catch { return null; }
}

function write(tool, profileId, raw) {
  const key = normalize(raw);
  const file = keyFile(tool, profileId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { masked: mask(key) };
}

function remove(tool, profileId) {
  if (!FILE_TOOLS.has(tool) || !validId(profileId)) return false;
  try { fs.unlinkSync(keyFile(tool, profileId)); return true; } catch { return false; }
}

function status(tool, profileId) {
  const key = read(tool, profileId);
  return { apiKey: Boolean(key), masked: mask(key) };
}

// Codex reports its auth mode in `login status`; only a boolean leaves this function.
function codexApiKeyMode(binding) {
  const { launchEnv } = require('./launch/profile-resolver');
  const r = require('child_process').spawnSync(binding.executable, ['login', 'status'], { env: launchEnv(binding), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { loggedIn: r.status === 0, apiKey: r.status === 0 && /api key/i.test(`${r.stdout || ''}\n${r.stderr || ''}`) };
}

// Register a key for an existing profile. Returns { masked, home }. stdio: how codex output is shown.
function register(tool, profileId, raw, { stdio = 'pipe' } = {}) {
  const key = normalize(raw);
  if (tool === 'claude') {
    const r = write('claude', profileId, key);
    return { masked: r.masked, warning: /^sk-ant-/.test(key) ? null : 'Anthropic API 키는 보통 sk-ant- 로 시작합니다' };
  }
  if (tool === 'exaone') {
    const r = write('exaone', profileId, key);
    return { masked: r.masked, warning: /^sk-/.test(key) ? null : 'EXAONE API 키는 보통 sk- 로 시작합니다' };
  }
  if (tool !== 'codex') throw new Error(`Unsupported tool: ${tool}`);
  const { resolveProfile, launchEnv } = require('./launch/profile-resolver');
  const binding = resolveProfile('codex', profileId);
  const out = stdio === 'inherit' ? 'inherit' : 'pipe';
  const r = require('child_process').spawnSync(binding.executable, ['login', '--with-api-key'], { env: launchEnv(binding), input: key + '\n', stdio: ['pipe', out, out], timeout: 60000, windowsHide: true });
  if (r.error) throw r.error;
  // Never surface raw codex output in errors: it may echo key material.
  if (r.status !== 0) throw new Error(`codex login --with-api-key 실패 (종료 코드 ${r.status})`);
  return { masked: mask(key), home: binding.home, warning: null };
}

// Remove a key. Codex is logged out only when it is in API-key mode.
function unregister(tool, profileId, { stdio = 'pipe' } = {}) {
  if (FILE_TOOLS.has(tool)) return { removed: remove(tool, profileId) };
  if (tool !== 'codex') throw new Error(`Unsupported tool: ${tool}`);
  const { resolveProfile, launchEnv } = require('./launch/profile-resolver');
  const binding = resolveProfile('codex', profileId);
  if (!codexApiKeyMode(binding).apiKey) throw new Error('API 키 로그인이 아닙니다. 구독 로그인은 건드리지 않습니다.');
  const r = require('child_process').spawnSync(binding.executable, ['logout'], { env: launchEnv(binding), stdio: stdio === 'inherit' ? 'inherit' : 'ignore', timeout: 30000, windowsHide: true });
  if (r.status !== 0) throw new Error(`codex logout 실패 (종료 코드 ${r.status})`);
  return { removed: true };
}

module.exports = { read, write, remove, status, normalize, mask, register, unregister, codexApiKeyMode, DIR };
