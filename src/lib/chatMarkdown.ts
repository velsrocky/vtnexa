import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Render a finalized assistant chat message to sanitized HTML for the
 * Commander transcript. Same sanitizer posture as preview.ts, plus <a>
 * removed: a clicked link would navigate the whole app webview, so URLs
 * stay visible as plain text instead of becoming clickable.
 */
export function renderChatMarkdown(md: string): string {
  // Unwrap markdown links to "text (url)" first: <a> is dropped by the
  // sanitizer below (a clicked link would navigate the app webview), and
  // FORBID_TAGS alone would discard the href with it — this keeps the URL
  // visible as plain text instead.
  const text = md.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, "$1 ($2)");
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(String(raw ?? ""), {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "a"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style"],
  });
}
