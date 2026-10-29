# Functional debugging — 2026-10-28

Six defects were corrected without changing the model or adding new agent tools.

| Defect | Fix and regression coverage |
|---|---|
| A new workspace inherited old tabs and dirty buffers | Workspace boot clears editor state; a test starts with unsaved buffers from another root and checks that they do not cross the boundary |
| Undo ignored a resumed session's history or retained another session's actions | Workspace/session state now owns the Undo/Redo stacks; a regression resumes a different history, undoes its file only, then verifies a fresh session has no old history |
| Overlapping session saves could finish out of order | Saves are serialized; a delayed first write cannot overwrite the newer snapshot |
| Normal window close could discard edits still waiting for autosave | The Tauri close handler awaits an immediate session save, prevents closing on failure, and blocks close during an active Commander turn |
| Plan-mode answers could be marked unverified because no mutation occurred | Mutation expectations apply only when mutable tools are available and Plan mode is off |
| An auto-write treated every read error as a missing file | Only missing-file errors permit creation; permission/read errors refuse the write and preserve the original |

Validation: **607 frontend tests passed, 3 skipped; 7 Playwright browser tests
passed; ESLint, TypeScript, and the native macOS release app build passed.**
The close-handler tests cover immediate saving, save failure, active agent
protection, listener cleanup, and browser preview behavior. The capability change
adds only `core:window:allow-destroy`, needed by Tauri's close-handler API after
the save succeeds.

The rebuilt app is installed at `/Applications/VTNexa.app`; the prior local
installation is preserved at `/tmp/VTNexa-before-functional-fixes.app`. The new
bundle passed strict code-signature integrity verification and was launched.
It remains a local ad-hoc build, not a notarized beta release.

Native UI automation still requires macOS Accessibility permission. Therefore,
native close-button behavior has handler regression coverage and a successful
native build, but has not been exercised by clicking the installed UI. Forced
termination and OS-level quit paths that bypass window-close requests are not
covered by the new close handler. Prior live-model task reliability limitations
remain; these changes do not establish that weak local models generate correct
code consistently.

The earlier beta-validation DMG remains a historical artifact. This functional
debugging pass rebuilt and installed the `.app`; it did not republish that DMG
or release a beta.
