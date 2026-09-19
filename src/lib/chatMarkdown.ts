import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Render an assistant chat message to sanitized HTML for the Commander
 * transcript. Same sanitizer posture as preview.ts, plus <a> removed: a
 * clicked link would navigate the whole app webview, so URLs stay visible as
 * plain text instead of becoming clickable.
 *
 * Safe to call on partial text while an answer streams: measured against
 * marked, an unterminated fence (```/~~~), a half-written table and unclosed
 * emphasis all render acceptably and never surface raw delimiters - so no
 * fence auto-closing is applied (it would inject the closing fence's own
 * backticks into the block, or append an empty <pre></pre>).
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
