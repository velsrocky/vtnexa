// Scripted OpenAI-compatible provider for Playwright agent-turn e2e tests.
// Every reply is content from `script`: strings become final/first text,
// {tool, args} entries become single tool_calls rounds. Records the outbound
// request bodies so tests can assert task retention, nudge channels, etc.
export type ScriptStep = string | { tool: string; args: unknown; id?: string };

export interface RouteLog {
  requests: unknown[][];
  bodies: Record<string, unknown>[];
}

export function sseBody(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

export function routeProvider(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  baseUrl: string,
  script: ScriptStep[],
): RouteLog {
  const log: RouteLog = { requests: [], bodies: [] };
  let n = 0;
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  void page.route(url, async (route: { fulfill: (r: unknown) => Promise<void> }) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    log.requests.push(body.messages as unknown[]);
    log.bodies.push(body);
    const step = script[Math.min(n++, script.length - 1)];
    if (typeof step === "string") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sseBody([
          { choices: [{ delta: { content: step } }] },
          { usage: { prompt_tokens: 8, completion_tokens: 6 } },
        ]),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: step.id ?? `e2e${n}`,
                    function: { name: step.tool, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
            },
          ],
        },
        { usage: { prompt_tokens: 8, completion_tokens: 6 } },
      ]),
    });
  });
  return log;
}

export function roleContents(messages: unknown[]): { role: string; content: string }[] {
  return (messages as { role: string; content?: string }[]).map((m) => ({ role: m.role, content: m.content ?? "" }));
}
