// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isHtmlPreview,
  isMarkdownPreview,
  languageFromPath,
  markdownToHtmlSrcDoc,
  textToHtmlSrcDoc,
} from "./preview";

describe("languageFromPath", () => {
  const cases: [string, string][] = [
    ["a.ts", "typescript"],
    ["a.tsx", "typescript"],
    ["a.JS", "javascript"],
    ["a.jsx", "javascript"],
    ["package.json", "json"],
    ["main.rs", "rust"],
    ["x.py", "python"],
    ["page.html", "html"],
    ["feed.xml", "html"],
    ["s.css", "css"],
    ["s.scss", "css"],
    ["R.md", "markdown"],
    ["R.markdown", "markdown"],
    ["c.yaml", "yaml"],
    ["c.yml", "yaml"],
    ["c.toml", "ini"],
    ["c.ini", "ini"],
    ["run.sh", "shell"],
    ["Dockerfile", "plaintext"],
    ["weird.qqq", "plaintext"],
    ["no_dot_extension", "plaintext"],
  ];
  it.each(cases)("%s -> %s", (path, lang) => {
    expect(languageFromPath(path)).toBe(lang);
  });
});

describe("preview detectors", () => {
  it("html and svg preview; markdown previews separately", () => {
    expect(isHtmlPreview("x.html")).toBe(true);
    expect(isHtmlPreview("x.htm")).toBe(true);
    expect(isHtmlPreview("icon.svg")).toBe(true);
    expect(isHtmlPreview("X.HTML")).toBe(true);
    expect(isHtmlPreview("x.md")).toBe(false);
    expect(isMarkdownPreview("notes.md")).toBe(true);
    expect(isMarkdownPreview("NOTES.Markdown")).toBe(true);
    expect(isMarkdownPreview("a.html")).toBe(false);
  });
});

describe("textToHtmlSrcDoc", () => {
  it("escapes markup in the body and the footer path", () => {
    const doc = textToHtmlSrcDoc("a<b>.txt", "<script>alert(1)</script> & <b>");
    expect(doc).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;");
    expect(doc).not.toContain("<script>alert(1)");
    expect(doc).toContain("a&lt;b>.txt");
    expect(doc).toContain("default-src 'none'");
  });
});

describe("markdownToHtmlSrcDoc", () => {
  it("renders markdown with a locked-down CSP wrapper", async () => {
    const doc = await markdownToHtmlSrcDoc("# Title\n\nsome **bold**");
    expect(doc).toContain("<h1>Title</h1>");
    expect(doc).toContain("<strong>bold</strong>");
    expect(doc).toContain("default-src 'none'");
  });

  it("strips scripts, styles and event handlers from hostile input", async () => {
    const doc = await markdownToHtmlSrcDoc(
      '<img src=x onerror="alert(1)">\n<script>steal()</script>\n<style>body{display:none}</style>\n[click](javascript:alert(1))',
    );
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("onerror");
    // The wrapper's own <style> is fine - the injected one must be gone.
    expect(doc).not.toContain("display:none");
    expect(doc).not.toMatch(/<a\b[^>]*href="javascript:/);
  });
});
