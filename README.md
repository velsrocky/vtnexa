# VTNexa

**A private agentic workspace for your code.** A desktop app
(Tauri v2 + React) where a tool-calling agent drives your workspace — autonomous
inside it, approval-gated the moment it reaches outside.

![VTNexa window](docs/screenshot.png)

Run it fully offline against Ollama, or point it at any OpenAI-compatible
endpoint, Anthropic, or Gemini. Your API keys live in the OS keychain. Your
files stay yours. No telemetry, no accounts, no cloud round-trip you didn't
choose.

## Why this exists

Most coding agents either (a) ask for permission on every keystroke or
(b) quietly edit your repo and hope for the best. VTNexa takes a third path:

- **Autonomous inside, gated outside.** File writes, shell commands, renames,
  deletes and commits *inside your workspace* run free — no popups. The
  moment an action reaches outside (absolute paths elsewhere, `~`, sudo,
  piped-to-shell downloads, browser and MCP tools), a native approval dialog
  pops. Toggle it in Settings → Commander autonomy (review-gated mode asks
  for everything, like before).
- **Local by default.** `ollama pull qwen2.5-coder:7b` and you have a private
  coding agent. Switch models per window — grind with a cheap local model in
  one window, think with a frontier model in another.
- **Every window is its own app instance.** Independent workspace folder,
  provider, terminal, chat history, and audit trail. `⧉ New Window` (or just
  launch the app again) opens a sibling.
- **Full transparency.** Per-window token counts, estimated cost, tool
  timing, and a persisted audit log of every tool call and your decision on
  it.

## Features

- **Commander** — tool-calling agent: list/read/search files, write files
  directly, run shell commands, typecheck edited files and query language
  servers (`lsp`: hover, definition, references, symbols), drive a real
  Chromium browser (navigate, click, type, screenshot with vision), and commit
  to git. In-workspace work runs free; outside-workspace access, browser
  actions and MCP tools pop the native approval dialog (backend single-use
  tokens). Review-gated mode (Settings) restores per-action approval with
  side-by-side Diff staging. Long shell work (installs, builds, test suites)
  runs as background jobs (`shell_bg` + `shell_poll`, same screening as
  foreground); turns that run out of budget offer a ▶ Continue
  button over full history. **Plan mode** (◔ toggle or per-turn) restricts it
  to read-only tools for investigation-first flows; routines always run Build.
- **Undo** — approved writes, renames and file deletes are captured
  (↩/↪ buttons, `/undo` `/redo` in chat). Shell/terminal, directory deletes
  and files over 256KB are out of scope; the stack resets on reload.
- **Editor** — Monaco with tabs, live markdown/HTML preview, and a Diff view
  that is also the approval surface.
- **Terminal** — a genuine interactive PTY per window (xterm.js): run dev
  servers, `vim`, `ssh`, whatever you'd do in a terminal.
- **Git tab** — status, per-file diffs, log, commit; approve-&-commit from
  the gate.
- **Nexa Pad / Plan / Memory** — shared notes and durable cross-session
  context the agent reads and writes (`<workspace>/.nexa/`).
- **Skills** — 9 ready-made slash commands (`/commit`, `/review`, `/explain`,
  `/map`, `/fix`, `/refactor`, `/test`, `/docs`, `/scaffold`); add your own
  as markdown files. Project `AGENTS.md`/`CLAUDE.md` is loaded every turn.
- **Routines** — scheduled agent runs with a 15-minute minimum interval.
- **Browser Use** — persistent Chromium profile (signed in as you) the agent
  can operate with your approval; screenshots come back as vision input.
- **MCP (early, opt-in)** — local-stdio and remote-HTTP MCP servers from
  `vtnexa.json` (`~/.config/vtnexa/vtnexa.json` +
  `<workspace>/.vtnexa/vtnexa.json`, see `.vtnexa/vtnexa.json.example`).
  Toggle + per-server status in the ⛁ panel; tools appear as
  `mcp_<server>_<tool>`, always require approval. Remote auth is static
  headers with `{env:...}` substitution (never commit tokens), or OAuth browser
  sign-in from the ⛁ panel (tokens in the OS keychain, silent refresh).
- **Sandboxing** — Approved commands run **exactly once** in firejail (when
  installed) with verified flags:
  - System directories read-only: `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`
  - Private `/tmp` and `/dev` per run
  - No privilege escalation (`--nonewprivs`)
  - Wall-clock time limit (30s, via `timeout` inside the jail)
  - The workspace stays writable (builds, tests, git need it) and network
    stays reachable (installs, fetches) — those are covered by the approval
    dialog and backend screening, not the jail.
  Without firejail, the same command runs behind the same screening +
  approval + timeout path (no second, unsandboxed execution).
- **Rate limiting** — 30 turns per minute per window, 500 turns per day (prevents token exhaustion)
- **Audit log export** — Export full audit trail with cryptographic hash verification
- **Health monitoring** — Uptime tracking, memory usage, turn count, heartbeat checks
- **Trusted paths** — Skip approval dialogs for safe directories (e.g., `docs/`, `src/generated/`, `tests/__snapshots__/`). Configure via Settings → Trusted Paths to reduce UX verbosity without compromising safety.

## Install

**Linux (deb):** grab the latest release `.deb` and `sudo dpkg -i`.

**From source:**

```sh
# prereqs: Node 20+/pnpm, Rust, and Tauri's system deps
# (Debian/Ubuntu: libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev)
pnpm install
pnpm tauri dev        # run from source
pnpm tauri build      # produce .deb / AppImage
```

**Model:** start Ollama (`ollama serve`, `ollama pull qwen2.5-coder:7b`) or
paste any provider's baseUrl + key into the provider bar. Tip: pick a model
that handles tool calling well (`qwen2.5:7b-instruct`, `llama3.1:8b`,
`qwen2.5-coder:32b`); VTNexa also recovers tool calls printed as plain text.

## Security model (honest version)

This section documents exactly what is and isn't protected. Read it carefully.

### ✅ What IS protected

- **Outside access pops a dialog.** Anything reaching outside the workspace
  (absolute paths elsewhere, `~`, sudo, piped-to-shell downloads, browser and
  MCP tools) pops a native OS dialog — page content cannot click it.
  In-workspace file writes, shell, renames, deletes and commits run free
  (opencode-style; toggle review-gated mode in Settings for per-action
  approval). Read-only tools always run free.
- **Workspace confinement.** File tools are confined server-side to the workspace root you pick (per window), with symlink-safe checks and a sensitive-path deny list.
- **Secrets.** API keys go to the OS keychain (per endpoint+model), never to session files or the workspace. Without a keychain daemon they fall back to app-local storage and the UI says so.
- **Destruction patterns blocked.** The backend refuses obviously destructive shell patterns (`rm -rf /`, `mkfs`, `dd`, `curl | sh` pipe downloads to shell) and direct reads of credential material (`~/.ssh`, AWS creds, `/etc/shadow`) — even when auto-approved or blindly approved.
- **Read-only skills are confined.** Skills that scope themselves to read-only
  work (e.g. `/rate`) can neither be offered nor trigger side-effect tools —
  refused fail-closed before any dialog could appear.

### ⚠️ What is NOT protected (auto mode)

**In auto mode the workspace is the trust boundary: a prompt-injected model
(malicious webpage content, poisoned repo instructions, hostile tool output)
can drive in-workspace writes and shell commands with NO popup.** The backend
backstops above still apply, and every auto-approved call is tagged `auto`
(not `approved`) in the audit log — but do not point Commander at untrusted
content in auto mode and walk away. Review-gated mode (Settings) restores a
dialog on every side effect.

### ⚠️ What is NOT sandboxed

**This is the critical limitation: Approved commands run as your OS user with your full permissions.**

- The interactive terminal (PTY) has NO screening - it's your shell.
- `curl ... | sh` is allowed in the backend but WARNINGED in the native approval dialog - it's how many toolchains work.
- The backend screening is a *backstop against blind clicking*, not a sandbox. It catches patterns, not obfuscation.
- If you approve a command that does `curl | sh` or runs arbitrary code, that code runs with your permissions.

### Recommendation

Treat every "Approve" click as a commitment to trust what the agent is doing. Read the native dialog carefully (including sandbox-escape warnings). The agent should explain what it needs to run before asking for approval. Treat unexpected dialogs as hostile and reject them.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## CLI

```
vtnexa --version     show version
vtnexa --help        options + skill list
vtnexa --uninstall   remove a per-user install
```

## Development

```sh
# Quick start
pnpm install
pnpm dev

# Full test suite
pnpm test                        # ~285 Vitest tests + coverage
pnpm e2e                         # Playwright E2E tests
cargo test --manifest-path src-tauri/Cargo.toml --lib  # 56 Rust tests

# Build
pnpm build                       # tsc + vite
cargo build --release            # Tauri release

# Lint and typecheck
pnpm exec tsc --noEmit
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

### Makefile targets

```sh
make dev         # Run development server
make build       # Build production app
make test        # Run all tests
make lint        # Run linters
make install-local  # Build and install locally
```

### CI/CD

Automated testing and building on every PR:
- ESLint (`--max-warnings 0`) + TypeScript type checking
- Vitest unit tests with a coverage ratchet
- Playwright e2e (chromium, against the web build)
- Rust fmt check, clippy (`-D warnings`), and tests
- Tauri release builds on all three platforms (draft release on `v*` tags)
- Dependabot: weekly grouped updates for npm, cargo and GitHub Actions

See `.github/workflows/ci.yml` for details.

Architecture: thin React components → domain hooks (one window = one
workspace) → Tauri commands in focused `src-tauri/src/` modules (workspace
sandbox, approvals, git, shell, PTY, keychain — see `docs/architecture.md`)
→ Playwright sidecar for Browser Use. Details in `docs/architecture.md`;
changes in `CHANGELOG.md`.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Early
project: expect rough edges, label experiments accordingly.

## License

Apache-2.0 — see [LICENSE](LICENSE).
