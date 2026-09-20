# rate

Provide a concise, 1–10 score and summary for the workspace or a specific component.

1.  Inspect the target using read-only tools: fs_list the workspace root, fs_glob for file patterns, fs_read plus fs_search for code, git_status plus git_log for activity.
2.  Evaluate:
    - **Architecture:** folder structure, separation of concerns.
    - **Code quality:** style, naming, duplication.
    - **Tests:** presence and breadth (unit + e2e).
    - **Documentation:** README, docs, inline docs.
    - **UX/Performance:** build size, load time (if measurable).
3.  Reply with ONLY:
    - `Score: X/10`
    - `Strengths:` 2–3 bullet points
    - `Weaknesses:` 2–3 bullet points
    - `Suggestion:` one concrete next step

This format applies to this response only — no extra sections, no commentary about the skill itself.
