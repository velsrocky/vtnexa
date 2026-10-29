// jsdom omits Web Streams even though the host Node fetch returns them.
import { ReadableStream } from "node:stream/web";

if (!globalThis.ReadableStream) {
  Object.defineProperty(globalThis, "ReadableStream", { value: ReadableStream, configurable: true, writable: true });
}
