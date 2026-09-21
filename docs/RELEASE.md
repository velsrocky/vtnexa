# Release checklist

Pre-1.0: tag `v0.x.y` from `main`; CI must be green on the tag.

1. **Version bump** — edit `version` in `package.json` and
   `src-tauri/Cargo.toml` (keep them in sync; the binary reads Cargo's).
2. **Clean tree + green bar**
   ```sh
   pnpm lint && pnpm exec tsc --noEmit
   pnpm exec vitest run --coverage
   pnpm e2e
   pnpm build
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
   cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
   ```
3. **Build bundles**
   ```sh
   pnpm tauri build          # .deb + AppImage under src-tauri/target/release/bundle/
   ```
   Tag pushes build all three platforms in CI (linux/windows/macos matrix);
   note in the release what's actually shipped.
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

## Signing & updater (opt-in, one-time setup)

Releases ship **unsigned** today (Windows SmartScreen and macOS Gatekeeper
will warn). The workflow already passes every signing secret through to
tauri-action when present (`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`,
`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE[_PASSWORD]`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) - they are no-ops while unset.

1. **Updater keypair** (one time, keep private key offline):
   ```sh
   pnpm tauri signer generate -w ~/.tauri/vtnexa.key
   ```
   Add the result to repo settings → Secrets → Actions as
   `TAURI_SIGNING_PRIVATE_KEY` (+ passphrase as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
2. **macOS signing** (needs an Apple Developer account): export a
   Developer ID certificate and set the `APPLE_*` secrets above.
3. **Enable the updater plugin**: add `tauri-plugin-updater` to the
   frontend/backend, point it at the release feed, and add
   `createUpdaterArtifacts: "true"` to the release job in ci.yml.
4. Verify: the next tagged release should attach `.sig` files and show
   a signed identity in `codesign -dv` / `signtool verify` output.

## Notes

- AppImage can't be built on Arch-based distros without extra libs; on
  Debian/Ubuntu it works out of the box.
- The `.deb` is the primary Linux artifact; `scripts/install-local.sh` is
  the no-sudo dev install.
