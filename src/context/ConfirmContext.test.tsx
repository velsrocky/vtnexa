// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmProvider, useConfirm } from "./ConfirmContext";

const realConfirm = window.confirm;
afterEach(() => {
  cleanup();
  window.confirm = realConfirm;
  vi.restoreAllMocks();
});

function Asker({ message, onResult }: { message: string; onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return <button onClick={async () => onResult(await confirm(message))}>ask</button>;
}

describe("ConfirmContext", () => {
  it("falls back to window.confirm without a provider", async () => {
    window.confirm = vi.fn(() => true) as never;
    let got: boolean | null = null;
    render(<Asker message="drop it?" onResult={(v) => (got = v)} />);
    fireEvent.click(screen.getByText("ask"));
    await waitFor(() => expect(got).toBe(true));
    expect(window.confirm).toHaveBeenCalledWith("drop it?");
  });

  it("provider modal confirms and cancels without blocking", async () => {
    const results: boolean[] = [];
    render(
      <ConfirmProvider>
        <Asker message="delete everything?" onResult={(v) => results.push(v)} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText("ask"));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("delete everything?")).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(results).toEqual([true]));

    fireEvent.click(screen.getByText("ask"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(results).toEqual([true, false]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
