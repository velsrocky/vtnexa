// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { probeProvider } from "./providerProbe";

const cfg = { baseUrl: "https://provider.test/v1", model: "coder", apiKey: "secret", kind: "openai" as const };
afterEach(() => vi.unstubAllGlobals());

it("checks Ollama models when configured with the server root", async () => {
  const fetch = vi.fn(async () => Response.json({ data: [{ id: "coder" }] }));
  vi.stubGlobal("fetch", fetch);
  await probeProvider({ ...cfg, baseUrl: "http://127.0.0.1:12000", kind: "ollama" });
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:12000/v1/models", expect.anything());
});

it("checks credentials and model availability without generating tokens", async () => {
  const fetch = vi.fn(async () => Response.json({ data: [{ id: "coder" }] }));
  vi.stubGlobal("fetch", fetch);
  await probeProvider(cfg);
  expect(fetch).toHaveBeenCalledWith(`${cfg.baseUrl}/models`, expect.objectContaining({ headers: { Authorization: "Bearer secret" } }));
  expect(fetch).toHaveBeenCalledOnce();
});

it("rejects authentication failures and missing models", async () => {
  vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
  await expect(probeProvider(cfg)).rejects.toThrow(/HTTP 401/);
  vi.stubGlobal("fetch", async () => Response.json({ data: [{ id: "another" }] }));
  await expect(probeProvider(cfg)).rejects.toThrow(/not listed/);
});

it("uses native Anthropic and Gemini model-list formats", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (headers["x-api-key"]) return Response.json({ data: [{ id: "coder" }] });
    expect(headers["x-goog-api-key"]).toBe("secret");
    return Response.json({ models: [{ name: "models/coder" }] });
  });
  vi.stubGlobal("fetch", fetch);
  await probeProvider({ ...cfg, kind: "anthropic" });
  await probeProvider({ ...cfg, kind: "gemini" });
});

it("uses the official Anthropic v1 path without changing proxy paths", async () => {
  const fetch = vi.fn(async () => Response.json({ data: [{ id: "coder" }] }));
  vi.stubGlobal("fetch", fetch);
  for (const baseUrl of ["https://api.anthropic.com", "https://api.anthropic.com/v1", "https://proxy.test/custom"]) {
    await probeProvider({ ...cfg, baseUrl, kind: "anthropic" });
  }
  expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
    "https://api.anthropic.com/v1/models", "https://api.anthropic.com/v1/models", "https://proxy.test/custom/models",
  ]);
});
