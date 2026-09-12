# Release checklist

Pre-1.0: tag `v0.x.y` from `main`; CI must be green on the tag.

1. **Version bump** — edit `version` in `package.json` and
   `src-tauri/Cargo.toml` (keep them in sync; the binary reads Cargo's).
2. **Clean tree + green bar**
   ```sh
   pnpm exec tsc --noEmit && pnpm test && pnpm build
   cargo test --manifest-path src-tauri/Cargo.toml --lib
   cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
   cargo fmt --manifest-path src-tauri/Cargo.toml --check
   ```
3. **Build bundles**
   ```sh
   pnpm tauri build          # .deb + AppImage under src-tauri/target/release/bundle/
   ```
   macOS/Windows artifacts need their respective runners (CI or a manual
   build on that OS) — note in the release what's actually shipped.
4. **Smoke the installed build** (not `tauri dev`):
   - `vtnexa --version` / `--help`
   - open a workspace, one Commander turn with a tool call, approve a diff,
     run a shell command, open a second window, restart the app (session
     restore), check the Audit tab.
5. **Tag + release**
   ```sh
   git tag -a v0.x.y -m "VTNexa v0.x.y" && git push origin v0.x.y
   ```
   Attach the `.deb` (and AppImage) to the GitHub release; write notes:
   highlights, fixed issues, known issues, model recommendations.
6. **Post-release:** close the milestone, update README if install paths
   changed.

## Notes

- AppImage can't be built on Arch-based distros without extra libs; on
  Debian/Ubuntu it works out of the box.
- The `.deb` is the primary Linux artifact; `scripts/install-local.sh` is
  the no-sudo dev install.
