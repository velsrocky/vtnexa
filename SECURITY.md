# Security Policy

VTNexa is a local-first tool whose security model is **workspace autonomy
with outside-access approval** (opencode-style), not isolation. A
review-gated mode (Settings → Commander autonomy, off by default) restores
per-action approval. This page states what the app does and does not protect
against — in auto mode first, since that is the default.

## What is enforced

- **Outside-access gate (native, backend-enforced):** agent actions reaching
  outside the workspace (absolute paths elsewhere, `~`, sudo, piped-to-shell
  downloads, browser actions, MCP tools) pop a NATIVE OS confirm dialog and
  mint a single-use token bound to the window, action, and exact arguments
  (5-minute expiry). Page JavaScript and model output can trigger the dialog
  but cannot click it, and direct backend calls without a token fail. Direct
  user gestures (Diff Approve button, Git commit button, tree ops, manual
  browser driving) mint tokens without a dialog — the click is the intent.
  In review-gated mode, every side effect above (plus in-workspace writes,
  staged as diffs) goes through the same dialog path.
- **In-workspace auto-approval (frontend, audited):** workspace-confined
  operations claim their token silently through the trusted runTool layer —
  the model never sees tokens. Every auto-approved call is tagged `auto`
  (never `approved`) in the audit log. Read-only skills (e.g. `/rate`) are
  additionally confined to their prescribed tools: out-of-scope calls are
  refused before any dialog could appear.
- **Workspace confinement (server-side):** file tools are restricted to the
  workspace root chosen per window, with symlink-safe path resolution and a
  deny list for sensitive paths (`~/.ssh`, `~/.gnupg`, browser profile,
  `/etc`, ...).
- **Shell backstop:** the backend refuses a small set of never-legitimate
  patterns — recursive forced removal of `/` or `$HOME`, `mkfs`/`mkswap`,
  `dd`/redirection to block devices, fork bombs, and direct credential reads
  (`cat ~/.ssh/id_rsa`, ...) — even if approved. Screening parses shell
  tokens and invocations (operators split at `; && || | &`), not raw
  substrings: `echo "rm -rf /"` is harmless, `sudo -u root cat ~/.ssh` is
  refused.
- **OS-level shell confinement (firejail):** when firejail is installed,
  agent shell commands (foreground *and* background jobs) run inside it:
  system directories read-only, private `/tmp` and `/dev`, no new privileges,
  workspace still read/write. When firejail is absent the command runs
  unsandboxed (screening-only) — same execution path, never a second try.
  The top bar shows a `⚠ no shell sandbox` chip whenever confinement is
  unavailable, so the degraded mode is never silent.
- **Secrets:** API keys are stored in the OS keychain (per endpoint+model),
  never in session files or the workspace. Without a keychain daemon they
  fall back to app-local storage, and the UI labels this.

## What is NOT protected

- **Approved commands run as you.** Pattern screening is defense-in-depth,
  not a jail: it does not resist deliberate obfuscation (`$'...'`, encodings,
  fetched scripts). firejail confines the *filesystem view*, not network or
  your own home directory (the workspace often lives under it). If you
  approve a command, read it first.
- **The interactive terminal is unscreened by design** — it is your shell.
- **Prompt injection:** web pages and file contents enter the model's
  context. A malicious page can try to steer the agent and can trigger
  approval dialogs, but it cannot confirm them — an unattended dialog blocks
  the turn instead of approving. **In auto mode (default) this protection
  covers only outside-workspace actions:** injected instructions CAN drive
  in-workspace writes and shell with no popup. Treat unexpected dialogs as
  hostile and reject them; point Commander at untrusted content only in
  review-gated mode.
- **Renderer compromise (XSS) is NOT contained:** arbitrary JavaScript in the
  webview can call the no-dialog claim path used by buttons. Mitigations are
  a tight CSP (no `unsafe-eval`, `frame-src 'self'`) and sanitized markdown
  previews — not a boundary. The gate's promise is narrower: model output
  alone cannot self-approve.
- **Multi-user systems:** per-user app data assumes a single trusted user
  session.

## Reporting a vulnerability

Open a **private security advisory** via
[GitHub → Security → Report a vulnerability](https://github.com/velsrocky/vtnexa/security/advisories/new),
or file a regular issue only if the bug is already public-safe. We aim to
acknowledge within 7 days and ship a fix or mitigation within 30.

## Version support

Pre-1.0: only the latest `main` is supported. Fixes land in `main` and ship
in the next release.
