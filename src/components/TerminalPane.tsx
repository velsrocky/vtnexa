import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/pty";
import { THEMES, asThemeId } from "../lib/theme";

interface Props {
  laneId: string;
  cwd: string;
  active: boolean;
  themeId: string;
  height: number;
}

export default function TerminalPane({ laneId, cwd, active, themeId, height }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || termRef.current) return;

    const term = new Terminal({
      theme: { ...THEMES[asThemeId(themeId)].xterm },
      fontSize: 13,
      fontFamily: "monospace",
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    const spawn = async () => {
      try {
        fit.fit();
      } catch {
        /* container may be hidden */
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        try {
          await ptySpawn(laneId, cwd || ".", cols, rows);
        } catch (e) {
          term.writeln(`\r\npty spawn failed: ${e}`);
        }
      }
    };
    spawn();

    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    const atBottom = () => {
      const el = hostRef.current?.querySelector(".xterm-viewport") as HTMLElement | null;
      if (!el) return true;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    };
    (async () => {
      unlistenOut = await listen<string>(`pty-output-${laneId}`, (e) => {
        const follow = atBottom();
        term.write(e.payload, () => {
          if (follow) term.scrollToBottom();
        });
      });
      unlistenExit = await listen(`pty-exit-${laneId}`, () => {
        term.writeln("\r\n[pty exited — press Restart]", () => term.scrollToBottom());
      });
    })();

    const onData = term.onData((data) => {
      ptyWrite(laneId, data).catch(() => {});
    });

    const onResize = () => {
      if (!active) return;
      try {
        fit.fit();
        ptyResize(laneId, term.cols, term.rows).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      onData.dispose();
      if (unlistenOut) unlistenOut();
      if (unlistenExit) unlistenExit();
      // NOTE: keep PTY alive on unmount for lane persistence;
      // killed explicitly via Restart or lane close.
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId]);

  // Live-apply palette changes.
  useEffect(() => {
    try {
      const term = termRef.current;
      if (term) term.options.theme = { ...THEMES[asThemeId(themeId)].xterm };
    } catch {
      /* ignore */
    }
  }, [themeId]);

  // fit when activated (hidden panes have 0 size) and when the box height
  // changes via the row resizer (debounced by the timeout).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          ptyResize(laneId, term.cols, term.rows).catch(() => {});
          term.scrollToBottom();
        }
      } catch {
        /* ignore */
      }
    }, 50);
    return () => clearTimeout(t);
  }, [active, laneId, height]);

  async function restart() {
    const term = termRef.current;
    try {
      await ptyKill(laneId);
    } catch {
      /* ignore */
    }
    spawnedRef.current = false;
    term?.clear();
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
    const cols = term?.cols || 80;
    const rows = term?.rows || 24;
    try {
      await ptySpawn(laneId, cwd || ".", cols, rows);
      spawnedRef.current = true;
    } catch (e) {
      term?.writeln(`restart failed: ${e}`);
    }
  }

  return (
    <div className={active ? "pty-box" : "pty-box hidden"}>
      <div className="row pty-bar">
        <span className="muted small">pty · {laneId.slice(0, 6)} · {cwd}</span>
        <button onClick={restart} title="Kill and respawn this lane's shell">Restart</button>
      </div>
      <div ref={hostRef} className="xterm-host" style={{ height }} />
    </div>
  );
}
