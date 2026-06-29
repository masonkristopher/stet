import { describe, expect, test } from "bun:test";

import { fuzzyMatch, rankFiles } from "@/utils/fuzzy";

const noContext = {
  changed: new Set<string>(),
  lastChangedAt: new Map<string, number>(),
  limit: 50,
};

describe("fuzzyMatch", () => {
  test("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("apptsx", "src/App.tsx")).toBeDefined();
    expect(fuzzyMatch("APP", "src/App.tsx")).toBeDefined();
  });

  test("rejects non-subsequences", () => {
    expect(fuzzyMatch("xyz", "src/App.tsx")).toBeUndefined();
    expect(fuzzyMatch("appz", "src/App.tsx")).toBeUndefined();
  });

  test("empty query matches everything with a neutral score", () => {
    expect(fuzzyMatch("", "src/App.tsx")).toBe(0);
  });

  test("basename matches outrank scattered path matches", () => {
    const basename = fuzzyMatch("git", "src/git.ts");
    const scattered = fuzzyMatch("git", "go/internal/types.ts");
    expect(basename).toBeDefined();
    expect(scattered).toBeDefined();
    expect(basename ?? 0).toBeGreaterThan(scattered ?? 0);
  });

  test("consecutive matches outrank gapped matches", () => {
    const consecutive = fuzzyMatch("tree", "src/tree.ts");
    const gapped = fuzzyMatch("tree", "test/render-mode.ts");
    expect(consecutive ?? 0).toBeGreaterThan(gapped ?? 0);
  });

  test("an early stray first char does not eat the real match", () => {
    // Greedy-from-first-occurrence would match the c in "src" and ruin the score
    expect(fuzzyMatch("cli", "src/cli.ts") ?? 0).toBeGreaterThan(
      fuzzyMatch("cli", "test/cli.test.ts") ?? 0,
    );
  });

  test("considers candidate starts after the first ten occurrences", () => {
    expect(fuzzyMatch("abc", "aaaaaaaaaa/src/abc.ts")).toBeDefined();
  });
});

describe("rankFiles", () => {
  const paths = ["src/App.tsx", "src/git.ts", "src/tree.ts", "test/git.test.ts", "README.md"];

  test("ranks by fuzzy score and respects the limit", () => {
    const results = rankFiles("git", paths, noContext);
    expect(results[0]).toBe("src/git.ts");
    expect(results).toContain("test/git.test.ts");
    expect(rankFiles("t", paths, { ...noContext, limit: 2 }).length).toBe(2);
  });

  test("the exact basename wins over its test file", () => {
    expect(rankFiles("git", ["test/git.test.ts", "src/git.ts"], noContext)[0]).toBe("src/git.ts");
  });

  test("ranks matches found after many candidate starts", () => {
    expect(rankFiles("abc", ["aaaaaaaaaa/src/abc.ts", "src/a-b-c.ts"], noContext)[0]).toBe(
      "aaaaaaaaaa/src/abc.ts",
    );
  });

  test("drops non-matching paths", () => {
    expect(rankFiles("zzz", paths, noContext)).toEqual([]);
  });

  test("empty query orders by recency, then changed, then name", () => {
    const results = rankFiles("", paths, {
      changed: new Set(["test/git.test.ts"]),
      lastChangedAt: new Map([
        ["src/tree.ts", 2000],
        ["src/git.ts", 1000],
      ]),
      limit: 50,
    });

    expect(results.slice(0, 3)).toEqual(["src/tree.ts", "src/git.ts", "test/git.test.ts"]);
    expect(results.slice(3)).toEqual(["README.md", "src/App.tsx"]);
  });
});
