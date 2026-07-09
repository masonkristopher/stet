import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Layer, Stream } from "effect";

import type { CheckerFileState } from "@/diagnostics/checker";
import { LanguageServers, ServerInstalling, ServerUnavailable } from "@/diagnostics/servers";
import type { Capability, ServerHandle } from "@/diagnostics/servers";
import { Diagnostics, DiagnosticsLive } from "@/diagnostics/service";
import { LspRequestError } from "@/diagnostics/transport";
import type { LspConnection } from "@/diagnostics/transport";
import type { ChangedFile } from "@/git/model";

function changed(path: string): ChangedFile {
  return {
    additions: 1,
    binary: false,
    deletions: 0,
    kind: "modified",
    mtimeMs: 0,
    path,
    stage: "unstaged",
    warnings: [],
  };
}

// A push server: it publishes the given items for a document as soon as the client opens it, exactly
// As typescript-language-server does. A real LspConnection, not a mock of stet's own code.
function pushingHandle(items: unknown[]): ServerHandle {
  const published = new Map<string, unknown[]>();
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: (uris) =>
      Effect.sync(() => {
        for (const uri of uris) {
          published.delete(uri);
        }
      }),
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: (textDocument) => Effect.sync(() => void published.set(textDocument.uri, items)),
    published: Effect.sync(() => published),
    pullDiagnostics: () =>
      Effect.fail(
        new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
      ),
    request: () => Effect.succeed(null),
    whenProjectLoaded: Effect.void,
  };
  return { capabilities: new Set(), connection };
}

// A server whose stdout has closed (it died): it never publishes and reports closed, so the settle
// Loop short-circuits instead of waiting out the cap.
function deadHandle(): ServerHandle {
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => true),
    notify: () => Effect.void,
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    pullDiagnostics: () =>
      Effect.fail(
        new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
      ),
    request: () => Effect.succeed(null),
    whenProjectLoaded: Effect.void,
  };
  return { capabilities: new Set(), connection };
}

function collectUpdates(
  repoRoot: string,
  files: ChangedFile[],
  servers: Layer.Layer<LanguageServers>,
  prior?: ReadonlyMap<string, CheckerFileState>,
) {
  return Effect.runPromise(
    Diagnostics.pipe(
      Effect.flatMap((diagnostics) => Stream.runCollect(diagnostics.run(repoRoot, files, prior))),
      Effect.map((updates) => [...updates]),
      Effect.provide(DiagnosticsLive.pipe(Layer.provide(servers))),
    ),
  );
}

// The run streams a snapshot per server as it finishes; the last one is the fully-merged state.
async function runDiagnostics(
  repoRoot: string,
  files: ChangedFile[],
  servers: Layer.Layer<LanguageServers>,
) {
  const updates = await collectUpdates(repoRoot, files, servers);
  return updates.at(-1)?.state ?? new Map<string, CheckerFileState>();
}

// Language-aware fake: each server publishes for the files of its own language, and a language with
// No handle degrades to unavailable, exactly as a missing server would. Lets one test exercise the
// Typescript + oxlint merge a real `.ts` file now triggers.
function fakeServers(byLanguage: Record<string, ServerHandle>) {
  return Layer.succeed(LanguageServers)({
    acquire: (language) => {
      const handle = byLanguage[language];
      return handle === undefined
        ? Effect.fail(new ServerUnavailable({ language, message: "not found" }))
        : Effect.succeed(handle);
    },
  });
}

function withRepo(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "diag-lsp-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return run(dir).finally(() => rmSync(dir, { force: true, recursive: true }));
}

const anError = {
  message: "Type error",
  range: { end: { character: 7, line: 0 }, start: { character: 6, line: 0 } },
  severity: 1,
  source: "ts",
};

const aLintWarning = {
  message: "`debugger` statement is not allowed",
  range: { end: { character: 1, line: 1 }, start: { character: 0, line: 1 } },
  severity: 2,
  source: "oxc",
};

test("an interrupted run leaves the document open and the next run reconciles it", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    const opens: string[] = [];
    const changes: string[] = [];
    const closes: string[] = [];
    // Publishes only on didChange, never on didOpen: run 1's settle keeps looping until we
    // Interrupt it, while run 2 (after an edit) completes from the change-triggered publish.
    const published = new Map<string, unknown[]>();
    const connection: LspConnection = {
      changeDocument: (uri) =>
        Effect.sync(() => {
          changes.push(uri);
          published.set(uri, [anError]);
        }),
      clearPublished: (uris) =>
        Effect.sync(() => {
          for (const uri of uris) {
            published.delete(uri);
          }
        }),
      closeDocument: (uri) => Effect.sync(() => void closes.push(uri)),
      closed: Effect.sync(() => false),
      notify: () => Effect.void,
      openDocument: (textDocument) => Effect.sync(() => void opens.push(textDocument.uri)),
      published: Effect.sync(() => published),
      pullDiagnostics: () =>
        Effect.fail(
          new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
        ),
      request: () => Effect.succeed(null),
      whenProjectLoaded: Effect.void,
    };
    const handle: ServerHandle = { capabilities: new Set(), connection };

    const state = await Effect.runPromise(
      Diagnostics.pipe(
        Effect.flatMap((diagnostics) =>
          Stream.runDrain(diagnostics.run(dir, [changed("src/a.ts")])).pipe(
            // Run 1's settle loop runs ~10s; interrupt long before, with the document open.
            Effect.timeout("100 millis"),
            Effect.catchTag("TimeoutError", () => Effect.void),
            Effect.andThen(
              Effect.sync(() => writeFileSync(join(dir, "src/a.ts"), "const a = 2\n")),
            ),
            Effect.andThen(
              Stream.runCollect(diagnostics.run(dir, [changed("src/a.ts")])).pipe(
                Effect.map((updates) => ({
                  closesBeforeTeardown: [...closes],
                  state: [...updates].at(-1)?.state,
                })),
              ),
            ),
          ),
        ),
        Effect.provide(DiagnosticsLive.pipe(Layer.provide(fakeServers({ typescript: handle })))),
      ),
    );

    const uri = pathToFileURL(join(dir, "src/a.ts")).href;
    // The document survives the interrupt (that is the keeper's point), the keeper's bookkeeping
    // Stays accurate (run 2 sends didChange, never a second didOpen), and run 2 resolves.
    expect(opens).toEqual([uri]);
    expect(state.closesBeforeTeardown).toEqual([]);
    expect(changes).toEqual([uri]);
    expect(state.state?.get("src/a.ts")).toMatchObject({ count: 1, status: "findings" });
  });
});

test("maps a pushed diagnostic onto the changed file as findings", async () => {
  await withRepo({ "src/a.ts": "const a: string = 1\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("src/a.ts")],
      fakeServers({ typescript: pushingHandle([anError]) }),
    );
    const fileState = state.get("src/a.ts");
    expect(fileState?.status).toBe("findings");
    expect(fileState?.diagnostics[0]).toMatchObject({
      line: 1,
      message: "Type error",
      severity: "error",
      source: "ts",
    });
  });
});

test("merges findings from every server that handles the file", async () => {
  await withRepo({ "src/a.ts": "const a: string = 1\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("src/a.ts")],
      fakeServers({
        oxlint: pushingHandle([aLintWarning]),
        typescript: pushingHandle([anError]),
      }),
    );
    const fileState = state.get("src/a.ts");
    expect(fileState?.status).toBe("findings");
    expect(fileState?.diagnostics).toHaveLength(2);
    expect(fileState?.diagnostics.map((diagnostic) => diagnostic.source).toSorted()).toEqual([
      "oxc",
      "ts",
    ]);
  });
});

test("streams a snapshot per server as each finishes, not one combined update", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    const updates = await collectUpdates(
      dir,
      [changed("src/a.ts")],
      fakeServers({
        oxlint: pushingHandle([aLintWarning]),
        typescript: pushingHandle([]),
      }),
    );
    // Two servers handle the file, so it surfaces two progressive snapshots rather than one.
    expect(updates).toHaveLength(2);
    // Every emission is a complete snapshot covering the file, and the last is fully merged.
    expect(updates[0]?.state.get("src/a.ts")).toBeDefined();
    expect(updates.at(-1)?.state.get("src/a.ts")?.status).toBe("findings");
  });
});

test("holds a file's prior badge while a slower server is still running", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    // Delay typescript so oxlint deterministically finishes first, leaving an emission mid-run.
    const servers = Layer.succeed(LanguageServers)({
      acquire: (language) => {
        const handle = pushingHandle([]); // Both servers report clean
        return language === "typescript"
          ? Effect.succeed(handle).pipe(Effect.delay("30 millis"))
          : Effect.succeed(handle);
      },
    });
    const prior = new Map<string, CheckerFileState>([
      ["src/a.ts", { count: 1, diagnostics: [], status: "findings" }],
    ]);
    const updates = await collectUpdates(dir, [changed("src/a.ts")], servers, prior);
    // First emission (oxlint done, typescript still running): the file holds its prior badge, not pending.
    expect(updates[0]?.state.get("src/a.ts")?.status).toBe("findings");
    // Final emission (both done, both clean): the held badge resolves to clean.
    expect(updates.at(-1)?.state.get("src/a.ts")?.status).toBe("clean");
  });
});

test("reports a file the server publishes no items for as clean", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("src/a.ts")],
      fakeServers({ oxlint: pushingHandle([]), typescript: pushingHandle([]) }),
    );
    expect(state.get("src/a.ts")?.status).toBe("clean");
  });
});

test("stays clean when one server resolves clean and another is unavailable", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    // Only typescript is present; oxlint degrades to unavailable but must not override the clean result.
    const state = await runDiagnostics(
      dir,
      [changed("src/a.ts")],
      fakeServers({ typescript: pushingHandle([]) }),
    );
    expect(state.get("src/a.ts")?.status).toBe("clean");
  });
});

const aBiomeFinding = {
  message: "Unexpected empty block.",
  range: { end: { character: 1, line: 0 }, start: { character: 0, line: 0 } },
  severity: 1,
  source: "biome",
};

test("runs biome only when the repo has a biome config", async () => {
  // A css file is biome-only; with a biome.json the repo opts in, so biome reports its findings.
  await withRepo({ "biome.json": "{}", "src/a.css": "a{}\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("src/a.css")],
      fakeServers({ biome: pushingHandle([aBiomeFinding]) }),
    );
    const fileState = state.get("src/a.css");
    expect(fileState?.status).toBe("findings");
    expect(fileState?.diagnostics[0]).toMatchObject({
      message: "Unexpected empty block.",
      source: "biome",
    });
  });
});

test("leaves a biome-only file unavailable in a repo without a biome config", async () => {
  // No biome.json: biome gates off, so a css file has no active server and never falsely resolves clean.
  await withRepo({ "src/a.css": "a{}\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("src/a.css")],
      fakeServers({ biome: pushingHandle([aBiomeFinding]) }),
    );
    expect(state.get("src/a.css")?.status).toBe("unavailable");
  });
});

test("marks a file with no language server as unavailable, never clean", async () => {
  await withRepo({ "docs/readme.md": "# hi\n" }, async (dir) => {
    const state = await runDiagnostics(dir, [changed("docs/readme.md")], fakeServers({}));
    expect(state.get("docs/readme.md")?.status).toBe("unavailable");
  });
});

test("leaves a file the server has not published for as pending, never clean", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("src/a.ts")],
      fakeServers({ oxlint: deadHandle(), typescript: deadHandle() }),
    );
    expect(state.get("src/a.ts")?.status).toBe("pending");
  });
});

test("leaves files pending with a message while the server is downloading", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    const installing = Layer.succeed(LanguageServers)({
      acquire: () => Effect.fail(new ServerInstalling({ language: "typescript" })),
    });
    const state = await runDiagnostics(dir, [changed("src/a.ts")], installing);
    const fileState = state.get("src/a.ts");
    expect(fileState?.status).toBe("pending");
    expect(fileState?.message).toContain("installing");
  });
});

test("degrades to unavailable when the server cannot be acquired", async () => {
  await withRepo({ "src/a.ts": "const a = 1\n" }, async (dir) => {
    const failing = Layer.succeed(LanguageServers)({
      acquire: () =>
        Effect.fail(
          new ServerUnavailable({
            language: "typescript",
            message: "not found",
          }),
        ),
    });
    const state = await runDiagnostics(dir, [changed("src/a.ts")], failing);
    expect(state.get("src/a.ts")?.status).toBe("unavailable");
  });
});

// A pull server: it answers `textDocument/diagnostic` per uri instead of publishing on open, and
// Optionally pushes items too (the hybrid rust-analyzer shape). A real LspConnection, not a mock.
function pullingHandle(options: {
  itemsByUri?: Record<string, unknown[]>;
  related?: ReadonlyMap<string, unknown[]>;
  pushed?: unknown[];
  rejects?: string;
}): ServerHandle {
  const published = new Map<string, unknown[]>();
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: (uris) =>
      Effect.sync(() => {
        for (const uri of uris) {
          published.delete(uri);
        }
      }),
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: (textDocument) =>
      Effect.sync(() => {
        if (options.pushed !== undefined) {
          published.set(textDocument.uri, options.pushed);
        }
      }),
    published: Effect.sync(() => published),
    pullDiagnostics: (uri) =>
      options.rejects === undefined
        ? Effect.succeed({
            items: options.itemsByUri?.[uri] ?? [],
            related: options.related ?? new Map<string, unknown[]>(),
          })
        : Effect.fail(
            new LspRequestError({ message: options.rejects, method: "textDocument/diagnostic" }),
          ),
    request: () => Effect.succeed(null),
    whenProjectLoaded: Effect.void,
  };
  return { capabilities: new Set<Capability>(["pullDiagnostics"]), connection };
}

test("a pull-capable server resolves findings from the pull answer, no publish needed", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const uri = pathToFileURL(join(dir, "config.yaml")).href;
    const state = await runDiagnostics(
      dir,
      [changed("config.yaml")],
      fakeServers({ yaml: pullingHandle({ itemsByUri: { [uri]: [anError] } }) }),
    );
    expect(state.get("config.yaml")).toMatchObject({ count: 1, status: "findings" });
  });
});

test("a pull answer and a concurrent push merge for a hybrid server", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const uri = pathToFileURL(join(dir, "config.yaml")).href;
    const state = await runDiagnostics(
      dir,
      [changed("config.yaml")],
      fakeServers({
        yaml: pullingHandle({ itemsByUri: { [uri]: [anError] }, pushed: [aLintWarning] }),
      }),
    );
    // The pulled native finding and the pushed one both surface, one channel never masking the other.
    expect(state.get("config.yaml")).toMatchObject({ count: 2, status: "findings" });
  });
});

test("a rejected pull marks the file failed with the server's message, never clean", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const state = await runDiagnostics(
      dir,
      [changed("config.yaml")],
      fakeServers({ yaml: pullingHandle({ rejects: "boom" }) }),
    );
    expect(state.get("config.yaml")).toMatchObject({ message: "boom", status: "failed" });
  });
});

test("a pull answer's related documents surface findings for their own paths", async () => {
  await withRepo({ "config.yaml": "a: 1\n", "other.yaml": "b: 2\n" }, async (dir) => {
    const relatedUri = pathToFileURL(join(dir, "other.yaml")).href;
    const state = await runDiagnostics(
      dir,
      [changed("config.yaml")],
      fakeServers({
        yaml: pullingHandle({ related: new Map([[relatedUri, [anError]]]) }),
      }),
    );
    // The pulled file is clean; the cross-file report lands on the path it names.
    expect(state.get("config.yaml")).toMatchObject({ count: 0, status: "clean" });
    expect(state.get("other.yaml")).toMatchObject({ count: 1, status: "findings" });
  });
});

test("a related report's findings survive the named file's own pull failing", async () => {
  await withRepo({ "config.yaml": "a: 1\n", "other.yaml": "b: 2\n" }, async (dir) => {
    const configUri = pathToFileURL(join(dir, "config.yaml")).href;
    const otherUri = pathToFileURL(join(dir, "other.yaml")).href;
    // Config.yaml's pull succeeds and carries a related report naming other.yaml; other.yaml's own
    // Pull is rejected. The real cross-file finding must not be wiped by the failure placeholder.
    const connection: LspConnection = {
      changeDocument: () => Effect.void,
      clearPublished: () => Effect.void,
      closeDocument: () => Effect.void,
      closed: Effect.sync(() => false),
      notify: () => Effect.void,
      openDocument: () => Effect.void,
      published: Effect.sync(() => new Map<string, unknown[]>()),
      pullDiagnostics: (uri) =>
        uri === configUri
          ? Effect.succeed({ items: [], related: new Map([[otherUri, [anError]]]) })
          : Effect.fail(
              new LspRequestError({ message: "boom", method: "textDocument/diagnostic" }),
            ),
      request: () => Effect.succeed(null),
      whenProjectLoaded: Effect.void,
    };
    const handle: ServerHandle = {
      capabilities: new Set<Capability>(["pullDiagnostics"]),
      connection,
    };

    const state = await runDiagnostics(
      dir,
      [changed("config.yaml"), changed("other.yaml")],
      fakeServers({ yaml: handle }),
    );

    expect(state.get("config.yaml")).toMatchObject({ count: 0, status: "clean" });
    expect(state.get("other.yaml")).toMatchObject({ count: 1, status: "findings" });
  });
});

// A recording pull server for keeper tests: pull answers keep runs fast and deterministic (no
// Settle waits), and the event log shows exactly what the keeper sent.
function keeperProbe() {
  const opens: string[] = [];
  const changes: string[] = [];
  const closes: string[] = [];
  const published = new Map<string, unknown[]>();
  const connection: LspConnection = {
    changeDocument: (uri) => Effect.sync(() => void changes.push(uri)),
    clearPublished: (uris) =>
      Effect.sync(() => {
        for (const uri of uris) {
          published.delete(uri);
        }
      }),
    closeDocument: (uri) => Effect.sync(() => void closes.push(uri)),
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: (textDocument) => Effect.sync(() => void opens.push(textDocument.uri)),
    published: Effect.sync(() => published),
    pullDiagnostics: () => Effect.succeed({ items: [], related: new Map<string, unknown[]>() }),
    request: () => Effect.succeed(null),
    whenProjectLoaded: Effect.void,
  };
  const handle: ServerHandle = {
    capabilities: new Set<Capability>(["pullDiagnostics"]),
    connection,
  };
  return { changes, closes, handle, opens };
}

// Captures the probe's event log inside the provided effect, before the layer tears down: teardown
// Itself closes every kept document (the keeper's scope finalizer), which is asserted separately.
function runSequence<T>(
  runs: { repoRoot: string; files: ChangedFile[] }[],
  servers: Layer.Layer<LanguageServers>,
  capture: () => T,
) {
  return Effect.runPromise(
    Diagnostics.pipe(
      Effect.flatMap((diagnostics) =>
        Effect.forEach(
          runs,
          ({ files, repoRoot }) =>
            Stream.runCollect(diagnostics.run(repoRoot, files)).pipe(
              Effect.map(
                (updates) => [...updates].at(-1)?.state ?? new Map<string, CheckerFileState>(),
              ),
            ),
          { concurrency: 1 },
        ).pipe(Effect.map((states) => ({ captured: capture(), states }))),
      ),
      Effect.provide(DiagnosticsLive.pipe(Layer.provide(servers))),
    ),
  );
}

test("keeps documents open across runs and sends nothing for unchanged content", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const probe = keeperProbe();
    const files = [changed("config.yaml")];
    const { captured, states } = await runSequence(
      [
        { files, repoRoot: dir },
        { files, repoRoot: dir },
      ],
      fakeServers({ yaml: probe.handle }),
      () => ({ changes: [...probe.changes], closes: [...probe.closes], opens: [...probe.opens] }),
    );

    // One didOpen for both runs, no didClose in between, no didChange for untouched content.
    const uri = pathToFileURL(join(dir, "config.yaml")).href;
    expect(captured.opens).toEqual([uri]);
    expect(captured.changes).toEqual([]);
    expect(captured.closes).toEqual([]);
    expect(states[1]?.get("config.yaml")).toMatchObject({ status: "clean" });
    // Teardown (app exit) releases the kept document via the keeper's scope finalizer.
    expect(probe.closes).toEqual([uri]);
  });
});

test("sends a didChange instead of reopening when the content moved", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const probe = keeperProbe();
    const files = [changed("config.yaml")];
    const uri = pathToFileURL(join(dir, "config.yaml")).href;
    const captured = await Effect.runPromise(
      Diagnostics.pipe(
        Effect.flatMap((diagnostics) =>
          Stream.runDrain(diagnostics.run(dir, files)).pipe(
            Effect.andThen(Effect.sync(() => writeFileSync(join(dir, "config.yaml"), "a: 2\n"))),
            Effect.andThen(Stream.runDrain(diagnostics.run(dir, files))),
            Effect.andThen(
              Effect.sync(() => ({
                changes: [...probe.changes],
                closes: [...probe.closes],
                opens: [...probe.opens],
              })),
            ),
          ),
        ),
        Effect.provide(DiagnosticsLive.pipe(Layer.provide(fakeServers({ yaml: probe.handle })))),
      ),
    );

    expect(captured.opens).toEqual([uri]);
    expect(captured.changes).toEqual([uri]);
    expect(captured.closes).toEqual([]);
  });
});

test("closes a document that leaves the changed set", async () => {
  await withRepo({ "config.yaml": "a: 1\n", "other.yaml": "b: 2\n" }, async (dir) => {
    const probe = keeperProbe();
    const { captured } = await runSequence(
      [
        { files: [changed("config.yaml"), changed("other.yaml")], repoRoot: dir },
        { files: [changed("config.yaml")], repoRoot: dir },
      ],
      fakeServers({ yaml: probe.handle }),
      () => ({ closes: [...probe.closes] }),
    );

    expect(captured.closes).toEqual([pathToFileURL(join(dir, "other.yaml")).href]);
  });
});

test("a run against a different repo releases the previous repo's documents", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, (dirA) =>
    withRepo({ "config.yaml": "b: 2\n" }, async (dirB) => {
      const probe = keeperProbe();
      const { captured } = await runSequence(
        [
          { files: [changed("config.yaml")], repoRoot: dirA },
          { files: [changed("config.yaml")], repoRoot: dirB },
        ],
        fakeServers({ yaml: probe.handle }),
        () => ({ closes: [...probe.closes], opens: [...probe.opens] }),
      );

      // The switch releases dirA's document (so a later switch back reopens it cleanly), and dirB
      // Opens its own.
      expect(captured.closes).toEqual([pathToFileURL(join(dirA, "config.yaml")).href]);
      expect(captured.opens).toEqual([
        pathToFileURL(join(dirA, "config.yaml")).href,
        pathToFileURL(join(dirB, "config.yaml")).href,
      ]);
    }),
  );
});

test("reopens the set on a fresh server after the pooled one dies between runs", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const uri = pathToFileURL(join(dir, "config.yaml")).href;
    const first = keeperProbe();
    let firstDead = false;
    // A probe whose `closed` the test can flip, simulating the pooled server dying between runs.
    const dyingConnection: LspConnection = {
      ...first.handle.connection,
      closed: Effect.sync(() => firstDead),
    };
    const second = keeperProbe();
    const handles = [
      { capabilities: first.handle.capabilities, connection: dyingConnection },
      second.handle,
    ];
    let acquires = 0;
    const rotating = Layer.succeed(LanguageServers)({
      acquire: () =>
        Effect.suspend(() => {
          const handle = handles.at(Math.min(acquires, handles.length - 1));
          acquires += 1;
          return handle === undefined
            ? Effect.fail(new ServerUnavailable({ language: "yaml", message: "gone" }))
            : Effect.succeed(handle);
        }),
    });

    const files = [changed("config.yaml")];
    await Effect.runPromise(
      Diagnostics.pipe(
        Effect.flatMap((diagnostics) =>
          Stream.runDrain(diagnostics.run(dir, files)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                firstDead = true;
              }),
            ),
            Effect.andThen(Stream.runDrain(diagnostics.run(dir, files))),
          ),
        ),
        Effect.provide(DiagnosticsLive.pipe(Layer.provide(rotating))),
      ),
    );

    // Run 1 opened on the first server; run 2 found it dead and reopened on the replacement,
    // Without a goodbye didClose to the corpse.
    expect(first.opens).toEqual([uri]);
    expect(first.closes).toEqual([]);
    expect(second.opens).toEqual([uri]);
    expect(acquires).toBe(2);
  });
});

test("releases a language's keeper when its changed set drops to zero", async () => {
  await withRepo({ "config.yaml": "a: 1\n", "data.json": "{}\n" }, async (dir) => {
    const yaml = keeperProbe();
    const json = keeperProbe();
    const { captured, states } = await runSequence(
      [
        { files: [changed("config.yaml"), changed("data.json")], repoRoot: dir },
        { files: [changed("data.json")], repoRoot: dir },
      ],
      fakeServers({ json: json.handle, yaml: yaml.handle }),
      () => ({ jsonCloses: [...json.closes], yamlCloses: [...yaml.closes] }),
    );

    // The yaml keeper released its document (nothing tracks it anymore); json's stayed held.
    expect(captured.yamlCloses).toEqual([pathToFileURL(join(dir, "config.yaml")).href]);
    expect(captured.jsonCloses).toEqual([]);
    expect(states[1]?.get("data.json")).toMatchObject({ status: "clean" });
  });
});

test("concurrent runs share one keeper instead of racing two into existence", async () => {
  await withRepo({ "config.yaml": "a: 1\n" }, async (dir) => {
    const probe = keeperProbe();
    let acquires = 0;
    // An acquire slow enough that both concurrent runs pass the keeper-cache miss before either
    // Finishes creating; the per-key lock must serialize them onto one keeper.
    const slowServers = Layer.succeed(LanguageServers)({
      acquire: () =>
        Effect.sync(() => {
          acquires += 1;
        }).pipe(Effect.andThen(Effect.sleep("50 millis")), Effect.as(probe.handle)),
    });

    const files = [changed("config.yaml")];
    const captured = await Effect.runPromise(
      Diagnostics.pipe(
        Effect.flatMap((diagnostics) =>
          Effect.all(
            [
              Stream.runDrain(diagnostics.run(dir, files)),
              Stream.runDrain(diagnostics.run(dir, files)),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map(() => ({ acquires, opens: [...probe.opens] }))),
        ),
        Effect.provide(DiagnosticsLive.pipe(Layer.provide(slowServers))),
      ),
    );

    expect(captured.acquires).toBe(1);
    expect(captured.opens).toEqual([pathToFileURL(join(dir, "config.yaml")).href]);
  });
});
