import { useState } from "react";

// Input + ▾ dropdown of saved values. Free typing always allowed;
// picking fills the field. Labels may be masked (api keys).
export default function Combo({ value, onPick, options, placeholder, secret }: {
  value: string;
  onPick: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  secret?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <input
        value={value}
        onChange={(e) => onPick(e.target.value)}
        placeholder={placeholder}
        type={secret ? "password" : "text"}
      />
      <button
        onClick={() => setOpen((o) => !o)}
        title={options.length ? "Saved working configs" : "No saved configs yet - configs that answer successfully save here"}
      >
        ▾
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: "absolute", top: "100%", left: 0, right: 0, zIndex: 60,
              background: "var(--panel)", border: "1px solid var(--border3)", borderRadius: 6,
              maxHeight: 220, overflow: "auto", minWidth: 180,
            }}
          >
            {options.length === 0 && (
              <div className="muted small" style={{ padding: "6px 8px" }}>no saved yet</div>
            )}
            {options.map((o, i) => (
              <div
                key={`${o.value}-${i}`}
                onClick={() => {
                  onPick(o.value);
                  setOpen(false);
                }}
                style={{ padding: "6px 8px", cursor: "pointer", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {o.label}
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
