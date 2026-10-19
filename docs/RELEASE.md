# Release checklist

Public releases are fail-closed. A tag never publishes an unsigned release.

1. **Version the three manifests together.** Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. The pushed tag must be exactly `v<manifest version>`.
2. **Run the local checks.**
   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm test:provision
   pnpm test:sidecar
   pnpm e2e
   pnpm build
   cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
   cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml --locked
   ```
3. **Configure the mandatory release secrets.** The following names are exact:
   - `TAURI_SIGNING_PRIVATE_KEY`: the Tauri updater private key. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is also passed when the key is encrypted.
   - `WINDOWS_CERTIFICATE`: a base64-encoded Windows code-signing PFX.
   - `WINDOWS_CERTIFICATE_PASSWORD`: the PFX export/import password.
   - `WINDOWS_TIMESTAMP_URL`: the configured RFC 3161 timestamp service URL.
   - **macOS signing and notarization are mandatory, not optional.** An ad-hoc or
     unsigned macOS build is blocked by Gatekeeper, and Tauri cannot update an
     unsigned macOS app at all. Provide ONE of:
     - signing: `APPLE_SIGNING_IDENTITY` (a Developer ID Application identity
       already in the runner keychain) **or** `APPLE_CERTIFICATE` +
       `APPLE_CERTIFICATE_PASSWORD` (base64 P12, imported by Tauri); and
     - notarization: `APPLE_ID` + `APPLE_PASSWORD` (an app-specific password)
       + `APPLE_TEAM_ID` **or** `APPLE_API_KEY` + `APPLE_API_KEY_ID` +
       `APPLE_API_ISSUER` (App Store Connect API key).

     The preflight fails closed when neither alternative of a category is
     completely configured, and reports the missing NAMES only - never a
     secret value.

     The updater key password is optional only when the private key is not
     encrypted.
4. **Tag and push.**
   ```sh
   git tag -a v1.2.3 -m "VTNexa v1.2.3"
   git push origin v1.2.3
   ```
5. **Wait for the tagged pipeline.** `release-preflight` checks the exact tag, all three manifest versions, and the required secret names before any release build. A missing or malformed value fails without printing secret contents.
6. **Build each platform.** The matrix stages the checksum-verified Node sidecar, builds Tauri bundles, imports the PFX into the Windows runner, derives its code-signing thumbprint, and signs the app and installer artifacts through `bundle.windows.signCommand`. The command uses SHA-256 for both the file digest and timestamp digest and uses the configured timestamp URL. On macOS the runner fails closed unless Apple signing and notarization material is present, and the App Store Connect API key (when used) is materialised from the secret to a `0600` file before Tauri reads it. Tauri then creates the updater artifacts and `.sig` files with `TAURI_SIGNING_PRIVATE_KEY`.
7. **Keep the GitHub release draft.** `tauri-action` uploads to a draft only. Two verification jobs then run against that draft, and the release is published only if BOTH pass:
   - `release-verify-windows` (Windows): the final verification job waits for every matrix build, downloads the draft assets, parses `latest.json`, requires every updater asset and matching `.sig`, requires both Windows installer formats, and rejects malformed or mismatched data. It then checks every downloaded Windows `.exe`/`.msi` for `Valid` status, the expected certificate thumbprint, SHA-256, and a trusted timestamp verified by `signtool`.
   - `release-verify-macos` (macOS): extracts the shipped `.app` bundle and verifies the Developer ID Application signature, the expected team identifier, Gatekeeper acceptance (`source=Notarized Developer ID`) and the stapled notarization ticket. An ad-hoc signature, a missing ticket, or a signature from another team fails the release.
8. **Publish.** `release-publish` needs both verification jobs, re-checks that the release is still a draft, and only then flips it public.

A local unsigned build may proceed only when no Windows signing material is configured. If any signing variable is present, the signing script fails closed until the thumbprint and timestamp URL are both valid. A local build never substitutes for the tagged release preflight.

## Windows WebDriver smoke

The `Windows Tauri Smoke` workflow runs on pull requests, pushes to `main`, and manual dispatch. It installs exact `tauri-driver` 2.0.6, installs the matching Edge driver through `msedgedriver-tool` 0.2.2 pinned to source revision `8c4b34f51b45f5cf08013366d703de464ab871d1`, stages the verified Node sidecar, builds real NSIS and MSI bundles, and drives the built WebView2 executable. The smoke is Windows-only and uses the real Tauri IPC path: first-run view, absolute temporary workspace entry, ready workbench, workspace value returned by IPC, and the real Settings dialog. It does not use the web preview or Tauri invoke stubs.

Protocol and signing/release helpers are dependency-free Node scripts. Their unit tests run with `pnpm test:node`; the release manifest, secret preflight and Apple signing/verification tests are part of the normal CI test jobs.
