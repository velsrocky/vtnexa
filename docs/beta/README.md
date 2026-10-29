# VTNexa controlled beta

Invite 5–10 developers only after the candidate is signed, notarized, and the
native installation and live-provider checks have passed. The local ad-hoc
build is a device-test artifact and is not the distributable beta.

Live task checks can be repeated on this machine:

```sh
node scripts/device-agent-validation.mjs --model llama3.1:8b
node scripts/device-agent-validation.mjs --model deepseek-r1:8b
node scripts/device-agent-validation.mjs --cancel-only
```

These run the production agent loop against the real provider and actual
temporary files, with immutable acceptance tests. Their IPC adapter is a
filesystem harness; these results do not replace native desktop UI tests.
For a cloud run, configure `VTNEXA_TEST_BASE_URL`, `VTNEXA_TEST_MODEL`,
`VTNEXA_TEST_API_KEY`, and optionally `VTNEXA_TEST_KIND` in the process
environment, then run the same script with `--cloud`. Keys are not logged.

## Candidate and enrollment

Record the version, source commit and working-tree patch hash, DMG SHA-256,
signing identity, and notarization result with each candidate. Each tester gets
a stable ID (P01–P10). Keep contacts in the chosen private distribution channel;
the tracker needs IDs and results only. No invitations have been sent yet.

Use `cohort.json` for observations and run:

```sh
node scripts/beta-metrics.mjs docs/beta/cohort.json
```

An empty cohort means no results, not a zero-percent success rate. Record dates
as YYYY-MM-DD in one agreed timezone. `activeDates` are reported usage days,
not downloads or invitation opens. Day 2 means the calendar day after first
use; day 7 means six calendar days after first use.

Participant shape:

```json
{"id":"P01","invitedAt":"YYYY-MM-DD","installedAt":null,"firstUsedAt":null,"activeDates":[]}
```

Task result shape:

```json
{"participantId":"P01","candidate":"version + artifact hash","date":"YYYY-MM-DD","task":"bug-fix | feature | refactor","provider":"model and endpoint type, no keys","completed":false,"testsPassed":false,"lostWork":false,"evidence":"private issue or retained audit export"}
```

Issue shape:

```json
{"id":"B001","participantId":"P01","severity":"P0 | P1 | P2","status":"open | fixed | verified","reproduction":"steps","candidate":"version + artifact hash","evidence":"path or private link"}
```

## Tester procedure

1. Install the signed DMG into Applications on a machine without VTNexa data.
   Record whether Gatekeeper accepts it and whether onboarding opens.
2. Choose a temporary git repository. Connect Ollama or a cloud provider.
   Record configuration errors and time to the first successful response.
3. Fix a small bug, add a feature, and refactor existing code. For each task,
   inspect the git diff, run independent tests, and record the outcome.
4. Try review-gated mode. Reject an agent action and verify it did not occur.
   File tools should refuse paths outside the workspace. Shell screening is
   not complete isolation of project scripts.
5. Make an unsaved editor change and draft a message. Save the session, quit,
   reopen, explicitly resume the saved session, and verify the full contents.
6. Start a long model response, press Stop, and confirm the app becomes usable
   without late output or an unintended later tool action.
7. Check for updates. When a newer signed beta is available, install it and
   verify the version and existing workspace/session data afterward.
8. Report whether the app was used on day 2 and day 7. Report lost work
   immediately, including the candidate and reproduction steps.

## Review cadence

Review incoming issues daily. P0 is lost work, unintended outside access, or
credential exposure; pause distribution until investigated. P1 blocks a core
task or installation. Fix and independently retest each issue before marking
it verified. Keep feature scope fixed during the cohort.

Invite message, to send through the selected channel after the release gates:

> I’m testing a VTNexa beta with a small developer group. Please try the
> attached signed candidate on a temporary repository and follow the linked
> checklist. I’m measuring installation success, completed coding tasks,
> lost-work incidents, and whether you return on day 2/day 7. Reply with your
> participant ID, version, what you asked it to do, and the result. Participation
> and follow-up feedback are optional; the app sends no telemetry.
