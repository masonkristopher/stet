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

  test("smart case: an uppercase query char outranks a mismatched case", () => {
    const exact = fuzzyMatch("Tree", "src/Tree.tsx");
    const wrongCase = fuzzyMatch("Tree", "src/tree.tsx");
    expect(exact ?? 0).toBeGreaterThan(wrongCase ?? 0);
  });

  test("an all-lowercase query stays case-insensitive", () => {
    expect(fuzzyMatch("tree", "src/Tree.tsx")).toBeDefined();
  });

  test("repeated query chars require the same count in the candidate", () => {
    expect(fuzzyMatch("ll", "src/all.ts")).toBeDefined();
    expect(fuzzyMatch("lll", "src/all.ts")).toBeUndefined();
  });
});

describe("multi-term queries", () => {
  const docPath = ".agents/skills/opentui/docs/keymap/core.mdx";

  test("each space-separated term matches a different part of the path", () => {
    expect(fuzzyMatch("agents keymap", docPath)).toBeDefined();
  });

  test("term order does not change the score", () => {
    expect(fuzzyMatch("agents keymap", docPath)).toBe(fuzzyMatch("keymap agents", docPath));
  });

  test("one non-matching term rejects the whole query", () => {
    expect(fuzzyMatch("agents zzz", docPath)).toBeUndefined();
  });

  test("leading, trailing, and repeated whitespace collapse between terms", () => {
    expect(fuzzyMatch("  git   ts  ", "src/git.ts")).toBeDefined();
  });

  test("an all-whitespace query matches everything with a neutral score", () => {
    expect(fuzzyMatch("   ", "src/App.tsx")).toBe(0);
  });

  test("a second matching term increases the score", () => {
    expect(fuzzyMatch("agents keymap", docPath) ?? 0).toBeGreaterThan(
      fuzzyMatch("keymap", docPath) ?? 0,
    );
  });

  test("a duplicated term may match the same characters twice", () => {
    expect(fuzzyMatch("git git", "src/git.ts")).toBeDefined();
  });

  test("terms can match disjoint parts of the same path", () => {
    expect(fuzzyMatch("src ts", "src/App.tsx")).toBeDefined();
  });

  test("smart case applies per term, not to the whole query", () => {
    expect(fuzzyMatch("Tree keymap", "src/Tree.tsx")).toBeUndefined();

    const exactSecondTerm = fuzzyMatch("Tree tsx", "src/Tree.tsx");
    const wrongCaseSecondTerm = fuzzyMatch("Tree tsx", "src/tree.tsx");
    expect(exactSecondTerm ?? 0).toBeGreaterThan(wrongCaseSecondTerm ?? 0);
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

  test("ranks a multi-term query, matching each term anywhere in the path", () => {
    const docPaths = [
      ".agents/skills/opentui/docs/keymap/core.mdx",
      "src/keymap.ts",
      ".agents/README.md",
      "src/App.tsx",
    ];

    const results = rankFiles("agents keymap", docPaths, noContext);
    expect(results).toContain(".agents/skills/opentui/docs/keymap/core.mdx");
    expect(results).not.toContain("src/App.tsx");
  });

  test("drops paths missing any term", () => {
    expect(rankFiles("git zzz", paths, noContext)).toEqual([]);
  });

  test("empty query over more paths than the limit equals the full-sort head", () => {
    const manyPaths = Array.from({ length: 500 }, (_, index) => {
      const dir = index % 3 === 0 ? "src" : index % 3 === 1 ? "test" : "docs";
      return `${dir}/f${String(index).padStart(3, "0")}.ts`;
    });
    const options = {
      changed: new Set(manyPaths.filter((_, index) => index % 7 === 0)),
      lastChangedAt: new Map(
        manyPaths.filter((_, index) => index % 5 === 0).map((path, index) => [path, 1000 + index]),
      ),
      limit: 50,
    };

    const fullSort = [...manyPaths]
      .toSorted((a, b) => {
        const recencyDelta =
          (options.lastChangedAt.get(b) ?? 0) - (options.lastChangedAt.get(a) ?? 0);
        if (recencyDelta !== 0) {
          return recencyDelta;
        }
        const changedDelta = (options.changed.has(b) ? 1 : 0) - (options.changed.has(a) ? 1 : 0);
        if (changedDelta !== 0) {
          return changedDelta;
        }
        return a.localeCompare(b);
      })
      .slice(0, options.limit);

    expect(rankFiles("", manyPaths, options)).toEqual(fullSort);
  });

  test("an all-whitespace query behaves exactly like an empty query", () => {
    const options = {
      changed: new Set(["test/git.test.ts"]),
      lastChangedAt: new Map([["src/git.ts", 1000]]),
      limit: 50,
    };

    expect(rankFiles("   ", paths, options)).toEqual(rankFiles("", paths, options));
  });
});
