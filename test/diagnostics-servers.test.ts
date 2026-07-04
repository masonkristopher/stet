import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import {
  activeServersForPath,
  lspLanguageId,
  performHandshake,
  resolveServerCommand,
  serversForPath,
  serversProviding,
} from "@/diagnostics/servers";
import type { LspConnection } from "@/diagnostics/transport";

test("resolves a source file to every server that handles its extension", () => {
  // Biome, oxlint, and typescript all claim the JS/TS family, so a code file runs through all three.
  expect(serversForPath("src/a.tsx")).toEqual(["biome", "oxlint", "typescript"]);
  expect(serversForPath("src/a.mjs")).toEqual(["biome", "oxlint", "typescript"]);
  // Only biome claims css/graphql; the extension matcher includes it regardless of repo gating.
  expect(serversForPath("src/a.css")).toEqual(["biome"]);
  // Json overlaps biome (biome only in a biome repo, the json server everywhere); yaml is disjoint.
  expect(serversForPath("package.json")).toEqual(["biome", "json"]);
  expect(serversForPath("config.yaml")).toEqual(["yaml"]);
  expect(serversForPath("config.yml")).toEqual(["yaml"]);
  expect(serversForPath("README.md")).toEqual([]);
  expect(serversForPath("Makefile")).toEqual([]);
});

test("activeServersForPath gates biome on a repo's biome config", () => {
  const withConfig = mkdtempSync(join(tmpdir(), "sideye-biome-"));
  const withJsonc = mkdtempSync(join(tmpdir(), "sideye-biome-"));
  const without = mkdtempSync(join(tmpdir(), "sideye-biome-"));
  writeFileSync(join(withConfig, "biome.json"), "{}");
  writeFileSync(join(withJsonc, "biome.jsonc"), "{}");

  try {
    // A biome.json (or biome.jsonc) opts the repo in; biome then handles the JS/TS family and css.
    expect(activeServersForPath("src/a.ts", withConfig)).toEqual(["biome", "oxlint", "typescript"]);
    expect(activeServersForPath("src/a.css", withJsonc)).toEqual(["biome"]);
    // Without a biome config, biome stays off: oxlint/typescript still run, css has no server.
    expect(activeServersForPath("src/a.ts", without)).toEqual(["oxlint", "typescript"]);
    expect(activeServersForPath("src/a.css", without)).toEqual([]);
  } finally {
    rmSync(withConfig, { force: true, recursive: true });
    rmSync(withJsonc, { force: true, recursive: true });
    rmSync(without, { force: true, recursive: true });
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
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: (method) => Effect.sync(() => void notified.push(method)),
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
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
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
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
    clearPublished: () => Effect.void,
    closeDocument: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    openDocument: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
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
