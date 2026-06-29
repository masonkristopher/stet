import { expect, test } from "bun:test";

import { Effect, Queue } from "effect";

import type { JsonRpcMessage } from "@/diagnostics/jsonrpc";
import { createByteChannel } from "@/diagnostics/lsp-process";

/**
 * `cat` echoes stdin to stdout, so a framed message written through the channel comes back as the
 * same decoded message. This exercises the real read-loop, stdin write, and framing over an actual
 * OS pipe, without needing a language server.
 */
test("byte channel round-trips framed messages through a real subprocess", async () => {
  const received = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* roundTrip() {
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn({ cmd: ["cat"], stderr: "pipe", stdin: "pipe", stdout: "pipe" }),
          ),
          (process) => Effect.sync(() => process.kill()),
        );
        const channel = yield* createByteChannel(child);

        const outgoing: JsonRpcMessage = {
          id: 1,
          jsonrpc: "2.0",
          method: "ping",
          params: { n: 1 },
        };
        const second: JsonRpcMessage = { jsonrpc: "2.0", method: "note", params: { text: "café" } };
        yield* channel.send(outgoing);
        yield* channel.send(second);

        return [yield* Queue.take(channel.inbound), yield* Queue.take(channel.inbound)];
      }),
    ),
  );

  expect(received).toEqual([
    { id: 1, jsonrpc: "2.0", method: "ping", params: { n: 1 } },
    { jsonrpc: "2.0", method: "note", params: { text: "café" } },
  ]);
});
