// Theme + palette definitions. CSS variables (see App.css) carry every
// surface color; `monaco` picks the editor theme; `xterm` is applied live to
// terminals. Add a palette here + a `[data-theme]` block in App.css.

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
}

export interface ThemeDef {
  id: string;
  label: string;
  monaco: string;
  xterm: XtermTheme;
}

export const THEME_IDS = ["graphite", "paper", "ocean", "forest", "ember"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEMES: Record<ThemeId, ThemeDef> = {
  graphite: {
    id: "graphite",
    label: "Graphite (dark)",
    monaco: "vs-dark",
    xterm: { background: "#0a0a0d", foreground: "#e6e6e6", cursor: "#3b6cff" },
  },
  paper: {
    id: "paper",
    label: "Paper (light)",
    monaco: "vs",
    xterm: { background: "#f4f4f6", foreground: "#1b1b1f", cursor: "#2f5fe0" },
  },
  ocean: {
    id: "ocean",
    label: "Ocean (dark blue)",
    monaco: "vs-dark",
    xterm: { background: "#080e1a", foreground: "#d9e6ff", cursor: "#4f8cff" },
  },
  forest: {
    id: "forest",
    label: "Forest (dark green)",
    monaco: "vs-dark",
    xterm: { background: "#080f0b", foreground: "#d8ecdf", cursor: "#35c98a" },
  },
  ember: {
    id: "ember",
    label: "Ember (warm dark)",
    monaco: "vs-dark",
    xterm: { background: "#100c0a", foreground: "#f0e2d6", cursor: "#e86a2c" },
  },
};

export function asThemeId(v: unknown): ThemeId {
  return (THEME_IDS as readonly string[]).includes(v as string) ? (v as ThemeId) : "graphite";
}
