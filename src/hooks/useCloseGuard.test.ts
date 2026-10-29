import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCloseGuard } from "./useCloseGuard";

const bridge = vi.hoisted(() => ({ register: vi.fn(), native: true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: bridge.register }) }));
vi.mock("../lib/tauri", () => ({ isTauri: () => bridge.native }));
afterEach(() => { bridge.register.mockReset(); bridge.native = true; });

async function setup(saveSession = vi.fn(async () => true)) {
  let close: (event: { preventDefault: () => void }) => Promise<void> = async () => undefined;
  const unlisten = vi.fn();
  bridge.register.mockImplementation(async (handler) => { close = handler; return unlisten; });
  const opts = { ready: true, agentActiveRef: { current: false }, saveSession };
  const hook = renderHook(() => useCloseGuard(opts));
  await act(async () => undefined);
  return { ...hook, opts, close: (event: { preventDefault: () => void }) => close(event), unlisten };
}

it("flushes the latest session before allowing a window to close", async () => {
  const h = await setup();
  const save = vi.fn(async () => true);
  h.opts.saveSession = save;
  h.rerender();
  const event = { preventDefault: vi.fn() };
  await act(async () => { await h.close(event); });
  expect(save).toHaveBeenCalledOnce();
  expect(event.preventDefault).not.toHaveBeenCalled();
  h.unmount();
  expect(h.unlisten).toHaveBeenCalledOnce();
});

it("keeps the window open when saving fails", async () => {
  const h = await setup(vi.fn(async () => false));
  const event = { preventDefault: vi.fn() };
  await act(async () => { await h.close(event); });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(h.result.current).toContain("session could not be saved");
});

it("prevents closing during an active agent turn", async () => {
  const h = await setup();
  h.opts.agentActiveRef.current = true;
  const event = { preventDefault: vi.fn() };
  await act(async () => { await h.close(event); });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(h.opts.saveSession).not.toHaveBeenCalled();
});

it("does not install a native handler in the browser preview", async () => {
  bridge.native = false;
  renderHook(() => useCloseGuard({ ready: true, agentActiveRef: { current: false }, saveSession: async () => true }));
  expect(bridge.register).not.toHaveBeenCalled();
});
