// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownBody, StreamingBody } from "./ChatPane";

// Render-level pins for the transcript pieces that were originally written
// without visual verification: markdown body, streaming body, thinking tail.
describe("transcript rendering", () => {
  it("renders finalized markdown as HTML, not raw delimiters", () => {
    const { container } = render(<MarkdownBody content={"**bold** and `code`\n\n- item"} />);
    const md = container.querySelector(".md");
    expect(md?.querySelector("strong")?.textContent).toBe("bold");
    expect(md?.querySelector("code")?.textContent).toBe("code");
    expect(md?.querySelector("li")?.textContent).toBe("item");
    expect(md?.textContent).not.toContain("**");
  });

  it("keeps links inert (URL as text, no anchor)", () => {
    const { container } = render(<MarkdownBody content={"[docs](https://x.test)"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("https://x.test");
  });

  it("streaming body renders a muted thinking tail plus the markdown answer", () => {
    const { container } = render(<StreamingBody content={"Answer **now**"} thinking={"weighing options"} />);
    const tail = container.querySelector(".thinking-tail");
    expect(tail?.textContent).toContain("⏺ thinking");
    expect(tail?.textContent).toContain("weighing options");
    expect(container.querySelector(".md strong")?.textContent).toBe("now");
  });

  it("streaming body omits the thinking block when there is none", () => {
    const { container } = render(<StreamingBody content="plain answer" />);
    expect(container.querySelector(".thinking-tail")).toBeNull();
    expect(container.querySelector(".md")?.textContent).toContain("plain answer");
  });
});