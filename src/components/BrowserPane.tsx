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
  getBrowserPort,
  setBrowserPort,
  type BrowserSnapshot,
  type BrowserStatus,
} from "../lib/browser";
import { claimFor } from "../lib/approval";

function portFromBaseUrl(baseUrl: string | null | undefined): number | null {
  if (!baseUrl) return null;
  try {
    const port = Number.parseInt(new URL(baseUrl).port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export default function BrowserPane() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [headless, setHeadless] = useState(false);
  const [urlInput, setUrlInput] = useState("https://example.com");
  const [snap, setSnap] = useState<BrowserSnapshot | null>(null);
  const [shot, setShot] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("Browser Use uses a persistent native browser profile.");
  const [typeTexts, setTypeTexts] = useState<Record<number, string>>({});

  const refresh = useCallback(async () => {
    try {
      const snapshot = await browserSnapshot();
      setSnap(snapshot);
      setUrlInput(snapshot.url || "");
    } catch (error) {
      setNote(`snapshot failed: ${error}`);
    }
    try {
      const screenshot = await browserScreenshot();
      if (screenshot.imageBase64) {
        setShot(`data:${screenshot.mimeType || "image/jpeg"};base64,${screenshot.imageBase64}`);
      }
    } catch {
      void 0;
    }
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await browserStatus();
      setStatus(next);
      setRunning(next.running === true);
      const port = next.port ?? portFromBaseUrl(next.baseUrl);
      if (port !== null) setBrowserPort(port);
      if (next.running) await refresh();
      return next.ready === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({
        ready: false,
        running: false,
        missing: [`Browser preflight failed: ${message}`],
        remediation: ["Restore the Tauri bridge, then choose Recheck."],
      });
      setRunning(false);
      return false;
    } finally {
      setChecking(false);
    }
  }, [refresh]);

  useEffect(() => {
    void check();
  }, [check]);

  async function start() {
    if (status?.ready !== true) {
      await check();
      return;
    }
    setBusy(true);
    try {
      const result = await browserStart(headless);
      if (result.ok === false || result.running !== true) {
        throw new Error(result.error || result.missing?.[0] || "browser_start returned no status; choose Recheck");
      }
      setStatus(result);
      setRunning(true);
      setNote(`browser running (profile ${result.profilePath || status?.profilePath || "native platform directory"})`);
      await refresh();
    } catch (error) {
      setRunning(false);
      setNote(`start failed: ${error instanceof Error ? error.message : String(error)}`);
      await check();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    try {
      await browserStop();
      setRunning(false);
      setStatus((current) => (current ? { ...current, running: false } : current));
      setShot("");
      setSnap(null);
      setNote("browser stopped");
    } catch (error) {
      setNote(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function go() {
    setBusy(true);
    try {
      await browserNavigate(urlInput, await claimFor("browser_navigate", { url: urlInput }));
      await refresh();
    } catch (error) {
      setNote(`navigate failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function clickRef(ref: number) {
    setBusy(true);
    try {
      await browserClick(ref, await claimFor("browser_click", { target_ref: ref }));
      await refresh();
    } catch (error) {
      setNote(`click failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function typeRef(ref: number) {
    const text = typeTexts[ref] ?? "";
    if (!text) return;
    setBusy(true);
    try {
      await browserType(ref, text, false, await claimFor("browser_type", { target_ref: ref }));
      await refresh();
    } catch (error) {
      setNote(`type failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const ready = status?.ready === true;
  const missing = status?.missing ?? [];
  const remediation = status?.remediation ?? [];

  return (
    <div className="browser-col">
      <div className="row">
        <span className={running ? "pill on" : "pill"}>{running ? "● running" : ready ? "○ ready" : "○ not ready"}</span>
        <span className="muted small">sidecar port: {getBrowserPort() || "dynamic"}</span>
        <label className="muted small">
          <input type="checkbox" checked={headless} onChange={(event) => setHeadless(event.target.checked)} /> headless
        </label>
        {running ? (
          <button onClick={stop} disabled={busy}>Stop</button>
        ) : (
          <button onClick={start} disabled={!ready || busy || checking}>Start browser</button>
        )}
        <button onClick={() => void check()} disabled={busy || checking}>Recheck</button>
        {running && <button onClick={() => void refresh()} disabled={busy}>Refresh</button>}
      </div>
      {!ready && (
        <div className="browser-prereq" role="alert">
          <strong>Browser Use is not ready.</strong>
          {missing.length > 0 && <ul>{missing.map((item) => <li key={item}>{item}</li>)}</ul>}
          {remediation.length > 0 && <ul>{remediation.map((item) => <li key={item}>{item}</li>)}</ul>}
          <button onClick={() => void check()} disabled={checking}>Recheck prerequisites</button>
        </div>
      )}
      <div className="row">
        <input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void go()} placeholder="https://…" className="grow" disabled={!running} />
        <button onClick={() => void go()} disabled={!running || busy}>Go</button>
        <button onClick={async () => { await browserBack(await claimFor("browser_back", {})); await refresh(); }} disabled={!running || busy} title="Back">←</button>
        <button onClick={async () => { await browserScroll(0, 600); await refresh(); }} disabled={!running || busy} title="Scroll down">▼</button>
        <button onClick={async () => { await browserScroll(0, -600); await refresh(); }} disabled={!running || busy} title="Scroll up">▲</button>
      </div>
      <div className="muted small">{note}</div>
      {status?.blockedTarget && <div className="muted small">Blocked navigation target: {status.blockedTarget}</div>}
      <div className="browser-body">
        <div className="browser-shot">
          {shot ? <img src={shot} alt="page screenshot" /> : <div className="muted">no screenshot yet</div>}
        </div>
        <div className="browser-els">
          <div className="pane-title">{snap ? `${snap.title || "(no title)"} — ${snap.elements?.length ?? 0} elements` : "snapshot"}</div>
          <div className="el-list">
            {(snap?.elements ?? []).map((element) => (
              <div key={element.ref} className="el-row">
                <span className="el-ref">[{element.ref}]</span>
                <span className="el-tag">{element.tag}</span>
                <span className="el-name">{element.name}</span>
                <button onClick={() => void clickRef(element.ref)} disabled={busy}>Click</button>
                {(element.tag === "input" || element.tag === "textarea") && (
                  <>
                    <input
                      value={typeTexts[element.ref] ?? ""}
                      onChange={(event) => setTypeTexts({ ...typeTexts, [element.ref]: event.target.value })}
                      placeholder="type…"
                      className="el-type"
                    />
                    <button onClick={() => void typeRef(element.ref)} disabled={busy}>Type</button>
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
