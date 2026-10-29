# Mac device validation — 2026-10-28

## Decision

**Do not distribute this candidate yet.** A local test app has been built and
installed, but Developer ID signing/notarization is unavailable, native UI
automation is blocked, and the installed local models do not reliably complete
the coding acceptance tasks. Cloud evaluation and tester enrollment are pending.

Device: Apple Silicon macOS. Source version: 1.0.7, based on commit
`83a36754b4048e8dcf98a299131766e16f533a52` plus the current uncommitted fixes.
Host Node: 26.12.1. Packaged sidecar Node: 24.18.0, archive checksum verified.

Final local installer: `/tmp/VTNexa_1.0.7_beta-validation.dmg` (not a
distributable signed beta). SHA-256:
`0f42c43e151afffde85a7e084541fdd884ff57b5b3932f399aab379321fc0deb`.
Installed executable SHA-256:
`bd0bedd6314a10532508b64d0d24be960ca09c16c85d4f1de477106cbda425ad`.

## Checks completed

| Check | Observation |
|---|---|
| Native app build | Tauri release `.app` built with the real Rust backend and embedded frontend |
| DMG | Initial Tauri DMG built and checksum verified; a later cosmetic Finder packaging step failed, so a standard DMG was created from the rebuilt app using `hdiutil` |
| Installation | Final DMG installed into `/Applications/VTNexa.app` as a clean bundle replacement; prior local test app retained in `/tmp/VTNexa-before-device-fixes.app` |
| Launch | `open` succeeded; System Events reported the `vtnexa` process running |
| Bundle integrity | `codesign --verify --deep --strict` passed for the installed local bundle |
| Distribution trust | `spctl` rejected the ad-hoc bundle. No Developer ID identity or notarization credentials were available |
| Updater artifact | Downloaded the real published macOS 1.0.5 artifact; verified its signature against the app's configured public key; modified bytes were rejected |
| Upgrade installation | Not tested: local source is 1.0.7 while the latest published version is 1.0.5; no newer signed candidate exists for the transition |
| Engine cancellation | Stopped an actual Ollama response after its first text chunk; received `AbortError`; the next request returned `Ready` |
| Frontend regression suite | 598 passed, 3 skipped |
| Rust backend suite on this Mac | 168 passed |
| Node tooling and release suite | 68 passed |
| Browser UI regression suite | 7 passed; these use mocked Tauri IPC and are not native desktop tests |
| Static checks | ESLint, TypeScript, and patch whitespace checks passed |

## Real coding tasks

These use the **production TypeScript agent**, actual Ollama responses, real
temporary git repositories, and immutable independent acceptance tests. The IPC
adapter performs actual filesystem operations but is not the native Tauri
backend. They do not establish native approval-dialog behavior or full desktop
task success. Fixture diffs and test output are retained in the evidence files.

| Provider/model | Bug fix | Feature | Refactor |
|---|---|---|---|
| Ollama `llama3.1:8b`, final run | Pass | Fail | Fail |
| Ollama `deepseek-r1:8b`, comparison run | Fail | Timeout | Fail |
| Cloud provider | Not run: no configured credential | Not run | Not run |

The final llama bug fix changed subtraction to addition and passed independent
tests. Its feature attempt wrote incorrectly escaped source and failed tests.
Its refactor did not produce a valid implementation change. Earlier runs also
changed the public function API or omitted write content entirely. The model
sample is small; these are observed run results, not a general model benchmark.

## Failures fixed during this session

- `fs_write` now rejects omitted/non-string content before reading or changing
  a file. An explicitly supplied empty string remains a supported operation.
- Nonzero foreground and background shell exits now count as tool failures.
- The agent retries unresolved failures before accepting a completion claim.
  Remaining failures are explicitly marked unverified in the final response.
- Coding claims made without any workspace tool use trigger bounded repair
  attempts and remain visibly unverified if the model still does not act.
- Unverified completions produce an error turn status in the desktop frontend.
- Corrected release documentation that implied a signed/notarized 1.0.7 release
  already existed. The observed latest published release was 1.0.5.

The installation automation initially merged bundles with `ditto`, retaining
obsolete hashed frontend assets and invalidating the installed signature. The
merged copy was preserved in `/tmp/VTNexa-merged-invalid.app`; a clean bundle
replacement from the final DMG then passed strict signature verification and
launched successfully. Future local replacement must move the old bundle aside
before copying, rather than merge resource directories.

These safeguards prevent specific unsafe or misleading outcomes. They do not
make an incapable model complete the coding tasks successfully.

## Pending checks and inputs

- **Native onboarding, approval/rejection dialogs, saving/resuming after app
  restart, native Stop button, and updater UI:** macOS reports Accessibility
  disabled for automation. Enable Codex in System Settings → Privacy & Security
  → Accessibility before these checks can be performed. Backend and mocked UI
  regression coverage does not replace these device tests.
- **Cloud tasks:** choose a provider/endpoint/model and configure a credential
  locally. No cloud credential was found in the environment or VTNexa keychain.
  Do not place keys in the tracker or report.
- **Distributable beta:** supply Developer ID signing and notarization setup.
  GitHub secret metadata showed an updater signing key but no Apple signing or
  notarization secrets. Updater signatures do not substitute for Gatekeeper trust.
- **5–10 testers:** provide the recipient list and distribution channel. No
  invitations were sent and no beta was published. Day 2/day 7 retention can
  only be observed after participants use the app on those days.

## Evidence and follow-up

- [Final llama run](evidence/ollama-llama31.json)
- [Deepseek comparison](evidence/ollama-deepseek.json)
- [Streaming cancellation](evidence/cancellation.json)
- [Published updater verification](evidence/updater.json)
- [Current cohort metrics](evidence/cohort-metrics.json)
- [Final installer identity](evidence/artifact.json)
- [Beta checklist and tracker](README.md)

Re-run native acceptance and cloud tasks after the missing inputs are available.
Fix reproduced lost-work, permission, and task-completion failures before
expanding the cohort or feature scope.
