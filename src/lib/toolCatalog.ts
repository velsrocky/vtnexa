import type { ToolDef } from "./toolDefs";

/** Built-in tool catalog (moved verbatim from providers.ts). */
export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "fs_list",
      description:
        "List directory entries. Absolute path inside the workspace, read-only. Use this (not fs_read) for directories and to discover file names. Good: {path: \"/ws/src\"}. Bad: {path: \"src\"} (relative - rejected).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_read",
      description:
        "Read a text file BEFORE editing it. Absolute path inside the workspace, read-only, 2MB max. Files only - for directories use fs_list. Good: {path: \"/ws/src/App.tsx\"}. Bad: {path: \"App.tsx\"} (relative - rejected); {path: \"/ws/src\"} (a directory - use fs_list).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_search",
      description:
        "Search file contents across the workspace (grep-like). Returns {path, line, text} matches. Default: case-insensitive literal substring. Set regex=true for regex. Optional path (subdir, absolute) and glob (filename filter). Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          case_sensitive: { type: "boolean" },
          regex: { type: "boolean" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_glob",
      description:
        "Find files by name pattern (* = any sequence, ? = one char; comma-separated for multiple). Returns relative paths. Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lsp_diagnostics",
      description:
        "Typecheck/lint one file and return diagnostics filtered to it (tsc for ts/js, cargo check for rs, py_compile for py). Absolute path inside the workspace. Read-only, auto-approved. Use after edits to verify. Project-level checkers can take up to ~2min on first run.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lsp",
      description:
        "Code intelligence via language servers (typescript-language-server, rust-analyzer). Ops: hover, definition, references (need 1-based line, optional character), documentSymbol (symbols in one file), workspaceSymbol (needs symbol query). Absolute path inside the workspace. Read-only, auto-approved. Needs no project setup beyond the server binary; first runs index the project and can take ~1min.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string" },
          path: { type: "string" },
          line: { type: "number" },
          character: { type: "number" },
          symbol: { type: "string" },
        },
        required: ["op", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_list",
      description:
        "List project skills (.vtnexa/skills/*.md) as {name, description}. Read-only, auto-approved.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_read",
      description:
        "Read a project skill's full instructions by name. Use when the task matches a skill. Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sessions_list",
      description:
        "List this workspace's past chat sessions (id, title, directory, updated, message count, preview). Read-only, auto-approved. Use when asked to proceed/continue with no history in THIS chat - find the thread first, never invent prior work.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "session_read",
      description:
        "Read one past session's messages by id (from sessions_list): title, directory and recent user/assistant messages, truncated. Read-only, auto-approved. Keys and drafts are never included.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_create",
      description:
        "Create an empty file (parents included) or, with is_dir=true, a directory. Errors if it exists. Read-only-ish, auto-approved.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, is_dir: { type: "boolean" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_rename",
      description: "Rename/move a file or directory (absolute paths, target must not exist). REQUIRES user approval.",
      parameters: {
        type: "object",
        properties: { old_path: { type: "string" }, new_path: { type: "string" } },
        required: ["old_path", "new_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_delete",
      description:
        "Delete a file, or a directory (needs recursive=true for non-empty dirs). Permanent. REQUIRES user approval.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Show git branch + changed files for the repo containing cwd (absolute dir). Read-only, auto-approved. Errors when cwd is not in a git repo.",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" } },
        required: ["cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Show uncommitted diff (set staged=true for staged). Optional path (absolute file) to limit output. Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          path: { type: "string" },
          staged: { type: "boolean" },
        },
        required: ["cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commits (hash, author, date, message). Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" }, limit: { type: "number" } },
        required: ["cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description:
        "Stage ONLY the listed files (absolute paths) and commit with message. Prefer small commits with clear messages. REQUIRES user approval.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          message: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["cwd", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write",
      description:
        "PROPOSE a file write (staged to Diff review gate, needs user Approve - does NOT write directly). First fs_read the file, then send the COMPLETE new content. Absolute path. Never re-send identical content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_run",
      description:
        "Run a shell command via sh -c and wait (30s timeout, REQUIRES user approval - explain what and why first; cwd must be an absolute dir inside the workspace). For anything that may take longer (installs, builds, test suites, servers): use shell_bg instead, then shell_poll until done. Prefer read-only commands; never chain destructive ones.",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" }, cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_bg",
      description:
        "Start a shell command in the background via sh -c (REQUIRES user approval - explain what and why first; cwd must be an absolute dir inside the workspace). Returns a job_id immediately. Poll it with shell_poll until status is done; kill with shell_kill. Use for installs, builds, test suites - anything past ~25s. Same destructive-pattern screening as shell_run.",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" }, cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_poll",
      description:
        "Check a background job from shell_bg (read-only, auto-approved). Returns status running|done with output tails; when done, full output (truncated). A done job is collected once - polling again errors, so save what you need. Keep polling running jobs instead of starting duplicates.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_kill",
      description: "Stop a background job from shell_bg (REQUIRES user approval). Use when a job is stuck, wrong, or superseded - not to silence output you haven't read.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate the Browser Use tab to a URL (REQUIRES user approval)",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Read current page: url, title, text and clickable elements with refs",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click a page element by its snapshot ref (REQUIRES user approval)",
      parameters: { type: "object", properties: { target_ref: { type: "number" } }, required: ["target_ref"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Fill a text input by its snapshot ref (REQUIRES user approval)",
      parameters: {
        type: "object",
        properties: { target_ref: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } },
        required: ["target_ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Capture the page as a screenshot that YOU CAN SEE (vision - the image is attached to the conversation). Use it to verify layout, styling, and errors. Also viewable in the Browser tab.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_back",
      description: "Go back one page in browser history (REQUIRES user approval)",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the page by dx/dy pixels (read-only-ish, no approval needed)",
      parameters: {
        type: "object",
        properties: { dx: { type: "number" }, dy: { type: "number" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nexa_read",
      description: "Read the shared Nexa notes (pad = scratch, plan = agreed work, memory = durable cross-session context). Auto-approved, always fresh - prefer over guessing.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["pad", "plan", "memory"] },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nexa_write",
      description: "Update a shared Nexa note (writes .nexa/{pad,plan,memory}.md directly, visible in sidebar - keep short, 16KB max. Use memory for durable decisions and cross-session context; pad for scratch; plan for agreed work.)",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["pad", "plan", "memory"] },
          content: { type: "string" },
        },
        required: ["kind", "content"],
      },
    },
  },
];
