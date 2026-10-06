'use strict';
// Claude Code profile inspection. Reads only non-secret identity fields and the
// usage cache written by the status line hook. Tokens are never read here.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const edition = require('./edition.json');
const cred = edition.credentialMetadata ? require('./claude-cred') : { plan: () => ({}) };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Primary identity source: `claude auth status` (official CLI command, JSON: loggedIn, email,
// orgName, subscriptionType). Run against the real binary with CLAUDE_CONFIG_DIR set for
// non-default homes, so it works regardless of where the token is stored. ~0.3 s, cached 60 s.
const { execFileSync } = require('child_process');
const AUTH_TTL_MS = 60 * 1000;
const authCache = new Map(); // home -> { at, info }

function realClaude() {
  try { const rb = require('./store').load().realBin; if (rb && rb.claude && fs.existsSync(rb.claude)) return rb.claude; } catch {}
  return null;
}

function authStatus(home) {
  const hit = authCache.get(home);
  if (hit && Date.now() - hit.at < AUTH_TTL_MS) return hit.info;
  let info = null;
  const bin = realClaude();
  if (bin) {
    const env = require('./launch/profile-resolver').launchEnv({ tool: 'claude', profileId: home === P.DEFAULT_HOME.claude ? 'default' : 'profile', home });
    try {
      const out = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', env, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const j = JSON.parse(out.slice(out.indexOf('{')));
      info = { loggedIn: Boolean(j.loggedIn), email: j.email || null, org: j.orgName || null, subscriptionType: j.subscriptionType || null, authMethod: j.authMethod || null };
    } catch { info = null; }
  }
  authCache.set(home, { at: Date.now(), info });
  return info;
}
function invalidate(home) { authCache.delete(home); }

function identity(home) {
  const s = authStatus(home);
  if (s) {
    const c = s.loggedIn ? cred.plan(home) : {};
    const sub = s.subscriptionType;
    return {
      email: s.email, org: s.org,
      plan: c.plan || (sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : null),
      planDetail: c.rateLimitTier || (s.authMethod ? `로그인 방식: ${s.authMethod}` : null),
      loggedIn: s.loggedIn,
    };
  }
  if (!edition.credentialMetadata) return { email: null, org: null, plan: null, loggedIn: false };
  // Fallback when the CLI is unavailable: account metadata in <home>/.claude.json
  // (CLAUDE_CONFIG_DIR set) or ~/.claude.json (default home).
  const candidates = home === P.DEFAULT_HOME.claude
    ? [path.join(P.HOME, '.claude.json'), path.join(home, '.claude.json')]
    : [path.join(home, '.claude.json')];
  for (const f of candidates) {
    const j = readJson(f);
    const a = j && j.oauthAccount;
    if (a) {
      const c = cred.plan(home);
      return {
        email: a.emailAddress || null,
        org: a.organizationName || null,
        plan: c.plan || a.subscriptionType || (a.billingType === 'stripe_subscription' ? '구독' : a.billingType) || null,
        planDetail: c.rateLimitTier || null,
        loggedIn: true,
      };
    }
  }
  return { email: null, org: null, plan: null, loggedIn: false };
}

function usage(home) {
  const j = readJson(path.join(home, P.USAGE_CACHE_NAME));
  if (!j || !j.rate_limits) return null;
  const r = j.rate_limits;
  const win = (w) => (w ? { usedPercent: w.used_percentage ?? null, resetsAt: w.resets_at ?? null } : null);
  return {
    capturedAt: j.captured_at || null,
    source: j.source || 'statusline',
    fiveHour: win(r.five_hour),
    sevenDay: win(r.seven_day),
    extra: Object.keys(r).filter((k) => !['five_hour', 'seven_day'].includes(k)).map((k) => ({ name: k, ...win(r[k]) })),
  };
}

function inspect(home) {
  return { ...identity(home), usage: usage(home), home };
}

module.exports = { inspect, invalidate };
