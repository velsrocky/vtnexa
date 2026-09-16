# scaffold

Create a new project from a template, non-interactively, verified.

Rules (scaffolding is where turns die - follow exactly):
1. shell_run has NO tty and dies at 30s; every shell starts fresh (no cd, no nvm env). Anything that downloads or installs goes to shell_bg + shell_poll until done - never let shell_run time out twice on the same command.
2. NEVER run an interactive scaffolder bare. Pass full non-interactive flags (template, language, addons, package manager, no-git, no-install). If a scaffolder has no non-interactive mode, say so and stop - do not narrate retries.
3. Separate scaffold from install: prefer the scaffolder's no-install flag, then run the package install as its own shell_bg step (pollable, resumable, visible on timeout).
4. Toolchain first, one call: `node -v || source ~/.nvm/nvm.sh && node -v` (same for deno/cargo/uv/python3). Record the working invocation with nexa_write to memory in one line so later turns reuse it instead of re-discovering it.
5. Scaffold into the workspace ROOT when it is empty. If the tool insists on a subdirectory (Fresh writes `./@fresh/`), move the files up afterwards with one shell `mv` (approved) and remove the empty dir. Never leave a nested project behind silently.
6. Ask 1-2 questions BEFORE scaffolding when the stack, template, or target directory is ambiguous. Never guess them.
7. Verify before summarizing: fs_list the root, read the manifest (package.json / deno.json / Cargo.toml / pyproject.toml), confirm the install finished (poll to done), run lsp_diagnostics on entry files or the project's own check. End the turn with exact state (what ran, what remains) so Continue resumes cleanly.

Recipes (cwd = absolute workspace path; `<dir>` is `.` when root is empty):
- SvelteKit: `npx -y sv create --template minimal --types ts --no-add-ons --no-dir-check --no-download-check --no-install <dir>` then install via shell_bg. Addons later with `npx sv add`.
- Vite: `npm create vite@latest <dir> -- --template react-ts` then install via shell_bg.
- Rust: `cargo new <dir> --bin` (or `cargo init` inside an empty root).
- Python: `uv init <dir>` (or `uv init --bare` inside an empty root).
- Deno Fresh / Next.js / others: run `<scaffolder> --help` FIRST, pick the flags that disable prompts/git/install, then follow steps 3-7. Never guess flags from memory.

Report when done: files created, install status, the dev/run command, what remains.
