import { Result, Schema } from "effect";
import { bundledThemesInfo } from "shiki/themes";

import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { mergeDeep } from "./merge";
import { ThemeSchema, type Theme } from "./tokens";

// Kept here, not imported from config, so theme/ stays free of a config
// Dependency; the config schema validates the matching shape.
export type ThemeSelection = string | { dark: string; light: string } | undefined;

// `syntaxTheme` (set when a theme's `syntax` is a bundled name) sources code colors
// From that theme; otherwise `tokens.syntax` does. `tokens` always drive the UI.
interface RegisteredTheme {
  tokens: Theme;
  syntaxTheme?: string;
}

const builtins: Record<string, RegisteredTheme> = {
  dark: { tokens: darkTheme },
  light: { tokens: lightTheme },
};

const registry = new Map<string, RegisteredTheme>(Object.entries(builtins));

const bundledThemeIds = new Set(bundledThemesInfo.map((theme) => theme.id));

export function themeForName(name: string): Theme {
  return registry.get(name)?.tokens ?? darkTheme;
}

export function syntaxThemeForName(name: string) {
  return registry.get(name)?.syntaxTheme;
}

export function hasTheme(name: string) {
  return registry.has(name);
}

// Built-ins first (`dark`, `light`), then user themes in registration order; `Map`
// Preserves insertion order, which is the order the switcher lists them in.
export function themeNames() {
  return [...registry.keys()];
}

// Test-only: the registry is a process-global map, so a test that registers themes
// Would leak them into later tests. Snapshot before and restore after to isolate.
export function snapshotRegistry() {
  return new Map(registry);
}

export function restoreRegistry(snapshot: ReturnType<typeof snapshotRegistry>) {
  registry.clear();
  for (const [name, theme] of snapshot) {
    registry.set(name, theme);
  }
}

export function selectThemeName(selection: ThemeSelection, appearance: "dark" | "light") {
  if (selection === undefined) {
    return appearance;
  }
  return typeof selection === "string" ? selection : selection[appearance];
}

export interface ResolvedThemes {
  themes: Map<string, RegisteredTheme>;
  issues: string[];
}

const decodeTheme = Schema.decodeUnknownResult(ThemeSchema);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve raw config theme entries into validated themes, applying `base` merges with cycle
 * detection. Anything wrong (invalid entry, unknown base or syntax theme, cycle) is reported in
 * `issues` rather than thrown, so one bad theme never sinks the rest.
 */
export function resolveThemes(raw: Record<string, unknown>): ResolvedThemes {
  const resolved = new Map<string, RegisteredTheme>();
  const failed = new Set<string>();
  const issues: string[] = [];

  const tokensOf = (name: string, candidate: unknown) =>
    Result.match(decodeTheme(candidate), {
      onFailure: (error) => {
        issues.push(`theme "${name}": ${String(error)}`);
        return undefined;
      },
      onSuccess: (theme) => theme,
    });

  const bundledOr = (name: string, value: string) => {
    if (bundledThemeIds.has(value)) {
      return value;
    }
    issues.push(`theme "${name}": unknown syntax theme ${JSON.stringify(value)}`);
    return undefined;
  };

  const resolve = (name: string, stack: string[]): RegisteredTheme | undefined => {
    const cached = resolved.get(name);
    if (cached !== undefined) {
      return cached;
    }
    if (failed.has(name)) {
      return undefined;
    }
    const entry = raw[name];
    if (entry === undefined) {
      // Not a user theme: a built-in is the only other source (used by `base`).
      return builtins[name];
    }
    if (stack.includes(name)) {
      issues.push(`theme "${name}" has a circular base`);
      failed.add(name);
      return undefined;
    }
    if (!isPlainObject(entry)) {
      tokensOf(name, entry); // Decode reports why a non-object entry isn't a theme
      failed.add(name);
      return undefined;
    }

    const { base: baseName, syntax: syntaxValue, ...uiTokens } = entry;

    const base = typeof baseName === "string" ? resolve(baseName, [...stack, name]) : undefined;
    if (typeof baseName === "string" && base === undefined) {
      issues.push(`theme "${name}": base "${baseName}" not found`);
      failed.add(name);
      return undefined;
    }

    let syntaxTheme: string | undefined;
    let overrides: Record<string, unknown> = {};
    if (typeof syntaxValue === "string") {
      syntaxTheme = bundledOr(name, syntaxValue);
    } else if (isPlainObject(syntaxValue)) {
      overrides = syntaxValue;
    } else if (syntaxValue === undefined) {
      syntaxTheme = base?.syntaxTheme;
    } else {
      issues.push(`theme "${name}": syntax must be a bundled theme name or a token map`);
    }

    const mergedUi = base === undefined ? uiTokens : mergeDeep(base.tokens, uiTokens);
    const syntax = mergeDeep(base?.tokens.syntax ?? darkTheme.syntax, overrides);
    const candidate = isPlainObject(mergedUi) ? { ...mergedUi, syntax } : mergedUi;

    const tokens = tokensOf(name, candidate);
    if (tokens === undefined) {
      failed.add(name);
      return undefined;
    }
    const record: RegisteredTheme = { syntaxTheme, tokens };
    resolved.set(name, record);
    return record;
  };

  for (const name of Object.keys(raw)) {
    resolve(name, []);
  }

  return { issues, themes: resolved };
}

export function registerThemes(themes: Map<string, RegisteredTheme>) {
  for (const [name, theme] of themes) {
    registry.set(name, theme);
  }
}
