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
function withPeer<A, E>(run: (peer: Peer) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* fakePeer() {
        const inbound = yield* Queue.make<unknown, Cause.Done>();
        const sent = yield* Queue.make<JsonRpcMessage, Cause.Done>();
        const connection = yield* makeTransport({
          inbound,
          send: (message) => Queue.offer(sent, message).pipe(Effect.asVoid),
        });
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
