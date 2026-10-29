import type { ProviderConfig } from "../types";
import { providerRequest } from "./providerRequest";
import { anthropicBaseUrl } from "./providerEndpoint";
import { ollamaBaseUrl, usesOllamaProtocol } from "./ollama";

/** Model listing verifies reachability/auth/model availability without a paid completion. */
export async function probeProvider(cfg: ProviderConfig, signal?: AbortSignal): Promise<void> {
  const base = cfg.baseUrl.trim().replace(/\/$/, "");
  const kind = cfg.kind && cfg.kind !== "auto" ? cfg.kind
    : /api\.anthropic\.com/i.test(base) ? "anthropic"
    : /generativelanguage\.googleapis\.com/i.test(base) ? "gemini" : "openai";
  const headers: Record<string, string> = kind === "anthropic"
    ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
    : kind === "gemini" ? { "x-goog-api-key": cfg.apiKey }
    : cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  const endpoint = usesOllamaProtocol(cfg) ? `${ollamaBaseUrl(base)}/v1`
    : kind === "anthropic" ? anthropicBaseUrl(base) : base;
  const response = await providerRequest(`${endpoint}/models`, { headers, signal }, { connectMs: 10_000, idleMs: 10_000 });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Provider model check returned HTTP ${response.status}. Check the endpoint and API key.`);
  }
  const data = await response.json();
  const models: unknown[] = kind === "gemini" ? data.models ?? [] : data.data ?? [];
  if (!Array.isArray(models)) throw new Error("Provider returned an invalid model list.");
  const ids = models.map((model) => {
    const value = model as { id?: string; name?: string };
    return kind === "gemini" ? value.name?.replace(/^models\//, "") : value.id;
  });
  const selected = kind === "gemini" ? cfg.model.trim().replace(/^models\//, "") : cfg.model.trim();
  if (!ids.includes(selected)) {
    throw new Error(`Model "${cfg.model.trim()}" was not listed by this provider. Choose an available model and retry.`);
  }
}
