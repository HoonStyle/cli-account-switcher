# Account delegation contract

Applies to agents working in this repository, including Claude Code and Codex.

- A request to delegate to another account means a per-process profile, NOT a global active-account change.
- Inspect the intended installation with `cli-accounts --help` and `cli-accounts list --json`. The JSON includes its data root and exact profile IDs; installations may have different profiles.
- Use `cli-accounts delegate claude --profile <id> -- <literal CLI arguments>` or `cli-accounts delegate codex --profile <id> -- <literal CLI arguments>`. Keep the requested model in the official CLI arguments. `run <tool> --profile <id> -- ...` remains compatible with older installations.
- Never use `use`/`switch`, rewrite global configuration, copy credentials, or substitute an active/default profile to satisfy a delegation request. Missing profiles or authentication failures must be reported, not repaired by switching accounts.
- Direct execution forwards the official CLI output and exit status. Preserve the actual CLI session/thread ID if returned; do not invent a managed task ID. Use `tasks` when managed task tracking is required.
- Do not install or reload a running app as a side effect of a source change.
- Verify both source and installed launchers with `node test/delegation.js`; it uses isolated temporary profiles and fake executables, not live authentication.
