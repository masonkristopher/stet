/**
 * On-demand read-only code-intelligence pulls (`textDocument/definition`,
 * `textDocument/references`, hover, document symbols, and the two-step call hierarchy) over the
 * warm `LanguageServers` pool. Each call is an open/request/close bracket on the first acquired
 * server that advertises the needed capability (oxlint, which advertises none, drops out;
 * typescript answers). Call hierarchy adds a second `prepare` → resolve round-trip inside the one
 * open document. The seam the diagnostics push flow lacks; #130/#131.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context, Data, Effect, Layer } from "effect";

import { LanguageServers, lspLanguageId, serversProviding } from "@/diagnostics/servers";
import type { Capability } from "@/diagnostics/servers";
import { relativize } from "@/utils/path";

import {
  firstHierarchyItem,
  normalizeDefinition,
  normalizeDocumentSymbols,
  normalizeIncomingCalls,
  normalizeOutgoingCalls,
  normalizeReferences,
  parseHover,
} from "./protocol";
import type { HoverSegment, NormalizedLocation, NormalizedSymbol } from "./protocol";

/**
 * Canonicalize to realpath so a symlinked repo root and a server-resolved target compare in the
 * same form; falls back to the raw path when it no longer exists (a deleted or out-of-repo
 * target).
 */
function realpathOr(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A code-intel request that failed past degradation (server error, dropped connection, timeout). */
export class IntelRequestError extends Data.TaggedError("IntelRequestError")<{
  readonly method: string;
  readonly message: string;
}> {}

interface Position {
  line: number;
  character: number;
}

export class Intel extends Context.Service<
  Intel,
  {
    readonly definition: (
      repoRoot: string,
      path: string,
      position: Position,
    ) => Effect.Effect<NormalizedLocation[], IntelRequestError>;
    readonly references: (
      repoRoot: string,
      path: string,
      position: Position,
    ) => Effect.Effect<NormalizedLocation[], IntelRequestError>;
    readonly hover: (
      repoRoot: string,
      path: string,
      position: Position,
    ) => Effect.Effect<HoverSegment[], IntelRequestError>;
    readonly implementation: (
      repoRoot: string,
      path: string,
      position: Position,
    ) => Effect.Effect<NormalizedLocation[], IntelRequestError>;
    readonly symbols: (
      repoRoot: string,
      path: string,
    ) => Effect.Effect<NormalizedSymbol[], IntelRequestError>;
    readonly callHierarchy: (
      repoRoot: string,
      path: string,
      position: Position,
      direction: "incoming" | "outgoing",
    ) => Effect.Effect<NormalizedLocation[], IntelRequestError>;
  }
>()("sideye/Intel") {}

export const IntelLive = Layer.effect(
  Intel,
  Effect.gen(function* intelLive() {
    const servers = yield* LanguageServers;

    // The first server for this file that advertises the capability. `serversProviding` drops
    // Servers whose static hint can't answer it (no wasted acquire); the handshake-advertised set
    // Stays the gate. Acquire failures (unavailable/installing/spawn) skip that server too.
    function firstCapableServer(repoRoot: string, path: string, capability: Capability) {
      return Effect.gen(function* select() {
        for (const language of serversProviding(path, capability)) {
          const handle = yield* servers
            .acquire(language, repoRoot)
            .pipe(Effect.catch(() => Effect.void));
          if (handle !== undefined && handle.capabilities.has(capability)) {
            return handle;
          }
        }
        return undefined;
      });
    }

    // The shared open/project-load/close bracket every intel pull runs inside. Acquires the first
    // Capable server, reads the file, opens the document (closed atomically on any exit), waits out
    // The project load, then runs `use` with a request `send` and the document uri; `empty` is the
    // Result when no capable server answers or the file vanished, before `use` runs. `use` shapes
    // Its own reply (one request or the two-step prepare/resolve), so this stays generic over it.
    function withOpenDocument<T>(
      repoRoot: string,
      path: string,
      capability: Capability,
      empty: T,
      use: (
        send: (
          method: string,
          params: Record<string, unknown>,
        ) => Effect.Effect<unknown, IntelRequestError>,
        uri: string,
      ) => Effect.Effect<T, IntelRequestError>,
    ) {
      return Effect.scoped(
        Effect.gen(function* request() {
          const handle = yield* firstCapableServer(repoRoot, path, capability);
          if (handle === undefined) {
            return empty;
          }
          const absolute = join(repoRoot, path);
          // A file deleted between the caret read and this pull can't be opened; degrade to empty.
          const text = yield* Effect.promise(() =>
            Bun.file(absolute)
              .text()
              .catch(() => undefined),
          );
          if (text === undefined) {
            return empty;
          }
          const uri = pathToFileURL(absolute).href;
          // Open/close as one resource so the close is registered atomically with the open and runs
          // On success, error, or interruption (no leak in the window before a finalizer installs).
          // The connection is shared with the diagnostics pool; `openDocument`/`closeDocument` refcount
          // The uri in the transport, so a concurrent open of the same doc no longer races this bracket.
          yield* Effect.acquireRelease(
            handle.connection.openDocument({
              languageId: lspLanguageId(path),
              text,
              uri,
              version: 1,
            }),
            () => handle.connection.closeDocument(uri),
          );
          // Opening the doc triggers the project load; querying before it finishes makes tsserver
          // Resolve an import to its local binding (the F12-stops-at-import bug), so wait for the
          // Load. The wait is interruptible (the caller aborts on the next keystroke/navigation) and
          // Resolves on connection close; the 60s backstop covers a server that never signals load.
          yield* handle.connection.whenProjectLoaded.pipe(
            Effect.timeout("60 seconds"),
            Effect.ignore,
          );
          // One request with a 5s timeout, mapping transport failures to `IntelRequestError`. Shared
          // Across a pull's single request and a hierarchy's prepare + resolve so they can't drift.
          const send = (method: string, params: Record<string, unknown>) =>
            handle.connection.request(method, params).pipe(
              Effect.timeout("5 seconds"),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(new IntelRequestError({ message: "timed out", method })),
              ),
              Effect.catchTag("LspRequestError", (error) =>
                Effect.fail(new IntelRequestError({ message: error.message, method })),
              ),
            );
          return yield* use(send, uri);
        }),
      );
    }

    // A one-shot pull: open the document, send `method` at the caret (or document-wide when
    // `position` is undefined), and normalize the reply. The location callers relativize inside their
    // Own `normalize`, so this stays generic over the reply shape rather than baking the mapping in.
    function pull<T>(
      repoRoot: string,
      path: string,
      position: Position | undefined,
      capability: Capability,
      method: string,
      extraParams: Record<string, unknown>,
      normalize: (reply: unknown) => T,
      empty: T,
    ) {
      return withOpenDocument(repoRoot, path, capability, empty, (send, uri) =>
        send(method, {
          textDocument: { uri },
          // `documentSymbol` addresses the whole document, so it carries no position; other
          // Pulls resolve at the caret. Omit the key entirely when absent rather than send null.
          ...(position === undefined ? {} : { position }),
          ...extraParams,
        }).pipe(Effect.map(normalize)),
      );
    }

    // The two-step variant for call hierarchy: `prepare` returns an opaque item, a second request
    // Resolves its edges. Both round-trips share the one open document from `withOpenDocument` (so the
    // Prepared item stays valid across the resolve and the doc closes once). The prepare reply's item
    // Rides back to `resolveMethod` verbatim (params are `{ item }`, not `{ textDocument, position }`),
    // Which is why it needs its own request body rather than `pull`'s. No item under the caret (not a
    // Callable symbol) short-circuits to empty before the second round-trip.
    function pullPrepareResolve(
      repoRoot: string,
      path: string,
      position: Position,
      capability: Capability,
      prepareMethod: string,
      resolveMethod: string,
      normalize: (reply: unknown) => NormalizedLocation[],
    ) {
      return withOpenDocument(repoRoot, path, capability, [] as NormalizedLocation[], (send, uri) =>
        Effect.gen(function* resolve() {
          const item = firstHierarchyItem(
            yield* send(prepareMethod, { position, textDocument: { uri } }),
          );
          return item === undefined ? [] : normalize(yield* send(resolveMethod, { item }));
        }),
      );
    }

    // A location reply's paths are absolute; relativize each to a repo path (a target outside the
    // Repo, e.g. node_modules, stays absolute so the caller can detect and skip it). Both sides are
    // Canonicalized so a symlinked root (macOS /var ↔ /private/var) still matches an in-repo target
    // The server resolved to its realpath. Hover carries no paths, so it skips this entirely.
    function relativizeLocations(
      repoRoot: string,
      normalize: (reply: unknown) => NormalizedLocation[],
    ) {
      const canonicalRoot = realpathOr(repoRoot);
      return (reply: unknown) =>
        normalize(reply).map((location) => ({
          column: location.column,
          line: location.line,
          path: relativize(realpathOr(location.path), canonicalRoot),
        }));
    }

    return {
      callHierarchy: (repoRoot, path, position, direction) =>
        pullPrepareResolve(
          repoRoot,
          path,
          position,
          "callHierarchy",
          "textDocument/prepareCallHierarchy",
          direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
          relativizeLocations(
            repoRoot,
            direction === "incoming" ? normalizeIncomingCalls : normalizeOutgoingCalls,
          ),
        ),
      definition: (repoRoot, path, position) =>
        pull(
          repoRoot,
          path,
          position,
          "definition",
          "textDocument/definition",
          {},
          relativizeLocations(repoRoot, normalizeDefinition),
          [],
        ),
      hover: (repoRoot, path, position) =>
        pull(repoRoot, path, position, "hover", "textDocument/hover", {}, parseHover, []),
      implementation: (repoRoot, path, position) =>
        pull(
          repoRoot,
          path,
          position,
          "implementation",
          "textDocument/implementation",
          {},
          relativizeLocations(repoRoot, normalizeDefinition),
          [],
        ),
      references: (repoRoot, path, position) =>
        pull(
          repoRoot,
          path,
          position,
          "references",
          "textDocument/references",
          { context: { includeDeclaration: true } },
          relativizeLocations(repoRoot, normalizeReferences),
          [],
        ),
      symbols: (repoRoot, path) =>
        pull(
          repoRoot,
          path,
          undefined,
          "documentSymbol",
          "textDocument/documentSymbol",
          {},
          normalizeDocumentSymbols,
          [],
        ),
    };
  }),
);
