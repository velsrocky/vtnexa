import { setTimeout as delay } from "node:timers/promises";

export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export class WebDriverError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WebDriverError";
    this.code = details.code;
    this.data = details.data;
  }
}

export function buildSessionPayload(application, { browserName = "wry", args = [] } = {}) {
  if (typeof application !== "string" || application.trim() === "") {
    throw new TypeError("WebDriver application path must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("WebDriver application args must be strings");
  }
  const tauriOptions = { application };
  if (args.length > 0) tauriOptions.args = [...args];
  return {
    capabilities: {
      alwaysMatch: {
        browserName,
        "tauri:options": tauriOptions,
      },
      firstMatch: [{}],
    },
  };
}

function responseValue(payload, response) {
  if (payload && typeof payload === "object" && payload.value && typeof payload.value === "object" && payload.value.error) {
    throw new WebDriverError(payload.value.message || payload.value.error, {
      code: payload.value.error,
      data: payload.value.data,
    });
  }
  if (!response.ok) {
    throw new WebDriverError(`WebDriver request failed with HTTP ${response.status}`);
  }
  return payload && Object.prototype.hasOwnProperty.call(payload, "value") ? payload.value : payload;
}

export class WebDriverClient {
  constructor({ baseUrl = "http://127.0.0.1:4444", timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("WebDriver client requires fetch");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
  }

  async request(method, endpoint, body, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text.trim() !== "") {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          throw new WebDriverError(`WebDriver returned malformed JSON: ${error.message}`);
        }
      }
      return responseValue(payload, response);
    } catch (error) {
      if (error instanceof WebDriverError) throw error;
      const message = error && error.name === "AbortError" ? `request timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error);
      throw new WebDriverError(`WebDriver ${method} ${endpoint} failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  sessionEndpoint(suffix = "") {
    if (!this.sessionId) throw new WebDriverError("WebDriver session has not been created");
    return `/session/${encodeURIComponent(this.sessionId)}${suffix}`;
  }

  async createSession(application, options = {}) {
    const value = await this.request("POST", "/session", buildSessionPayload(application, options));
    const sessionId = value && (value.sessionId || value.session_id);
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new WebDriverError("WebDriver session response did not contain a session id");
    }
    this.sessionId = sessionId;
    return value;
  }

  async deleteSession() {
    if (!this.sessionId) return null;
    const endpoint = this.sessionEndpoint();
    try {
      return await this.request("DELETE", endpoint, undefined, 10000);
    } finally {
      this.sessionId = null;
    }
  }

  async findElement(selector) {
    const value = await this.request("POST", this.sessionEndpoint("/element"), {
      using: "css selector",
      value: selector,
    });
    const elementId = value && value[ELEMENT_KEY];
    if (typeof elementId !== "string" || elementId === "") {
      throw new WebDriverError(`WebDriver did not return an element id for ${selector}`);
    }
    return elementId;
  }

  elementEndpoint(elementId, suffix) {
    return `${this.sessionEndpoint(`/element/${encodeURIComponent(elementId)}`)}${suffix}`;
  }

  async click(elementId) {
    return this.request("POST", this.elementEndpoint(elementId, "/click"), {});
  }

  async clear(elementId) {
    return this.request("POST", this.elementEndpoint(elementId, "/clear"), {});
  }

  async sendKeys(elementId, text) {
    return this.request("POST", this.elementEndpoint(elementId, "/value"), {
      text,
      value: [text],
    });
  }

  async getText(elementId) {
    return this.request("GET", this.elementEndpoint(elementId, "/text"));
  }

  async getAttribute(elementId, name) {
    return this.request("GET", this.elementEndpoint(elementId, `/attribute/${encodeURIComponent(name)}`));
  }

  async getProperty(elementId, name) {
    return this.request("GET", this.elementEndpoint(elementId, `/property/${encodeURIComponent(name)}`));
  }
}

export async function retryUntil(operation, { timeoutMs = 30000, intervalMs = 250, description = "operation" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let attempts = 0;
  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(intervalMs);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${description} timed out after ${timeoutMs}ms and ${attempts} attempts: ${detail}`);
}
