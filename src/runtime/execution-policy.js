'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// A capability grant, not a synonym for write permission. Old roots never gain
// command execution just because this version is installed.
function normalizeExecutionPolicy(permission, value = 'edit-only') {
  if (!['edit-only', 'build-test'].includes(value)) throw Error('Invalid executionPolicy');
  if (value === 'build-test' && permission !== 'workspace-write') throw Error('build-test requires workspace-write');
  return value;
}
const buildRules = ['dotnet build', 'dotnet build *', 'dotnet test', 'dotnet test *', 'dotnet restore', 'dotnet restore *',
  'npm test', 'npm test *', 'npm run build', 'npm run build *', 'npm run test', 'npm run test *',
  'node --test', 'node --test *', 'node --check *', 'node test/*', 'node scripts/test-*'];
const versionCache = new Map();
function verifyClaude(executable) {
  const st = fs.statSync(executable), key = `${executable}:${st.size}:${st.mtimeMs}`;
  if (versionCache.has(key)) return;
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && (Number(version[2]) < 1 || Number(version[2]) === 1 && Number(version[3]) < 290))) throw Error('build-test requires Claude Code 2.1.290 or later');
  const help = execFileSync(executable, ['--help'], { encoding: 'utf8', timeout: 10000 });
  for (const flag of ['--restricted', '--settings', '--permission-prompts']) if (!help.includes(flag)) throw Error(`build-test requires ${flag}`);
  if (process.platform !== 'darwin') throw Error('Claude build-test sandbox is currently verified only on macOS');
  fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK);
  versionCache.set(key, true);
}
function existing(dir) { try { return fs.realpathSync(dir); } catch { return null; } }
function buildSettings({ binding, cwd, dir }) {
  verifyClaude(binding.executable);
  cwd = fs.realpathSync(cwd);
  const home = os.homedir();
  const sdk = [path.join(home, '.dotnet'), '/usr/local/share/dotnet'].map(existing).find(p => p && fs.existsSync(path.join(p, 'dotnet')));
  // Discover the native Node installation, never the switcher's account shims.
  let node = process.execPath;
  if (!/^node(?:\.exe)?$/.test(path.basename(node))) {
    node = require('../wrappers').which('node');
    if (!node) throw Error('A native Node installation is required for build-test');
  }
  node = fs.realpathSync(node);
  const nodeBin = path.dirname(node), nodeRoot = path.dirname(nodeBin);
  const cache = path.join(cwd, '.build-cache');
  let cacheStat; try { cacheStat = fs.lstatSync(cache); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (cacheStat && (cacheStat.isSymbolicLink() || !cacheStat.isDirectory())) throw Error('Unsafe build cache path');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const npmUser = path.join(cache, 'npm-user.conf'), npmGlobal = path.join(cache, 'npm-global.conf');
  for (const file of [npmUser, npmGlobal]) {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe build config path');
      fs.ftruncateSync(fd, 0);
    } finally { fs.closeSync(fd); }
  }
  let commonGit;
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_')) delete gitEnv[key];
  gitEnv.GIT_CONFIG_GLOBAL = '/dev/null'; gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  try { commonGit = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: gitEnv }).trim(); } catch { throw Error('Cannot resolve isolated worktree Git boundary'); }
  const secrets = ['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.npmrc', '**/NuGet.Config', '**/nuget.config'].map(p => path.join(cwd, p));
  const settings = {
    permissions: { allow: buildRules.map(rule => `Bash(${rule})`), deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(./**/*.pem)', 'Read(./**/*.key)', 'Read(./**/.npmrc)'], defaultMode: 'acceptEdits' },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [],
      filesystem: { disabled: false, denyRead: ['/Users', '/home', '/Volumes', ...secrets], allowRead: [cwd, nodeRoot, ...(sdk ? [sdk] : [])],
        denyWrite: [commonGit, path.join(cwd, '.git'), path.join(cwd, '.claude'), path.join(cwd, '.codex')], allowWrite: [] },
      network: { allowedDomains: ['registry.npmjs.org', 'api.nuget.org', 'globalcdn.nuget.org'], allowLocalBinding: false, allowAllUnixSockets: false },
      credentials: { envVars: ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK'].map(name => ({ name, mode: 'deny' })) },
    },
  };
  const settingsFile = path.join(dir, 'execution-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const env = { PATH: [nodeBin, sdk, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(path.delimiter),
    DOTNET_CLI_HOME: path.join(cache, 'dotnet'), NUGET_PACKAGES: path.join(cache, 'nuget'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    npm_config_cache: path.join(cache, 'npm'), npm_config_userconfig: npmUser, npm_config_globalconfig: npmGlobal,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', BASH_ENV: '/dev/null', ENV: '/dev/null' };
  if (sdk) env.DOTNET_ROOT = sdk;
  return { settingsFile, env };
}
function executionEnv(invocation, env) {
  if (!invocation.executionEnv) return env;
  const clean = {};
  // The model CLI authenticates from its pinned native profile. Arbitrary
  // service variables (including tokens/database URLs) are not build inputs.
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) if (env[key] !== undefined) clean[key] = env[key];
  return { ...clean, SHELL: '/bin/bash', ...invocation.executionEnv };
}
module.exports = { normalizeExecutionPolicy, buildRules, buildSettings, executionEnv };
