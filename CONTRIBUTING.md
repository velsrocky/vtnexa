# Contributing to VTNexa

Thanks for helping! This is an early-stage (0.x) project — feedback, bug
reports, and small PRs are especially valuable right now.

## Dev setup

```sh
# prereqs: Node 20+, pnpm, Rust (stable), Tauri v2 system deps
# Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
#   libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf
pnpm install
pnpm tauri dev
```

## The green bar (what CI runs)

```sh
pnpm exec tsc --noEmit     # types
pnpm test                  # vitest (139 tests, jsdom)
pnpm build                 # tsc + vite bundle
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

## Layout

- `src/App.tsx` — composition only: wires hooks + render. Keep it boring.
- `src/hooks/*` — one domain per hook (workspace state, editor, diff gate,
  session, git, provider, shell, routines, skills, init, prefs). Each has
  colocated tests.
- `src/components/*` — presentational, props in / callbacks out.
- `src/lib/providers.ts` — the multi-backend agent loop (OpenAI-compatible /
  Anthropic / Gemini). The most safety-sensitive file in the frontend;
  changes need tests.
- `src-tauri/src/lib.rs` — sandboxed fs/git/shell/PTY/keychain commands.
  Every new command must be confined per-window and registered in
  `capabilities/default.json` if it needs a frontend permission.

## Conventions

- **Tests are required for behavior changes** in hooks and `providers.ts`.
  Pure logic > snapshots; mock the Tauri seam via `vi.mock("@tauri-apps/api/core")`.
- Keep the security posture: anything that runs commands or touches paths
  goes through the existing guards (`checked_path`, `shell_deny_reason`,
  approval gating). New side-effecting tools must be added to `GATED_TOOLS`.
- No new runtime dependencies without a strong reason — this ships as a
  desktop bundle.
- Style: match surrounding code; comments only where the *why* is non-obvious.

## PRs

- One concern per PR; describe the user-visible change and how you verified.
- Link the issue when there is one.
- CI green = ready for review.

## Issues

Use the templates. For bugs: include OS, model + endpoint, and the audit-tab
entry (copy JSON) for the failing tool call — it makes repros fast.
