# Security Policy

VTNexa is a local-first tool whose security model is **human-in-the-loop
approval**, not isolation. This page states what the app does and does not
protect against.

## What is enforced

- **Review gate:** every side-effecting tool call (shell, browser actions,
  rename/delete, git commit) requires an explicit approval click. File edits
  are staged as diffs; nothing writes to disk until you approve.
- **Workspace confinement (server-side):** file tools are restricted to the
  workspace root chosen per window, with symlink-safe path resolution and a
  deny list for sensitive paths (`~/.ssh`, `~/.gnupg`, browser profile,
  `/etc`, ...).
- **Shell backstop:** the backend refuses a small set of never-legitimate
  patterns — recursive forced removal of `/` or `$HOME`, `mkfs`/`mkswap`,
  `dd`/redirection to block devices, fork bombs, and direct credential reads
  (`cat ~/.ssh/id_rsa`, ...) — even if approved.
- **Secrets:** API keys are stored in the OS keychain (per endpoint+model),
  never in session files or the workspace. Without a keychain daemon they
  fall back to app-local storage, and the UI labels this.

## What is NOT protected

- **Approved commands run as you.** The shell backstop is pattern-based
  defense-in-depth, **not a sandbox**. It does not resist deliberate
  obfuscation (`$'...'`, encodings, fetched scripts). If you approve a
  command, read it first.
- **The interactive terminal is unscreened by design** — it is your shell.
- **Prompt injection:** web pages and file contents enter the model's
  context. A malicious page could try to steer the agent; your approval
  clicks are the last line of defense.
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
