# Launch kit — getting the first 10 real users

VTNexa is technically a product and commercially a project with zero users.
This document is the plan to close that gap. It is deliberately concrete:
channels, ready-to-paste copy, and a schedule.

**The goal is not stars. The goal is ten people who install it, use it on a
real repository, and tell you what broke.** Everything below serves that.

---

## 1. Positioning

The one-line pitch (use this everywhere):

> A local-first desktop coding agent with workspace file tools, local model
> support, and native approval dialogs for commands that require review.

Why that pitch and not "another AI coding agent":

- VTNexa offers workspace autonomy with screened command approvals. Its gate
  is a **native OS dialog** with a single-use token bound to the exact command.
  Shell screening cannot infer all effects of project scripts, and optional
  Firejail protections do not provide complete workspace isolation.
- **It runs fully offline** against Ollama. No account, no telemetry, no
  data leaving the machine. That is a real differentiator for anyone who
  cannot send their code to an API.
- It is a **desktop app**, not a web app: a real terminal, a real editor, a
  real git pane, and a per-window workspace.

Who this is for (the first ten are all of these):

| Persona | Why it fits |
|---|---|
| Privacy-conscious / air-gapped devs | Ollama, no telemetry, keys in the OS keychain |
| People who review AI diffs for a living | The Diff gate *is* the approval surface |
| Local-first / OSS AI enthusiasts | `ollama pull qwen2.5-coder:7b` and it works |
| Power users with a messy multi-repo workflow | One window = one independent instance |
| Teams evaluating agentic tooling | Retained audit events help debug tool use; exports have an unauthenticated checksum |

Who it is **not** for (say this out loud, it saves support time): people who
want a hosted product, people who need their IDE to be VS Code, people who
want the agent to touch files outside the project.

---

## 2. Where the first ten are

Post in order of expected yield. Each community has a self-promo rule —
read it before posting.

| # | Channel | Why | Notes |
|---|---|---|---|
| 1 | **Hacker News — Show HN** | Highest-quality feedback audience; they will find the real bugs | Best launch day. Post 8am–10am ET. |
| 2 | **r/rust** | The stack is Rust + Tauri; the audience reads the code | Post the *architecture*, not the marketing. |
| 3 | **r/LocalLLaMA** | Exactly the "run it offline with Ollama" audience | Lead with the local-model story. |
| 4 | **r/programming** | Broad reach, strict rules | Lead with a technical post-mortem, not a launch. |
| 5 | **lobste.rs** | Smaller, technical, kind | Submit the "what we got wrong" write-up. |
| 6 | **MCP / agentic-Discord servers** | MCP + browser-use users | Ask for tool-call feedback. |
| 7 | **Ollama Discord / GitHub Discussions** | The local-model crowd | |
| 8 | **Dev.to / personal blog** | You own the traffic; no community rules | Publish the macOS process-control post-mortem. |
| 9 | **Product Hunt** | Low signal, good for a vanity screenshot | Only after HN. |
| 10 | **Direct outreach** | Highest conversion | See §5. |

**Do not** cross-post the same text to more than two communities on the same
day. Read each community's rules. Disclose that you built it. If a mod asks,
answer honestly.

---

## 3. Ready-to-paste copy

### 3.1 Show HN (title + body)

**Title**

```
Show HN: VTNexa – a local-first desktop coding workspace with native approval dialogs
```

**Body**

```
I built VTNexa because I wanted the convenience of an agent that can edit my
code without it also being able to `rm -rf` my home directory.

It's a desktop app (Tauri v2 + React, Rust backend). An agent ("Commander")
drives your workspace: reads, searches, writes files, runs shell commands,
drives a real Chromium browser, queries language servers, commits to git.

The model of trust is simple:

  - Inside the workspace: it acts. Writes, shell, renames, deletes, commits.
    No popups.
  - Detected outside access: it asks. A native OS dialog (not a web prompt, so
    the agent can't click its own approval) shows the exact command, and the
    backend mints a single-use token bound to the window, the action and the
    exact arguments. 5-minute expiry, single use.
  - Shell commands run as your OS user. Project scripts can have outside
    effects that screening cannot detect; this is not full isolation.

It's also fully offline if you want it to be: point it at Ollama
(qwen2.5-coder:7b) and nothing leaves your machine. API keys for other
providers live in the OS keychain. No accounts, no telemetry.

Things I'm not proud of yet, so you know what you're getting:
  - macOS only has an Apple Silicon build.
  - The shell runs with your full permissions once you approve it. There's
    firejail support, but it's opt-in by the OS.
  - Browser Use needs a system Chromium (Chrome/Edge/Chromium) - not bundled.

macOS: https://github.com/velsrocky/vtnexa/releases
Source: https://github.com/velsrocky/vtnexa

I'd especially like to hear: what would you want the approval gate to cover
that it doesn't today?
```

### 3.2 r/LocalLLaMA

```
Built a desktop coding agent that runs fully against Ollama - no API key, no
account, nothing leaves the machine.

It's called VTNexa. Point it at http://localhost:11434/v1 with
qwen2.5-coder:7b and it reads/edits/runs things in a folder you pick. It
asks when command screening detects outside access, and for browser/MCP
actions, through native OS dialogs. Project scripts can have outside effects
that screening cannot detect. File tools enforce the folder boundary.

The part I'm most unsure about: small local models are weak at tool calling.
I added a lot of scaffolding to keep them honest (one tool call per reply,
no placeholder paths, a failure breaker after 4 consecutive failed calls).
If you run local models, I'd love to hear where it still falls over.

Repo + binaries (macOS arm64 / Windows x64 / Linux x64):
https://github.com/velsrocky/vtnexa
```

### 3.3 r/rust — the technical post

```
I wrote a Rust process supervisor for a Tauri app and it was subtly broken on
macOS in three independent ways. Here's what I found, in case it saves
somebody else the weekend.

1. sysctl KERN_PROCARGS2 strips the environment block for Apple platform
   binaries. /bin/sh and /bin/sleep will not show you their env, so a
   "put a secret token in the env and find your children" scheme silently
   fails for exactly the binaries you most want to track. The fix is to kill
   the process group - which you already set up with setpgid - because the
   group outlives its leader, so kill(-pgid) still reaches an orphan.

2. proc_listallpids truncates. On a busy machine I measured it returning 6
   pids out of ~780. Not an error, just a short list. proc_listchildpids is
   per-parent and doesn't have the problem, so make that authoritative and
   don't trust the global enumeration.

3. proc_pidinfo cannot read a zombie on macOS. So a command that exits
   immediately can be unreadable the instant you look at it. And
   proc_listchildpids on a zombie parent returns the GLOBAL process count,
   which is a fun way to put 700 unrelated pids into your process tree.

Also: kill(-pgid) on a group whose only member is a zombie returns EPERM,
not ESRCH, so treat EPERM as "nothing to signal" rather than a failure.

Full write-up and the code: https://github.com/velsrocky/vtnexa
```

### 3.4 The "what we got wrong" write-up (lobste.rs / dev.to)

The highest-signal post you can write, and it doubles as marketing. Outline:

1. The promise: workspace file tools with screened command approval.
2. How the gate actually works (native dialog, single-use token bound to the
   exact command, 5-minute TTL).
3. **The honest limits** — the agent runs with your permissions once you
   approve; XSS in the renderer is not contained; in auto mode a
   prompt-injected page can drive in-workspace writes.
4. The three macOS process bugs above.
5. What I would do next.

Sections 3 and 4 are the ones people will quote. Do not soften them.

---

## 4. The launch schedule (two weeks)

| Day | Do |
|---|---|
| 0 | Tag and publish v1.0.7. **Verify the download yourself on a clean machine** — the macOS build must open without a Gatekeeper warning. |
| 1 | Show HN. Stay in the thread for 4 hours. Answer every comment. |
| 2 | Fix whatever HN found. Post the fixes as a comment. |
| 3 | r/LocalLLaMA + r/rust (different copy for each). |
| 4 | lobste.rs + the "what we got wrong" write-up on your own blog. |
| 5 | Discord servers (MCP, Ollama). |
| 6 | Direct outreach (§5). |
| 7 | Ship a fix release for whatever came up. Comment everywhere you posted. |
| 8–14 | One post per day, rotating. Keep the issue tracker fast. |

**Cadence rule:** respond to every issue within 24 hours, even if the answer
is "noted". A slow issue tracker is the fastest way to lose the first ten.

---

## 5. Direct outreach (highest conversion, do this first)

Ten people is ten conversations, not ten posts. Pick ten individuals who
publicly care about this problem and write to them **personally**:

- Maintainers of small, popular local-model tooling (Ollama wrappers, LM
  Studio plugins, aider/Continue-style projects) — they have users who ask
  "does it work with my local model?" every day.
- Authors of posts about agentic coding tool safety — they have opinions and
  an audience.
- People who complained publicly that coding agents "edit my whole repo
  without asking" — they have exactly this problem.
- Two or three people you know personally who use macOS and would try it.

**The message (personalise the first line):**

```
Hi <name> - I saw <specific thing they wrote/did>. I built a desktop agent
with workspace file tools and screened command approvals, and I'd
value your take on whether the gate is in the right place.

It's macOS/Windows/Linux, runs against Ollama if you want it fully offline:
https://github.com/velsrocky/vtnexa

If it's not for you, a one-line "no" is genuinely useful to me.
```

**Do not** ask for stars. Ask for a problem report. Stars from ten people are
worth less than one specific bug report.

---

## 6. What to ask the first ten

Put this in the issue template you link to, and ask it in the DM. Three
questions, not a survey:

1. **What did you ask it to do first, and did it do it?** (This is the only
   metric that matters at this stage.)
2. **Where did it stop and ask you for permission, and was that the right
   moment?** (This finds the trust-model bugs.)
3. **What did you have to teach it that it should have known?** (This finds
   the prompt bugs.)

Ask for an **audit export** when they report a problem. It contains up to the
latest 100 events in a session, with capped arguments and a checksum for
detecting edits. It helps investigation but does not prove authenticity or
completeness.

---

## 7. What to measure

Track these by hand, in a spreadsheet. Ten users is too small for analytics
and the app sends no telemetry by design.

| Metric | Target | Why |
|---|---|---|
| Downloads (GitHub release assets) | ≥ 30 | Reach, not success |
| People who started a real session | ≥ 10 | The actual goal |
| People who came back a second day | ≥ 5 | The only real product signal |
| Issues filed by a non-maintainer | ≥ 5 | Means it reached people who cared |
| "It did the thing I asked" | ≥ 5 of 10 | The product works |
| Permission-gate complaints | track all | Trust model is the differentiator |

---

## 8. Rules for ourselves

- **Never claim a feature that is not in the codebase.** The README used to
  advertise a "Health monitoring" panel that did not exist. That is exactly
  the kind of thing that costs you the first ten users the moment they
  look. If you add it, ship it first.
- **Ship the honest limits.** The security section of the README is a
  strength; keep it.
- **One window, one instance, one workspace** is the product. Do not spend
  the launch on features.
- **Do not add telemetry to make this easier to measure.** Ten users do not
  justify losing the property that makes the product worth having. Ask
  instead.
- If a user reports that the agent did something outside the workspace
  without asking, that is a P0 — fix it before anything else and reply
  publicly.
