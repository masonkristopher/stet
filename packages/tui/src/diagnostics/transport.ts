/**
 * JSON-RPC request/response correlation over an abstract message channel. A forked router fiber
 * drains inbound messages: responses resolve the matching pending request, server-to-client
 * requests get a minimal reply so the server never blocks, notifications are logged. Decoupled from
 * the process so it can be driven by a fake in-process peer in tests.
 */
import { Data, Deferred, Effect, Queue } from "effect";
import type { Cause } from "effect";

import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from "./jsonrpc";
import type { JsonRpcMessage } from "./jsonrpc";

export class LspRequestError extends Data.TaggedError("LspRequestError")<{
  readonly method: string;
  readonly message: string;
}> {}

export interface LspTransportChannel {
  readonly inbound: Queue.Dequeue<unknown, Cause.Done>;
  readonly send: (message: JsonRpcMessage) => Effect.Effect<void>;
}

interface TextDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
  readonly version: number;
}

/** One `textDocument/diagnostic` answer: the file's items plus any cross-file reports it carried. */
interface PulledDiagnostics {
  readonly items: unknown[];
  /** Full `relatedDocuments` reports keyed by uri; per-answer data, deliberately not stored. */
  readonly related: ReadonlyMap<string, unknown[]>;
}

export interface LspConnection {
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, LspRequestError>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>;
  /**
   * One pull-diagnostics round trip for an open document, with `resultId` bookkeeping: the previous
   * answer's id rides along as `previousResultId`, and an `unchanged` report resolves to the items
   * cached from the last `full` one. The cache is the transport's because it must live exactly as
   * long as the connection: a fresh server knows no prior resultId, a warm one honors it.
   */
  readonly pullDiagnostics: (uri: string) => Effect.Effect<PulledDiagnostics, LspRequestError>;
  /**
   * Refcounted `textDocument/didOpen`: sent only on the first holder of a uri (count 0→1); a later
   * holder reuses the already-open doc. Intel pulls and the diagnostics run share one connection,
   * so this keeps a second open from resetting the server's view of a doc another holder still
   * needs.
   */
  readonly openDocument: (textDocument: TextDocument) => Effect.Effect<void>;
  /**
   * Full-text `textDocument/didChange` for an already-open document, versioned by a per-uri counter
   * the transport owns (seeded from the open's version, bumped per change), so callers never
   * coordinate versions. Full sync is deliberate: stet always holds the whole on-disk file, and a
   * full-replacement event is valid under both full and incremental server sync modes.
   */
  readonly changeDocument: (uri: string, text: string) => Effect.Effect<void>;
  /** Refcounted `textDocument/didClose`: sent only when the last holder of the uri releases (1→0). */
  readonly closeDocument: (uri: string) => Effect.Effect<void>;
  /** Latest server-pushed `publishDiagnostics` items, keyed by document URI. */
  readonly published: Effect.Effect<ReadonlyMap<string, unknown[]>>;
  /** Drop stored diagnostics for the given URIs before reopening them, so a re-pull starts clean. */
  readonly clearPublished: (uris: readonly string[]) => Effect.Effect<void>;
  /** True once the server's stdout closed — the child died; the pool should rebuild it. */
  readonly closed: Effect.Effect<boolean>;
  /**
   * Resolves once the server has finished loading its project (the first `$/progress` "end" after
   * `initialize`), or immediately when already loaded. Until then a server like
   * typescript-language-server answers `textDocument/definition` from the local import binding
   * instead of resolving cross-file, so intel pulls await this before requesting. Also resolves on
   * connection close so a pull never hangs past server death.
   */
  readonly whenProjectLoaded: Effect.Effect<void>;
}

interface Pending {
  readonly deferred: Deferred.Deferred<unknown, LspRequestError>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ParsedReport {
  readonly kind: "full" | "unchanged";
  readonly resultId?: string;
  readonly items: unknown[];
  readonly related: Map<string, unknown[]>;
}

// A DocumentDiagnosticReport: `full` carries items (and the resultId to send back next time),
// `unchanged` asserts the previous resultId still holds. `relatedDocuments` nests one report per
// Cross-file uri; only its `full` entries carry data, and the spec nests no further level.
function parseDiagnosticReport(value: unknown): ParsedReport | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const resultId = typeof value.resultId === "string" ? { resultId: value.resultId } : {};
  const related = new Map<string, unknown[]>();
  if (isObject(value.relatedDocuments)) {
    for (const [uri, report] of Object.entries(value.relatedDocuments)) {
      if (isObject(report) && report.kind === "full" && Array.isArray(report.items)) {
        related.set(uri, report.items);
      }
    }
  }
  if (value.kind === "full" && Array.isArray(value.items)) {
    return { items: value.items, kind: "full", related, ...resultId };
  }
  if (value.kind === "unchanged") {
    return { items: [], kind: "unchanged", related, ...resultId };
  }
  return undefined;
}

export function makeTransport(
  channel: LspTransportChannel,
  onRequest?: (method: string, params: unknown) => Effect.Effect<unknown>,
  onRefreshRequest?: Effect.Effect<void>,
) {
  return Effect.gen(function* makeTransportScope() {
    // Default answer for a server-to-client request: a null result, so a server that asks for
    // Something we do not model (typescript) never stalls. oxlint supplies a real handler.
    const respond = onRequest ?? (() => Effect.succeed(null));
    const pending = new Map<number, Pending>();
    const published = new Map<string, unknown[]>();
    const openCounts = new Map<string, number>();
    let nextId = 0;
    let closed = false;
    // Resolved on the first project-load `$/progress` "end" (or on close); `whenProjectLoaded`
    // Gates intel pulls so a request never lands during the load window with a premature reply.
    let loaded = false;
    const projectLoaded = yield* Deferred.make<void>();
    const markLoaded = Effect.suspend(() => {
      if (loaded) {
        return Effect.void;
      }
      loaded = true;
      return Deferred.succeed(projectLoaded, undefined).pipe(Effect.asVoid);
    });

    function dispatch(message: unknown) {
      if (isJsonRpcResponse(message)) {
        if (typeof message.id !== "number") {
          return Effect.void;
        }
        const entry = pending.get(message.id);
        if (entry === undefined) {
          return Effect.void;
        }
        pending.delete(message.id);
        return message.error === undefined
          ? Deferred.succeed(entry.deferred, message.result)
          : Deferred.fail(
              entry.deferred,
              new LspRequestError({ message: message.error.message, method: entry.method }),
            );
      }
      if (isJsonRpcRequest(message)) {
        const { id } = message;
        // A server nudging "re-pull your diagnostics" (rust-analyzer after a cargo check cycle):
        // Answer immediately so it never stalls, then surface the nudge so the app re-runs checks.
        if (message.method === "workspace/diagnostic/refresh") {
          return channel
            .send({ id, jsonrpc: "2.0", result: null })
            .pipe(Effect.andThen(onRefreshRequest ?? Effect.void));
        }
        // Answer other server-to-client requests so the server does not stall waiting on us; the
        // Handler (or the null default) decides the result.
        return respond(message.method, message.params).pipe(
          Effect.flatMap((result) => channel.send({ id, jsonrpc: "2.0", result })),
        );
      }
      if (isJsonRpcNotification(message)) {
        if (message.method === "textDocument/publishDiagnostics" && isObject(message.params)) {
          const { diagnostics, uri } = message.params;
          if (typeof uri === "string" && Array.isArray(diagnostics)) {
            published.set(uri, diagnostics);
          }
          return Effect.void;
        }
        // A workDoneProgress "end" marks the project load complete; before it, intel replies are
        // Resolved from the local import binding rather than cross-file (the F12-stops-at-import bug).
        if (message.method === "$/progress" && isObject(message.params)) {
          const { value } = message.params;
          return isObject(value) && value.kind === "end" ? markLoaded : Effect.void;
        }
        return Effect.logDebug(`lsp notification ${message.method}`);
      }
      return Effect.void;
    }

    // The router stops when the inbound queue ends or fails (the connection closed); fail every
    // Still-pending request so a caller awaiting a reply is released rather than hanging forever.
    const router = Queue.take(channel.inbound).pipe(
      Effect.flatMap(dispatch),
      Effect.forever,
      Effect.catchCause(() =>
        Effect.sync(() => {
          closed = true;
        }).pipe(
          // Release any pull awaiting project load so it fails fast instead of hanging past death.
          Effect.andThen(markLoaded),
          Effect.andThen(
            Effect.forEach(
              [...pending.values()],
              (entry) =>
                Deferred.fail(
                  entry.deferred,
                  new LspRequestError({ message: "connection closed", method: entry.method }),
                ),
              { discard: true },
            ),
          ),
        ),
      ),
    );
    yield* Effect.forkScoped(router);

    const request = (method: string, params?: unknown) =>
      Deferred.make<unknown, LspRequestError>().pipe(
        Effect.flatMap((deferred) => {
          const id = nextId;
          nextId += 1;
          pending.set(id, { deferred, method });
          return channel
            .send({ id, jsonrpc: "2.0", method, params })
            .pipe(
              Effect.andThen(Deferred.await(deferred)),
              Effect.ensuring(Effect.sync(() => pending.delete(id))),
            );
        }),
      );

    const notify = (method: string, params?: unknown) =>
      channel.send({ jsonrpc: "2.0", method, params });

    // The pull bucket: per uri, the last full report's items and the resultId to echo back. Only
    // Documents this client pulls enter it, so it stays bounded by the changed set. Commits need no
    // Per-uri ordering: each run renders from its own answers (the bucket only feeds the next
    // `previousResultId`), every commit is an atomic (resultId, items) pair the server itself
    // Issued, and echoing an older pair at worst makes the server answer `full` (an `unchanged` is
    // The server asserting the held pair is still current, so its reuse is correct by definition).
    const pulled = new Map<string, { resultId?: string; items: unknown[] }>();

    const pullDiagnostics = (uri: string) =>
      Effect.suspend(() => {
        const previous = pulled.get(uri);
        return request("textDocument/diagnostic", {
          textDocument: { uri },
          ...(previous?.resultId === undefined ? {} : { previousResultId: previous.resultId }),
        }).pipe(
          Effect.flatMap((result) => {
            const report = parseDiagnosticReport(result);
            if (report === undefined) {
              return Effect.fail(
                new LspRequestError({
                  message: "malformed diagnostic report",
                  method: "textDocument/diagnostic",
                }),
              );
            }
            const items = report.kind === "full" ? report.items : (previous?.items ?? []);
            // An `unchanged` without the (spec-required) resultId keeps the stored one; a `full`
            // Without one means the server issues no ids, so none is stored.
            const resultId =
              report.kind === "full" ? report.resultId : (report.resultId ?? previous?.resultId);
            pulled.set(uri, { items, ...(resultId === undefined ? {} : { resultId }) });
            return Effect.succeed({ items, related: report.related } satisfies PulledDiagnostics);
          }),
        );
      });

    // Per-uri document versions, seeded by the open's version and bumped per change. Never reset on
    // Close: LSP only requires versions to increase within an open session, and staying monotonic
    // For the connection's lifetime satisfies that for every reopen with no bookkeeping.
    const versions = new Map<string, number>();

    // The count is read-modified-written synchronously inside `suspend`, before the async send, so a
    // Second fiber acquiring the same uri can't interleave between the read and the increment.
    const openDocument = (textDocument: TextDocument) =>
      Effect.suspend(() => {
        const count = openCounts.get(textDocument.uri) ?? 0;
        openCounts.set(textDocument.uri, count + 1);
        if (count > 0) {
          return Effect.void;
        }
        const version = Math.max(textDocument.version, (versions.get(textDocument.uri) ?? 0) + 1);
        versions.set(textDocument.uri, version);
        return notify("textDocument/didOpen", { textDocument: { ...textDocument, version } });
      });

    const changeDocument = (uri: string, text: string) =>
      Effect.suspend(() => {
        const version = (versions.get(uri) ?? 0) + 1;
        versions.set(uri, version);
        return notify("textDocument/didChange", {
          contentChanges: [{ text }],
          textDocument: { uri, version },
        });
      });

    const closeDocument = (uri: string) =>
      Effect.suspend(() => {
        const count = openCounts.get(uri) ?? 0;
        if (count > 1) {
          openCounts.set(uri, count - 1);
          return Effect.void;
        }
        openCounts.delete(uri);
        return count === 1
          ? notify("textDocument/didClose", { textDocument: { uri } })
          : Effect.void;
      });

    return {
      changeDocument,
      clearPublished: (uris: readonly string[]) =>
        Effect.sync(() => {
          for (const uri of uris) {
            published.delete(uri);
          }
        }),
      closeDocument,
      closed: Effect.sync(() => closed),
      notify,
      openDocument,
      published: Effect.sync(() => published),
      pullDiagnostics,
      request,
      whenProjectLoaded: Effect.suspend(() =>
        loaded ? Effect.void : Deferred.await(projectLoaded),
      ),
    } satisfies LspConnection;
  });
}
