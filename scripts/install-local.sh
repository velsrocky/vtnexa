#!/usr/bin/env bash
# Build the .deb and install it per-user without sudo:
#   ~/VTNexa/usr/bin/vtnexa  (binary + resources)
#   ~/.local/bin/vtnexa      (PATH shim - keeps `vtnexa --version` working)
#   ~/.local/share/applications/VTNexa.desktop + icon (launcher)
# Usage: scripts/install-local.sh [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEST="$HOME/VTNexa"
BIN="$DEST/usr/bin/vtnexa"
SHIM="$HOME/.local/bin/vtnexa"

if [[ "${1:-}" == "--skip-build" ]]; then
  echo "==> skipping build (--skip-build)"
else
  echo "==> building release bundle (deb)"
  pnpm tauri build --bundles deb
fi

DEB="$(ls -t src-tauri/target/release/bundle/deb/VTNexa_*.deb 2>/dev/null | head -n1 || true)"
if [[ -z "$DEB" ]]; then
  echo "error: no VTNexa_*.deb found under src-tauri/target/release/bundle/deb/" >&2
  echo "       run without --skip-build first" >&2
  exit 1
fi

echo "==> installing $DEB -> $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
dpkg-deb -x "$DEB" "$DEST"

echo "==> PATH shim: $SHIM"
mkdir -p "$HOME/.local/bin"
ln -sf "$BIN" "$SHIM"

echo "==> desktop entry + icon"
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor"
ICON_SRC="$(find "$DEST/usr/share/icons/hicolor" -name vtnexa.png | sort | head -n1 || true)"
if [[ -n "$ICON_SRC" ]]; then
  cp -f "$ICON_SRC" "$HOME/.local/share/icons/vtnexa.png"
  ICON="$HOME/.local/share/icons/vtnexa.png"
else
  ICON="utilities-terminal"
fi
sed -e "s|^Exec=.*|Exec=$BIN|" -e "s|^Icon=.*|Icon=$ICON|" \
  "$DEST/usr/share/applications/VTNexa.desktop" > "$HOME/.local/share/applications/VTNexa.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo "==> verify"
"$SHIM" --version
echo "done. Launch from your apps grid, or run: vtnexa"
