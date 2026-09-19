# Changelog

## Unreleased

### Fixed
- **Approved shell commands never ran**: the `shell_run` wrapper sent
  snake_case `approval_token`/`approval_detail` keys, but Tauri v2 binds
  command args camelCase — so every approved call (agent + manual shell tab)
  died at the binding layer with "missing required key approvalToken" *after*
  the dialog was approved. Wrapper fixed; wire-format regression tests added.
- **Shell sandboxing actually works now**: firejail integration had invalid
  flags (`--profile=new`, `--nonewpriv`, `--rlimit-*`) and swallowed failures
  via `let _ =`, so every approved command ran in a doomed jail and then
  **again unsandboxed** (double side effects). `sandbox::exec_command` is now
  the single execution path (firejail with verified flags when installed,
  `timeout`-wrapped otherwise); README security claims corrected to match
  reality (no invented memory/network limits).
- Stale `#[allow(dead_code)]` in `sandbox.rs` removed; firejail-absent
  fallback (30s `timeout`) documented and tested.
- Dead `git_merge`/`git_worktree_*` frontend wrappers removed (no backend
  commands, no callers).

### Commander legibility
- Agent replies render as **markdown** (sanitized via DOMPurify; links become
  inert `text (url)`; event handlers stripped) — only finalized replies, so
  live streaming never flickers partial markup.
- **Role headers** (You / Commander / Note) and **turn separators** make the
  transcript scannable.
- **Inline tool cards**: each turn's tool calls appear as a collapsed summary
  row (`7 tool calls · 6/7 ok · 2 approved · 4.2s`) that expands to one card
  per call — tool name, key arg, ok/fail, approve/reject badge, duration.
  Captured from the audit stream (≤40/turn), persisted in session.json
  (last 20/message, strict revive validation).
- **Prompt contract rewrite**: act-first micro-contract replaces the
  frontier-model rambling mandates (restated intent + numbered plan on every
  reply); anti-narration rules moved to end-of-prompt where they bind;
  stall-warning no longer teaches the model to echo meta-commentary.

### Session durability
- **Undo/redo trails persist** across reloads/restarts (newest 10 entries,
  512KB char budget, oldest-first eviction, strict revive validation);
  `/undo` after a reload reverts the last approved write/rename/delete.
- Playwright artifacts (`playwright-report/`, `test-results/`) gitignored.

### Security
- Native OS approval dialogs (`approval_issue`): page JS and model output can
  trigger but cannot click them. Tokens are single-use and bound to window +
  action + exact argument detail (5min TTL); argument swaps after approval are
  refused. Direct user gestures (Diff Approve, commit buttons, tree ops,
  manual browser driving) use dialog-free `approval_claim` — safe against
  prompt injection, explicitly NOT against XSS (see SECURITY.md).
- `fs_write` and `shell_kill` now require tokens (were UI-gated only); Diff
  Approve, undo/redo, Git tab, tree ops, skill creation, and manual shell /
  browser driving all thread claim tokens.
- Retired the HTML ApprovalModal queue (programmatically clickable) and the
  interim `workspaceStore`; shell escape warnings moved into the native
  dialog text.
- Backend approval tokens enforced on `shell_*`, `git_commit`,
  `fs_write/rename/delete`, `browser_*`, `mcp_call_tool`, `lsp_*` exec paths.
  Direct `invoke` without a token now fails.
- Tightened CSP (drop `unsafe-eval`, `frame-src 'self'`, minimal `img/font`).
- PTY ids validated and window-bound (`<label>:<lane>`); `create_window`
  capped at 10.
- `set_workspace_root` refuses `/` and `$HOME` without explicit confirm.
- Shell screening: basename matching (`/bin/cat`), `sudo -u`/`env` prefix
  handling, interpreter coverage (python/node/perl/ruby/git/vim…), paren fix
  for `open('~/.ssh/…')`.
- MCP: local command allowlist (npx/node/python/uvx/bunx/deno/go…; blocks
  sh/curl/sudo), workspace-only `untrusted` flag + trust note, `{env:}`
  stripping for untrusted servers.
- LSP: `find_project_root`/`server_command` clamped to workspace; `cargo`/`tsc`
  need approval, local `.bin` servers need approval, `py_compile` stays free.
- Browser: token via 0600 file, `--no-sandbox` opt-in only, release pins to
  bundled `server.js`, SSRF block (loopback/private/link-local) in Rust +
  sidecar, empty-token deny.

### Frontend
- `runTool` mints backend tokens after modal Approve; `lsp_*` gated
  dynamically; unknown MCP fails before any popup/invoke.
- Split `lib/toolDefs.ts` (gating) + `lib/approval.ts` + `lib/workspaceStore.ts`;
  `providers.ts` re-exports for compat.
- MCP panel shows `untrusted` badge + workspace trust warning.
- `vitest.config.ts` with coverage; 285+ frontend tests green.

## 0.3.0
- Review-gated Commander, Monaco/Diff, PTY, Git tab, routines, browser use,
  MCP (opt-in), skills, per-window isolation, audit log.
