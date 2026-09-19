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
