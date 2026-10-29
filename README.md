<div align="center">

# CLI Account Switch

**English** | [한국어](README.ko.md)

**Manage your Claude Code and Codex CLI accounts in one place.**

Local profiles · CLI launches · Usage records · Managed tasks

![Preview](https://img.shields.io/badge/status-preview-orange)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Getting started](#getting-started) · [Features](#features) · [How it works](#how-it-works) · [Web dashboard](#web-dashboard) · [Development](#development)

</div>

---

CLI Account Switch is an Electron desktop app for managing multiple local Claude Code and Codex CLI profiles. It separates configuration homes and launches each official CLI with the selected profile. The official CLIs handle sign-in and model requests.

> **Preview** — Current version: `0.2.0-preview.14`. Signed and notarized installers are not yet available. Windows build configuration is included, but managed task execution on Windows is not supported. [Release notes](docs/releases/v0.2.0-preview.14.md).

## Screenshots

The three desktop screenshots below use the actual app renderer with synthetic data. Account labels, usage values, model lists, task states, and terminal output are examples—not real accounts or execution results. Screenshots show the current Korean-language UI.

### Account profiles

Select Claude Code and Codex profiles and view locally recorded usage.

<img src="docs/images/account-profiles.png" alt="Claude Code and Codex profile selection with demo data" width="460">

### Task setup and model selection

Choose a project folder, coordinator, model, and participating accounts.

![Task setup and per-account model selection with demo data](docs/images/model-dropdowns.png)

### Task status and terminal output

Inspect delegated work and read-only terminal output in one view.

![Task status and terminal output with demo data](docs/images/terminal-desktop.png)

### Scriptable widget design preview

A reference design for displaying per-account usage and record timestamps. **This is a layout preview generated on macOS, not an iPhone screenshot.** Values do not represent current usage. The widget code and its server are not included in this repository.

<img src="docs/images/scriptable-widget-preview.png" alt="Scriptable usage widget layout preview, not an iPhone screenshot" width="660">

## Features

| Feature | What it does |
| --- | --- |
| **Account profiles** | Add and select separate profiles for Claude Code and Codex. |
| **Profile-specific launches** | Start new CLI sessions with the selected configuration home. |
| **Shared skills and instructions** | Link skills, instructions, and settings from the default home instead of maintaining duplicate copies. |
| **Shared stored memory** | Link the existing Codex `memories` directory into new profiles. Conversation sessions are not transferred. |
| **Local usage records** | Read Claude status-line records and Codex session records. |
| **Task management** | Track execution, reviews, and result delivery. |
| **Task context and session resume** | Persist goals, results, reviews, and session IDs; resume the same coordinator session on subsequent turns. |
| **Web dashboard** | Submit, inspect, respond to, and cancel tasks from a local browser; view terminal output. |
| **Model selection** | Select account-scoped models for coordination and delegated work. |
| **Read-only terminal output** | Inspect task output with periodic refresh. |
| **Project selection** | Use a native folder picker in the app or server-side folder browsing in the dashboard. |
| **Optional OpenClaw integration** | Connect managed work to the current conversation through a plugin. |

## Getting started

### Requirements

- **Node.js 24+**, npm, and Git
- The official CLIs you intend to use: Claude Code (`claude`) and Codex (`codex`)
- Your own accounts with access to the corresponding services
- A desktop environment capable of running Electron

Install the official CLIs separately. This app does not provide service accounts or subscription access.

### Run from source

```sh
git clone https://github.com/HoonStyle/cli-account-switcher.git
cd cli-account-switcher
npm ci
npm start
```

Prebuilt preview installers are available from [GitHub Releases](https://github.com/HoonStyle/cli-account-switcher/releases).

### First launch

1. Open the app from the menu bar or system tray. It starts hidden by default.
2. Add a profile for the CLI you want to use.
3. Complete the official CLI's sign-in flow for that profile.
4. Select the profile and launch a new CLI session or task.
5. Configure local usage collection if you want usage indicators.

> Switching profiles affects **new launches only**. It does not change existing terminal sessions or authentication stored independently by other apps.

## How it works

```text
CLI Account Switch
  ├─ Claude profile → CLAUDE_CONFIG_DIR → Official Claude Code CLI
  └─ Codex profile  → CODEX_HOME        → Official Codex CLI
                                            └─ Direct provider communication
```

| CLI | Profile configuration home | Environment variable |
| --- | --- | --- |
| Claude Code | `~/.cli-accounts-distribution/claude/<profile>/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.cli-accounts-distribution/codex/<profile>/` | `CODEX_HOME` |

New profiles use their own local directories and the official sign-in flow. They do not sign in by copying another account's credentials.

### Default profile and app data

The `default` profile uses the official CLI's existing home, `~/.claude` or `~/.codex`, without a separate configuration-home override. It therefore shares the default login and status-line settings used when running that CLI directly.

App data lives in `~/.cli-accounts-distribution` by default. You can override this with `CLI_ACCOUNTS_ROOT`, but do not reuse another tool's data directory. Avoid duplicate usage hooks and make sure PATH selects the intended CLI wrappers.

## Shared skills, instructions, and memory

Profiles can keep separate logins while sharing skills and instructions. When creating a profile, the app links these existing items from the official CLI's default home:

| CLI | Source | Shared items |
| --- | --- | --- |
| Claude Code | `~/.claude/` | `settings.json`, `CLAUDE.md`, `plugins`, `skills`, `agents`, `commands`, `hooks`, `rules` |
| Codex | `~/.codex/` | `config.toml`, `AGENTS.md`, `skills`, `plugins`, `rules`, `memories` |

For example, profiles linked to `~/.codex/skills` reference the same directory. Editing linked content affects every profile referencing that source. This uses **the CLI's default home as the shared source**, rather than moving skills into a separate registry.

### Stored context is not a conversation session

Instructions such as `CLAUDE.md` and `AGENTS.md`, along with Codex's `memories` directory, are eligible for sharing. The app does not summarize conversations to create memories; creation and use of `memories` depend on the CLI.

Conversation history and running sessions are not part of this shared-file list. **Switching accounts alone does not restore an entire conversation or transfer a running task's context.**

### Sharing behavior

- Sharing is enabled by default when adding a profile in the app.
- Only source items present at creation time are linked. Existing destination items are not overwritten.
- The app uses symbolic links, with directory junctions on Windows. If a file link fails, it falls back to a one-time copy; copied files do not stay synchronized.
- Adding a source item later does not automatically create links in existing profiles.
- Use the app-installed CLI with `--no-share` to create a profile without shared settings:

```sh
cli-accounts add codex isolated --no-share
```

## Explicit skill and context handoff

The task form accepts background, constraints, decisions, completion criteria, and selected skill directory names. CLI/API submissions use the same optional `context` object. New tasks snapshot project-root `AGENTS.md`/`CLAUDE.md` by default (`projectInstructions: false` opts out). Skills are resolved from project `.agents/skills`, project tool-specific skills, then the pinned profile's `skills` directory. A missing selected skill fails before execution.

Selected `SKILL.md` instructions are supplied explicitly to both CLIs; supporting files are copied into a task-owned read-only snapshot. This is **explicit instruction/resource delivery**, not enabling all native slash commands, plugins, hooks or MCP servers. Existing tool permissions, Claude safe mode and Codex config/rule isolation remain in effect. A skill requiring an unavailable tool must report that limitation. File-link sharing alone is not evidence that a model used a skill.

Snapshots are pinned across managed retries/resumes and record their SHA256, profile, skill names and instruction files. Versioned `respond`/`resume` may update the structured context; skill/instruction selection stays pinned. Attempts record the effective handoff hash and context revision. Accepted task follow-up messages are also forwarded to later children in chronological order, so a coordinator need not rephrase every user correction. Full conversation history and private memory files are not automatically collected. Snapshot limits are 12 skills, 200 files, 8 MiB total, 1 MiB per file and 128 KiB of inline instructions; nested resource symlinks and credential files are rejected.

Direct profile-pinned execution can use the same handoff format without creating a managed coordinator:

```sh
cli-accounts delegate codex --profile work --context /absolute/task.json -- exec --json -
cli-accounts delegate claude --profile work --context /absolute/task.json -- -p
```

`task.json` contains `projectPath`, `goal`, and `context`, for example:

```json
{
  "projectPath": "/absolute/project",
  "goal": "Review the change and return evidence",
  "context": {
    "background": "Continue the agreed review",
    "constraints": ["Do not modify source files"],
    "decisions": ["Keep the current public API"],
    "completionCriteria": ["Report findings with file paths"],
    "skills": ["code-review"],
    "projectInstructions": true
  }
}
```

Direct mode preserves piped prompt text, pins the requested profile, and prints a local context receipt path to stderr. That receipt is not a managed task ID; retain the native CLI session/thread ID for continuation. Each direct invocation captures its supplied context anew. Managed tasks additionally retain the context and frozen skill snapshots in their durable task record.

## Task context and session resume

Managed tasks persist their goal, project path, baseline commit, participating accounts, execution attempts, delegated results, reviews, and coordinator session ID in SQLite. The default database is `~/.cli-accounts-distribution/runtime/tasks.sqlite`. Per-attempt records in the runtime directory also retain prompts and results.

Subsequent coordinator turns use Claude's `--resume` or Codex's `exec resume` to continue the same session. Follow-up prompts include delegated results, review states, and additional user input. OpenClaw integration uses the bound conversation's identifiers.

This preserves **managed task context**. It does not collect every terminal conversation or automatically move sessions between accounts. After a service restart, the runtime reconciles persisted execution state and results. Ambiguous execution remains flagged for inspection rather than being blindly relaunched. The original CLI session and profile data must also remain available.

Task records can contain prompts, project paths, and output. Do not commit the runtime directory to a public repository.

### Execution and recovery

`executionPolicy` defaults to `edit-only`. Explicit `build-test` permission for a writable Claude task enables restricted build/test commands on macOS; it requires Claude Code 2.1.290+ with the supported sandbox flags and the relevant SDK. Installing an update does not upgrade existing task permissions.

Build children inherit the native Node installation used to start the task service; launch the service with the project's required Node version. Run the granted commands directly (`npm ci --offline`, `npm run typecheck`, `npm test`, `npm run build`, or `node --import tsx --test ...`) without `env`, `cd`, shell wrappers or compound commands. npm checks package engine requirements and uses isolated configuration files. Existing npm content cache entries may be read for offline installs; the shared cache remains read-only and logs stay in the worktree. A cold cache can still cause an explicit offline cache-miss error. Linked worktrees may read their exact common Git directory, while Git writes, secret reads and unsandboxed execution remain denied.

Tasks paused before execution can be resumed with bounded retry/round limits. Follow-up delegations can explicitly receive versioned files from earlier task worktrees; those changes are not automatically merged into the original project.

Artifact inputs must list individual relative files, not directories or globs. If a task was blocked before any input snapshot was captured, `tasks resume ID request.json` also accepts `inputOverrides: [{taskId, inputs: [{taskId, resultVersion, paths}]}]`. The outer task ID identifies a blocked task selected in `retryTaskIds`; inner IDs and versions must match all of its original sources. Replacement paths may only narrow the original selection, for example from `apps/server` to `apps/server/src/app.ts`. The service checks the entire selection with the normal file, baseline, conflict and size rules before consuming the versioned request. It rejects captured inputs, new sources, wider paths and unsafe files. Repairs are audited, atomic and idempotent; the same request ID must be reused when an outcome is uncertain. Check `health.capabilities.artifactInputRecovery` before sending overrides to an installed service.

## Web dashboard

Use the same task-management interface in a local browser. From the source directory:

```sh
node src/cli.js dashboard
# Open http://127.0.0.1:18473 in your browser
```

If the app-installed `cli-accounts` command is on PATH:

```sh
cli-accounts dashboard
cli-accounts dashboard --port 18474
```

- Choose a project folder, accounts, and models, then submit work.
- Inspect task status, delegated results, reviews, and read-only terminal output.
- Respond to requests for input or cancel work through a confirmation step.
- Folder selection browses **the filesystem of the computer running the server**.

The screenshot below was captured from the actual HTTP dashboard using synthetic data, not real accounts or task execution results.

![Local web dashboard with demo data](docs/images/web-dashboard.png)

### Access and security

The server binds to `127.0.0.1` by default and validates the host, Origin, and request headers. It does not provide a separate user sign-in system. Because it can launch tasks and expose paths and output, do not expose it directly to the internet.

`--public-origin https://host` only adds an allowed origin for a reverse proxy. It does not configure authentication or an HTTPS server. Remote access requires a separately configured proxy with authentication, access controls, and TLS.

## Usage and authentication

- **Claude Code:** usage comes from local status-line records.
- **Codex:** usage comes from local session records.
- The official CLIs manage credentials for sign-in and provider communication.
- The app does not read account credentials to collect email metadata or call usage endpoints directly. Use profile labels to identify accounts.

Usage appears after the CLI writes a supported local record. Missing or older records can leave values unavailable or out of date. **Real-time balances and quotas are not guaranteed.**

## OpenClaw integration

```sh
npm run build:plugin
openclaw plugins install ./plugins/openclaw
```

- The plugin manifest requires OpenClaw **2026.9.6** or later. Verify API compatibility with your installed version.
- The plugin uses the app's data directory. Do not install duplicate plugins with the same plugin or tool IDs.
- Result delivery requires explicit acknowledgment. An ambiguous send/ack boundary does not guarantee exactly-once delivery.
- `account_tasks get` returns a compact summary. Read `context`, `task`, or `final` pages using the returned `nextOffset` and `queryRevision`; summaries are not complete review evidence.
- The dashboard can separately show recent OpenClaw activity through read-only Gateway queries. Offline records are marked stale, and an observed execution ending does not imply the user's goal is complete.

### preview.10 structural contracts

Question answers now carry the displayed generation and input version. Integrated delivery uses authenticated host receipts and read-only recovery for unknown outcomes. Update the app, runtime and plugin together: this release uses database schema 2 and mutation protocol 3. Optional OpenClaw integration additionally requires the paired host SDK (`sendSessionBoundMessageBatch`, `readSessionBoundMessageReceipt`, atomic workflow-injection fencing), Core agent schema 25 and native record V2; the manifest minimum alone is not sufficient. These host changes are not bundled in the installers. See the [upgrade notes](docs/releases/v0.2.0-preview.10.md).

### preview.9 runtime contract changes

- Execution, review, user-input requests, and delivery are separate states. A versioned `inputRequest` preserves the blocker independently of runner warnings. After reporting it to the bound conversation and verifying delivery, use `ack_attention` with that exact `attentionVersion`; only an explicit response or bounded `resume` continues the work.
- Tool task `state` uses the same execution observation as the dashboard; `ledgerState` retains the persisted scheduling state. Detail history contains the latest 500 events in chronological order.
- Paging happens in the service, before RPC transmission. The dashboard uses bounded previews and restores complete task evidence on expansion, pinned to the same result revision. OpenClaw and the local UI share one projector; truncated previews are not treated as complete evidence. Current execution is selected by its persisted attempt ID, not the wall clock.
- Mutations require a same-connection protocol handshake. Mixed client/service versions are rejected before applying changes, without restarting active work. RPC requests are limited to 1 MiB including the full UTF-8 JSON envelope and newline; oversized requests are rejected before mutation. Shorten and retry the same task/attempt/generation, not a new task.
- Normal split UTF-8 output is preserved. Invalid stdout or authoritative result-file encoding fails the execution instead of silently storing repaired text as a successful result. The raw diagnostic `get`/`list` RPCs retain an 8 MiB response limit; normal dashboard and OpenClaw reads use the bounded read APIs.

## Development

### Tests

```sh
npm ci
npm test                 # Basic behavior
npm run test:runtime     # Runtime checks — macOS
npm run test:dashboard   # Dashboard and Electron UI checks — macOS
npm run test:reset-ui    # Renderer regression checks — macOS
npm run build:plugin     # Build the OpenClaw plugin
```

Electron UI tests require a desktop environment.

### Build installers

```sh
npm run dist:mac   # Universal macOS DMG
npm run dist:win   # Windows NSIS installer and portable build
```

Artifacts are written to `dist/`. Build on the corresponding operating system. macOS signing and notarization are not currently configured.

### GitHub Actions

The [verification and build workflow](.github/workflows/ci.yml) runs basic tests and plugin builds on macOS and Windows for pushes to `main` and pull requests. macOS also runs runtime, dashboard, and renderer tests.

Manual dispatch (`workflow_dispatch`) builds installers and retains artifacts for seven days. The separate [publish workflow](.github/workflows/publish-release.yml) takes the successful build run ID and exact commit SHA, verifies provenance, and publishes a prerelease with installer checksums. Signing, notarization, and Windows runtime validation remain separate tasks.

## Limitations

- The currently enabled CLIs are Claude Code and Codex.
- Windows installer build configuration is included, but managed task execution on Windows is not supported.
- Usage depends on local records and may differ from current provider quotas.
- Profile switching does not change existing CLI sessions or other apps' independent authentication.
- Provider terms and access requirements still apply. The app does not create accounts, share subscriptions, proxy authentication, rotate accounts on rate limits, or bypass access restrictions.

## License

[MIT License](LICENSE) · Copyright (c) 2026 HoonStyle

External CLIs and services remain subject to their own licenses and terms.

### Delegating with an explicit account

Account delegation selects a profile **for that task**, not a global `use`/`switch`.
Call OpenClaw `account_tasks(action="connect")` first: `installation` identifies
its edition/data root and `accounts` lists valid `participants[].profileId` values.
Missing profiles fail before submission with `PROFILE_NOT_IN_INSTALLATION`; never
substitute the active account, copy credentials, or reconfigure the Gateway.
For a different installation, inspect that installation's absolute CLI path with
`--help` and `list`, then run:

```sh
/path/to/cli-accounts run codex --profile <id> -- exec -m <model> '<prompt>'
```

Global activation stays unchanged. Direct CLI thread IDs are not managed task IDs;
direct runs are not automatically imported into the managed task list. Separate
installation task stores are not automatically merged.

### Claude Code / Codex: per-task delegation

```sh
cli-accounts list --json
cli-accounts delegate claude --profile <id> -- <official-cli-args...>
cli-accounts delegate codex --profile <id> -- <official-cli-args...>
```

`delegate` requires an explicit profile and never changes the active account.
The same commands work from Claude Code, Codex, OpenClaw, or a terminal.
Use the CLI belonging to the intended installation; `list --json` reports its
storage root and profile IDs without reading credentials. A missing profile or
failed child process never falls back to the active account. `use`/`switch` is
only for an explicit global-switch request. Existing `run --profile` remains
supported. Direct runs return CLI output/exit status, not managed task receipts.
Repository agent instructions are in `AGENTS.md` and `CLAUDE.md`; they are not
silently installed into users' global agent configuration.
