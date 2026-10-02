import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  ELEMENT_KEY,
  WebDriverClient,
  buildSessionPayload,
} from "./tauri-driver-client.mjs";

const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function fakeWebDriver() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      response.end(JSON.stringify({ value: { sessionId: "session-1", capabilities: {} } }));
      return;
    }
    if (request.method === "POST" && request.url === "/session/session-1/element") {
      response.end(JSON.stringify({ value: { [ELEMENT_KEY]: "element-1" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/session/session-1/element/element-1/property/value") {
      response.end(JSON.stringify({ value: "C:\\Users\\runner\\workspace" }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/session/session-1") {
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.end(JSON.stringify({ value: null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

describe("Tauri WebDriver protocol client", () => {
  it("constructs a W3C Tauri session capability", () => {
    const payload = buildSessionPayload("C:\\build\\vtnexa.exe", { args: ["--smoke"] });
    assert.deepEqual(payload, {
      capabilities: {
        alwaysMatch: {
          browserName: "wry",
          "tauri:options": {
            application: "C:\\build\\vtnexa.exe",
            args: ["--smoke"],
          },
        },
        firstMatch: [{}],
      },
    });
  });

  it("creates, drives, reads, and deletes a session over W3C HTTP", async () => {
    const { baseUrl, requests } = await fakeWebDriver();
    const client = new WebDriverClient({ baseUrl });
    await client.createSession("C:\\build\\vtnexa.exe");
    const element = await client.findElement("[data-testid='workbench']");
    await client.clear(element);
    await client.sendKeys(element, "C:\\Temp\\workspace");
    await client.click(element);
    assert.equal(await client.getProperty(element, "value"), "C:\\Users\\runner\\workspace");
    await client.deleteSession();
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "POST /session",
      "POST /session/session-1/element",
      "POST /session/session-1/element/element-1/clear",
      "POST /session/session-1/element/element-1/value",
      "POST /session/session-1/element/element-1/click",
      "GET /session/session-1/element/element-1/property/value",
      "DELETE /session/session-1",
    ]);
    assert.deepEqual(requests[0].body.capabilities.alwaysMatch["tauri:options"], {
      application: "C:\\build\\vtnexa.exe",
    });
  });
});
