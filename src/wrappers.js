'use strict';
// Installs PATH shims for `claude` and `codex` that read the active profile from
// state.json and exec the real binary with CLAUDE_CONFIG_DIR / CODEX_HOME set.
// Also installs the status line cache hook that persists Claude rate_limits.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');
const store = require('./store');

function which(cmd) {
  const tool = P.IS_WIN ? 'where' : 'which';
  const args = P.IS_WIN ? [cmd] : ['-a', cmd];
  let out = '';
  // A packaged app launched from Finder has launchd's minimal PATH; resolve with the login shell's PATH.
  const env = { ...process.env, PATH: effectivePath() };
  try { out = execFileSync(tool, args, { encoding: 'utf8', env }); } catch {}
  // Skip our own shim if it is already on PATH.
  const bin = path.resolve(P.BIN_DIR).toLowerCase();
  const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .filter((p) => !path.resolve(path.dirname(p)).toLowerCase().startsWith(bin));
  const usable = (file) => {
    try {
      const fd = fs.openSync(file, 'r');
      let head;
      try { const buf = Buffer.alloc(1024); head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString(); }
      finally { fs.closeSync(fd); }
      return !/cli-account-switcher shim|bin\/lib\/launch\/run\.js/.test(head);
    } catch { return false; }
  };
  const hit = hits.find(usable);
  if (hit) return hit;
  if (!P.IS_WIN) {
    // GUI shells can have a broken/minimal PATH; try common per-user install locations directly.
    for (const p of [path.join(P.HOME, '.local/bin', cmd), `/opt/homebrew/bin/${cmd}`, `/usr/local/bin/${cmd}`]) {
      try { if (fs.existsSync(p) && (fs.statSync(p).mode & 0o111) && usable(p)) return p; } catch {}
    }
  }
  return null;
}

function shimSh(tool) {
  return `#!/bin/sh
# cli-account-switcher shim for ${tool}
ROOT="\${CLI_ACCOUNTS_ROOT:-$HOME/${P.DATA_DIRECTORY}}"
exec node "$ROOT/bin/lib/launch/run.js" shim ${tool} "$@"
`;
}

function shimCmd(tool) {
  return `@echo off
rem cli-account-switcher shim for ${tool}
if "%CLI_ACCOUNTS_ROOT%"=="" (set "ROOT=%USERPROFILE%\\${P.DATA_DIRECTORY}") else (set "ROOT=%CLI_ACCOUNTS_ROOT%")
node "%ROOT%\\bin\\lib\\launch\\run.js" shim ${tool} %*
`;
}

function cliLauncherSh() {
  return `#!/bin/sh
ROOT="\${CLI_ACCOUNTS_ROOT:-$HOME/${P.DATA_DIRECTORY}}"
exec node "$ROOT/bin/lib/cli.js" "$@"
`;
}
function cliLauncherCmd() {
  return `@echo off
if "%CLI_ACCOUNTS_ROOT%"=="" (set "ROOT=%USERPROFILE%\\${P.DATA_DIRECTORY}") else (set "ROOT=%CLI_ACCOUNTS_ROOT%")
node "%ROOT%\\bin\\lib\\cli.js" %*
`;
}

// Status line hook: persist rate_limits into the active config dir, then run the
// user's original status line command with the same stdin.
function statusLineHookSource() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input);
    if (j.rate_limits) {
      const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      const out = path.join(dir, '${P.USAGE_CACHE_NAME}');
      const tmp = out + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ captured_at: new Date().toISOString(), rate_limits: j.rate_limits }), { mode: 0o600 });
      fs.renameSync(tmp, out);
    }
  } catch {}
  let orig = null;
  try { orig = require(path.join(process.env.CLI_ACCOUNTS_ROOT || path.join(os.homedir(), '${P.DATA_DIRECTORY}'), 'state.json')).statusLineOriginal; } catch {}
  if (orig && orig.command) {
    const r = spawnSync(orig.command, { input, shell: true, encoding: 'utf8', env: process.env });
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.status || 0);
  }
});
`;
}

function installShims() {
  fs.mkdirSync(P.BIN_DIR, { recursive: true, mode: 0o755 });
  const state = store.load();
  state.realBin = state.realBin || {};
  // Drop artefacts of tools that are no longer enabled (e.g. gemini).
  for (const t of P.DISABLED_TOOLS || []) {
    for (const f of [path.join(P.BIN_DIR, t), path.join(P.BIN_DIR, t + '.cmd'), path.join(P.ACTIVE_DIR, t), path.join(P.ACTIVE_DIR, t + '.real')]) { try { fs.unlinkSync(f); } catch {} }
    if (state[t]) delete state[t];
  }
  for (const tool of P.TOOLS) {
    const envVar = P.ENV_VAR[tool];
    const real = which(tool);
    if (real) state.realBin[tool] = real;
    if (P.IS_WIN) {
      fs.writeFileSync(path.join(P.BIN_DIR, tool + '.cmd'), shimCmd(tool, envVar));
    } else {
      const f = path.join(P.BIN_DIR, tool);
      fs.writeFileSync(f, shimSh(tool, envVar), { mode: 0o755 });
      fs.chmodSync(f, 0o755);
    }
  }
  const hook = path.join(P.BIN_DIR, 'claude-statusline-cache.js');
  fs.writeFileSync(hook, statusLineHookSource(), { mode: 0o755 });
  // Self-contained copy of the modules the console CLI needs, so it works without the app running.
  fs.mkdirSync(P.LIB_DIR, { recursive: true });
  const edition = require('./edition.json');
  const modules = ['edition.json', 'paths.js', 'store.js', 'claude.js', 'codex.js', 'codex-reset-credits.js', 'model-catalog.js', 'project-folders.js', 'official-auth.js', 'terminal.js', 'wrappers.js', 'cli.js'];
  if (edition.credentialMetadata) modules.push('claude-cred.js', 'codex-identity.js');
  if (edition.directUsageApi) modules.push('usage-api.js', 'gemini.js');
  for (const f of modules) {
    fs.copyFileSync(path.join(__dirname, f), path.join(P.LIB_DIR, f));
  }
  for (const dir of ['launch', 'runtime', 'adapters', 'dashboard', 'renderer']) {
    const source = path.join(__dirname, dir);
    // Electron's ASAR cpSync cannot extract a directory; copy files individually.
    const copyTree = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const input = path.join(from, entry.name), output = path.join(to, entry.name);
        if (entry.isDirectory()) copyTree(input, output);
        else if (entry.isFile()) fs.copyFileSync(input, output);
      }
    };
    if (fs.existsSync(source)) copyTree(source, path.join(P.LIB_DIR, dir));
  }
  if (P.IS_WIN) {
    fs.writeFileSync(path.join(P.BIN_DIR, 'cli-accounts.cmd'), cliLauncherCmd());
  } else {
    const f = path.join(P.BIN_DIR, 'cli-accounts');
    fs.writeFileSync(f, cliLauncherSh(), { mode: 0o755 });
    fs.chmodSync(f, 0o755);
  }
  store.save(state);
  return { binDir: P.BIN_DIR, realBin: state.realBin, hook };
}

// The PATH a *new terminal* will see. A GUI app launched from Finder/Dock inherits launchd's
// minimal PATH, not the shell's, so we ask the user's login shell (or the Windows user
// environment) instead of trusting process.env.PATH. Cached briefly; falls back to process.env.
let effPathCache = { at: 0, value: null };
function effectivePath() {
  if (Date.now() - effPathCache.at < 30000 && effPathCache.value) return effPathCache.value;
  let value = null;
  try {
    if (P.IS_WIN) {
      const ps = `[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')`;
      value = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000 }).trim();
    } else {
      const sh = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(sh, ['-lic', 'printf "%s\\n" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split('\n').map((s) => s.trim()).filter((s) => s.includes(path.delimiter) || s.startsWith('/'));
      value = lines[lines.length - 1] || null; // last line: hooks may print banners before it
    }
  } catch {}
  if (!value) value = process.env.PATH || '';
  if (!P.IS_WIN) {
    const extras = [path.join(P.HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const seen = new Set(value.split(path.delimiter).filter(Boolean));
    for (const p of extras) if (!seen.has(p)) { value = value ? `${value}${path.delimiter}${p}` : p; seen.add(p); }
  }
  effPathCache = { at: Date.now(), value };
  return value;
}

// PATH status: does the shim dir come before the real binaries in a new terminal?
function pathStatus() {
  const bin = path.resolve(P.BIN_DIR);
  const parts = effectivePath().split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  const idx = parts.findIndex((p) => p.toLowerCase() === bin.toLowerCase());
  const state = store.load();
  const realDirs = Object.values(state.realBin || {}).map((p) => path.resolve(path.dirname(p)));
  const realIdx = parts.findIndex((p) => realDirs.some((r) => r.toLowerCase() === p.toLowerCase()));
  return { binDir: bin, onPath: idx >= 0, first: idx >= 0 && (realIdx < 0 || idx < realIdx), shellHint: shellHint(), rcFile: rcFile() };
}

function rcFile() {
  if (P.IS_WIN) return null;
  const sh = path.basename(process.env.SHELL || '/bin/zsh');
  return path.join(P.HOME, sh === 'bash' ? '.bashrc' : sh === 'fish' ? '.config/fish/config.fish' : '.zshrc');
}

function pathLine() {
  const sh = path.basename(process.env.SHELL || '/bin/zsh');
  if (sh === 'fish') return `fish_add_path -m ${P.BIN_DIR}`;
  return `export PATH="${P.BIN_DIR}:$PATH"`;
}

function shellHint() {
  if (P.IS_WIN) return `사용자 환경변수 PATH 맨 앞에 추가: ${P.BIN_DIR}`;
  return `${rcFile().replace(P.HOME, '~')} 마지막 줄에 추가: ${pathLine()}`;
}

// One-click registration. macOS/Linux: append the export line to the shell rc (backup first).
// Windows: prepend to the *user* Path via .NET (setx would truncate long values).
function registerPath() {
  if (P.IS_WIN) {
    const ps = `$u=[Environment]::GetEnvironmentVariable('Path','User'); if (($u -split ';') -notcontains '${P.BIN_DIR}') { [Environment]::SetEnvironmentVariable('Path', '${P.BIN_DIR};' + $u, 'User') }`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 10000 });
    effPathCache = { at: 0, value: null };
    return { file: '사용자 환경변수 Path', line: P.BIN_DIR, note: '새로 여는 터미널부터 적용됩니다.' };
  }
  const rc = rcFile();
  const line = pathLine();
  let cur = '';
  try { cur = fs.readFileSync(rc, 'utf8'); } catch {}
  if (cur.includes(P.BIN_DIR)) return { file: rc, line, alreadyPresent: true };
  if (cur) fs.copyFileSync(rc, rc + '.bak-cli-accounts');
  fs.appendFileSync(rc, `${cur && !cur.endsWith('\n') ? '\n' : ''}\n# cli-account-switcher: claude/codex 계정 전환 래퍼\n${line}\n`);
  effPathCache = { at: 0, value: null };
  return { file: rc, line, backup: cur ? rc + '.bak-cli-accounts' : null, note: '새로 여는 터미널부터 적용됩니다.' };
}

// Hook the status line so Claude Code's rate_limits JSON gets persisted per profile.
function enableUsageHook() {
  const settingsFile = path.join(P.DEFAULT_HOME.claude, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  const hook = path.join(P.BIN_DIR, 'claude-statusline-cache.js');
  const hookCmd = `node "${hook}"`;
  const state = store.load();
  const cur = settings.statusLine;
  if (cur && cur.command === hookCmd) return { alreadyEnabled: true };
  if (cur && cur.type === 'command') state.statusLineOriginal = { command: cur.command };
  store.save(state);
  fs.copyFileSync(settingsFile, settingsFile + '.bak-cli-accounts');
  settings.statusLine = { type: 'command', command: hookCmd, padding: cur && cur.padding != null ? cur.padding : 0, refreshInterval: (cur && cur.refreshInterval) || 30 };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return { alreadyEnabled: false, original: state.statusLineOriginal, backup: settingsFile + '.bak-cli-accounts' };
}

function disableUsageHook() {
  const settingsFile = path.join(P.DEFAULT_HOME.claude, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  const state = store.load();
  if (state.statusLineOriginal && state.statusLineOriginal.command) {
    settings.statusLine = { ...(settings.statusLine || {}), type: 'command', command: state.statusLineOriginal.command };
  } else {
    delete settings.statusLine;
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function usageHookStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(P.DEFAULT_HOME.claude, 'settings.json'), 'utf8'));
    return Boolean(s.statusLine && /claude-statusline-cache\.js/.test(s.statusLine.command || ''));
  } catch { return false; }
}

module.exports = { installShims, pathStatus, registerPath, enableUsageHook, disableUsageHook, usageHookStatus, which };
