/** Bound provider connection and body inactivity while preserving Stop. */
export async function providerRequest(
  url: string,
  init: RequestInit = {},
  limits = { connectMs: 30_000, idleMs: 120_000 },
): Promise<Response> {
  const controller = new AbortController();
  const parent = init.signal;
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const cleanup = () => parent?.removeEventListener("abort", abort);

  async function bounded<T>(operation: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new DOMException("Request stopped", "AbortError"));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new Error("Provider timed out. Check the endpoint and retry.")), ms);
    });
    try {
      if (controller.signal.aborted) return await cancelled;
      return await Promise.race([operation(), cancelled]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  try {
    const response = await bounded(() => fetch(url, { ...init, signal: controller.signal }), limits.connectMs);
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await bounded(() => reader.read(), limits.idleMs);
          if (next.done) {
            cleanup();
            stream.close();
          } else stream.enqueue(next.value);
        } catch (error) {
          cleanup();
          void reader.cancel().catch(() => undefined);
          stream.error(error);
        }
      },
      cancel(reason) {
        cleanup();
        const cancelled = reader.cancel(reason);
        controller.abort(reason);
        // WebKit/Chromium may reject cancellation when aborting fetch has
        // already closed its underlying body. Cleanup must not mask HTTP errors.
        return cancelled.catch(() => undefined);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
