import { describe, expect, test } from "bun:test";

import { darkTheme } from "@/theme/dark";
import {
  registerThemes,
  resolveThemes,
  restoreRegistry,
  selectThemeName,
  snapshotRegistry,
  themeForName,
  themeNames,
} from "@/theme/registry";

describe("themeForName", () => {
  test("returns a built-in by name", () => {
    expect(themeForName("dark")).toBe(darkTheme);
  });

  test("falls back to dark for an unknown name", () => {
    expect(themeForName("does-not-exist")).toBe(darkTheme);
  });
});

describe("selectThemeName", () => {
  test("uses the appearance when nothing is selected", () => {
    expect(selectThemeName(undefined, "light")).toBe("light");
  });

  test("a single name pins regardless of appearance", () => {
    expect(selectThemeName("gruvbox", "light")).toBe("gruvbox");
  });

  test("a pair follows the appearance", () => {
    expect(selectThemeName({ dark: "a", light: "b" }, "dark")).toBe("a");
    expect(selectThemeName({ dark: "a", light: "b" }, "light")).toBe("b");
  });
});

describe("themeNames", () => {
  test("includes the built-ins", () => {
    expect(themeNames()).toContain("dark");
    expect(themeNames()).toContain("light");
  });

  test("lists registered themes after the built-ins", () => {
    const snapshot = snapshotRegistry();
    try {
      registerThemes(resolveThemes({ "registry-probe": { base: "dark" } }).themes);
      const names = themeNames();

      expect(names).toContain("registry-probe");
      expect(names.indexOf("dark")).toBeLessThan(names.indexOf("registry-probe"));
    } finally {
      restoreRegistry(snapshot);
    }
  });
});

describe("resolveThemes", () => {
  test("accepts a full theme", () => {
    const { issues, themes } = resolveThemes({ mine: darkTheme });

    expect(issues).toEqual([]);
    expect(themes.get("mine")?.tokens).toEqual(darkTheme);
  });

  test("merges a base override, inheriting unspecified tokens", () => {
    const { issues, themes } = resolveThemes({
      soft: { accent: { primary: "#abcdef" }, base: "dark" },
    });

    expect(issues).toEqual([]);
    expect(themes.get("soft")?.tokens.accent.primary).toBe("#abcdef");
    expect(themes.get("soft")?.tokens.surface.base).toBe(darkTheme.surface.base);
  });

  test("resolves a base that is another custom theme", () => {
    const { issues, themes } = resolveThemes({
      child: { base: "parent", surface: { base: "#0a0a0a", cursor: "#0b0b0b", panel: "#0c0c0c" } },
      parent: { accent: { primary: "#abcdef" }, base: "dark" },
    });

    expect(issues).toEqual([]);
    expect(themes.get("child")?.tokens.accent.primary).toBe("#abcdef");
    expect(themes.get("child")?.tokens.surface.base).toBe("#0a0a0a");
  });

  test("a string syntax names a bundled theme and inherits through a base", () => {
    const { issues, themes } = resolveThemes({
      child: { base: "parent" },
      parent: { base: "dark", syntax: "catppuccin-mocha" },
    });

    expect(issues).toEqual([]);
    expect(themes.get("parent")?.syntaxTheme).toBe("catppuccin-mocha");
    expect(themes.get("child")?.syntaxTheme).toBe("catppuccin-mocha");
  });

  test("an object syntax overrides token colors (no bundled theme)", () => {
    const { issues, themes } = resolveThemes({
      mine: { base: "dark", syntax: { keyword: "#abcdef" } },
    });

    expect(issues).toEqual([]);
    expect(themes.get("mine")?.syntaxTheme).toBeUndefined();
    expect(themes.get("mine")?.tokens.syntax.keyword).toBe("#abcdef");
    expect(themes.get("mine")?.tokens.syntax.string).toBe(darkTheme.syntax.string);
  });

  test("reports an unknown bundled syntax theme but still resolves the tokens", () => {
    const { issues, themes } = resolveThemes({ mine: { base: "dark", syntax: "nope" } });

    expect(themes.get("mine")?.syntaxTheme).toBeUndefined();
    expect(themes.get("mine")?.tokens).toBeDefined();
    expect(issues.some((issue) => issue.includes("syntax theme"))).toBe(true);
  });

  test("reports an unknown base and skips the theme", () => {
    const { issues, themes } = resolveThemes({ mine: { base: "nope" } });

    expect(themes.has("mine")).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("nope");
  });

  test("an invalid shared base is reported once, not per referrer", () => {
    const { issues, themes } = resolveThemes({
      a: { base: "bad" },
      b: { base: "bad" },
      bad: { accent: { primary: "oops" } },
    });

    expect(themes.size).toBe(0);
    expect(issues.filter((issue) => issue.startsWith('theme "bad":'))).toHaveLength(1);
  });

  test("reports a circular base", () => {
    const { issues, themes } = resolveThemes({ a: { base: "b" }, b: { base: "a" } });

    expect(themes.size).toBe(0);
    expect(issues.some((issue) => issue.includes("circular"))).toBe(true);
  });

  test("reports an invalid override value", () => {
    const { issues, themes } = resolveThemes({
      mine: { accent: { primary: "red" }, base: "dark" },
    });

    expect(themes.has("mine")).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("accent");
  });

  test("reports an invalid full theme", () => {
    const { issues, themes } = resolveThemes({ mine: { accent: { primary: "#abcdef" } } });

    expect(themes.has("mine")).toBe(false);
    expect(issues).toHaveLength(1);
  });
});
