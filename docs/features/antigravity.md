# Antigravity shared-login adapter (unreleased)

Antigravity CLI (`agy`) is intentionally **not** in `paths.TOOLS`: its OS login
is shared with the Antigravity app/IDE. Changing a settings folder does not
establish credential isolation. Do not expose it as a pinned/managed account,
change the global login to satisfy a delegation, or silently fall back to it.

## Use

1. Install and sign in through the official `agy` CLI.
2. In Switch, select **현재 로그인 저장**, or run:
   `cli-accounts antigravity save personal`.
3. Save the current account **before** using official `/logout` to sign in to a
   different account, then save that second account under another name.
4. Close Antigravity app, IDE, CLI and background daemon processes yourself.
5. Select **이 계정으로 전환** and confirm the shared-login dialog, or run:
   `cli-accounts antigravity use personal --shared-login`.
6. Start official `agy` again. A native OS-keyring access prompt may require your
   approval. Switch never terminates/restarts the app or changes its quota policy.

Commands: `antigravity list`, `check`, `usage` (alias `quota`), `save <label>`,
`use <label|email|id> --shared-login`, `remove <label|email|id>`, `recover`.
`agy` is a command-group alias; `list|add|use|rm agy ...` also works.
Use `--json` for machine-readable output. `list` reads saved metadata only;
`check` explicitly reads the current local credential. It does not validate the
credential with Google. No automatic quota requests are added.

## Usage: one row per shared quota pool

Select **사용량 조회**, or run `cli-accounts antigravity usage --json`.
Switch invokes the installed official `agy -p /usage --output-format json`
(requires 1.1.11+) with no inference prompt. The official CLI owns authentication
and any normal token refresh; Switch does not read credentials for this query.

- Use the server's quota groups, not per-model rows. Repeated bucket IDs are
  shown once; equal fractions/reset times alone never merge separate pools.
- Show every measured window within its group. Weekly-only responses do not
  acquire a fabricated five-hour allowance. Separate groups such as Argon stay
  separate. Unknown, disabled or invalid fractions are not converted to 100%.
- The CLI report has no verified account identity. It appears under **현재 로그인
  사용량**, not under a saved account. It never switches logins to fetch a quota.
- Used/remaining mode follows the existing display setting. Reset time and
  observation age accompany the values. Failed refreshes preserve prior values
  with an explicit error. Results are in memory until exit or login switching;
  startup and panel opening never launch a quota probe.
- Concurrent clicks join one request. A cross-edition lock excludes account
  switching. The probe uses a private disposable working directory, a 45-second
  deadline and a 1-MiB combined output cap. Its owned process group is stopped
  on completion/cancellation; existing agy processes are not selected or stopped.
  Auto-update is disabled for the child, and browser-opening launchers are
  blocked in its PATH/BROWSER. Failures never echo raw CLI diagnostics.

References: [official /usage docs](https://antigravity.google/docs/cli/commands/usage/)
and [CodexBar's maintained CLI report notes](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md).
The official macOS arm64 agy 1.4.12 live report was checked once on 2026-10-31:
SUCCESS, zero model turns, two separately identified weekly pools. This proves
the actual report path, not every subscription's quota shape. Windows native
execution and future CLI versions still require their own acceptance checks.

## Storage and failure behavior

- Saved credentials live only in the native OS keyring, through pinned
  `@napi-rs/keyring` 2.1.2. Account labels/email/IDs live under this edition's
  data root in `antigravity/registry.json` (0600). No credential is sent to a
  network endpoint by Switch or returned through UI/CLI JSON. The official agy
  process contacts Google when usage is explicitly requested.
- macOS official go-keyring values may carry `go-keyring-base64:` (or legacy
  `go-keyring-encoded:` hexadecimal) around the JSON. Identity parsing decodes
  these tagged formats strictly; snapshots, keyring writes and rollback keep
  the original bytes. The existing plaintext fallback receives decoded JSON,
  not the keyring envelope. Arbitrary untagged base64 is not accepted.
- The official shared entry is service `gemini`, account `antigravity`.
  Windows uses the exact `gemini:antigravity` target and raw UTF8 bytes.
- Existing official `~/.gemini/antigravity-cli/antigravity-oauth-token` is
  updated along with the keyring; no new plaintext fallback is created.
  Different identities in the two stores block switching.
- Saved vault namespaces are edition-root-specific. The **live** login,
  transaction journal, lock and rollback slots are shared across editions.
- `proper-lockfile` serializes Switch operations. Antigravity process discovery
  fails closed; detected app/IDE/CLI/language-server processes block switching.
  This cannot stop a user or another application launching midway through a
  switch. Keep all Antigravity surfaces closed until switching finishes.
- Refreshed live credentials are saved back to the matching saved account.
  Both old stores are backed up in separate keyring entries before mutation.
  Failed writes roll back with readback; interrupted/incomplete rollback leaves
  a journal and blocks further changes until explicit `recover` succeeds.
- Removing a saved account does not log the current account out. The most
  recent pre-switch rollback credential remains in the protected rollback slot.
  No credential export/import or automatic account rotation is provided.
- The default account UI renders only metadata, not a background keyring scan.
  Current identity is a timestamped observation and may change outside Switch.

## Evidence and limits (2026-10-31)

- Official [authentication documentation](https://antigravity.google/docs/install/)
  describes shared sign-in and native keyring authentication.
- Official [issue 1261](https://github.com/google-antigravity/antigravity-cli/issues/1261)
  collaborator states that Windows credential storage is not namespaced by
  `USERPROFILE`. [Issue 381](https://github.com/google-antigravity/antigravity-cli/issues/381)
  still requests a supported auth-profile selector.
- Official macOS arm64 `agy` 1.4.12 was downloaded without installation; its
  manifest SHA512 matched. Executable SHA256:
  `34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3`.
  Actual `--help` has no profile selector. REA build-info evidence
  `ev_2d945c1e197333d04a60ca9c8e1774bbe2521f572cc6408277e1dc496fcb41b2`
  identifies a Go arm64 Mach-O. Ghidra deep analysis hit its 330-second startup
  deadline and Go 1.28 support warning; unverified environment strings are not
  used by this adapter. This is not proof no private selector exists.
- Existing [agy-auth](https://github.com/fikrilal/agy-auth) and
  [agyx](https://github.com/dongwook-chan/agyx) use shared credential replacement.
  They were inspected, not installed or copied. Switch adds a narrow adapter
  to its existing UI without their OAuth implementation, proxy or quota rotation.
- Tests cover synthetic credentials, rollback faults/recovery, cross-edition
  concurrency, drift, CLI rejection of pinned execution, and Chromium UI.
  A disposable native macOS keyring roundtrip is separate from account tests.
  Cross-process `security` access requested OS approval and was cancelled;
  real agy sign-in/refresh and native Windows/Intel execution remain unverified.
  No real user credential was read or switched during implementation.

## Verification

`npm run test:antigravity` uses synthetic credentials and a hidden isolated
Electron renderer, plus real main/preload IPC with an injected synthetic vault.
The IPC integration verifies that cancellation performs zero credential writes.
`npm run test:antigravity-native` creates and deletes only a
UUID-named disposable OS-keyring entry; it never accesses `gemini:antigravity`.
Set `AGY_TEST_CROSS_READ=1` explicitly for the macOS cross-process ACL check;
this can require an OS permission and times out after eight seconds.

Production installation, app reload, Google login and releases are separate
from source verification and have not been performed by these tests.

### Recorded local results

- Personal and distribution default test suites passed; Windows-only terminal
  checks skipped on macOS. Existing profile-launch/delegation (28 cases), model
  catalogue and reset-credit renderer checks passed without provider changes.
- All 13 adapter cases and the two-width Chromium UI passed. Real main/preload
  IPC passed startup-without-keyring-access, save, cancel, confirmation, action
  allowlist and saved-account removal without logout.
- Disposable native ARM macOS UTF8 keyring write/read/delete passed. This does
  **not** establish that the official agy process has permission to read a
  Switch-created keychain entry. That OS approval remains a real-account gate.
- Universal app contains separately verified arm64 and x86_64 NAPI libraries.
  The initial build exposed a missing cross-architecture optional dependency;
  `scripts/prepare-native-keyring.js` now installs both pinned, SHA512-verified
  packages before packaging. `x64ArchFiles` preserves the separate libraries,
  and the loader selects the actual running CPU; ARM is not relabelled as Intel.
- `test/antigravity-packaged.js` loads the ARM binding from the actual universal
  ASAR, extracts the standalone CLI, loads its native binding and runs metadata
  listing in a temporary home. It never reads real credentials. Run it with
  `ELECTRON_RUN_AS_NODE=1 <app-executable> test/antigravity-packaged.js <app.asar>`;
  never launch an app normally with a test script argument.

A packaged app is a verification artifact, not a release or proof of successful
Google sign-in. Explicitly confirmed application replacement/restart and an
interactive two-account agy sign-in/refresh check are still required for live
acceptance. Native Windows and Intel execution are not tested on this ARM Mac.

### macOS login recognition fix (2026-10-31)

After official agy 1.4.12 sign-in, an approved, read-only native observation
confirmed a `go-keyring-base64:` envelope containing `token`, `auth_method`
and `id_token_email`. The old parser rejected the physical keyring string;
unwrapping it let the same parser identify the account. Only field names/types
and pass/fail booleans were retained, never credential values. The encoding
matches [upstream go-keyring](https://github.com/zalando/go-keyring/blob/master/keyring_darwin.go).

Regression coverage uses synthetic values with that observed schema: direct
login check/display over real main/preload IPC, save/switch, canonical fallback
JSON, exact physical-byte rollback and malformed-envelope rejection. Initial
reproduction failed on the old parser; all 15 adapter cases pass after fixing
the actual parsing and fallback-writing paths. This does not establish a live
two-account switch/refresh or authorize restarting the installed app.

Diagnostic procedure: a read-only keychain request can still open an OS approval
dialog, and approval may be specific to the requesting executable. Keep only
one live credential-read probe pending, let the user handle its prompt, and do
not click Check or spawn another reader while that probe is unresolved. Retain
only a schema/prefix classification and pass/fail results; never log credentials.
Do not automate SecurityAgent or substitute another reader to bypass approval.
