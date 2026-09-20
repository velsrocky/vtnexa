import { useEffect, useState } from "react";
import { THEMES, asThemeId, type ThemeId } from "../lib/theme";
import { clampW } from "../lib/utils";

// Persisted UI prefs: theme + panel widths + the column/row resizers.
// Fully self-contained (localStorage only).
export function usePrefs() {
  // Theme + palette.
  const [themeId, setThemeId] = useState<ThemeId>(() => asThemeId(localStorage.getItem("vtai.theme")));
  const theme = THEMES[themeId];
  useEffect(() => {
    document.documentElement.dataset.theme = themeId;
    try {
      localStorage.setItem("vtai.theme", themeId);
    } catch {
      /* ignore */
    }
  }, [themeId]);

  // Panel widths (persisted). Editor takes the rest.
  const [leftW, setLeftW] = useState(() =>
    clampW(Number(localStorage.getItem("vtai.leftW")), 160, 480, 240),
  );
  const [rightW, setRightW] = useState(() =>
    clampW(Number(localStorage.getItem("vtai.rightW")), 240, 640, 360),
  );

  // Skill section height in the left column (persisted). The file list above
  // takes the rest.
  const [skillH, setSkillH] = useState(() =>
    clampW(Number(localStorage.getItem("vtai.skillH")), 60, 400, 150),
  );

  function onResizerDown(side: "left" | "right") {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === "left" ? leftW : rightW;
      const [lo, hi, key] =
        side === "left" ? [160, 480, "vtai.leftW"] : [240, 640, "vtai.rightW"];
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const w = Math.round(Math.min(hi, Math.max(lo, side === "left" ? startW + dx : startW - dx)));
        if (side === "left") setLeftW(w);
        else setRightW(w);
        try {
          localStorage.setItem(key, String(w));
        } catch {
          /* ignore */
        }
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
  }

  function onSkillResizerDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = skillH;
    const move = (ev: MouseEvent) => {
      // Divider sits above the skills section: dragging up grows it.
      const h = Math.round(Math.min(400, Math.max(60, startH - (ev.clientY - startY))));
      setSkillH(h);
      try {
        localStorage.setItem("vtai.skillH", String(h));
      } catch {
        /* ignore */
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return { themeId, setThemeId, theme, leftW, rightW, onResizerDown, skillH, onSkillResizerDown };
}
