# Local-model functional debugging — 2026-10-29

The coding path now completes the three small device tasks with
`qwen2.5-coder:7b`. This is a working local-model configuration, not a claim
that all installed models or larger projects are reliable.

## Changes

- Native Ollama `/api/chat` uses a constrained JSON action schema instead of
  relying on each model's native tool-call template. Code strings are decoded
  once, preserving real newlines and literal escape sequences. Answers stream
  normally; action/file JSON stays out of the chat transcript.
- `auto` recognizes the standard loopback Ollama port. Explicit `ollama`
  supports other endpoints; explicit `openai` preserves compatibility mode.
  Provider history and saved sessions retain the selection. Model checks and
  the model picker normalize Ollama root, `/api`, and `/v1` endpoints.
- The local Commander prompt is shorter and consistent with the action format.
  Ordinary coding tasks offer focused file/shell tools; explicitly requested
  browser, Git, language-server, notes, and MCP capabilities remain available.
  Existing Plan-mode restrictions and native approval gates still apply.
- Schema sampler initialization errors alone receive a JSON-mode retry. The
  session remembers incompatible endpoint/model pairs; action validation and
  execution gates remain in force. Other HTTP errors do not take this fallback.
- Compatibility-mode text calls accept `parameters` as well as `arguments`.
  Unchanged writes cannot masquerade as implementation progress; repeated
  reads/tests after real edits no longer trigger the stuck-loop guard.
- Interrupted turns report a stopped/error state rather than successful
  completion. Unresolved tool errors remain visible in final answers.

## Device evidence

The opt-in harness runs the production `useAgentTurn` prompt and orchestration,
the real Ollama service, and real temporary Git fixtures. A filesystem IPC
adapter supplies file operations, approval tokens, and real Node test commands.
It does **not** exercise native Tauri dialogs or the installed app's chat UI.
The checks use host Node 26.12.1.

The original acceptance tests are immutable. Independent checks also verify
the exact public exports and error messages, reject unchanged implementations,
and require one `Number.isFinite` occurrence for the refactor. The harness also
checks that the model ran passing tests after its final edit, separately from
the independent verifier's test run.

| Qwen Coder task | Result |
| --- | --- |
| Fix subtraction in `sum` | Passed; correct addition and empty-array behavior |
| Add `average` using `sum` | Passed; existing `sum` preserved, empty array returns zero |
| Extract shared validation | Passed; private helper, existing exports and error behavior preserved |
| Stop during streamed answer | Passed; `AbortError` surfaced |
| Send a fresh request after Stop | Passed; received `ready` |

Review the [coding evidence](beta/evidence/ollama-qwen25-coder-native-full.json)
and [cancellation evidence](beta/evidence/ollama-qwen25-coder-cancellation.json).
The coding evidence includes actual diffs and test output; the adjacent task
event files record the model's file writes and test commands.

Earlier intermediate runs exposed a false pass: behavior tests accepted an
unwanted exported helper. Independent API checks now reject that result. No
fixture implementation was manually fixed and no acceptance test was weakened
to produce a pass.

Llama 3.1 8B still added an unwanted exported helper in its latest refactor
retry, which the independent API check rejected. See its
[failure evidence](beta/evidence/ollama-llama31-native-refactor.json).
DeepSeek R1 8B's initial native retry failed inside Ollama while initializing
the sampler; see the [initial evidence](beta/evidence/ollama-deepseek-native-refactor.json).
After adding the sampler fallback, its next refactor attempt still did not
complete within the four-minute limit; see the
[retry evidence](beta/evidence/ollama-deepseek-native-fallback-refactor.json).
These models are not established as reliable alternatives by this validation.

## Reproduce

```sh
node scripts/device-agent-validation.mjs --model qwen2.5-coder:7b --full-prompt
node scripts/device-agent-validation.mjs --model qwen2.5-coder:7b --cancel-only
node scripts/device-agent-validation.mjs --model llama3.1:8b --task refactor --full-prompt
node scripts/device-agent-validation.mjs --model deepseek-r1:8b --task refactor --full-prompt
```

Each run prints its evidence directory and returns a nonzero exit status on
failure. It changes only temporary fixtures. No cloud credentials are required.

## Checks and installation

- Frontend: 624 tests passed, 3 skipped.
- Node regression checks: 68 passed.
- Playwright: 7 passed, using mocked native/provider boundaries.
- TypeScript and ESLint passed; desktop release app build passed.
- The local app bundle passed strict signature-integrity verification and was
  installed at `/Applications/VTNexa.app`. An earlier build in this pass was
  launched successfully; relaunch the app to load the final build. The previous installation
  is preserved at `/tmp/VTNexa-before-ollama-20261029.app`.

The app is locally ad-hoc signed, without notarization. Native UI interaction
still lacks Accessibility automation permission; these results do not establish
that native approval dialogs or a fresh GUI coding session were exercised.
No beta was published and no developer invitations were sent.
