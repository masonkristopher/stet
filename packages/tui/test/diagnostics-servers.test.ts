import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect } from "effect";

import {
  activeServersForPath,
  handshakeConfigFor,
  registerServers,
  resolveLanguages,
  restoreServers,
  snapshotServers,
  intelLanguage,
  lspLanguageId,
  performHandshake,
  registerLanguages,
  resolveServerCommand,
  restoreLanguages,
  serversForPath,
  serversProviding,
  snapshotLanguages,
} from "@/diagnostics/servers";
import { LspRequestError } from "@/diagnostics/transport";
import type { LspConnection } from "@/diagnostics/transport";

test("resolves a source file to its language's servers in declared order", () => {
  // The JS/TS family lists its canonical server first, then the linters that overlap it.
  expect(serversForPath("src/a.tsx")).toEqual(["typescript", "oxlint", "biome"]);
  expect(serversForPath("src/a.mjs")).toEqual(["typescript", "oxlint", "biome"]);
  // Only biome claims css/graphql; the language matcher includes it regardless of repo gating.
  expect(serversForPath("src/a.css")).toEqual(["biome"]);
  // Json overlaps biome (biome only in a biome repo, the json server everywhere); yaml is disjoint.
  expect(serversForPath("package.json")).toEqual(["json", "biome"]);
  expect(serversForPath("config.yaml")).toEqual(["yaml"]);
  expect(serversForPath("config.yml")).toEqual(["yaml"]);
  expect(serversForPath("README.md")).toEqual([]);
  expect(serversForPath("Makefile")).toEqual([]);
});

test("routes Python files to basedpyright then ruff, with intel on basedpyright only", () => {
  const repo = mkdtempSync(join(tmpdir(), "stet-python-"));
  try {
    // Both `.py` and `.pyi` stubs open as python and run both always-on servers, primary first.
    expect(serversForPath("src/main.py")).toEqual(["basedpyright", "ruff"]);
    expect(serversForPath("stubs/typed.pyi")).toEqual(["basedpyright", "ruff"]);
    expect(lspLanguageId("src/main.py")).toBe("python");
    expect(lspLanguageId("stubs/typed.pyi")).toBe("python");
    // Code-intel is basedpyright's; ruff lints only, so it never surfaces for a pull or warm.
    expect(serversProviding("src/main.py", "hover")).toEqual(["basedpyright"]);
    expect(serversProviding("src/main.py", "references")).toEqual(["basedpyright"]);
    expect(serversProviding("src/main.py", "implementation")).toEqual(["basedpyright"]);
    expect(intelLanguage("src/main.py", repo)).toBe("basedpyright");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("routes an exact filename ahead of its extension", () => {
  const snapshot = snapshotLanguages();
  try {
    // A registered language can claim extensionless names (Dockerfile) and specific filenames that
    // Would otherwise resolve through their extension (justfile.yaml here), like icons do.
    registerLanguages({
      docker: { extensions: {}, filenames: { Dockerfile: "dockerfile" }, servers: ["yaml"] },
      just: { extensions: {}, filenames: { "justfile.yaml": "just" }, servers: ["nonexistent"] },
    });
    expect(serversForPath("services/api/Dockerfile")).toEqual(["yaml"]);
    expect(lspLanguageId("services/api/Dockerfile")).toBe("dockerfile");
    // The exact-name claim wins over the yaml extension the basename would otherwise match.
    expect(lspLanguageId("justfile.yaml")).toBe("just");
    // A server key the registry doesn't know is dropped rather than acquired.
    expect(serversForPath("justfile.yaml")).toEqual([]);
    // The dot in a directory name never reads as an extension.
    expect(serversForPath("src/v1.2/README")).toEqual([]);
  } finally {
    restoreLanguages(snapshot);
  }
});

test("activeServersForPath gates biome on a repo's biome config", () => {
  const withConfig = mkdtempSync(join(tmpdir(), "stet-biome-"));
  const withJsonc = mkdtempSync(join(tmpdir(), "stet-biome-"));
  const without = mkdtempSync(join(tmpdir(), "stet-biome-"));
  writeFileSync(join(withConfig, "biome.json"), "{}");
  writeFileSync(join(withJsonc, "biome.jsonc"), "{}");

  try {
    // A biome.json (or biome.jsonc) opts the repo in; biome then handles the JS/TS family and css.
    expect(activeServersForPath("src/a.ts", withConfig)).toEqual(["typescript", "oxlint", "biome"]);
    expect(activeServersForPath("src/a.css", withJsonc)).toEqual(["biome"]);
    // Without a biome config, biome stays off: oxlint/typescript still run, css has no server.
    expect(activeServersForPath("src/a.ts", without)).toEqual(["typescript", "oxlint"]);
    expect(activeServersForPath("src/a.css", without)).toEqual([]);
  } finally {
    rmSync(withConfig, { force: true, recursive: true });
    rmSync(withJsonc, { force: true, recursive: true });
    rmSync(without, { force: true, recursive: true });
  }
});

test("intelLanguage picks the one server that answers code-intel for a file", () => {
  const repo = mkdtempSync(join(tmpdir(), "stet-intel-"));
  try {
    // TypeScript is the only registered server that provides code-intel, so a JS/TS-family file
    // Resolves to it regardless of the other extension-matching servers (oxlint, biome).
    expect(intelLanguage("src/a.ts", repo)).toBe("typescript");
    expect(intelLanguage("src/a.tsx", repo)).toBe("typescript");
    expect(intelLanguage("src/a.mjs", repo)).toBe("typescript");
    // CSS/JSON/YAML only match intel-less servers, and an extensionless file matches none: no warm.
    expect(intelLanguage("src/a.css", repo)).toBeUndefined();
    expect(intelLanguage("package.json", repo)).toBeUndefined();
    expect(intelLanguage("config.yaml", repo)).toBeUndefined();
    expect(intelLanguage("Makefile", repo)).toBeUndefined();
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("lspLanguageId maps non-JS/TS file types to their LSP language ids", () => {
  expect(lspLanguageId("a.json")).toBe("json");
  expect(lspLanguageId("a.jsonc")).toBe("jsonc");
  expect(lspLanguageId("a.css")).toBe("css");
  expect(lspLanguageId("a.graphql")).toBe("graphql");
  expect(lspLanguageId("a.yaml")).toBe("yaml");
  expect(lspLanguageId("a.yml")).toBe("yaml");
});

test("serversProviding keeps only servers whose static hint can answer the intent", () => {
  // Only typescript declares definition/references; oxlint pushes diagnostics and declares neither,
  // So intel never acquires it for a code-intel pull.
  expect(serversProviding("src/a.ts", "definition")).toEqual(["typescript"]);
  expect(serversProviding("src/a.tsx", "references")).toEqual(["typescript"]);
  expect(serversProviding("src/a.ts", "implementation")).toEqual(["typescript"]);
  // Json and yaml only push diagnostics (validation-only), so they never surface for a code-intel pull.
  expect(serversProviding("package.json", "definition")).toEqual([]);
  expect(serversProviding("config.yaml", "hover")).toEqual([]);
  expect(serversProviding("README.md", "definition")).toEqual([]);
});

test("resolveServerCommand returns undefined for a language with no registered server", () => {
  expect(resolveServerCommand("ruby", "/repo")).toBeUndefined();
});

test("handshake parses advertised providers into the capability set", async () => {
  const requested: string[] = [];
  const notified: string[] = [];
  let initializeParams: unknown;
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: (method) => Effect.sync(() => void notified.push(method)),
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    pullDiagnostics: () =>
      Effect.fail(
        new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
      ),
    request: (method, params) =>
      Effect.sync(() => {
        requested.push(method);
        initializeParams = method === "initialize" ? params : initializeParams;
        // A typescript-language-server-shaped reply: definition/references/hover as options
        // Objects, no diagnosticProvider (it pushes diagnostics instead).
        return method === "initialize"
          ? {
              capabilities: {
                definitionProvider: true,
                documentSymbolProvider: { label: "TypeScript" },
                hoverProvider: true,
                implementationProvider: true,
                referencesProvider: true,
              },
            }
          : null;
      }),
    whenProjectLoaded: Effect.void,
  };

  const handle = await Effect.runPromise(performHandshake(connection, "/repo"));

  expect(handle.capabilities.has("definition")).toBe(true);
  expect(handle.capabilities.has("references")).toBe(true);
  expect(handle.capabilities.has("hover")).toBe(true);
  expect(handle.capabilities.has("documentSymbol")).toBe(true);
  expect(handle.capabilities.has("implementation")).toBe(true);
  expect(handle.capabilities.has("pullDiagnostics")).toBe(false);
  expect(requested).toEqual(["initialize"]);
  expect(notified).toEqual(["initialized"]);
  // Opting into workDoneProgress is what makes tsserver report project-load begin/end; without it
  // The intel readiness gate never opens.
  expect(initializeParams).toMatchObject({ capabilities: { window: { workDoneProgress: true } } });
  // The hierarchicalDocumentSymbolSupport flag is what makes a server return the nested
  // `DocumentSymbol[]`; without it the outline downgrades to a flat `SymbolInformation[]`.
  expect(initializeParams).toMatchObject({
    capabilities: {
      textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
    },
  });
});

test("handshake yields an empty capability set when no providers are advertised", async () => {
  // An oxlint-shaped reply: it lints via push and advertises none of the code-intel providers.
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    pullDiagnostics: () =>
      Effect.fail(
        new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
      ),
    request: () => Effect.succeed({ capabilities: {} }),
    whenProjectLoaded: Effect.void,
  };

  const handle = await Effect.runPromise(performHandshake(connection, "/repo"));

  expect(handle.capabilities.has("definition")).toBe(false);
  expect(handle.capabilities.has("pullDiagnostics")).toBe(false);
  expect(handle.capabilities.size).toBe(0);
});

test("handshake treats a malformed provider value as unsupported", async () => {
  // Only `true` or an options object advertises support; a non-conformant `null`/`0` must not count.
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    pullDiagnostics: () =>
      Effect.fail(
        new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
      ),
    request: () =>
      Effect.succeed({
        capabilities: {
          definitionProvider: null,
          implementationProvider: 0,
          referencesProvider: 0,
        },
      }),
    whenProjectLoaded: Effect.void,
  };

  const handle = await Effect.runPromise(performHandshake(connection, "/repo"));

  expect(handle.capabilities.has("definition")).toBe(false);
  expect(handle.capabilities.has("implementation")).toBe(false);
  expect(handle.capabilities.has("references")).toBe(false);
});

test("handshake advertises pull diagnostics and refresh support, and parses diagnosticProvider", async () => {
  let initializeParams: unknown;
  // A rust-analyzer-shaped reply: it advertises diagnosticProvider, so the pull path activates.
  const connection: LspConnection = {
    changeDocument: () => Effect.void,
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    pullDiagnostics: () =>
      Effect.fail(
        new LspRequestError({ message: "unsupported", method: "textDocument/diagnostic" }),
      ),
    request: (method, params) =>
      Effect.sync(() => {
        initializeParams = method === "initialize" ? params : initializeParams;
        return {
          capabilities: {
            diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
          },
        };
      }),
    whenProjectLoaded: Effect.void,
  };

  const handle = await Effect.runPromise(performHandshake(connection, "/repo"));

  expect(handle.capabilities.has("pullDiagnostics")).toBe(true);
  // Servers only answer `textDocument/diagnostic` (and only send refresh nudges) when the client
  // Declares the matching caps in `initialize`.
  expect(initializeParams).toMatchObject({
    capabilities: {
      textDocument: { diagnostic: { relatedDocumentSupport: true } },
      workspace: { diagnostics: { refreshSupport: true } },
    },
  });
});

test("handshakeConfigFor derives the handshake from data, substituting repo placeholders", async () => {
  const config = handshakeConfigFor(
    {
      initializationOptions: [
        { options: { configPath: null, run: "onType" }, workspaceUri: "{repoUri}" },
      ],
      settings: { configPath: null, root: "{repoRoot}", run: "onType" },
    },
    "/some/repo",
  );

  expect(config?.initializationOptions).toEqual([
    {
      options: { configPath: null, run: "onType" },
      workspaceUri: pathToFileURL("/some/repo").href,
    },
  ]);
  // Settings presence advertises the caps that invite the configuration pull.
  expect(config?.workspaceCapabilities).toEqual({ configuration: true, workspaceFolders: true });
  // Every requested configuration item gets one substituted copy of the settings.
  const answer = await Effect.runPromise(
    config?.onRequest?.("workspace/configuration", { items: [{}, {}] }) ?? Effect.succeed(null),
  );
  expect(answer).toEqual([
    { configPath: null, root: "/some/repo", run: "onType" },
    { configPath: null, root: "/some/repo", run: "onType" },
  ]);
  // Other server-to-client requests fall through to the transport's null default.
  const other = await Effect.runPromise(
    config?.onRequest?.("window/workDoneProgress/create", {}) ?? Effect.succeed("missing"),
  );
  expect(other).toBeNull();
});

test("handshakeConfigFor yields nothing for a server with no handshake needs", () => {
  expect(handshakeConfigFor({}, "/some/repo")).toBeUndefined();
});

test("a handshake closure replaces the data-derived handshake entirely", () => {
  const config = handshakeConfigFor(
    {
      handshake: () => ({ initializationOptions: { fromClosure: true } }),
      initializationOptions: { fromData: true },
      settings: { fromData: true },
    },
    "/some/repo",
  );
  expect(config?.initializationOptions).toEqual({ fromClosure: true });
  expect(config?.workspaceCapabilities).toBeUndefined();
});

test("substitution never rescans text a placeholder inserted", () => {
  // A repo path containing a literal placeholder token is legal on disk; the substitution must
  // Insert it verbatim, not substitute inside its own output.
  const repoRoot = "/tmp/{repoUri}/repo";
  const config = handshakeConfigFor(
    { initializationOptions: { root: "{repoRoot}", uri: "{repoUri}" } },
    repoRoot,
  );
  expect(config?.initializationOptions).toEqual({
    root: repoRoot,
    uri: pathToFileURL(repoRoot).href,
  });
});

test("resolveLanguages turns a new language into routable file types and synthesized servers", () => {
  const { issues, languages, servers } = resolveLanguages({
    elixir: {
      extensions: ["ex", ".exs"],
      servers: [
        {
          command: ["elixir-ls", "--stdio"],
          settings: { elixirLS: { dialyzerEnabled: false } },
        },
      ],
    },
  });

  expect(issues).toEqual([]);
  // File types map to the language key as their LSP languageId; a leading dot is tolerated.
  expect(languages.elixir).toMatchObject({
    extensions: { ex: "elixir", exs: "elixir" },
    servers: ["elixir/elixir-ls"],
  });
  const spec = servers["elixir/elixir-ls"];
  expect(spec).toMatchObject({
    args: ["--stdio"],
    binary: "elixir-ls",
    settings: { elixirLS: { dialyzerEnabled: false } },
  });
  // Optimistic intel: the handshake-advertised set stays the authoritative gate.
  expect(spec?.provides).toContain("definition");
  // No provisioning for user servers: repo-local -> PATH only.
  expect(spec?.provision).toBeUndefined();
});

test("resolveLanguages overrides a built-in's servers while inheriting its file types", () => {
  const { issues, languages, servers } = resolveLanguages({
    typescript: { servers: ["typescript", "biome"] },
  });

  expect(issues).toEqual([]);
  expect(servers).toEqual({});
  // The list replaced (oxlint dropped); the inherited extensions keep their per-extension ids.
  expect(languages.typescript?.servers).toEqual(["typescript", "biome"]);
  expect(languages.typescript?.extensions).toMatchObject({
    ts: "typescript",
    tsx: "typescriptreact",
  });
});

test("resolveLanguages reports and drops an unknown built-in server reference", () => {
  const { issues, languages } = resolveLanguages({
    typescript: { servers: ["typescript", "eslint"] },
  });

  expect(issues).toEqual(['language "typescript": unknown server "eslint"']);
  expect(languages.typescript?.servers).toEqual(["typescript"]);
});

test("resolveLanguages skips invalid entries without sinking the rest", () => {
  const { issues, languages } = resolveLanguages({
    go: { extensions: ["go"], servers: [{ command: ["gopls"] }] },
    nonsense: "not an object",
    scala: { extensions: [42], servers: [{ command: ["metals"] }] },
  });

  expect(issues).toEqual([
    'language "nonsense": must be an object',
    'language "scala": extensions must be an array of non-empty strings',
  ]);
  expect(Object.keys(languages)).toEqual(["go"]);
});

test("resolveLanguages never lets a new language shadow another's file types", () => {
  const { issues, languages } = resolveLanguages({
    mylang: { extensions: ["ts", "ml"], servers: [{ command: ["mylang-lsp"] }] },
  });

  expect(issues).toEqual([
    'language "mylang": extensions entry "ts" already belongs to "typescript"',
  ]);
  // The unclaimed extension still routes; the shadowing one is skipped.
  expect(languages.mylang?.extensions).toEqual({ ml: "mylang" });
});

test("resolveLanguages rejects a new language with no file types or no servers", () => {
  const { issues, languages } = resolveLanguages({
    empty: { servers: [{ command: ["lsp"] }] },
    serverless: { extensions: ["xyz"] },
  });

  expect(issues).toEqual([
    'language "empty": declares no file types',
    'language "serverless": declares no servers',
  ]);
  expect(languages).toEqual({});
});

test("resolveLanguages flags unknown fields so typos never silently no-op", () => {
  const { issues } = resolveLanguages({
    // A typo'd extensions key leaves a new language with no file types at all.
    elixir: { extentions: ["ex"], servers: [{ command: ["elixir-ls"] }] },
    // A typo'd command key leaves an inline server unusable.
    ruby: { extensions: ["rb"], servers: [{ comand: ["ruby-lsp"] }] },
  });

  expect(issues).toContain('language "elixir": unknown field "extentions"');
  expect(issues).toContain('language "elixir": declares no file types');
  expect(issues).toContain(
    'language "ruby": a server must be a built-in name or { command: [...] }',
  );
});

test("registered config languages route files exactly like built-ins", () => {
  const languageSnapshot = snapshotLanguages();
  const serverSnapshot = snapshotServers();
  try {
    const resolved = resolveLanguages({
      docker: {
        filenames: ["Dockerfile"],
        servers: [{ command: ["docker-langserver", "--stdio"] }],
      },
      typescript: { servers: ["typescript"] },
    });
    expect(resolved.issues).toEqual([]);
    registerServers(resolved.servers);
    registerLanguages(resolved.languages);

    // The inline server routes by exact filename with the language key as languageId.
    expect(serversForPath("services/api/Dockerfile")).toEqual(["docker/docker-langserver"]);
    expect(lspLanguageId("services/api/Dockerfile")).toBe("docker");
    // The override dropped oxlint and biome for the JS/TS family.
    expect(serversForPath("src/a.ts")).toEqual(["typescript"]);
    // The synthesized server declares intel, so the warm-hold picks it up.
    expect(intelLanguage("services/api/Dockerfile", "/repo")).toBe("docker/docker-langserver");
  } finally {
    restoreLanguages(languageSnapshot);
    restoreServers(serverSnapshot);
  }
});

test("an inline server command may be an absolute path, used as-is", () => {
  const languageSnapshot = snapshotLanguages();
  const serverSnapshot = snapshotServers();
  try {
    const resolved = resolveLanguages({
      probe: { extensions: ["prb"], servers: [{ command: ["/bin/ls", "--stdio"] }] },
    });
    expect(resolved.issues).toEqual([]);
    registerServers(resolved.servers);
    registerLanguages(resolved.languages);

    // Bun.which passes an existing executable path through, so the docs' "an absolute path is
    // Used as-is" holds: no node_modules/.bin or PATH entry involved.
    expect(resolveServerCommand("probe/ls", "/some/repo")).toEqual(["/bin/ls", "--stdio"]);
    expect(serversForPath("src/x.prb")).toEqual(["probe/ls"]);
  } finally {
    restoreLanguages(languageSnapshot);
    restoreServers(serverSnapshot);
  }
});

// The reversed declaration orders below are built through Object.fromEntries because a plain
// Object literal cannot hold them: the sort-keys auto-fix re-sorts literal keys alphabetically,
// Which is exactly how an earlier version of these tests silently lost its second order.
function inBothOrders(entries: [string, unknown][]) {
  return [Object.fromEntries(entries), Object.fromEntries(entries.toReversed())];
}

test("an override that drops a file type frees it for another language, in any order", () => {
  // "flow" wants js/jsx, which the typescript built-in owns until the override narrows it away.
  const flow = { extensions: ["js", "jsx"], servers: [{ command: ["flow", "lsp"] }] };
  const narrowed = { extensions: ["ts", "tsx"] };

  for (const raw of inBothOrders([
    ["flow", flow],
    ["typescript", narrowed],
  ])) {
    const { issues, languages } = resolveLanguages(raw);
    expect(issues).toEqual([]);
    expect(languages.flow?.extensions).toEqual({ js: "flow", jsx: "flow" });
    expect(languages.typescript?.extensions).toEqual({ ts: "typescript", tsx: "typescriptreact" });
  }
});

test("a file type an override keeps still beats a new claimant, in any order", () => {
  const grabber = { extensions: ["ts"], servers: [{ command: ["grabber-lsp"] }] };
  const keepsTs = { servers: ["typescript"] };

  for (const raw of inBothOrders([
    ["grabber", grabber],
    ["typescript", keepsTs],
  ])) {
    const { issues, languages } = resolveLanguages(raw);
    expect(issues).toEqual([
      'language "grabber": extensions entry "ts" already belongs to "typescript"',
    ]);
    expect(languages.grabber?.extensions).toEqual({});
    expect(languages.typescript?.extensions).toMatchObject({ ts: "typescript" });
  }
});

test("a skipped entry's file types never block a later claimant", () => {
  const { issues, languages } = resolveLanguages({
    broken: { extensions: ["zig"], servers: "not an array" },
    zig: { extensions: ["zig"], servers: [{ command: ["zls"] }] },
  });

  expect(issues).toEqual(['language "broken": servers must be an array']);
  expect(languages.zig?.extensions).toEqual({ zig: "zig" });
  expect(languages.broken).toBeUndefined();
});
