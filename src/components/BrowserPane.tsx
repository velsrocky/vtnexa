import { useCallback, useEffect, useState } from "react";
import {
  browserBack,
  browserClick,
  browserNavigate,
  browserScreenshot,
  browserScroll,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserType,
  type BrowserSnapshot,
} from "../lib/browser";

export default function BrowserPane() {
  const [running, setRunning] = useState(false);
  const [headless, setHeadless] = useState(false);
  const [urlInput, setUrlInput] = useState("https://example.com");
  const [snap, setSnap] = useState<BrowserSnapshot | null>(null);
  const [shot, setShot] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("Browser Use — real Chromium, persistent profile (signed in as you).");
  const [typeTexts, setTypeTexts] = useState<Record<number, string>>({});

  const refresh = useCallback(async () => {
    try {
      const s = await browserSnapshot();
      setSnap(s);
      setUrlInput(s.url || "");
    } catch (e) {
      setNote(`snapshot failed: ${e}`);
    }
    try {
      const sh = await browserScreenshot();
      if (sh.imageBase64) setShot(`data:${sh.mimeType || "image/jpeg"};base64,${sh.imageBase64}`);
    } catch {
      /* screenshot optional */
    }
  }, []);

  const check = useCallback(async () => {
    try {
      const st = await browserStatus();
      setRunning(!!st.running);
      if (st.running) refresh();
      return !!st.running;
    } catch {
      setRunning(false);
      return false;
    }
  }, [refresh]);

  useEffect(() => {
    check();
  }, [check]);

  async function start() {
    setBusy(true);
    try {
      // browser_start resolves (does not reject) with {ok:false,...} when the
      // sidecar fails to become ready - treat that as a failure, not "running".
      const r = (await browserStart(39317, headless)) as { ok?: boolean; error?: string } | null;
      if (!r || r.ok === false) throw new Error(r?.error || "sidecar did not become ready");
      setRunning(true);
      setNote("browser running (profile ~/.config/vtai-browser-profile)");
      await refresh();
    } catch (e) {
      setRunning(false);
      setNote(`start failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    await browserStop();
    setRunning(false);
    setNote("browser stopped");
  }

  async function go() {
    setBusy(true);
    try {
      await browserNavigate(urlInput);
      await refresh();
    } catch (e) {
      setNote(`navigate failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function clickRef(ref: number) {
    setBusy(true);
    try {
      await browserClick(ref);
      await refresh();
    } catch (e) {
      setNote(`click failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function typeRef(ref: number) {
    const text = typeTexts[ref] ?? "";
    if (!text) return;
    setBusy(true);
    try {
      await browserType(ref, text, false);
      await refresh();
    } catch (e) {
      setNote(`type failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="browser-col">
      <div className="row">
        <span className={running ? "pill on" : "pill"}>{running ? "● running" : "○ stopped"}</span>
        <label className="muted small">
          <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} /> headless
        </label>
        {!running ? (
          <button onClick={start} disabled={busy}>Start browser</button>
        ) : (
          <button onClick={stop}>Stop</button>
        )}
        <button onClick={() => check().then(() => refresh())} disabled={!running || busy}>↻ Refresh</button>
      </div>
      <div className="row">
        <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="https://…" className="grow" disabled={!running} />
        <button onClick={go} disabled={!running || busy}>Go</button>
        <button onClick={async () => { await browserBack(); await refresh(); }} disabled={!running} title="Back">←</button>
        <button onClick={async () => { await browserScroll(0, 600); await refresh(); }} disabled={!running} title="Scroll down">▼</button>
        <button onClick={async () => { await browserScroll(0, -600); await refresh(); }} disabled={!running} title="Scroll up">▲</button>
      </div>
      <div className="muted small">{note}</div>
      <div className="browser-body">
        <div className="browser-shot">
          {shot ? <img src={shot} alt="page screenshot" /> : <div className="muted">no screenshot yet</div>}
        </div>
        <div className="browser-els">
          <div className="pane-title">{snap ? `${snap.title || "(no title)"} — ${snap.elements?.length ?? 0} elements` : "snapshot"}</div>
          <div className="el-list">
            {(snap?.elements ?? []).map((el) => (
              <div key={el.ref} className="el-row">
                <span className="el-ref">[{el.ref}]</span>
                <span className="el-tag">{el.tag}</span>
                <span className="el-name">{el.name}</span>
                <button onClick={() => clickRef(el.ref)} disabled={busy}>Click</button>
                {(el.tag === "input" || el.tag === "textarea") && (
                  <>
                    <input
                      value={typeTexts[el.ref] ?? ""}
                      onChange={(e) => setTypeTexts({ ...typeTexts, [el.ref]: e.target.value })}
                      placeholder="type…"
                      className="el-type"
                    />
                    <button onClick={() => typeRef(el.ref)} disabled={busy}>Type</button>
                  </>
                )}
              </div>
            ))}
          </div>
          {snap?.text && <pre className="page-text">{snap.text.slice(0, 1500)}</pre>}
        </div>
      </div>
    </div>
  );
}
