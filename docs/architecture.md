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
    (modal → `approval_issue` token → backend command).
  - `approval.ts` — `approvalIssue()` + `lspNeedsApproval()` (.py free).
  - `workspaceStore.ts` — audit/approval queue store (App.tsx slimming).
  - `tauri.ts` / `browser.ts` / `mcp.ts` / `pty.ts` — typed `invoke` wrappers
    (all privileged calls carry `approval_token`).

## Backend (`src-tauri/src/`)

- `lib.rs` — sandbox (`checked_path`, `ensure_within_root`), shell screening
  (`shell_deny_reason`), PTY (window-bound ids), git (argv-direct), skills.
- `approvals.rs` — single-use capability tokens (window + action, 5min TTL).
  Privileged: `shell_*`, `git_commit`, `fs_rename/delete`, `browser_*`,
  `mcp_call_tool`, `lsp_*` (exec paths).
- `mcp.rs` — local allowlist (npx/node/python…; no sh/curl), workspace-only
  servers marked `untrusted` (no `{env:}` substitution), `mcp_workspace_trust`.
- `lsp.rs` / `lsp_ops.rs` — `find_project_root` clamped to workspace;
  `cargo`/`tsc`/local servers need approval, `py_compile` is free.
- `browser.rs` + `sidecar/browser/server.js` — token via 0600 file (env
  fallback), sandboxed Chromium (no `--no-sandbox` by default), SSRF block
  (loopback/private/link-local), release pins to bundled `server.js`.
- `shell_jobs.rs` — background jobs (8 max, 30min, 2MB), same screening.

## Security model

Approval modal is UX; `ApprovalStore` is enforcement. CSP is tight
(no `unsafe-eval`, `frame-src 'self'`). See `SECURITY.md` for the honest
limits (approved commands run as you; PTY is your shell).
