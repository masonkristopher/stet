import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import { parseSearchOutput, searchArgs } from "@/git/search";
import { Git, GitLive } from "@/git/service";
import { ProcessLive } from "@/process";

import { createFixtureRepo } from "./helpers";

describe("searchArgs", () => {
  test("a lowercase query is case-insensitive", () => {
    expect(searchArgs("needle", undefined)).toContain("-i");
  });

  test("an uppercase character makes the query case-sensitive", () => {
    expect(searchArgs("Needle", undefined)).not.toContain("-i");
  });

  test("whole-repo search passes no pathspec", () => {
    expect(searchArgs("needle", undefined)).not.toContain("--");
  });

  test("changed-scope search limits to the given paths", () => {
    const args = searchArgs("needle", ["src/a.ts", "src/b.ts"]);
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "src/a.ts", "src/b.ts"]);
  });
});

describe("parseSearchOutput", () => {
  test(String.raw`parses NUL-framed path\0line\0text records`, () => {
    const output = "src/a.ts\x002\x00  const needle = 1\nsrc/b.ts\x0010\x00return needle\n";
    expect(parseSearchOutput(output)).toEqual([
      { line: 2, path: "src/a.ts", text: "  const needle = 1" },
      { line: 10, path: "src/b.ts", text: "return needle" },
    ]);
  });

  test("keeps colons and other delimiters inside the matched text", () => {
    expect(parseSearchOutput("a.ts\x005\x00const url = `http://x`\n")).toEqual([
      { line: 5, path: "a.ts", text: "const url = `http://x`" },
    ]);
  });

  test("empty output yields no matches", () => {
    expect(parseSearchOutput("")).toEqual([]);
  });
});

const runSearch = (repo: string, query: string, paths: readonly string[] | undefined) =>
  Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.search(repo, query, paths)),
      Effect.provide(GitLive),
      Effect.provide(ProcessLive),
    ),
  );

test("Git.search finds tracked and untracked content repo-wide", async () => {
  const repo = createFixtureRepo("git-search-repo-", { "src/a.ts": "const needle = 1\n" });
  try {
    writeFileSync(join(repo, "src", "b.ts"), "return needle\n");

    const matches = await runSearch(repo, "needle", undefined);

    expect(matches.map((match) => match.path).toSorted()).toEqual(["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("Git.search limits to the changed pathspec and is smart-case", async () => {
  const repo = createFixtureRepo("git-search-scope-", {
    "src/a.ts": "const needle = 1\n",
    "src/c.ts": "const needle = 2\n",
  });
  try {
    const changed = await runSearch(repo, "needle", ["src/a.ts"]);
    expect(changed.map((match) => match.path)).toEqual(["src/a.ts"]);

    const cased = await runSearch(repo, "NEEDLE", undefined);
    expect(cased).toEqual([]);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});
