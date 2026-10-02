#!/usr/bin/env bash
# Real-backend Linux WebDriver smoke wrapper.
#
# Drives the ACTUAL app (not the mocked Playwright e2e suite) through
# tauri-driver + WebKitWebDriver. Requires:
#   - tauri-driver 2.0.6   (cargo install tauri-driver --version 2.0.6 --locked)
#   - WebKitWebDriver      (webkit2gtk-driver / webkitgtk-webdriver package)
#   - a display            (xvfb-run is used automatically when DISPLAY is unset)
#
# Usage: scripts/tauri-smoke.sh [--app <path>] [--build] [--require] [--optional]
#   --app      path to the built binary (default: src-tauri/target/debug/vtnexa)
#   --build    build the app first (tauri build --debug --no-bundle)
#   --require  fail hard when prerequisites are missing (CI)
#   --optional skip with a warning when prerequisites are missing (aggregate local run)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${SKIP_TAURI_SMOKE:-0}" = "1" ]; then
  echo "SKIP_TAURI_SMOKE=1 set; skipping the real-backend Tauri smoke" >&2
  exit 0
fi

APP="$PWD/src-tauri/target/debug/vtnexa"
DO_BUILD=0
REQUIRE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:?--app needs a path}"; shift 2 ;;
    --build) DO_BUILD=1; shift ;;
    --require) REQUIRE=1; shift ;;
    --optional) REQUIRE=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

missing() {
  echo "tauri-smoke: $1" >&2
  if [ "$REQUIRE" -eq 1 ]; then
    exit 1
  fi
  echo "tauri-smoke: skipping (pass --require to make this fatal)" >&2
  exit 0
}

DRIVER="${TAURI_DRIVER_BIN:-$HOME/.cargo/bin/tauri-driver}"
[ -x "$DRIVER" ] || missing "tauri-driver not found at $DRIVER; install: cargo install tauri-driver --version 2.0.6 --locked"

if [ -z "${TAURI_WEBKIT_WEBDRIVER:-}" ]; then
  if command -v WebKitWebDriver >/dev/null 2>&1; then
    TAURI_WEBKIT_WEBDRIVER="$(command -v WebKitWebDriver)"
  else
    found="$(ls /usr/lib/*/webkit2gtk-*/WebKitWebDriver /usr/libexec/webkit2gtk-*/WebKitWebDriver 2>/dev/null | head -n1 || true)"
    if [ -n "$found" ]; then TAURI_WEBKIT_WEBDRIVER="$found"; fi
  fi
fi
[ -n "${TAURI_WEBKIT_WEBDRIVER:-}" ] || missing "WebKitWebDriver not found; install webkit2gtk-driver or set TAURI_WEBKIT_WEBDRIVER"

if [ -z "${DISPLAY:-}" ] && ! command -v xvfb-run >/dev/null 2>&1; then
  missing "no DISPLAY and xvfb-run is unavailable"
fi

if [ "$DO_BUILD" -eq 1 ] || [ ! -x "$APP" ]; then
  echo "== building the Tauri app (frontend embedded) ==" >&2
  pnpm exec tauri build --debug --no-bundle
fi

export TAURI_WEBKIT_WEBDRIVER
export TAURI_DRIVER_BIN="$DRIVER"

SMOKE=(node scripts/tauri-linux-smoke.mjs --app "$APP")
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a --server-args="-screen 0 1600x1000x24" "${SMOKE[@]}"
fi
exec "${SMOKE[@]}"