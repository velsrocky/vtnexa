import { memo } from "react";
import Combo from "./Combo";
import { asKind } from "../lib/providerHistory";
import { useProviderBar } from "../context/AppContext";

function ProviderBarInner() {
  const {
    windowLabel,
    editCfg,
    provHist,
    provModels,
    modelsNote,
    keychainOk,
    setEditCfg,
    refreshModels,
  } = useProviderBar();
  return (
    <div className="configbar">
      <span className="muted small" title="Every window has its own provider - this edits this window's">
        {`⚙ ${windowLabel}`}
      </span>
      <select
        value={editCfg.kind ?? "auto"}
        onChange={(e) => {
          const kind = asKind(e.target.value);
          // Switching backend presets the matching baseUrl when the current
          // one is empty or a different provider's default.
          const presets: Record<string, string> = {
            anthropic: "https://api.anthropic.com",
            gemini: "https://generativelanguage.googleapis.com/v1beta",
            openai: "http://localhost:11434/v1",
          };
          const cur = editCfg.baseUrl.trim().toLowerCase();
          const isPreset = Object.values(presets).some((p) => cur === p.toLowerCase() || cur === "");
          setEditCfg({
            kind,
            ...(kind !== "auto" && isPreset ? { baseUrl: presets[kind] } : {}),
          });
        }}
        title="Provider API: auto-detect from baseUrl, or force OpenAI-compatible / Anthropic / Gemini"
      >
        <option value="auto">auto</option>
        <option value="openai">openai</option>
        <option value="anthropic">anthropic</option>
        <option value="gemini">gemini</option>
      </select>
      <Combo
        value={editCfg.baseUrl}
        onPick={(v) => setEditCfg({ baseUrl: v })}
        options={[...new Set(provHist.map((h) => h.baseUrl).filter(Boolean))].map((v) => ({ value: v, label: v }))}
        placeholder="baseUrl"
      />
      <Combo
        value={editCfg.model}
        onPick={(v) => setEditCfg({ model: v })}
        options={[...new Set([...provModels, ...provHist.map((h) => h.model)].filter(Boolean))].map((v) => ({ value: v, label: v }))}
        placeholder="model"
      />
      <button onClick={refreshModels} title="List models this endpoint actually serves">⟳</button>
      {modelsNote && <span className="muted small">{modelsNote}</span>}
      <input
        value={editCfg.apiKey}
        onChange={(e) => setEditCfg({ apiKey: e.target.value })}
        placeholder="apiKey (optional)"
        type="password"
        title={
          keychainOk
            ? "Stored in your OS keychain, auto-filled per endpoint+model"
            : keychainOk === false
              ? "No OS keychain detected - key is kept locally for this setup"
              : "apiKey (optional)"
        }
      />
      {keychainOk === false && (
        <span className="muted small" title="Install a Secret Service provider (e.g. gnome-keyring) for OS-keychain storage">
          keys stored locally
        </span>
      )}
    </div>
  );
}

export default memo(ProviderBarInner);
