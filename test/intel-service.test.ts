import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Effect, Layer } from "effect";

import { LanguageServers, ServerUnavailable } from "../src/diagnostics/servers";
import type { Capability, ServerHandle } from "../src/diagnostics/servers";
import { LspRequestError } from "../src/diagnostics/transport";
import type { LspConnection } from "../src/diagnostics/transport";
import { Intel, IntelLive, IntelRequestError } from "../src/intel/service";

interface Recorded {
  method: string;
  params: unknown;
}

// A real LspConnection wired to a synchronous responder, not a mock of sideye's own code. Every
// Outbound request/notification is appended to `log` so a test can assert the open/request/close order.
function handle(
  capabilities: Capability[],
  respond: (method: string, params: unknown) => Effect.Effect<unknown, LspRequestError>,
  log: Recorded[],
): ServerHandle {
  const connection: LspConnection = {
    clearPublished: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: (method, params) => Effect.sync(() => void log.push({ method, params })),
    published: Effect.sync(() => new Map<string, unknown[]>()),
    request: (method, params) => {
      log.push({ method, params });
      return respond(method, params);
    },
  };
  return { capabilities: new Set(capabilities), connection };
}

function fakeServers(byLanguage: Record<string, ServerHandle>) {
  return Layer.succeed(LanguageServers)({
    acquire: (language) => {
      const found = byLanguage[language];
      return found === undefined
        ? Effect.fail(new ServerUnavailable({ language, message: "not found" }))
        : Effect.succeed(found);
    },
  });
}

function runDefinition(
  repoRoot: string,
  path: string,
  position: { line: number; character: number },
  servers: Layer.Layer<LanguageServers>,
) {
  return Effect.runPromise(
    Intel.pipe(
      Effect.flatMap((intel) => intel.definition(repoRoot, path, position)),
      Effect.provide(IntelLive.pipe(Layer.provide(servers))),
    ),
  );
}

function withRepo(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "intel-lsp-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return run(dir).finally(() => rmSync(dir, { force: true, recursive: true }));
}

const definitionRange = { end: { character: 9, line: 4 }, start: { character: 2, line: 4 } };

test("definition opens the file, requests at the caret, normalizes, then closes", async () => {
  await withRepo(
    { "src/a.ts": "const x = y\n", "src/b.ts": "export const y = 1\n" },
    async (dir) => {
      const log: Recorded[] = [];
      const targetUri = pathToFileURL(join(dir, "src/b.ts")).href;
      const ts = handle(
        ["definition"],
        (method) =>
          method === "textDocument/definition"
            ? Effect.succeed({ range: definitionRange, uri: targetUri })
            : Effect.succeed(null),
        log,
      );
      const servers = fakeServers({
        oxlint: handle([], () => Effect.succeed(null), []),
        typescript: ts,
      });

      const result = await runDefinition(dir, "src/a.ts", { character: 6, line: 0 }, servers);

      // The absolute target under the repo root comes back repo-relative, ready for the tree/viewer.
      expect(result).toEqual([{ column: 3, line: 5, path: "src/b.ts" }]);
      expect(log.map((entry) => entry.method)).toEqual([
        "textDocument/didOpen",
        "textDocument/definition",
        "textDocument/didClose",
      ]);
      const request = log[1];
      expect(request?.params).toMatchObject({
        position: { character: 6, line: 0 },
        textDocument: { uri: pathToFileURL(join(dir, "src/a.ts")).href },
      });
    },
  );
});

test("definition relativizes an in-repo target when the repo root is a symlink", async () => {
  await withRepo(
    { "src/a.ts": "const x = y\n", "src/b.ts": "export const y = 1\n" },
    async (dir) => {
      // The repo lives under a symlink (macOS /var ↔ /private/var); the server resolves the target to
      // Its realpath. Without canonicalizing both sides, the prefix check drops the in-repo jump.
      const link = `${dir}-link`;
      symlinkSync(realpathSync(dir), link);
      try {
        const targetUri = pathToFileURL(realpathSync(join(link, "src/b.ts"))).href;
        const ts = handle(
          ["definition"],
          () => Effect.succeed({ range: definitionRange, uri: targetUri }),
          [],
        );

        const result = await runDefinition(
          link,
          "src/a.ts",
          { character: 6, line: 0 },
          fakeServers({ typescript: ts }),
        );

        expect(result).toEqual([{ column: 3, line: 5, path: "src/b.ts" }]);
      } finally {
        rmSync(link, { force: true });
      }
    },
  );
});

test("definition leaves an out-of-repo target absolute so the caller can skip it", async () => {
  await withRepo({ "src/a.ts": "import { x } from 'lib'\n" }, async (dir) => {
    // A definition in a global stdlib resolves outside the repo root; it can't be relativized.
    const targetUri = pathToFileURL("/opt/lib/index.d.ts").href;
    const ts = handle(
      ["definition"],
      () => Effect.succeed({ range: definitionRange, uri: targetUri }),
      [],
    );

    const result = await runDefinition(
      dir,
      "src/a.ts",
      { character: 9, line: 0 },
      fakeServers({ typescript: ts }),
    );

    expect(result).toEqual([{ column: 3, line: 5, path: fileURLToPath(targetUri) }]);
  });
});

test("definition skips a server lacking the capability and selects the next", async () => {
  await withRepo({ "src/a.ts": "const x = 1\n" }, async (dir) => {
    const oxLog: Recorded[] = [];
    const tsLog: Recorded[] = [];
    const targetUri = pathToFileURL(join(dir, "src/a.ts")).href;
    // Oxlint advertises no definition capability; it must never be opened or queried.
    const oxlint = handle(
      [],
      () => Effect.succeed({ range: definitionRange, uri: targetUri }),
      oxLog,
    );
    const typescript = handle(
      ["definition"],
      () => Effect.succeed({ range: definitionRange, uri: targetUri }),
      tsLog,
    );

    const result = await runDefinition(
      dir,
      "src/a.ts",
      { character: 0, line: 0 },
      fakeServers({ oxlint, typescript }),
    );

    expect(result).toHaveLength(1);
    expect(oxLog).toEqual([]);
    expect(tsLog.map((entry) => entry.method)).toContain("textDocument/definition");
  });
});

test("definition degrades a server error to IntelRequestError and still closes the document", async () => {
  await withRepo({ "src/a.ts": "const x = 1\n" }, async (dir) => {
    const log: Recorded[] = [];
    const ts = handle(
      ["definition"],
      (method) => Effect.fail(new LspRequestError({ message: "boom", method })),
      log,
    );

    const error = await Effect.runPromise(
      Intel.pipe(
        Effect.flatMap((intel) => intel.definition(dir, "src/a.ts", { character: 0, line: 0 })),
        Effect.flip,
        Effect.provide(IntelLive.pipe(Layer.provide(fakeServers({ typescript: ts })))),
      ),
    );

    expect(error).toBeInstanceOf(IntelRequestError);
    expect(error.method).toBe("textDocument/definition");
    // The acquireRelease finalizer closes the document even though the request failed.
    expect(log.map((entry) => entry.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didClose",
    ]);
  });
});

test("definition returns empty when no acquired server has the capability", async () => {
  await withRepo({ "src/a.ts": "const x = 1\n" }, async (dir) => {
    const servers = fakeServers({
      oxlint: handle([], () => Effect.succeed(null), []),
      typescript: handle([], () => Effect.succeed(null), []),
    });
    expect(await runDefinition(dir, "src/a.ts", { character: 0, line: 0 }, servers)).toEqual([]);
  });
});

test("definition never acquires a server whose static hint can't answer it", async () => {
  await withRepo({ "src/a.ts": "const x = 1\n" }, async (dir) => {
    const acquired: string[] = [];
    const ts = handle(["definition"], () => Effect.succeed(null), []);
    const servers = Layer.succeed(LanguageServers)({
      acquire: (language) => {
        acquired.push(language);
        return language === "typescript"
          ? Effect.succeed(ts)
          : Effect.fail(new ServerUnavailable({ language, message: "not found" }));
      },
    });

    await runDefinition(dir, "src/a.ts", { character: 0, line: 0 }, servers);

    // Oxlint declares no code-intel intents, so it is skipped before any acquire.
    expect(acquired).toEqual(["typescript"]);
  });
});

test("definition returns empty for a file that is not on disk", async () => {
  await withRepo({ "src/a.ts": "const x = 1\n" }, async (dir) => {
    const ts = handle(["definition"], () => Effect.succeed(null), []);
    const result = await runDefinition(
      dir,
      "src/gone.ts",
      { character: 0, line: 0 },
      fakeServers({ typescript: ts }),
    );
    expect(result).toEqual([]);
  });
});

test("references sends includeDeclaration context and maps the Location array", async () => {
  await withRepo({ "src/a.ts": "const x = 1\n" }, async (dir) => {
    const log: Recorded[] = [];
    const targetUri = pathToFileURL(join(dir, "src/a.ts")).href;
    const ts = handle(
      ["references"],
      (method) =>
        method === "textDocument/references"
          ? Effect.succeed([{ range: definitionRange, uri: targetUri }])
          : Effect.succeed(null),
      log,
    );

    const result = await Effect.runPromise(
      Intel.pipe(
        Effect.flatMap((intel) => intel.references(dir, "src/a.ts", { character: 6, line: 0 })),
        Effect.provide(IntelLive.pipe(Layer.provide(fakeServers({ typescript: ts })))),
      ),
    );

    expect(result).toEqual([{ column: 3, line: 5, path: "src/a.ts" }]);
    expect(log[1]?.params).toMatchObject({ context: { includeDeclaration: true } });
  });
});
