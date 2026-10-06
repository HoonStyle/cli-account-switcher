'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const store = require('../store');

function executable(file, tool) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`Missing absolute executable for ${tool}`);
  let real;
  try {
    real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) throw new Error('not a file');
    fs.accessSync(real, P.IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
  } catch { throw new Error(`Missing executable for ${tool}: ${file}`); }
  for (const name of [...P.TOOLS, 'cli-accounts']) {
    for (const suffix of ['', '.cmd']) {
      const shim = path.join(P.BIN_DIR, name + suffix);
      let target = shim;
      try { target = fs.realpathSync(shim); } catch {}
      if (real === target) throw new Error('Refusing recursive account shim');
    }
  }
  // Also reject copies of this application's generated launchers.
  const fd = fs.openSync(real, 'r');
  let header;
  try { const b = Buffer.alloc(1024); header = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString(); }
  finally { fs.closeSync(fd); }
  if (/cli-account-switcher shim|bin\/lib\/launch\/run\.js/.test(header)) throw new Error('Refusing recursive account shim');
  if (P.IS_WIN && /\.(cmd|bat)$/i.test(real)) throw new Error('Pinned launch requires a native executable on Windows; batch wrappers are unsupported');
  return real;
}

function resolveProfile(tool, profile, options = {}) {
  if (!P.TOOLS.includes(tool)) throw new Error(`Unsupported tool: ${tool}`);
  // store.load is deliberately forgiving for UI startup; launches fail closed on corrupt state.
  if (fs.existsSync(P.STATE_FILE)) JSON.parse(fs.readFileSync(P.STATE_FILE, 'utf8'));
  const state = store.load();
  const selected = profile == null ? state[tool].active : profile;
  const profileId = store.resolve(tool, selected, state);
  if (!store.validName(profileId)) throw new Error('Invalid profile ID');
  const configuredHome = store.profileHome(tool, profileId);
  // Only resolution for first login may tolerate an absent default directory.
  // Canonicalize existing homes so retargeting a profile symlink invalidates a binding.
  const exists = fs.existsSync(configuredHome);
  if ((!exists && profileId !== 'default') || (exists && !fs.statSync(configuredHome).isDirectory())) throw new Error(`Missing profile home: ${profileId}`);
  const home = exists ? fs.realpathSync(configuredHome) : configuredHome;
  const file = options.executable || (state.realBin || {})[tool] || require('../wrappers').which(tool);
  return { tool, profileId, home, executable: executable(file, tool) };
}

function validateBinding(binding) {
  if (!binding || typeof binding !== 'object') throw new Error('Invalid binding');
  const current = resolveProfile(binding.tool, binding.profileId);
  if (!fs.existsSync(current.home) || !fs.statSync(current.home).isDirectory()) throw new Error('Missing bound profile home');
  if (current.home !== binding.home || current.executable !== binding.executable) throw new Error('Profile binding changed; explicit rebind required');
  return current;
}

function launchEnv(binding, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (/^(CODEX_HOME|CLAUDE_CONFIG_DIR|CODEX_PROFILE|CLAUDE_PROFILE|OPENAI_.*|CODEX_API_KEY|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR|CLAUDE_CODE_API_KEY_HELPER_TTL_MS|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|AWS_.*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|CLOUD_ML_REGION|AZURE_.*)$/i.test(key)) delete env[key];
  }
  if (binding.tool === 'claude' && binding.profileId === 'default') {
    // Claude's native default uses ~/.claude.json as well as ~/.claude. Explicitly
    // setting CLAUDE_CONFIG_DIR relocates that file and is NOT equivalent to default.
    // Pin the native user home after removing inherited account overrides above.
    env.HOME = P.HOME;
    if (P.IS_WIN) env.USERPROFILE = P.HOME;
  } else env[P.ENV_VAR[binding.tool]] = binding.home;
  return env;
}
module.exports = { resolveProfile, validateBinding, launchEnv };
