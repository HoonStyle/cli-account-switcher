'use strict';
const os = require('os');
const path = require('path');

const edition = require('./edition.json');
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

// App-owned data lives here. Profile homes are subdirectories.
const ROOT = process.env.CLI_ACCOUNTS_ROOT || path.join(HOME, edition.dataDirectory);

// Gemini CLI support exists in gemini.js but is disabled: Google stopped serving Gemini CLI
// requests for free / Google AI Pro / Ultra accounts on 2026-06-18 (developers.googleblog.com,
// "Transitioning Gemini CLI to Antigravity CLI"). Re-enable by adding 'gemini' here.
const TOOLS = ['claude', 'codex'];
const DISABLED_TOOLS = ['gemini'];

// Where each tool keeps its config relative to the "home" the env var points at.
// Claude/Codex: the env var IS the config dir. Gemini: GEMINI_CLI_HOME is a root and the CLI
// creates .gemini inside it (official docs), so the default home is $HOME itself.
const CONFIG_SUBDIR = { claude: '', codex: '', gemini: '.gemini' };
function configDir(tool, home) { return CONFIG_SUBDIR[tool] ? path.join(home, CONFIG_SUBDIR[tool]) : home; }

module.exports = {
  HOME,
  DATA_DIRECTORY: edition.dataDirectory,
  IS_WIN,
  ROOT,
  TOOLS,
  DISABLED_TOOLS,
  STATE_FILE: path.join(ROOT, 'state.json'),
  BIN_DIR: path.join(ROOT, 'bin'),
  LIB_DIR: path.join(ROOT, 'bin', 'lib'),
  ACTIVE_DIR: path.join(ROOT, 'active'),
  PROFILES_DIR: { claude: path.join(ROOT, 'claude'), codex: path.join(ROOT, 'codex'), gemini: path.join(ROOT, 'gemini') },
  // The tool's own default home. The "default" profile maps here with no env override.
  DEFAULT_HOME: { claude: path.join(HOME, '.claude'), codex: path.join(HOME, '.codex'), gemini: HOME },
  ENV_VAR: { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', gemini: 'GEMINI_CLI_HOME' },
  CONFIG_SUBDIR,
  configDir,
  // Non-secret files shared from the default config dir into every new profile via links.
  SHARE_ALLOWLIST: {
    claude: ['settings.json', 'CLAUDE.md', 'plugins', 'skills', 'agents', 'commands', 'hooks', 'rules'],
    codex: ['config.toml', 'AGENTS.md', 'skills', 'plugins', 'rules', 'memories'],
    gemini: ['settings.json', 'GEMINI.md', 'commands', 'extensions', 'skills'],
  },
  USAGE_CACHE_NAME: 'usage-cache.json',
  LABEL: { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' },
};
