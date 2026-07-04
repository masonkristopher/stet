/**
 * Discovers and brings up language servers, pooled one per (language, repo root). Discovery is the
 * hybrid path: a repo-local binary wins over one on PATH (reusing the checker's `resolveBinary`).
 * The pool keeps a server warm across the many poll-driven pulls and releases it once the last
 * reference drops, so a worktree switch transparently swaps to a fresh server for the new root.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context, Data, Effect, Layer, RcMap } from "effect";
import type { Scope } from "effect";

import { resolveBinary } from "./checker";
import { LspProcess } from "./lsp-process";
import type { LspSpawnError } from "./lsp-process";
import { cachedBinaryPath, Provisioner } from "./provision";
import type { ProvisionSpec } from "./provision";
import { LspRequestError } from "./transport";
import type { LspConnection } from "./transport";

export class ServerUnavailable extends Data.TaggedError("ServerUnavailable")<{
  readonly language: string;
  readonly message: string;
}> {}

/** The language's server is still downloading; its files render as pending, not unavailable. */
export class ServerInstalling extends Data.TaggedError("ServerInstalling")<{
  readonly language: string;
}> {}

/**
 * The `initialize` shape and server-to-client request answers a server needs beyond the read-only
 * baseline, parameterized by repo root. typescript needs none of this; oxlint advertises
 * `workspace.configuration` and answers `workspace/configuration` with its lint options, or it
 * stays silent.
 */
interface HandshakeConfig {
  readonly workspaceCapabilities?: Record<string, unknown>;
  readonly initializationOptions?: unknown;
  readonly onRequest?: (method: string, params: unknown) => Effect.Effect<unknown>;
}

/** The read-only LSP intents sideye uses, keyed off each server's advertised `*Provider`. */
export type Capability =
  | "definition"
  | "references"
  | "hover"
  | "documentSymbol"
  | "callHierarchy"
  | "implementation"
  | "pullDiagnostics";

interface ServerSpec {
  readonly binary: string;
  readonly args: readonly string[];
  /** File extensions (no dot) this server handles; servers may overlap (oxlint lints what tsc owns). */
  readonly extensions: readonly string[];
  /**
   * The intents this server can answer, declared statically so intel skips a non-provider without
   * acquiring it. A pre-acquire filter only; the handshake-advertised set on `ServerHandle` stays
   * the authoritative gate, so this must not under-declare what the server actually provides.
   */
  readonly provides: readonly Capability[];
  /** Npm packages sideye installs into its cache when the server is found neither in repo nor PATH. */
  readonly provision?: { readonly packages: readonly string[] };
  /** Per-server handshake extras (caps, initializationOptions, server-request answers). */
  readonly handshake?: (repoRoot: string) => HandshakeConfig;
  /**
   * When set, the server runs only in repos this predicate accepts. oxlint/typescript run in every
   * JS/TS repo, but a competing linter like Biome should activate only where the repo opted into it
   * (a `biome.json`), the way an editor's Biome extension does, so it neither downloads into repos
   * that don't use it nor duplicates oxlint's findings.
   */
  readonly detect?: (repoRoot: string) => boolean;
}

// The JS/TS family both servers handle; typescript type-checks it, oxlint lints it.
const codeExtensions = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"] as const;

// Biome lints the JS/TS family plus json/css/graphql, where it adds findings oxlint does not.
const biomeExtensions = [...codeExtensions, "json", "jsonc", "css", "graphql"] as const;

// Adding a language is one registry entry plus its file extensions; the transport, pool, and
// Handshake are language-agnostic. typescript-language-server also serves JavaScript; oxlint lints
// The same files, so a `.ts` file resolves to both servers and their findings merge. A server with a
// `detect` gate runs only where its predicate accepts the repo (Biome needs a biome config).
const registry: Record<string, ServerSpec> = {
  biome: {
    args: ["lsp-proxy"],
    binary: "biome",
    // Read off disk; `detect` guarantees a biome config exists, so Biome resolves it on its own and
    // The transport's null default answers its `workspace/configuration` pull. No handshake needed.
    detect: (repoRoot) =>
      existsSync(join(repoRoot, "biome.json")) || existsSync(join(repoRoot, "biome.jsonc")),
    extensions: biomeExtensions,
    provides: [],
    provision: { packages: ["@biomejs/biome"] },
  },
  json: {
    // Always-on (no `detect`) so JSON gets schema validation in every repo. It overlaps Biome's
    // Json coverage where a biome config exists, but the two are complementary: Biome lints, this
    // Validates against schemas (package.json/tsconfig/SchemaStore); only raw syntax errors double
    // Up, and the per-file merge unions them.
    args: ["--stdio"],
    binary: "vscode-json-language-server",
    extensions: ["json", "jsonc"],
    provides: [],
    provision: { packages: ["vscode-langservers-extracted"] },
  },
  oxlint: {
    args: ["--lsp"],
    binary: "oxlint",
    extensions: codeExtensions,
    handshake: (repoRoot) => {
      // Oxlint validates only once it has workspace options; passing them inline (and answering
      // Its `workspace/configuration` pull defensively) makes it publish on didOpen. `run: onType`
      // Lints the open buffer; `configPath: null` finds `.oxlintrc.json` or uses defaults.
      const workspaceUri = pathToFileURL(repoRoot).href;
      const options = { configPath: null, run: "onType" };
      return {
        initializationOptions: [{ options, workspaceUri }],
        onRequest: (method, params) =>
          Effect.succeed(
            method === "workspace/configuration"
              ? configurationItems(params).map(() => options)
              : null,
          ),
        workspaceCapabilities: { configuration: true, workspaceFolders: true },
      };
    },
    provides: [],
    provision: { packages: ["oxlint"] },
  },
  typescript: {
    args: ["--stdio"],
    binary: "typescript-language-server",
    extensions: codeExtensions,
    provides: [
      "definition",
      "references",
      "hover",
      "documentSymbol",
      "callHierarchy",
      "implementation",
    ],
    provision: { packages: ["typescript-language-server", "typescript"] },
  },
  yaml: {
    args: ["--stdio"],
    binary: "yaml-language-server",
    extensions: ["yaml", "yml"],
    provides: [],
    provision: { packages: ["yaml-language-server"] },
  },
};

function configurationItems(params: unknown): unknown[] {
  return isObject(params) && Array.isArray(params.items) ? params.items : [];
}

/** Every language whose server handles this file's extension (typescript and oxlint overlap). */
export function serversForPath(path: string): string[] {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return [];
  }
  const extension = path.slice(dot + 1);
  return Object.keys(registry).filter((language) =>
    registry[language]?.extensions.includes(extension),
  );
}

/**
 * The registered languages whose repo gate (if any) accepts `repoRoot`. Evaluate once per run and
 * reuse across files: a gate may stat the filesystem (Biome's `detect`), so re-checking it per file
 * per snapshot emission would re-stat the same config repeatedly for an invariant result.
 */
export function activeLanguages(repoRoot: string): Set<string> {
  return new Set(
    Object.keys(registry).filter((language) => registry[language]?.detect?.(repoRoot) ?? true),
  );
}

/** Servers whose extension matches this path and whose repo gate (if any) accepts `repoRoot`. */
export function activeServersForPath(path: string, repoRoot: string): string[] {
  const active = activeLanguages(repoRoot);
  return serversForPath(path).filter((language) => active.has(language));
}

/** Servers for this path that statically declare they can answer `capability`, in registry order. */
export function serversProviding(path: string, capability: Capability): string[] {
  return serversForPath(path).filter((language) =>
    registry[language]?.provides.includes(capability),
  );
}

// The LSP `languageId` for `didOpen`, finer-grained than the server key so the server applies the
// Right grammar (tsx vs ts). Every registry extension needs an entry here, or `didOpen` sends
// `plaintext` and the server never analyzes the file.
const lspLanguageIdByExtension: Record<string, string> = {
  cjs: "javascript",
  css: "css",
  cts: "typescript",
  graphql: "graphql",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "javascriptreact",
  mjs: "javascript",
  mts: "typescript",
  ts: "typescript",
  tsx: "typescriptreact",
  yaml: "yaml",
  yml: "yaml",
};

export function lspLanguageId(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "plaintext" : (lspLanguageIdByExtension[path.slice(dot + 1)] ?? "plaintext");
}

// Discovery tiers: a repo-local binary or one on PATH wins; otherwise a server sideye has already
// Provisioned into its cache. A not-yet-provisioned server returns undefined (acquire then installs).
export function resolveServerCommand(language: string, repoRoot: string): string[] | undefined {
  const spec = registry[language];
  if (spec === undefined) {
    return undefined;
  }
  const repoOrPath = resolveBinary(repoRoot, spec.binary);
  if (repoOrPath !== undefined) {
    return [repoOrPath, ...spec.args];
  }
  const cached = cachedBinaryPath(language, spec.binary);
  if (existsSync(cached)) {
    return [cached, ...spec.args];
  }
  return undefined;
}

function provisionSpecFor(language: string): ProvisionSpec | undefined {
  const spec = registry[language];
  if (spec?.provision === undefined) {
    return undefined;
  }
  return { args: spec.args, binary: spec.binary, packages: spec.provision.packages };
}

export interface ServerHandle {
  readonly connection: LspConnection;
  /** Which read-only intents this server advertised; drives data-driven server selection. */
  readonly capabilities: ReadonlySet<Capability>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// LSP advertises a provider as `true` or an options object when supported, `undefined`/`false` when not.
const capabilityProviders = [
  ["definition", "definitionProvider"],
  ["references", "referencesProvider"],
  ["hover", "hoverProvider"],
  ["documentSymbol", "documentSymbolProvider"],
  ["callHierarchy", "callHierarchyProvider"],
  ["implementation", "implementationProvider"],
  ["pullDiagnostics", "diagnosticProvider"],
] as const satisfies readonly (readonly [Capability, string])[];

function parseCapabilities(initializeResult: unknown): Set<Capability> {
  const capabilities = isObject(initializeResult) ? initializeResult.capabilities : undefined;
  if (!isObject(capabilities)) {
    return new Set();
  }
  return new Set(
    capabilityProviders
      .filter(([, provider]) => {
        const advertised = capabilities[provider];
        return advertised === true || isObject(advertised);
      })
      .map(([capability]) => capability),
  );
}

/**
 * The LSP lifecycle handshake for a read-only client: `initialize` advertising only read-only
 * capabilities (diagnostics plus the code-intel pulls; no edit/format/rename), then `initialized`.
 * The server's advertised `*Provider`s decide which intents `capabilities` carries.
 */
export function performHandshake(
  connection: LspConnection,
  repoRoot: string,
  config?: HandshakeConfig,
) {
  return Effect.gen(function* handshake() {
    const result = yield* connection
      .request("initialize", {
        capabilities: {
          // Push diagnostics require advertising publishDiagnostics + synchronization, or servers
          // (E.g. typescript-language-server) stay silent. The definition/references/hover/symbol
          // Caps are the read-only code-intel pulls, all `textDocument/*` requests. No
          // Edit/format/rename: read-only. linkSupport lets definition reply with `LocationLink`s,
          // Which carry the symbol's name range. hierarchicalDocumentSymbolSupport is what makes a
          // Server return the nested `DocumentSymbol[]` (with `children`); without it it downgrades
          // To a flat `SymbolInformation[]` and the outline loses all nesting. A server only
          // Advertises `callHierarchyProvider` when the client advertises the matching client cap,
          // So it is declared here or the two-step prepare/resolve pull stays unavailable.
          textDocument: {
            callHierarchy: { dynamicRegistration: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            hover: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false, linkSupport: true },
            publishDiagnostics: { relatedInformation: true, versionSupport: false },
            references: { dynamicRegistration: false },
            synchronization: { didSave: false, dynamicRegistration: false },
          },
          // A server that pulls its settings (oxlint) needs the workspace caps advertised here.
          ...(config?.workspaceCapabilities === undefined
            ? {}
            : { workspace: config.workspaceCapabilities }),
          // Opt into server-driven progress so tsserver reports project-load begin/end; intel pulls
          // Gate on the "end" (see `whenProjectLoaded`), and without this it sends no progress at all.
          window: { workDoneProgress: true },
        },
        initializationOptions: config?.initializationOptions,
        processId: process.pid,
        rootUri: pathToFileURL(repoRoot).href,
        workspaceFolders: [{ name: "root", uri: pathToFileURL(repoRoot).href }],
      })
      .pipe(
        // A server that spawns but never answers initialize must not wedge the run.
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new LspRequestError({ message: "initialize timed out", method: "initialize" }),
          ),
        ),
      );
    yield* connection.notify("initialized", {});
    return {
      capabilities: parseCapabilities(result),
      connection,
    } satisfies ServerHandle;
  });
}

function connectServer(command: readonly string[], repoRoot: string, config?: HandshakeConfig) {
  return Effect.gen(function* connect() {
    const lsp = yield* LspProcess;
    const connection = yield* lsp.start(command, repoRoot, config?.onRequest);
    const handle = yield* performHandshake(connection, repoRoot, config);
    // Best-effort graceful teardown before the child is killed on scope close.
    yield* Effect.addFinalizer(() =>
      connection
        .request("shutdown")
        .pipe(Effect.andThen(connection.notify("exit")), Effect.timeout("1 second"), Effect.ignore),
    );
    return handle;
  });
}

// The pool key is "<language> <repoRoot>"; the language never contains a space, so the first space
// Is always the separator even when the repo path does. The explicit return type unifies the
// Ternary's two distinct Effect types into the one shape RcMap's lookup expects.
function lookupServer(
  key: string,
): Effect.Effect<
  ServerHandle,
  ServerUnavailable | LspSpawnError | LspRequestError,
  LspProcess | Scope.Scope
> {
  const separator = key.indexOf(" ");
  const language = key.slice(0, separator);
  const repoRoot = key.slice(separator + 1);
  const command = resolveServerCommand(language, repoRoot);
  if (command === undefined) {
    return Effect.fail(
      new ServerUnavailable({ language, message: `no language server for ${language}` }),
    );
  }
  return connectServer(command, repoRoot, registry[language]?.handshake?.(repoRoot));
}

export class LanguageServers extends Context.Service<
  LanguageServers,
  {
    readonly acquire: (
      language: string,
      repoRoot: string,
    ) => Effect.Effect<
      ServerHandle,
      ServerUnavailable | ServerInstalling | LspSpawnError | LspRequestError,
      Scope.Scope
    >;
  }
>()("sideye/LanguageServers") {}

type AcquireError = ServerUnavailable | ServerInstalling | LspSpawnError | LspRequestError;

export const LanguageServersLive = Layer.effect(
  LanguageServers,
  Effect.gen(function* languageServers() {
    const provisioner = yield* Provisioner;
    const pool = yield* RcMap.make({ idleTimeToLive: "30 seconds", lookup: lookupServer });

    // Connect through the warm pool; if the pooled server died (its stdout closed), evict it and
    // Bring up a fresh one, so a crash mid-session recovers on the next run.
    const fromPool = (language: string, repoRoot: string) => {
      const key = `${language} ${repoRoot}`;
      return RcMap.get(pool, key).pipe(
        Effect.flatMap((handle) =>
          handle.connection.closed.pipe(
            Effect.flatMap((isClosed) =>
              isClosed
                ? RcMap.invalidate(pool, key).pipe(Effect.andThen(RcMap.get(pool, key)))
                : Effect.succeed(handle),
            ),
          ),
        ),
      );
    };

    const acquire = (
      language: string,
      repoRoot: string,
    ): Effect.Effect<ServerHandle, AcquireError, Scope.Scope> =>
      Effect.suspend(() => {
        // A server already in the repo, on PATH, or provisioned into the cache: use it.
        if (resolveServerCommand(language, repoRoot) !== undefined) {
          return fromPool(language, repoRoot);
        }
        // Otherwise provision it (third tier); files stay pending until the download lands.
        const spec = provisionSpecFor(language);
        if (spec === undefined) {
          return Effect.fail(
            new ServerUnavailable({ language, message: `no language server for ${language}` }),
          );
        }
        return provisioner.ensure(language, spec).pipe(
          Effect.flatMap((state): Effect.Effect<ServerHandle, AcquireError, Scope.Scope> => {
            if (state.kind === "ready") {
              return fromPool(language, repoRoot);
            }
            if (state.kind === "installing") {
              return Effect.fail(new ServerInstalling({ language }));
            }
            if (state.kind === "failed") {
              return Effect.fail(new ServerUnavailable({ language, message: state.message }));
            }
            // Disabled: a server was needed but auto-download is off.
            return Effect.fail(
              new ServerUnavailable({
                language,
                message: `${language} server not found; auto-download is disabled`,
              }),
            );
          }),
        );
      });

    return { acquire };
  }),
);
