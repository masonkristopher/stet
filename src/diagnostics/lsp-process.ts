/**
 * The stdio byte channel for a long-lived language server. Unlike the one-shot `Process` service,
 * the child outlives any single request: stdin/stdout stay open while many requests interleave. A
 * forked read-loop decodes framed messages onto an inbound queue and `send` frames outbound
 * messages onto stdin. The server lifecycle (spawn, handshake, pool) is layered on top in P3.
 */
import { Context, Data, Effect, Layer, Queue } from "effect";
import type { Cause, Scope } from "effect";

import { createFrameDecoder, encodeMessage } from "./jsonrpc";
import type { JsonRpcMessage } from "./jsonrpc";
import { makeTransport } from "./transport";
import type { LspConnection, LspTransportChannel } from "./transport";

export class LspSpawnError extends Data.TaggedError("LspSpawnError")<{
  readonly command: readonly string[];
  readonly message: string;
}> {}

// A tagged error (not the global `Error`) so it stays distinct in the Effect failure channel.
class StreamReadError extends Data.TaggedError("StreamReadError")<{ readonly message: string }> {}

type LspChild = Bun.Subprocess<"pipe", "pipe", "pipe">;

/** Drives a stream to completion, handing each raw byte chunk to `onChunk`. */
function readChunks(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => Effect.Effect<void>,
): Effect.Effect<void, StreamReadError> {
  const reader = stream.getReader();
  const loop = (): Effect.Effect<void, StreamReadError> =>
    Effect.tryPromise({
      catch: (cause) =>
        new StreamReadError({ message: cause instanceof Error ? cause.message : String(cause) }),
      try: (signal) => {
        signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), {
          once: true,
        });
        return reader.read();
      },
    }).pipe(
      Effect.flatMap((result) =>
        result.done ? Effect.void : onChunk(result.value).pipe(Effect.flatMap(loop)),
      ),
    );
  return loop();
}

/**
 * Builds the byte channel over a spawned child: a stateful decoder turns stdout chunks into framed
 * messages on the inbound queue, `send` frames an outbound message onto stdin. Both pumps are
 * forked into the enclosing scope. Exposed (not just inlined into the server bring-up) so a real
 * subprocess can verify the round-trip without a language server.
 */
export function createByteChannel(child: LspChild) {
  return Effect.gen(function* byteChannel() {
    const inbound = yield* Queue.make<unknown, Cause.Done>();
    const decode = createFrameDecoder();

    const pumpStdout = readChunks(child.stdout, (chunk) =>
      Effect.forEach(decode(chunk), (message) => Queue.offer(inbound, message), { discard: true }),
    ).pipe(
      Effect.matchCauseEffect({
        onFailure: () => Queue.end(inbound),
        onSuccess: () => Queue.end(inbound),
      }),
    );

    const pumpStderr = readChunks(child.stderr, (chunk) =>
      Effect.logDebug(`[lsp stderr] ${new TextDecoder().decode(chunk).trimEnd()}`),
    ).pipe(Effect.ignore);

    yield* Effect.forkScoped(pumpStdout);
    yield* Effect.forkScoped(pumpStderr);

    const send = (message: JsonRpcMessage) =>
      Effect.promise(async () => {
        await child.stdin.write(encodeMessage(message));
        await child.stdin.flush();
      });

    return { inbound, send } satisfies LspTransportChannel;
  });
}

function acquireChild(command: readonly string[], cwd: string) {
  return Effect.acquireRelease(
    Effect.try({
      catch: (cause) =>
        new LspSpawnError({
          command,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      try: () =>
        Bun.spawn({ cmd: [...command], cwd, stderr: "pipe", stdin: "pipe", stdout: "pipe" }),
    }),
    (child) =>
      Effect.sync(() => {
        if (!child.killed) {
          child.kill();
        }
      }),
  );
}

/**
 * A language server held open for the lifetime of the acquiring scope: the child is killed on scope
 * close, the byte channel and request/response transport are wired on top. Spawning a missing
 * binary fails with `LspSpawnError` rather than escaping as a defect, mirroring `Process`.
 */
export class LspProcess extends Context.Service<
  LspProcess,
  {
    readonly start: (
      command: readonly string[],
      cwd: string,
      onRequest?: (method: string, params: unknown) => Effect.Effect<unknown>,
    ) => Effect.Effect<LspConnection, LspSpawnError, Scope.Scope>;
  }
>()("stet/LspProcess") {}

export const LspProcessLive = Layer.succeed(LspProcess)({
  start: (command, cwd, onRequest) =>
    acquireChild(command, cwd).pipe(
      Effect.flatMap(createByteChannel),
      Effect.flatMap((channel) => makeTransport(channel, onRequest)),
    ),
});
