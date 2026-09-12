import { marked } from "marked";
import DOMPurify from "dompurify";

export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "html":
    case "xml":
      return "html";
    case "css":
    case "scss":
      return "css";
    case "md":
    case "markdown":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
    case "ini":
      return "ini";
    case "sh":
      return "shell";
    default:
      return "plaintext";
  }
}

export function isHtmlPreview(path: string): boolean {
  return /\.(html?|svg)$/i.test(path);
}

export function isMarkdownPreview(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export async function markdownToHtmlSrcDoc(md: string): Promise<string> {
  const raw = await marked.parse(md);
  // Markdown may come from agent output or the web — strip scripts/event handlers.
  const body = DOMPurify.sanitize(String(raw ?? ""), {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style"],
  });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;">
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;line-height:1.6;color:#222}pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto}code{font-family:monospace}</style>
</head><body>${body}</body></html>`;
}

export function textToHtmlSrcDoc(path: string, text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safePath = path.replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head><body><pre style="font-family:monospace;white-space:pre-wrap">${esc}</pre><div style="font:12px system-ui;color:#888">${safePath}</div></body></html>`;
}
