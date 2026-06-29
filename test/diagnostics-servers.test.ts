import { expect, test } from "bun:test";

import { Effect } from "effect";

import {
  performHandshake,
  resolveServerCommand,
  serversForPath,
  serversProviding,
} from "../src/diagnostics/servers";
import type { LspConnection } from "../src/diagnostics/transport";

test("resolves a source file to every server that handles its extension", () => {
  // Typescript and oxlint both claim the JS/TS family, so a code file runs through both.
  expect(serversForPath("src/a.tsx")).toEqual(["oxlint", "typescript"]);
  expect(serversForPath("src/a.mjs")).toEqual(["oxlint", "typescript"]);
  expect(serversForPath("README.md")).toEqual([]);
  expect(serversForPath("Makefile")).toEqual([]);
});

test("serversProviding keeps only servers whose static hint can answer the intent", () => {
  // Only typescript declares definition/references; oxlint pushes diagnostics and declares neither,
  // So intel never acquires it for a code-intel pull.
  expect(serversProviding("src/a.ts", "definition")).toEqual(["typescript"]);
  expect(serversProviding("src/a.tsx", "references")).toEqual(["typescript"]);
  expect(serversProviding("README.md", "definition")).toEqual([]);
});

test("resolveServerCommand returns undefined for a language with no registered server", () => {
  expect(resolveServerCommand("ruby", "/repo")).toBeUndefined();
});

test("handshake parses advertised providers into the capability set", async () => {
  const requested: string[] = [];
  const notified: string[] = [];
  const connection: LspConnection = {
    clearPublished: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: (method) => Effect.sync(() => void notified.push(method)),
    published: Effect.sync(() => new Map<string, unknown[]>()),
    request: (method) =>
      Effect.sync(() => {
        requested.push(method);
        // A typescript-language-server-shaped reply: definition/references/hover as options
        // Objects, no diagnosticProvider (it pushes diagnostics instead).
        return method === "initialize"
          ? {
              capabilities: {
                definitionProvider: true,
                documentSymbolProvider: { label: "TypeScript" },
                hoverProvider: true,
                referencesProvider: true,
              },
            }
          : null;
      }),
  };

  const handle = await Effect.runPromise(performHandshake(connection, "/repo"));

  expect(handle.capabilities.has("definition")).toBe(true);
  expect(handle.capabilities.has("references")).toBe(true);
  expect(handle.capabilities.has("hover")).toBe(true);
  expect(handle.capabilities.has("documentSymbol")).toBe(true);
  expect(handle.capabilities.has("pullDiagnostics")).toBe(false);
  expect(requested).toEqual(["initialize"]);
  expect(notified).toEqual(["initialized"]);
});

test("handshake yields an empty capability set when no providers are advertised", async () => {
  // An oxlint-shaped reply: it lints via push and advertises none of the code-intel providers.
  const connection: LspConnection = {
    clearPublished: () => Effect.void,
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    request: () => Effect.succeed({ capabilities: {} }),
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
    closed: Effect.sync(() => false),
    notify: () => Effect.void,
    published: Effect.sync(() => new Map<string, unknown[]>()),
    request: () =>
      Effect.succeed({ capabilities: { definitionProvider: null, referencesProvider: 0 } }),
  };

  const handle = await Effect.runPromise(performHandshake(connection, "/repo"));

  expect(handle.capabilities.has("definition")).toBe(false);
  expect(handle.capabilities.has("references")).toBe(false);
});
