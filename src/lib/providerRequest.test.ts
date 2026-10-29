// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { providerRequest } from "./providerRequest";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("times out a connection even if the transport never settles", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
  const result = providerRequest("https://provider.test", {}, { connectMs: 10, idleMs: 20 });
  const assertion = expect(result).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(10);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("times out a stalled response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("partial")); } })));
  const response = await providerRequest("https://provider.test", {}, { connectMs: 10, idleMs: 20 });
  const assertion = expect(response.text()).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(20);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves Stop cancellation while reading a stream", async () => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream()));
  const response = await providerRequest("https://provider.test", { signal: controller.signal });
  const assertion = expect(response.text()).rejects.toThrow(/stopped/);
  controller.abort(new Error("stopped"));
  await assertion;
});

it("cleans up deadlines after a successful response", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => new Response('{"ok":true}'));
  const response = await providerRequest("https://provider.test");
  expect(await response.json()).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not let transport cancellation errors mask an HTTP response", async () => {
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel() { throw new Error("BodyStreamBuffer was aborted"); } }), { status: 503 }));
  const response = await providerRequest("https://provider.test");
  expect(response.status).toBe(503);
  await expect(response.body!.cancel()).resolves.toBeUndefined();
});
