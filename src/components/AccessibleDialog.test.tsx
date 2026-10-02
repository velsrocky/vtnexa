import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccessibleDialog from "./AccessibleDialog";

afterEach(cleanup);

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <AccessibleDialog title="Example dialog" onClose={() => setOpen(false)} showClose={false} initialFocus="first">
          <button>First</button>
          <button onClick={() => setOpen(false)}>Last</button>
        </AccessibleDialog>
      )}
    </div>
  );
}

describe("AccessibleDialog", () => {
  it("labels the dialog, traps both tab directions, and restores focus", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Example dialog");
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.click(screen.getByRole("button", { name: "Last" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and a backdrop but not from inside the panel", () => {
    const onClose = vi.fn();
    const { container } = render(
      <AccessibleDialog title="Closable" onClose={onClose} initialFocus="dialog">
        <button>Inside</button>
      </AccessibleDialog>,
    );
    const overlay = container.querySelector(".accessible-dialog-overlay") as HTMLElement;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps pending dialogs open and marks them busy", () => {
    const onClose = vi.fn();
    render(
      <AccessibleDialog title="Pending" onClose={onClose} pending>
        <button>Save</button>
      </AccessibleDialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focuses Cancel for destructive confirmations", async () => {
    render(
      <AccessibleDialog title="Please confirm" role="alertdialog" initialFocus="cancel" onClose={() => undefined}>
        <button data-dialog-initial-focus="cancel">Cancel</button>
        <button data-dialog-initial-focus="confirm">Delete</button>
      </AccessibleDialog>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Delete" }));
  });
});
