# CLI Account Switch

Private distribution staging repository. No public release has been made.

## Included

- Local Claude Code / Codex profile selection and pinned CLI launch.
- Login through each user's unmodified official CLI. Credentials stay with that CLI.
- Claude status-line usage records and Codex session usage records; no background quota endpoint calls.
- Managed tasks and optional OpenClaw current-conversation integration.
- Named, account-scoped model selectors for the coordinator and delegated work.
- Task status, review and delivery states, and read-only terminal output with periodic refresh.
- Project-folder selection: a native folder dialog in the app, or server-side folder browsing in the web dashboard.

Direct usage API modules and credential readers are **not included**. Codex login status is displayed without reading its authentication file; use profile labels to distinguish accounts. Usage may be absent or stale until the official CLI writes a supported local record. No guaranteed live balance or quota display.

## Install / develop

Requires Node.js 24+, npm, Git, and separately installed official CLIs (`claude`, `codex`).

```sh
npm ci
npm test
npm run test:runtime  # macOS; task execution on Windows remains unsupported
npm run test:dashboard # macOS; includes isolated Electron UI checks
npm run test:reset-ui  # macOS; renderer regression checks
npm start
```

Data defaults to `~/.cli-accounts-distribution`, separate from the internal edition (`~/.cli-accounts`). App ID and name are also separate. The display name is **CLI Account Switch**; the existing distribution app ID and data directory are retained for update compatibility. The `default` profile intentionally points to the official CLI's existing default home; that default login and optional status-line settings are shared between editions. Do not enable competing status-line hooks or put both wrapper directories first on PATH. Do not point `CLI_ACCOUNTS_ROOT` at the internal edition's directory. New profiles use their own local directories and official login, without copying credentials.

The application starts hidden in the menu bar. Open its menu to select an account, add a profile, install the local usage hook, or manage tasks. Existing terminal sessions keep their original accounts; changes apply to new launches.

## Optional OpenClaw integration

```sh
npm run build:plugin
openclaw plugins install ./plugins/openclaw
```

The plugin and tool IDs match the internal edition. Install **one edition's plugin per OpenClaw instance**, not both. This edition connects to the distribution data directory. Requires a compatible OpenClaw runtime (manifest minimum 2026.9.6; verify installed API compatibility).

## Build and release

```sh
npm run dist:mac
npm run dist:win
```

GitHub CI runs isolated tests; manual dispatch additionally builds unsigned installers and saves workflow artifacts. It does **not** publish a GitHub release or push a tag. Signing/notarization, Windows runtime validation, license selection, and public release approval remain separate release work. Repository code currently has no open-source license grant.

## Maintenance

Shared code is exported from the internal development repository using an allowlist. Export to a fresh directory, compare against this repository, run the test suites, and review changes before committing. Never copy `.git`, account homes, workstation paths, internal review logs, or generated runtime state. `SOURCE_MANIFEST.json` records the current export's file hashes, not private source history.

Multiple local profiles do not change provider terms or permissions. This tool does not create accounts, share subscriptions, proxy authentication, rotate on rate limits, or bypass access restrictions. Official CLIs communicate with their providers normally. Task result delivery requires explicit acknowledgement; an ambiguous send/ack boundary does not guarantee exactly-once delivery.
