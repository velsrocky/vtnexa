# Changelog

## Unreleased

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
