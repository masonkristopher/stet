import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { logArgs, parseLog } from "@/git/log";
import { EMPTY_TREE_SHA } from "@/git/model";
import { Git, GitLive } from "@/git/service";
import { ProcessLive } from "@/process";

import { createFixtureRepo, runGit } from "./helpers";

const FIELD = "\x1f";
// A NUL-terminated `git log -z` stream: fields joined by 0x1F, commits by NUL.
const stream = (...rows: string[][]) => `${rows.map((fields) => fields.join(FIELD)).join("\0")}\0`;

describe("logArgs", () => {
  test("caps the log at the given limit and NUL-separates commits", () => {
    const args = logArgs(30);
    expect(args).toContain("-z");
    expect(args).toContain("--max-count=30");
    expect(args[0]).toBe("git");
    expect(args[1]).toBe("log");
  });

  test("the format carries sha, short sha, parents, author, time, and subject", () => {
    const format = logArgs(1).find((arg) => arg.startsWith("--format="));
    expect(format).toBe(`--format=%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%s`);
  });
});

describe("parseLog", () => {
  test("parses NUL-separated commits into fields", () => {
    const out = stream(
      ["aaa111", "aaa", "bbb222", "Jimmy", "1700000000", "fix: null guard"],
      ["bbb222", "bbb", "ccc333", "Alex", "1699990000", "refactor tree"],
    );
    expect(parseLog(out)).toEqual([
      {
        author: "Jimmy",
        authorTime: 1_700_000_000,
        parent: "bbb222",
        sha: "aaa111",
        shortSha: "aaa",
        subject: "fix: null guard",
      },
      {
        author: "Alex",
        authorTime: 1_699_990_000,
        parent: "ccc333",
        sha: "bbb222",
        shortSha: "bbb",
        subject: "refactor tree",
      },
    ]);
  });

  test("a root commit (no parents) bases on the empty tree", () => {
    const out = stream(["r00t", "r00", "", "Jimmy", "1699000000", "initial commit"]);
    expect(parseLog(out)[0]?.parent).toBe(EMPTY_TREE_SHA);
  });

  test("a merge commit bases on its first parent", () => {
    const out = stream(["merge1", "mer", "p1 p2", "Jimmy", "1699000000", "merge branch"]);
    expect(parseLog(out)[0]?.parent).toBe("p1");
  });

  test("keeps delimiters inside a subject intact", () => {
    const out = stream(["s1", "s1", "p", "Jimmy", "1699000000", "feat(x): a, b: c"]);
    expect(parseLog(out)[0]?.subject).toBe("feat(x): a, b: c");
  });

  test("empty output yields no commits", () => {
    expect(parseLog("")).toEqual([]);
  });
});

const runRecentCommits = (repo: string, limit: number) =>
  Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.recentCommits(repo, limit)),
      Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
    ),
  );

test("Git.recentCommits returns commits newest-first, root based on the empty tree", async () => {
  const repo = createFixtureRepo("git-log-repo-", { "a.txt": "one\n" });
  writeFileSync(join(repo, "b.txt"), "two\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "second"]);
  writeFileSync(join(repo, "c.txt"), "three\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "third"]);

  const commits = await runRecentCommits(repo, 30);

  expect(commits.map((commit) => commit.subject)).toEqual(["third", "second", "fixture"]);
  expect(commits.at(-1)?.parent).toBe(EMPTY_TREE_SHA);
  expect(commits[0]?.parent).toBe(commits[1]?.sha);
});

test("Git.recentCommits returns no commits for a commitless repo (unborn HEAD)", async () => {
  // `git log` exits 128 with no output here; it must surface as an empty list, not
  // An error, so the picker shows its empty state.
  const repo = mkdtempSync(join(tmpdir(), "git-log-empty-"));
  try {
    runGit(repo, ["init"]);
    expect(await runRecentCommits(repo, 30)).toEqual([]);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("Git.recentCommits caps at the limit", async () => {
  const repo = createFixtureRepo("git-log-limit-", { "a.txt": "one\n" });
  writeFileSync(join(repo, "b.txt"), "two\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "second"]);

  expect(await runRecentCommits(repo, 1)).toHaveLength(1);
});
