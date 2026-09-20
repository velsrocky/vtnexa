# Changelog

## 0.4.0 - 2026-09-21

### Commander autonomy (opencode-style, default ON)
- **Approval only for outside access.** Workspace-confined operations (file
  writes, shell, renames, deletes, commits, typechecks) run with NO dialog;
  anything reaching outside (`~`, sudo, piped-to-shell, outside absolutes,
  browser/MCP tools) keeps the native dialog. New `workspaceScope.ts`
  confinement checker (component-boundary paths, quote-aware shell scanner,
  benign `/dev` nodes exempt). Toggle in Settings → Commander autonomy;
  review-gated mode restores per-action approval + Diff staging.
- **Agent writes go direct in auto mode** (no Diff staging), with undo
  captured so `/undo` still works. Auto-claimed approvals are tagged `auto`
  (never `approved`) in the audit log. Backend deny-list, confinement and
  credential blocks still apply — README/SECURITY rewritten honestly around
  the new trust model (workspace = trust boundary in auto mode).
- **Read-only skills are tool-confined.** Skills scoping themselves to
  read-only work (only `/rate` today) can neither be offered nor trigger
  side-effect tools — refused fail-closed before any dialog (the turn that
  committed + npm-installed during a rating is why this exists).
- **Rating buttons removed** (👍/👎 + local feedback store deleted) along
  with their e2e assertions.

### Tests
- **Long-turn integration coverage**: a hook-level replay of the messy live
  turn (30 messages of history, 10 tool rounds with parallel calls, a repeated
  call, a transient 500 mid-turn, reasoning deltas) that pins the whole
  context-management regression class in one place - task preserved in every
  outbound request, nudges confined to the tool/system channels, the 500
  retried rather than fatal, thinking frames streamed before the answer
  exists, tool cards and audit complete, turn closed cleanly. Mutation-checked:
  it fails if the task anchor is removed, and fails if nudges return to the
  user role.

### Tooling & quality
- **Injection surface narrowed:** browser page text now enters the model
  context behind an explicit `untrusted web page content` fence; the top bar
  always shows the active autonomy mode (`⌾ auto` / `⌾ gated`) so the trust
  model in force is never implicit.
- **Branch coverage** further improved (73.3% → 74.8%; 460 tests): hook-level
  suites for trusted-path management, editor-tab lifecycle (dirty guards,
  rename/delete retargeting), workspace switching/browse flows, preview
  variants and tauri wrapper defaults.
- **Sandbox visibility:** new `sandbox_status` backend command +
  `useSandboxStatus` probe; the top bar shows a `⚠ no shell sandbox` chip
  when firejail is absent or the probe fails (fail-closed display), so the
  screening-only degradation is never silent.
- **Real linting**: ESLint 9 flat config (typescript-eslint recommended,
  react-hooks, react-refresh) wired into `pnpm lint` with
  `--max-warnings 0`; all 53 pre-existing errors fixed (useless escapes and
  assignments, empty catches, untyped `Record<string, any>` policy
  signatures narrowed to `unknown`), wire-format JSON modules carry scoped
  documented disables instead of blanket rule-off.
- **Audit export verification was a no-op**: `computeHash` used an
  array-replacer in `JSON.stringify`, which serialized every entry to `{}` —
  any tampered export re-hashed to the same digest and "verified". Replaced
  with a canonical field-tuple serialization; tamper-evidence test suite
  added (field mutation, entry deletion, key reordering, malformed input).
- **CI rewritten**: was a workflow whose lint step always passed
  (`eslint || true` with eslint not installed), whose Rust jobs would fail
  without Tauri system deps, and which never ran the e2e suite. Now three
  jobs — frontend (lint, typecheck, vitest+coverage ratchet, Playwright e2e
  in chromium), backend (rustfmt, clippy `-D warnings`, cargo test, cached),
  release (tauri-action, drafts only on `v*` tags) — all with
  `--frozen-lockfile` and pnpm pinned via `packageManager`.
- **Vitest**: `vmThreads` + `isolate: false` (jsdom-per-file churn warning
  gone), DOM-less suites pinned to the `node` environment, coverage provider
  (`@vitest/coverage-v8`) actually installed and ratcheted at
  75/62/75/78.
- **Rust**: whole crate formatted with `cargo fmt` and enforced in CI.
- **Branch coverage push** (67.6% → 73.3%; statements 80.7% → 85.8%, ratchet
  raised to 82/70/80/85): full `preview.ts` suite (language map, CSP wrapper,
  sanitizer hostility cases), `browser.ts` port/approval wiring, and new
  `chatWithTools` round-trips pinning the toAnthropic (system/image merging,
  streamed `input_json_delta`, `tool_result`, orphan drop) and toGemini
  (`system_instruction`, UPPERCASE schema, `functionCall`/`functionResponse`,
  malformed-args guard) wire formats.
- **Dependabot** for npm, cargo and GitHub Actions (weekly, grouped).
  Release CI now builds Linux + Windows + macOS on tags.
- Dead code removed: unused duplicate of `ToolPolicy`/`ToolDef`
  (`src/lib/agent/types.ts`), empty `src/test-setup.ts`.

### Fixed
- **Approved browser actions never reached the backend**: the `browser_*`
  wrappers still sent snake_case `approval_token`/`approval_detail` and
  `target_ref`, but Tauri v2 binds camelCase — the same class of wire bug
  previously fixed for `shell_run`. Options silently bound to `None`
  (dropped approvals), required `u32` args failed outright. Wrappers
  corrected; wire-format regression tests added (`browser.test.ts`).
- **Synthetic nudges no longer masquerade as the user**: loop-guard,
  skill-follow-through, narration, denial and question repairs were injected as
  role "user" messages, which both crowded the user channel (a live model
  reported "only loop-guard prompts") and displaced the real request when
  history was trimmed. Repeat nudges now ride **inside the tool result** they
  follow; prose repairs are role "system" with a `[system nudge]` marker
  (Anthropic/Gemini fold these into the system prompt; OpenAI-compatible gets
  an in-place system instruction).
- **Long tool-heavy turns lost their task**: history trimming kept only the
  system message + the last 20 messages, and loop-guard nudges are injected as
  role "user" too - so trimming cut at a nudge and dropped the actual request.
  Observed live: a 23-tool-call analysis turn reached the model reporting
  "no actual task was given in the conversation - only loop-guard prompts".
  `windowConvo` now always re-attaches this turn's request (the pristine
  input's last user message) and never duplicates it.
- **Reasoning models froze the transcript blank**: llama.cpp/Ollama/DeepSeek
  stream chain-of-thought in `delta.reasoning_content`, which the parser
  ignored — a 35B's thinking phase (often 30s+) rendered as nothing at all.
  Reasoning deltas now drive a live muted `⏺ thinking` tail that is never
  persisted into the final message, and reasoning deltas publish their own
  frames (previously only content deltas did, so the phase stayed blank).
- **One transient 500 killed a finished turn**: `postJSON` retried only
  network errors, so a sporadic llama.cpp template/slot 500 (seen live:
  "Jinja Exception: No messages provided") aborted an otherwise successful
  45-second turn. Server-side failures (5xx/429) now retry once before any
  body byte is consumed - safe to replay; 4xx still fails fast.
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
- **Streaming markdown**: the in-flight reply now renders as markdown
  (throttled to ~8 updates/s, with a guaranteed final flush) instead of raw
  text, and the reasoning tail moved into a muted `⏺ thinking` block backed by
  its own `thinking` field - display-only, never persisted (session restore
  keeps id/role/content/tools only). Measured against marked: partial markdown
  (unterminated ```/~~~ fences, half-written tables, unclosed emphasis) renders
  safely, so no fence auto-closing is applied - appending a closing fence was
  verified to inject its own backticks into the block or add an empty `<pre>`.
- **Render-level tests** for the transcript: markdown body, streaming body,
  thinking tail, inert links (the pieces originally shipped unverified).
- **Playwright agent-turn e2e**: a real Commander turn in the production
  webview with a scripted OpenAI-compatible provider (route interception) and
  a browser-only Tauri stub for the workspace-boot path - asserts transcript
  markdown, tool-card trail, audit entry, provider task retention, and rating.
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

### Security hardening (review pass)
- **Trusted paths matched on substrings**: `docs` also matched `mydocs`,
  and any value (including `/`) was accepted with no validation — a planted
  entry could silently bypass `fs_write` gates. Patterns are now normalized
  relative fragments matched on path-component boundaries, with escapes
  (`..`, `~`, `/`) refused server-side and mirrored in the Settings UI.
- **Background shell jobs skipped the sandbox**: `shell_bg` spawned bare
  `sh` while `shell_run` went through firejail. New
  `sandbox::exec_bg_command` gives bg jobs identical confinement (time bound
  stays the 30min poll-kill), and job output files use `O_EXCL`.
- **MCP remote had no SSRF guard**: workspace-planted servers could point at
  IMDS/loopback/LAN. Untrusted servers now reuse the browser host blocklist;
  trusted (global/explicitly enabled) servers keep full access for local dev.
- **Approval detail truncation hole**: tokens fingerprinted only the 4k
  truncated prefix, so bytes past it were mutable without re-approval. Tokens
  now bind full length + hash alongside the prefix.
- **Unbounded session/routine reads**: `session_load`/`session_get`/
  `routines_load` read without caps (saves were capped). All loads now go
  through a metadata-gated `read_capped`.
- **Rate limiter was minute-only**: the advertised 500/day cap was a dead
  constant, and only `shell_run` was checked. Daily cap implemented, wait-time
  math fixed, coverage extended to `shell_bg`, `mcp_call_tool` and gated
  browser ops. Dead `health.rs` stub removed; approval-token fallback entropy
  hardened; `write_atomic` temp files use `O_EXCL`.
- PTY documented as user-gesture-only (absent from `TOOL_DEFS` by design) with
  a backend test pinning `pty_*` off the approval surface.

### Frontend hygiene + structure
- **`window.confirm` eliminated** (5 sites): new `ConfirmContext` with a
  non-blocking in-window modal (mounted above App); hooks fall back to the
  old blocking confirm only without a provider, so existing tests were
  unaffected. `closeTab` is async now; callers updated.
- **`providers.ts` split, phase 2**: `toolDefs.ts` owns the tool types
  (circular import with providers gone), new `toolCatalog.ts` owns `TOOL_DEFS`;
  `providers.ts` 2263 → ~1850 lines with compat re-exports.
- **Prop-drilling cleanup, phase 1**: new `AppContext` feeds TopBar /
  ProviderBar / WorkspaceBar / SessionBar (~30 props gone, memoized slices +
  `memo()` so stream tokens skip the bars); `updateWs`/`logAudit`/`stopTurn`
  stabilized with `useCallback`. Heavy panes stay on props pending
  selector-shaped stores (documented in context module).
- `useDiffGate` deduplicated onto `types.ts:undoEntrySize`; one
  `exhaustive-deps` disable removed (`useMcp.refresh` is a stable
  `useCallback`), the other 8 documented with loop/timing rationale; dead
  0-byte `src/config` + `src/__tests__` removed.

### Tests
- Turn-digest test repaired (it exercised the early-exit path, never the
  exhaustion path it claimed) plus its `process.env` typing break; digest
  suite green with the suite: 349 vitest + 69 Rust + clippy clean + 5 e2e.
- New: bar component tests (context rendering, interactions, fail-loud
  wiring), `ConfirmContext` modal tests, rate-limiter minute/daily tests,
  approval suffix-mutation test, trusted-pattern boundary tests, MCP SSRF
  test, sandbox bg-command test; new `settings.spec.ts` e2e pins trusted-path
  validation in the real webview.

## 0.3.0
- Review-gated Commander, Monaco/Diff, PTY, Git tab, routines, browser use,
  MCP (opt-in), skills, per-window isolation, audit log.
