import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "./chatMarkdown";

describe("renderChatMarkdown", () => {
  it("renders emphasis, lists and inline code", () => {
    const html = renderChatMarkdown("Uses **pnpm** and `pnpm test`\n\n- one\n- two");
    expect(html).toContain("<strong>pnpm</strong>");
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("keeps fenced code blocks as text", () => {
    const html = renderChatMarkdown("```\nrm -rf /\n```");
    expect(html).toContain("rm -rf /");
    expect(html).toContain("<pre>");
  });

  it("strips scripts, styles and links (URL stays as text)", () => {
    const html = renderChatMarkdown("hi<script>alert(1)</script>[click](https://x.test) <style>x</style>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<a ");
    expect(html).toContain("https://x.test");
  });

  it("never executes event handlers", () => {
    const html = renderChatMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });
});

describe("closeOpenFence", () => {
  it("marked already tolerates unterminated fences - no auto-close needed", () => {
    // Measured behavior (see renderChatMarkdown docs): appending a closing
    // fence injects its own backticks into the block or adds an empty <pre>,
    // so the renderer deliberately does not do it.
    const partial = renderChatMarkdown("Here:\n```bash\npnpm test");
    expect(partial).toContain("<pre>");
    expect(partial).toContain("pnpm test");
    expect(partial).not.toContain("```");
    const tilde = renderChatMarkdown("Result:\n~~~js\nlet a = 1");
    expect(tilde).toContain("<pre>");
    expect(tilde).toContain("let a = 1");
    expect(tilde).not.toContain("~~~");
  });

  it("half-written tables and emphasis render without raw delimiters", () => {
    const mid = renderChatMarkdown("| a | b |\n|---|---|\n| 1 |");
    expect(mid).toContain("<table>");
    expect(mid).not.toContain("|");
    const bold = renderChatMarkdown("partial **bold");
    expect(bold).toContain("partial");
  });
});
