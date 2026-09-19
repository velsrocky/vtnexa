# Architecture

One window = one app instance. Thin React components → domain hooks → Tauri
commands in `src-tauri/src/lib.rs` → OS / sidecar.

## Frontend (`src/`)

- `App.tsx` — composition only (TopBar/ProviderBar/WorkspaceBar/SessionBar +
  FileTree/EditorPane/ChatPane + Git/Browser/Terminal panes + modals).
- `hooks/` — one domain per hook (`useAgentTurn`, `useWorkspace`, `useGit`,
  `useMcp`, …) with colocated `*.test.ts`.
- `lib/` — pure + backend seams:
  - `toolDefs.ts` — READONLY/GATED sets, `toolsForMode` (plan vs build).
  - `providers.ts` — agent loop (`chatWithTools`) + `runTool` gate
    (native dialog → `Approval` token → backend command).
  - `approval.ts` — `approvalIssue()` (native dialog, agent path),
    `approvalClaim()`/`claimFor()` (no dialog, direct-gesture paths),
    `detailFor()`/`actionFor()` fingerprint helpers, `lspNeedsApproval()`.
  - `tauri.ts` / `browser.ts` / `mcp.ts` / `pty.ts` — typed `invoke` wrappers
    (all privileged calls carry `approval_token` + `approval_detail`).

## Backend (`src-tauri/src/`)

- `lib.rs` — thin facade: module declarations, `run()` (window lifecycle,
  managed state, command registration), and re-exports of the cross-module
  names other backend modules use (`WorkspaceRoots`, `checked_path`,
  `shell_deny_reason`, …).
- `workspace.rs` — per-window allowlist sandbox: `WorkspaceRoots` /
  `AppSettings` state, `checked_path`, `ensure_within_root` (symlink-safe),
  `is_trusted_path`, root set/get + `update_trusted_paths`.
- `util.rs` — P0 guardrail limits (`MAX_*`) + shared helpers (`write_atomic`,
  `truncate_chars`, `reject_sensitive`, `safe_absolute`).
- `fsops.rs` — file list/read/write/create/rename/delete + workspace-wide
  search (`fs_search` grep-style, `fs_glob`).
- `nexa.rs` — `<workspace>/.nexa/` persistence: Pad/Plan, legacy
  `session.json`, named sessions (`sessions/*`), routines.
- `keys.rs` — OS keychain for provider API keys (per endpoint+model, legacy
  service migration).
- `git.rs` — status/diff/commit/log/init (argv-direct, no shell).
- `skills.rs` — project + bundled skills (`.vtnexa/skills/*.md`).
- `shell.rs` — command screening (`shell_deny_reason`), capped exec
  (`run_capped`), `shell_run` behind the approval gate.
- `pty.rs` — window-bound PTY lanes (spawn/write/resize/kill, reaper).
- `window.rs` — `create_window` + label allocation.
- `approvals.rs` — native OS confirm (`approval_issue`, agent path) +
  dialog-free claims (`approval_claim`, direct gestures); single-use tokens
  bound to window + action + detail fingerprint, 5min TTL.
  Privileged: `shell_*`, `git_commit`, `fs_write/rename/delete`,
  `browser_*`, `mcp_call_tool`, `lsp_*` (exec paths).
- `mcp.rs` — local allowlist (npx/node/python…; no sh/curl), workspace-only
  servers marked `untrusted` (no `{env:}` substitution), `mcp_workspace_trust`.
- `lsp.rs` / `lsp_ops.rs` — `find_project_root` clamped to workspace;
  `cargo`/`tsc`/local servers need approval, `py_compile` is free.
- `browser.rs` + `sidecar/browser/server.js` — token via 0600 file (env
  fallback), sandboxed Chromium (no `--no-sandbox` by default), SSRF block
  (loopback/private/link-local), release pins to bundled `server.js`.
- `shell_jobs.rs` — background jobs (8 max, 30min, 2MB), same screening.

## Security model

Approval dialogs are native OS windows, not page DOM; `ApprovalStore` is the
enforcement point and tokens bind the exact approved arguments. CSP is tight
(no `unsafe-eval`, `frame-src 'self'`). Direct-gesture claims trust the
renderer by design — the gate stops model output from self-approving, not
XSS. See `SECURITY.md` for the honest limits (approved commands run as you;
PTY is your shell).
