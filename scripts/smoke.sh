#!/usr/bin/env bash
# Smoke gate: the full green bar in one command. Run before every commit.
# (Tauri dev/build smoke stays manual per docs/RELEASE.md.)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== tsc =="
pnpm exec tsc --noEmit

echo "== vitest =="
pnpm test

echo "== cargo test =="
cargo test --manifest-path src-tauri/Cargo.toml --lib

echo "== clippy =="
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings

echo "== fmt =="
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

echo "== sidecar syntax =="
node --check sidecar/browser/server.js

echo
echo "SMOKE OK"
