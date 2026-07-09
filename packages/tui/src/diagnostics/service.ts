/**
 * Collects language-server diagnostics and projects them onto the keyed `CheckerState` the UI
 * already renders. Changed files are grouped by language; each language's server is held by a
 * **document keeper** that persists across runs: the changed set stays open on the warm connection,
 * a run sends `didChange` only for files whose on-disk text moved (full-text sync), releases files
 * that left the set, and reopens everything on a fresh server if the pooled one died. Retrieval is
 * hybrid: a server advertising `diagnosticProvider` is pulled (one `textDocument/diagnostic` per
 * tracked file, push bucket unioned in), every other server keeps the push path, waiting only on
 * freshly-sent or still-unpublished documents. Every failure degrades a file to
 * `failed`/`unavailable` rather than erroring the stream, so a server hiccup never blanks the
 * panel. A file the server has not answered for stays `pending`, never falsely `clean` (the SPEC
 * invariant).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context, Effect, Exit, Layer, Scope, Semaphore, Stream } from "effect";

import type { ChangedFile } from "@/git/model";

import { stateForResolvedChecker } from "./checker";
import type { CheckerFileState, CheckerName, Diagnostic } from "./checker";
import { isLspDiagnostic, mapLspDiagnostic } from "./protocol";
import { activeLanguages, LanguageServers, lspLanguageId, serversForPath } from "./servers";
import type { ServerHandle } from "./servers";
import type { LspConnection } from "./transport";

export interface CheckerUpdate {
  checker: CheckerName;
  state: Map<string, CheckerFileState>;
}

export class Diagnostics extends Context.Service<
  Diagnostics,
  {
    readonly run: (
      repoRoot: string,
      files: ChangedFile[],
      prior?: ReadonlyMap<string, CheckerFileState>,
    ) => Stream.Stream<CheckerUpdate>;
  }
>()("stet/Diagnostics") {}

function mapItems(items: unknown[], uri: string): Diagnostic[] {
  return items
    .filter(isLspDiagnostic)
    .map((item) => Object.assign(mapLspDiagnostic(item, uri), { checker: "diagnostics" as const }));
}

const SETTLE_INTERVAL = "50 millis";
// ~10s cap: long enough for a cold tsserver to finish loading and publish, but short-circuited the
// Moment the server dies. A file still unpublished at the cap stays pending, not falsely clean.
const SETTLE_ATTEMPTS = 200;
// Some servers publish an empty array on didOpen, then the real diagnostics once analysis finishes;
// A short grace after first-publish lets that refining publish land before the snapshot.
const SETTLE_GRACE = "250 millis";

/**
 * Waits until every opened document has been published at least once, the server dies, or the cap
 * elapses. Servers push `publishDiagnostics` asynchronously after `didOpen`; an empty array still
 * counts as published, so a clean file settles too.
 */
function settle(connection: LspConnection, uris: string[], attempt = 0): Effect.Effect<void> {
  if (uris.length === 0) {
    return Effect.void;
  }
  return Effect.all([connection.published, connection.closed]).pipe(
    Effect.flatMap(([map, isClosed]) =>
      isClosed || attempt >= SETTLE_ATTEMPTS || uris.every((uri) => map.has(uri))
        ? Effect.void
        : Effect.sleep(SETTLE_INTERVAL).pipe(Effect.andThen(settle(connection, uris, attempt + 1))),
    ),
  );
}

// One pull request's ceiling: past it the file stays pending and the next run retries, so a cold
// Server that needs longer to index (rust-analyzer on a big crate) converges without wedging a run.
const PULL_TIMEOUT = "10 seconds";
const PULL_CONCURRENCY = 8;

interface Collected {
  diagnostics: Diagnostic[];
  /** Files the server answered for (clean or findings). */
  resolved: ChangedFile[];
  /** Files still awaiting an answer (cold start, slow server) — render as pending. */
  pending: ChangedFile[];
  /** Files whose pull the server rejected outright; render as failed with its message. */
  failed: { file: ChangedFile; message: string }[];
}

/**
 * The pull path: one `textDocument/diagnostic` round trip per opened file, no settle heuristics.
 * The push bucket is still read and unioned per uri, because a hybrid server (rust-analyzer)
 * answers pulls with its native findings while pushing its cargo-check ones. A timeout leaves the
 * file pending (the next run retries); a server error marks it failed, never falsely clean.
 */
function pullDiagnostics(handle: ServerHandle, opened: { file: ChangedFile; uri: string }[]) {
  return Effect.gen(function* pull() {
    const outcomes = yield* Effect.forEach(
      opened,
      ({ file, uri }) =>
        handle.connection.pullDiagnostics(uri).pipe(
          Effect.timeout(PULL_TIMEOUT),
          Effect.map((answer) => ({ answer, file, kind: "resolved" as const, uri })),
          Effect.catchTag("TimeoutError", () => Effect.succeed({ file, kind: "pending" as const })),
          Effect.catchTag("LspRequestError", (error) =>
            Effect.succeed({ file, kind: "failed" as const, message: error.message }),
          ),
        ),
      { concurrency: PULL_CONCURRENCY },
    );
    const map = yield* handle.connection.published;

    const collected: Collected = { diagnostics: [], failed: [], pending: [], resolved: [] };
    for (const outcome of outcomes) {
      if (outcome.kind === "pending") {
        collected.pending.push(outcome.file);
        continue;
      }
      if (outcome.kind === "failed") {
        collected.failed.push({ file: outcome.file, message: outcome.message });
        continue;
      }
      collected.resolved.push(outcome.file);
      const pushed = map.get(outcome.uri) ?? [];
      collected.diagnostics.push(...mapItems([...outcome.answer.items, ...pushed], outcome.uri));
      for (const [relatedUri, relatedItems] of outcome.answer.related) {
        collected.diagnostics.push(...mapItems(relatedItems, relatedUri));
      }
    }
    return collected;
  });
}

/**
 * One language server's persistent view of a repo's changed set. The scope holds the pooled server
 * reference across runs (so it stays warm while the repo is active), and `sent` records the hash of
 * each document's last-sent text, which is what decides open vs change vs nothing per run.
 */
interface Keeper {
  readonly handle: ServerHandle;
  readonly language: string;
  readonly repoRoot: string;
  readonly scope: Scope.Closeable;
  readonly sent: Map<string, ReturnType<typeof Bun.hash>>;
}

/**
 * Reconcile the keeper's open-document set with this run's files: a new file opens, a file whose
 * on-disk text moved gets a full-text `didChange`, an untouched file is merely held, and a file
 * that left the set (or vanished from disk) closes. Each send and its `sent` record commit as one
 * uninterruptible step, so an aborted run can never strand a document the bookkeeping disagrees
 * about; docs deliberately stay open after the run, that is the keeper's point.
 */
function syncDocuments(keeper: Keeper, repoRoot: string, files: ChangedFile[]) {
  return Effect.gen(function* sync() {
    const { connection } = keeper.handle;
    const dirty: { file: ChangedFile; uri: string }[] = [];
    const held: { file: ChangedFile; uri: string }[] = [];
    const pending: ChangedFile[] = [];
    const current = new Set<string>();
    for (const file of files) {
      const absolute = join(repoRoot, file.path);
      // A file deleted between model load and this run can't be read; the leave-sweep below closes
      // It if it was open, and it renders pending until the next run resolves what happened.
      const text = yield* Effect.promise(() =>
        Bun.file(absolute)
          .text()
          .catch(() => undefined),
      );
      if (text === undefined) {
        pending.push(file);
        continue;
      }
      const uri = pathToFileURL(absolute).href;
      current.add(uri);
      const hash = Bun.hash(text);
      if (keeper.sent.get(uri) === hash) {
        held.push({ file, uri });
        continue;
      }
      const send = keeper.sent.has(uri)
        ? connection.changeDocument(uri, text)
        : connection.openDocument({ languageId: lspLanguageId(file.path), text, uri, version: 1 });
      yield* Effect.uninterruptible(
        connection
          .clearPublished([uri])
          .pipe(
            Effect.andThen(send),
            Effect.andThen(Effect.sync(() => keeper.sent.set(uri, hash))),
          ),
      );
      dirty.push({ file, uri });
    }
    for (const uri of keeper.sent.keys()) {
      if (!current.has(uri)) {
        yield* Effect.uninterruptible(
          connection
            .closeDocument(uri)
            .pipe(Effect.andThen(Effect.sync(() => keeper.sent.delete(uri)))),
        );
      }
    }
    return { dirty, held, pending };
  });
}

function collectDiagnostics(keeper: Keeper, repoRoot: string, files: ChangedFile[]) {
  return Effect.gen(function* collect() {
    const { dirty, held, pending } = yield* syncDocuments(keeper, repoRoot, files);
    const { handle } = keeper;
    const tracked = [...dirty, ...held];

    // A server that advertises pull answers request/response, no settle heuristics. Every tracked
    // File is pulled, not just dirty ones: an untouched file answers `unchanged` cheaply, and an
    // Edit elsewhere in the open set can change its result even when its own text didn't move.
    if (handle.capabilities.has("pullDiagnostics")) {
      const collected = yield* pullDiagnostics(handle, tracked);
      return { ...collected, pending: [...pending, ...collected.pending] } satisfies Collected;
    }

    // Push path: wait on freshly-sent documents, plus any held one still unpublished (a server may
    // Publish late, after an earlier run's cap; the open doc lets that publish land and count).
    const alreadyPublished = yield* handle.connection.published;
    const waitUris = [
      ...dirty.map((entry) => entry.uri),
      ...held.filter((entry) => !alreadyPublished.has(entry.uri)).map((entry) => entry.uri),
    ];
    yield* settle(handle.connection, waitUris);
    if (waitUris.length > 0) {
      yield* Effect.sleep(SETTLE_GRACE);
    }
    const map = yield* handle.connection.published;

    const diagnostics: Diagnostic[] = [];
    const resolved: ChangedFile[] = [];
    for (const { file, uri } of tracked) {
      const items = map.get(uri);
      if (items === undefined) {
        pending.push(file);
      } else {
        resolved.push(file);
        diagnostics.push(...mapItems(items, uri));
      }
    }

    return { diagnostics, failed: [], pending, resolved } satisfies Collected;
  });
}

type LanguageOutcome =
  | { kind: "diagnostics"; collected: Collected }
  | { kind: "degraded"; status: "failed" | "unavailable"; message: string }
  | { kind: "installing"; message: string };

const statusRank: Record<CheckerFileState["status"], number> = {
  clean: 2,
  failed: 1,
  findings: 4,
  pending: 3,
  unavailable: 0,
};

/**
 * Merge one file's state across the servers that handle it (typescript and oxlint overlap): union
 * the diagnostics, and let the strongest signal win (findings > pending > clean > failed >
 * unavailable). A degraded server thus never overrides another's real result, so a tsc-clean file
 * with oxlint absent stays clean rather than flipping to unavailable.
 */
function mergeFileState(a: CheckerFileState, b: CheckerFileState): CheckerFileState {
  const diagnostics = [...a.diagnostics, ...b.diagnostics];
  const winner = statusRank[b.status] > statusRank[a.status] ? b : a;
  return {
    count: diagnostics.length,
    diagnostics,
    status: winner.status,
    ...(winner.message === undefined ? {} : { message: winner.message }),
  };
}

function mergeStates(maps: Map<string, CheckerFileState>[]): Map<string, CheckerFileState> {
  const merged = new Map<string, CheckerFileState>();
  for (const map of maps) {
    for (const [path, fileState] of map) {
      const existing = merged.get(path);
      merged.set(path, existing === undefined ? fileState : mergeFileState(existing, fileState));
    }
  }
  return merged;
}

export const DiagnosticsLive = Layer.effect(
  Diagnostics,
  Effect.gen(function* diagnosticsLive() {
    const servers = yield* LanguageServers;
    // Keeper scopes fork from the layer scope, so app teardown closes every held server and its
    // Open documents even if no run ever released them.
    const layerScope = yield* Effect.scope;
    const keepers = new Map<string, Keeper>();

    const closeKeeper = (key: string, keeper: Keeper) =>
      Scope.close(keeper.scope, Exit.void).pipe(
        Effect.andThen(Effect.sync(() => keepers.delete(key))),
      );

    // Per-key locks serializing keeper acquisition: a run superseding a still-interrupting one
    // Could otherwise pass the `keepers.get` check concurrently and create two keepers for one
    // Key, the overwritten one leaking its pool reference and document refcounts forever.
    const keeperLocks = new Map<string, Semaphore.Semaphore>();
    const keeperLock = (key: string) => {
      const existing = keeperLocks.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = Semaphore.makeUnsafe(1);
      keeperLocks.set(key, created);
      return created;
    };

    // One keeper per (server, repo): reused warm across runs, rebuilt (documents reopened fresh by
    // The next sync, since `sent` starts empty) when the pooled server died in between.
    const acquireKeeper = (language: string, repoRoot: string) => {
      const key = `${language} ${repoRoot}`;
      return Effect.gen(function* acquire() {
        const existing = keepers.get(key);
        if (existing !== undefined) {
          const isClosed = yield* existing.handle.connection.closed;
          if (!isClosed) {
            return existing;
          }
          yield* closeKeeper(key, existing);
        }
        const scope = yield* Scope.fork(layerScope);
        const handle = yield* servers.acquire(language, repoRoot).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const sent: Keeper["sent"] = new Map();
        // Release the documents when the keeper goes (worktree switch, app exit): the pooled
        // Server can outlive the keeper and be re-held later, and a stranded refcount would
        // Suppress that next didOpen, leaving cleared push state permanently unfilled. A dead
        // Server needs no goodbyes; its documents died with it.
        yield* Scope.addFinalizer(
          scope,
          Effect.suspend(() =>
            handle.connection.closed.pipe(
              Effect.flatMap((isClosed) =>
                isClosed
                  ? Effect.void
                  : Effect.forEach(
                      [...sent.keys()],
                      (uri) => handle.connection.closeDocument(uri),
                      {
                        discard: true,
                      },
                    ),
              ),
            ),
          ),
        );
        const created: Keeper = { handle, language, repoRoot, scope, sent };
        keepers.set(key, created);
        return created;
      }).pipe(Semaphore.withPermit(keeperLock(key)));
    };

    // Every run reconciles the resident keepers: one for a different repo (a worktree switch) or
    // For a language whose changed set dropped to zero is released, so its documents close and its
    // Server idles out of the pool instead of holding files no run tracks anymore.
    const releaseStaleKeepers = (repoRoot: string, active: ReadonlySet<string>) =>
      Effect.suspend(() =>
        Effect.forEach(
          [...keepers.entries()].filter(
            ([, keeper]) => keeper.repoRoot !== repoRoot || !active.has(keeper.language),
          ),
          ([key, keeper]) => closeKeeper(key, keeper),
          { discard: true },
        ),
      );

    function runLanguage(repoRoot: string, language: string, files: ChangedFile[]) {
      return acquireKeeper(language, repoRoot).pipe(
        Effect.flatMap(
          (keeper): Effect.Effect<LanguageOutcome> =>
            collectDiagnostics(keeper, repoRoot, files).pipe(
              Effect.map((collected) => ({ collected, kind: "diagnostics" })),
            ),
        ),
        Effect.catchTag("ServerUnavailable", (error) =>
          Effect.succeed<LanguageOutcome>({
            kind: "degraded",
            message: error.message,
            status: "unavailable",
          }),
        ),
        Effect.catchTag("ServerInstalling", (error) =>
          Effect.succeed<LanguageOutcome>({
            kind: "installing",
            message: `installing ${error.language} server…`,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed<LanguageOutcome>({
            kind: "degraded",
            message: error.message,
            status: "failed",
          }),
        ),
      );
    }

    // One server's view of its files as a keyed state map: findings/clean from a resolved run,
    // Pending for cold/installing files, failed/unavailable when the server degraded.
    function stateForLanguage(repoRoot: string, language: string, langFiles: ChangedFile[]) {
      return runLanguage(repoRoot, language, langFiles).pipe(
        Effect.map((outcome) => {
          if (outcome.kind === "diagnostics") {
            const { diagnostics, failed, pending, resolved } = outcome.collected;
            const map = stateForResolvedChecker("diagnostics", resolved, diagnostics, repoRoot);
            // A pending/failed file may already carry findings from another file's related
            // Report; those are real results, so they win (findings outrank both, per statusRank).
            for (const file of pending) {
              if (map.get(file.path)?.status !== "findings") {
                map.set(file.path, { count: 0, diagnostics: [], status: "pending" });
              }
            }
            for (const { file, message } of failed) {
              if (map.get(file.path)?.status !== "findings") {
                map.set(file.path, { count: 0, diagnostics: [], message, status: "failed" });
              }
            }
            return map;
          }
          const status = outcome.kind === "installing" ? "pending" : outcome.status;
          const map = new Map<string, CheckerFileState>();
          for (const file of langFiles) {
            map.set(file.path, { count: 0, diagnostics: [], message: outcome.message, status });
          }
          return map;
        }),
      );
    }

    // Files no active server handles stay unavailable; nothing else reports them, so they survive the
    // Merge. A repo-gated server (Biome off in a non-Biome repo) doesn't count as a handler here.
    function noServerState(serversFor: (path: string) => string[], changed: ChangedFile[]) {
      const map = new Map<string, CheckerFileState>();
      for (const file of changed) {
        if (serversFor(file.path).length === 0) {
          map.set(file.path, {
            count: 0,
            diagnostics: [],
            message: "no language server for this file type",
            status: "unavailable",
          });
        }
      }
      return map;
    }

    // A coherent snapshot from the servers finished so far. Per changed file: a fast server's
    // Findings show immediately; once every applicable server has reported the result is definitive
    // (clean, or the pending a server that never published leaves); until then the file holds its
    // Prior badge (or pending on a cold start) rather than flickering to pending each re-run.
    function snapshot(
      serversFor: (path: string) => string[],
      changed: ChangedFile[],
      done: Set<string>,
      maps: Map<string, CheckerFileState>[],
      noServer: Map<string, CheckerFileState>,
      prior: ReadonlyMap<string, CheckerFileState> | undefined,
    ) {
      const merged = mergeStates(maps);
      const state = new Map<string, CheckerFileState>(noServer);
      for (const file of changed) {
        const languages = serversFor(file.path);
        if (languages.length === 0) {
          continue;
        }
        const fileState = merged.get(file.path);
        if (fileState?.status === "findings") {
          state.set(file.path, fileState);
        } else if (languages.every((language) => done.has(language))) {
          state.set(file.path, fileState ?? { count: 0, diagnostics: [], status: "clean" });
        } else {
          state.set(
            file.path,
            prior?.get(file.path) ?? { count: 0, diagnostics: [], status: "pending" },
          );
        }
      }
      // Cross-file findings: a server reports errors in files outside the changed set (SPEC retains
      // Findings for every reported path), so carry those through too.
      for (const [path, fileState] of merged) {
        if (!state.has(path) && fileState.status === "findings") {
          state.set(path, fileState);
        }
      }
      return state;
    }

    // A file resolves to every server that handles its extension (typescript and oxlint both claim
    // The JS/TS family), so it runs through each concurrently and emits a fresh merged snapshot as
    // Each server finishes, rather than waiting for the slowest before showing anything.
    function run(
      repoRoot: string,
      files: ChangedFile[],
      prior?: ReadonlyMap<string, CheckerFileState>,
    ) {
      const changed = files.filter((file) => file.kind !== "deleted");
      // Evaluate each server's repo gate once for this run, then reuse it per file (and per snapshot
      // Emission below) so a filesystem-stat gate like Biome's isn't re-checked for every file.
      const active = activeLanguages(repoRoot);
      const serversFor = (path: string) =>
        serversForPath(path).filter((language) => active.has(language));
      const noServer = noServerState(serversFor, changed);
      const languages = [...new Set(changed.flatMap((file) => serversFor(file.path)))];
      if (languages.length === 0) {
        return Stream.fromEffect(
          releaseStaleKeepers(repoRoot, new Set()).pipe(
            Effect.as({ checker: "diagnostics", state: noServer } satisfies CheckerUpdate),
          ),
        );
      }

      const perLanguage = languages.map((language) =>
        Stream.fromEffect(
          // The keeper owns the server's lifetime across runs; no per-run scope to close.
          stateForLanguage(
            repoRoot,
            language,
            changed.filter((file) => serversFor(file.path).includes(language)),
          ).pipe(Effect.map((map) => ({ language, map }))),
        ),
      );

      const merged = Stream.mergeAll(perLanguage, { concurrency: "unbounded" }).pipe(
        Stream.scan(
          { done: new Set<string>(), maps: [] as Map<string, CheckerFileState>[] },
          (accumulator, next) => ({
            done: new Set(accumulator.done).add(next.language),
            maps: [...accumulator.maps, next.map],
          }),
        ),
        // Drop the empty seed scan emits before the first server finishes.
        Stream.drop(1),
        Stream.map(
          (accumulator) =>
            ({
              checker: "diagnostics",
              state: snapshot(
                serversFor,
                changed,
                accumulator.done,
                accumulator.maps,
                noServer,
                prior,
              ),
            }) satisfies CheckerUpdate,
        ),
      );

      // The repo sweep runs once, before any keeper for this run is acquired.
      return Stream.fromEffect(releaseStaleKeepers(repoRoot, new Set(languages))).pipe(
        Stream.flatMap(() => merged),
      );
    }

    return { run };
  }),
);
