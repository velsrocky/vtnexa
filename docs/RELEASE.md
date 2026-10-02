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
   The updater key password is optional only when the private key is not encrypted. Apple signing remains supported through the optional `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` secrets.
4. **Tag and push.**
   ```sh
   git tag -a v1.2.3 -m "VTNexa v1.2.3"
   git push origin v1.2.3
   ```
5. **Wait for the tagged pipeline.** `release-preflight` checks the exact tag, all three manifest versions, and the four mandatory secret names before any release build. A missing or malformed value fails without printing secret contents.
6. **Build each platform.** The matrix stages the checksum-verified Node sidecar, builds Tauri bundles, imports the PFX into the Windows runner, derives its code-signing thumbprint, and signs the app and installer artifacts through `bundle.windows.signCommand`. The command uses SHA-256 for both the file digest and timestamp digest and uses the configured timestamp URL. Tauri then creates the updater artifacts and `.sig` files with `TAURI_SIGNING_PRIVATE_KEY`.
7. **Keep the GitHub release draft.** `tauri-action` uploads to a draft only. The final Windows verification job waits for every matrix build, downloads the draft assets, parses `latest.json`, requires every updater asset and matching `.sig`, requires both Windows installer formats, and rejects malformed or mismatched data.
8. **Verify Authenticode.** PowerShell checks every downloaded Windows `.exe` and `.msi` for `Valid` status, the expected certificate thumbprint, SHA-256, and a trusted timestamp verified by `signtool`. Only after this succeeds does the job edit the draft to public.

A local unsigned build may proceed only when no Windows signing material is configured. If any signing variable is present, the signing script fails closed until the thumbprint and timestamp URL are both valid. A local build never substitutes for the tagged release preflight.

## Windows WebDriver smoke

The `Windows Tauri Smoke` workflow runs on pull requests, pushes to `main`, and manual dispatch. It installs exact `tauri-driver` 2.0.6, installs the matching Edge driver through `msedgedriver-tool` 0.2.2 pinned to source revision `8c4b34f51b45f5cf08013366d703de464ab871d1`, stages the verified Node sidecar, builds real NSIS and MSI bundles, and drives the built WebView2 executable. The smoke is Windows-only and uses the real Tauri IPC path: first-run view, absolute temporary workspace entry, ready workbench, workspace value returned by IPC, and the real Settings dialog. It does not use the web preview or Tauri invoke stubs.

Protocol and signing/release helpers are dependency-free Node scripts. Their unit tests run with `pnpm test:node`; the release manifest and secret preflight tests are part of the normal CI test jobs.
