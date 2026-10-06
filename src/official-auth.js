'use strict';
// Ask the unmodified official CLI about login. Never return raw stdout/stderr:
// some CLI versions include key prefixes or other account details in diagnostics.
const { execFileSync } = require('child_process');
const { resolveProfile, launchEnv } = require('./launch/profile-resolver');
const store = require('./store');
const cache = new Map();
function invalidate(home) { cache.delete(home); }
function codexIdentity(home) {
  const hit = cache.get(home);
  if (hit && Date.now() - hit.at < 60000) return hit.info;
  let info = { email: null, plan: null, loggedIn: false, authMode: null };
  try {
    const state = store.load();
    const profile = state.codex.profiles.find(id => store.profileHome('codex', id) === home);
    if (!profile) throw new Error('Unknown profile');
    const binding = resolveProfile('codex', profile);
    execFileSync(binding.executable, ['login', 'status'], {
      env: launchEnv(binding), timeout: 8000, stdio: 'ignore', windowsHide: true,
    });
    info = { ...info, loggedIn: true };
  } catch {}
  cache.set(home, { at: Date.now(), info });
  return info;
}
module.exports = { codexIdentity, invalidate };
