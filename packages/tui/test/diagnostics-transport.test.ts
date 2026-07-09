import { expect, test } from "bun:test";

import { Effect, Exit, Queue } from "effect";
import type { Cause } from "effect";

import { isJsonRpcNotification, isJsonRpcRequest } from "@/diagnostics/jsonrpc";
import type { JsonRpcMessage } from "@/diagnostics/jsonrpc";
import { makeTransport } from "@/diagnostics/transport";
import type { LspConnection } from "@/diagnostics/transport";

interface Peer {
  connection: LspConnection;
  /** Messages the client wrote outbound. */
  sent: Queue.Dequeue<JsonRpcMessage, Cause.Done>;
  /** Push a message back onto the inbound channel, as a real server would. */
  reply: (message: JsonRpcMessage) => Effect.Effect<void>;
  /** Close the inbound channel, simulating the server going away. */
  close: Effect.Effect<void>;
}

/** Drives the transport against a fake in-process peer over two queues. No process, no mocks. */
function withPeer<A, E>(
  run: (peer: Peer) => Effect.Effect<A, E>,
  onRefreshRequest?: Effect.Effect<void>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* fakePeer() {
        const inbound = yield* Queue.make<unknown, Cause.Done>();
        const sent = yield* Queue.make<JsonRpcMessage, Cause.Done>();
        const connection = yield* makeTransport(
          {
            inbound,
            send: (message) => Queue.offer(sent, message).pipe(Effect.asVoid),
          },
          undefined,
          onRefreshRequest,
        );
        return yield* run({
          close: Queue.end(inbound).pipe(Effect.asVoid),
          connection,
          reply: (message) => Queue.offer(inbound, message).pipe(Effect.asVoid),
          sent,
        });
      }),
    ),
  );
}

function idOf(message: JsonRpcMessage) {
  return isJsonRpcRequest(message) ? message.id : 0;
}

const doc = (uri: string) => ({ languageId: "typescript", text: "x", uri, version: 1 });

/** Drain every notification the client has written so far and return them, in order. */
function sentNotifications(sent: Queue.Dequeue<JsonRpcMessage, Cause.Done>) {
  return Queue.takeAll(sent).pipe(Effect.map((messages) => messages.filter(isJsonRpcNotification)));
}

test("didOpen is sent only for the first holder of a uri", async () => {
  const methods = await withPeer(({ connection, sent }) =>
    connection.openDocument(doc("file:///a.ts")).pipe(
      Effect.andThen(connection.openDocument(doc("file:///a.ts"))),
      Effect.andThen(sentNotifications(sent)),
      Effect.map((notifications) => notifications.map((message) => message.method)),
    ),
  );
  expect(methods).toEqual(["textDocument/didOpen"]);
});

test("didClose is sent only when the last holder of a uri releases", async () => {
  const methods = await withPeer(({ connection, sent }) =>
    connection.openDocument(doc("file:///a.ts")).pipe(
      Effect.andThen(connection.openDocument(doc("file:///a.ts"))),
      Effect.andThen(connection.closeDocument("file:///a.ts")),
      Effect.andThen(connection.closeDocument("file:///a.ts")),
      Effect.andThen(sentNotifications(sent)),
      Effect.map((notifications) => notifications.map((message) => message.method)),
    ),
  );
  expect(methods).toEqual(["textDocument/didOpen", "textDocument/didClose"]);
});

test("distinct uris are refcounted independently", async () => {
  const notifications = await withPeer(({ connection, sent }) =>
    connection
      .openDocument(doc("file:///a.ts"))
      .pipe(
        Effect.andThen(connection.openDocument(doc("file:///b.ts"))),
        Effect.andThen(connection.closeDocument("file:///a.ts")),
        Effect.andThen(sentNotifications(sent)),
      ),
  );
  // A opens, b opens, a closes while b stays open.
  expect(notifications).toMatchObject([
    { method: "textDocument/didOpen", params: { textDocument: { uri: "file:///a.ts" } } },
    { method: "textDocument/didOpen", params: { textDocument: { uri: "file:///b.ts" } } },
    { method: "textDocument/didClose", params: { textDocument: { uri: "file:///a.ts" } } },
  ]);
});

test("a uri reopened after a full release sends a fresh didOpen", async () => {
  const methods = await withPeer(({ connection, sent }) =>
    connection.openDocument(doc("file:///a.ts")).pipe(
      Effect.andThen(connection.closeDocument("file:///a.ts")),
      Effect.andThen(connection.openDocument(doc("file:///a.ts"))),
      Effect.andThen(sentNotifications(sent)),
      Effect.map((notifications) => notifications.map((message) => message.method)),
    ),
  );
  expect(methods).toEqual([
    "textDocument/didOpen",
    "textDocument/didClose",
    "textDocument/didOpen",
  ]);
});

test("request resolves with the result of the matching response", async () => {
  const exit = await withPeer(({ connection, reply, sent }) =>
    Effect.all(
      [
        Effect.exit(connection.request("initialize", { root: "/" })),
        Effect.gen(function* respond() {
          const outgoing = yield* Queue.take(sent);
          expect(outgoing).toMatchObject({ method: "initialize", params: { root: "/" } });
          yield* reply({ id: idOf(outgoing), jsonrpc: "2.0", result: { ok: true } });
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([result]) => result)),
  );
  expect(exit).toMatchObject({ _tag: "Success", value: { ok: true } });
});

test("request fails when the response carries an error", async () => {
  const exit = await withPeer(({ connection, reply, sent }) =>
    Effect.all(
      [
        Effect.exit(connection.request("textDocument/diagnostic")),
        Effect.gen(function* respond() {
          const outgoing = yield* Queue.take(sent);
          yield* reply({
            error: { code: -32_000, message: "boom" },
            id: idOf(outgoing),
            jsonrpc: "2.0",
          });
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([result]) => result)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
});

test("correlates concurrent requests by id, regardless of reply order", async () => {
  const results = await withPeer(({ connection, reply, sent }) =>
    Effect.all(
      [
        Effect.exit(connection.request("a")),
        Effect.exit(connection.request("b")),
        Effect.gen(function* respond() {
          const out1 = yield* Queue.take(sent);
          const out2 = yield* Queue.take(sent);
          // Reply to the second request first to prove correlation is by id, not arrival order.
          yield* reply({ id: idOf(out2), jsonrpc: "2.0", result: "B" });
          yield* reply({ id: idOf(out1), jsonrpc: "2.0", result: "A" });
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([a, b]) => ({ a, b }))),
  );
  expect(results.a).toMatchObject({ value: "A" });
  expect(results.b).toMatchObject({ value: "B" });
});

test("answers a server-to-client request with a null result", async () => {
  const echoed = await withPeer(({ reply, sent }) =>
    Effect.gen(function* scenario() {
      yield* reply({ id: 99, jsonrpc: "2.0", method: "window/workDoneProgress/create" });
      return yield* Queue.take(sent);
    }),
  );
  expect(echoed).toEqual({ id: 99, jsonrpc: "2.0", result: null });
});

test("answers a server-to-client request with the supplied handler's result", async () => {
  const echoed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* scenario() {
        const inbound = yield* Queue.make<unknown, Cause.Done>();
        const sent = yield* Queue.make<JsonRpcMessage, Cause.Done>();
        // Oxlint answers `workspace/configuration` with its options, or it never publishes.
        yield* makeTransport(
          { inbound, send: (message) => Queue.offer(sent, message).pipe(Effect.asVoid) },
          (method) =>
            Effect.succeed(method === "workspace/configuration" ? [{ run: "onType" }] : null),
        );
        yield* Queue.offer(inbound, {
          id: 7,
          jsonrpc: "2.0",
          method: "workspace/configuration",
          params: { items: [{}] },
        });
        return yield* Queue.take(sent);
      }),
    ),
  );
  expect(echoed).toEqual({ id: 7, jsonrpc: "2.0", result: [{ run: "onType" }] });
});

test("whenProjectLoaded stays pending until the project-load progress ends", async () => {
  const phases = await withPeer(({ connection, reply }) =>
    Effect.gen(function* scenario() {
      const probe = connection.whenProjectLoaded.pipe(
        Effect.as("loaded"),
        Effect.timeout("30 millis"),
        Effect.catchTag("TimeoutError", () => Effect.succeed("pending")),
      );
      // No progress yet: still loading, so the gate holds.
      const before = yield* probe;
      yield* reply({
        jsonrpc: "2.0",
        method: "$/progress",
        params: {
          token: "t",
          value: { kind: "begin", title: "Initializing JS/TS language features…" },
        },
      });
      // A "begin" alone must not open the gate.
      const during = yield* probe;
      yield* reply({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token: "t", value: { kind: "end" } },
      });
      const after = yield* connection.whenProjectLoaded.pipe(
        Effect.as("loaded"),
        Effect.timeout("1 second"),
        Effect.catchTag("TimeoutError", () => Effect.succeed("pending")),
      );
      return { after, before, during };
    }),
  );
  expect(phases).toEqual({ after: "loaded", before: "pending", during: "pending" });
});

test("whenProjectLoaded resolves when the connection closes", async () => {
  const phase = await withPeer(({ close, connection }) =>
    close.pipe(
      Effect.andThen(connection.whenProjectLoaded),
      Effect.as("loaded"),
      Effect.timeout("1 second"),
      Effect.catchTag("TimeoutError", () => Effect.succeed("pending")),
    ),
  );
  expect(phase).toBe("loaded");
});

test("a closed connection fails an in-flight request instead of hanging", async () => {
  const exit = await withPeer(({ close, connection, sent }) =>
    Effect.all(
      [
        Effect.exit(connection.request("initialize")),
        Effect.gen(function* shutDown() {
          yield* Queue.take(sent);
          yield* close;
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([result]) => result)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
});

test("pullDiagnostics echoes the stored resultId and reuses cached items on unchanged", async () => {
  const outcome = await withPeer(({ connection, reply, sent }) =>
    Effect.all(
      [
        Effect.gen(function* pulls() {
          const first = yield* connection.pullDiagnostics("file:///a.ts");
          const second = yield* connection.pullDiagnostics("file:///a.ts");
          return { first, second };
        }),
        Effect.gen(function* respond() {
          const out1 = yield* Queue.take(sent);
          expect(isJsonRpcRequest(out1) ? out1.method : undefined).toBe("textDocument/diagnostic");
          // The first pull carries no previousResultId: nothing has been answered yet.
          expect(isJsonRpcRequest(out1) ? out1.params : undefined).toEqual({
            textDocument: { uri: "file:///a.ts" },
          });
          yield* reply({
            id: idOf(out1),
            jsonrpc: "2.0",
            result: { items: ["d1"], kind: "full", resultId: "r1" },
          });
          const out2 = yield* Queue.take(sent);
          // The second pull echoes the first answer's resultId back.
          expect(isJsonRpcRequest(out2) ? out2.params : undefined).toEqual({
            previousResultId: "r1",
            textDocument: { uri: "file:///a.ts" },
          });
          yield* reply({
            id: idOf(out2),
            jsonrpc: "2.0",
            result: { kind: "unchanged", resultId: "r2" },
          });
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([pulls]) => pulls)),
  );
  expect(outcome.first.items).toEqual(["d1"]);
  // Unchanged means "same as the last full answer": the cached items resolve, not an empty set.
  expect(outcome.second.items).toEqual(["d1"]);
});

test("pullDiagnostics surfaces full relatedDocuments reports, skipping unchanged ones", async () => {
  const answer = await withPeer(({ connection, reply, sent }) =>
    Effect.all(
      [
        connection.pullDiagnostics("file:///a.ts"),
        Effect.gen(function* respond() {
          const outgoing = yield* Queue.take(sent);
          yield* reply({
            id: idOf(outgoing),
            jsonrpc: "2.0",
            result: {
              items: [],
              kind: "full",
              relatedDocuments: {
                "file:///b.ts": { items: ["cross"], kind: "full" },
                "file:///c.ts": { kind: "unchanged", resultId: "x" },
              },
              resultId: "r1",
            },
          });
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([pulled]) => pulled)),
  );
  expect([...answer.related.entries()]).toEqual([["file:///b.ts", ["cross"]]]);
});

test("pullDiagnostics fails on a malformed diagnostic report", async () => {
  const exit = await withPeer(({ connection, reply, sent }) =>
    Effect.all(
      [
        Effect.exit(connection.pullDiagnostics("file:///a.ts")),
        Effect.gen(function* respond() {
          const outgoing = yield* Queue.take(sent);
          yield* reply({ id: idOf(outgoing), jsonrpc: "2.0", result: { nonsense: true } });
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([result]) => result)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
});

test("workspace/diagnostic/refresh is answered null and surfaces the nudge", async () => {
  let refreshes = 0;
  const response = await withPeer(
    ({ reply, sent }) =>
      Effect.gen(function* run() {
        yield* reply({ id: 7, jsonrpc: "2.0", method: "workspace/diagnostic/refresh" });
        return yield* Queue.take(sent);
      }),
    Effect.sync(() => {
      refreshes += 1;
    }),
  );
  expect(response).toMatchObject({ id: 7, result: null });
  expect(refreshes).toBe(1);
});

test("changeDocument sends the full text with a version that keeps increasing per uri", async () => {
  const notifications = await withPeer(({ connection, sent }) =>
    connection
      .openDocument(doc("file:///a.ts"))
      .pipe(
        Effect.andThen(connection.changeDocument("file:///a.ts", "const a = 2\n")),
        Effect.andThen(connection.changeDocument("file:///a.ts", "const a = 3\n")),
        Effect.andThen(connection.openDocument(doc("file:///b.ts"))),
        Effect.andThen(connection.changeDocument("file:///b.ts", "const b = 2\n")),
        Effect.andThen(sentNotifications(sent)),
      ),
  );
  expect(notifications).toMatchObject([
    {
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///a.ts", version: 1 } },
    },
    {
      method: "textDocument/didChange",
      params: {
        contentChanges: [{ text: "const a = 2\n" }],
        textDocument: { uri: "file:///a.ts", version: 2 },
      },
    },
    {
      method: "textDocument/didChange",
      params: {
        contentChanges: [{ text: "const a = 3\n" }],
        textDocument: { uri: "file:///a.ts", version: 3 },
      },
    },
    {
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///b.ts", version: 1 } },
    },
    {
      method: "textDocument/didChange",
      params: { textDocument: { uri: "file:///b.ts", version: 2 } },
    },
  ]);
});

test("a reopened document's version never regresses", async () => {
  const notifications = await withPeer(({ connection, sent }) =>
    connection
      .openDocument(doc("file:///a.ts"))
      .pipe(
        Effect.andThen(connection.changeDocument("file:///a.ts", "x")),
        Effect.andThen(connection.closeDocument("file:///a.ts")),
        Effect.andThen(connection.openDocument(doc("file:///a.ts"))),
        Effect.andThen(sentNotifications(sent)),
      ),
  );
  // The reopen's version continues past the closed session's (LSP only needs increase, and
  // Monotonic-for-the-connection means no bookkeeping can ever send a regressing version).
  expect(notifications).toMatchObject([
    { method: "textDocument/didOpen", params: { textDocument: { version: 1 } } },
    { method: "textDocument/didChange", params: { textDocument: { version: 2 } } },
    { method: "textDocument/didClose" },
    { method: "textDocument/didOpen", params: { textDocument: { version: 3 } } },
  ]);
});
