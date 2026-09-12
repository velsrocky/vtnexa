# VTNexa — private, review-gated agentic workspace

A Tauri v2 desktop app (Rust + React/TypeScript): a Commander agent drives
your workspace through tools, with nothing writing, running, or clicking
without your explicit approval.

- **Commander** — tool-calling agent over any OpenAI-compatible endpoint,
  Anthropic, or Gemini. Token streaming, loop guard, history windowing.
- **Review gate** — agent writes stage into a Diff view; you Approve & apply
  (optionally commit). Shell, browser actions, renames, deletes, and commits
  pop an approval dialog. Read-only tools run free.
- **Browser Use** — real Chromium (persistent profile, signed in as you) the
  agent can navigate, read, click, type, and screenshot (vision).
- **Nexa Pad / Plan / Memory** — live shared notes at `.nexa/`; Memory is
  durable cross-session context.
- **Lanes + routines** — concurrent per-lane agents (background work with
  review-later dots) and scheduled routines, each in its own lane.
- **Git tab** — status, diffs, log, commits; Approve-&-commit from the gate.
- **Transparency** — per-lane tokens, estimated cost, tool timing, and a
  persisted audit trail of every tool call + decision.
- **Skills** — 8 ready-made slash skills (`/commit`, `/review`, `/explain`, `/map`, `/fix`, `/refactor`, `/test`, `/docs`) in `.vtnexa/skills/`. Invoke as `/name` in Commander or let the agent load them via `skill_read`; project `AGENTS.md`/`CLAUDE.md` is auto-loaded every turn.
- **Local by default** — keys in the OS keychain, files and sessions under
  your workspace (`.nexa/`), no telemetry. Works fully offline with Ollama.

## Skills

Bundled ready-mades live in `.vtnexa/skills/` (also shipped as Tauri resources, so they work before any workspace is opened). Add your own: create `.vtnexa/skills/<name>.md` — first `#` title is the name, first content line is the description, the rest is the instruction body.

| Skill | What it does |
|---|---|
| `/commit` | Conventional commit message for staged changes |
| `/review` | Review staged diff for bugs then style |
| `/explain` | Bottom-up file/function explainer |
| `/map` | Trace a feature across files |
| `/fix` | Fix an error from root cause + verify |
| `/refactor` | Clean up a file without changing behavior |
| `/test` | Write or run tests for the last change |
| `/docs` | Docstrings for changed functions |

Project convention: put team rules in `AGENTS.md` (or `CLAUDE.md` fallback) at the workspace root — Commander includes it every turn.

`vtnexa --help` lists skills and options; `vtnexa --version` and `vtnexa --uninstall` work without opening a window.

## Run

Prereqs: Node/pnpm, Rust, Ollama (or any OpenAI-compatible endpoint,
Anthropic/Gemini key).

```sh
pnpm install
pnpm tauri dev        # frontend + Rust desktop shell
```

First run: if Ollama isn't listening at `http://localhost:11434/v1`, the chat
will say so — start it (`ollama serve`, `ollama pull qwen2.5-coder:7b`) or
point baseUrl at your provider.

## Build

```sh
pnpm build            # typecheck + vite bundle
pnpm tauri build      # distributable bundle (needs system webkit/rust targets)
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
