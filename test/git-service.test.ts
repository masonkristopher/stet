import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { EMPTY_TREE_SHA } from "@/git/model";
import { Git, GitLive } from "@/git/service";
import { ProcessLive } from "@/process";

import { createFixtureRepo, runGit } from "./helpers";

const allScope = { kind: "all", ref: "HEAD" } as const;

function revParse(repo: string, ref: string) {
  return execFileSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).trim();
}

test("Git.loadModel reports a modified file with churn counts", async () => {
  const repo = createFixtureRepo("git-service-modified-", { "a.txt": "one\n" });
  try {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const model = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.loadModel(repo, allScope)),
        Effect.provide(GitLive),
        Effect.provide(ProcessLive),
      ),
    );

    const file = model.changed.find((entry) => entry.path === "a.txt");
    expect(file?.kind).toBe("modified");
    expect(file?.additions).toBe(1);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("Git.changedFiles includes an untracked file", async () => {
  const repo = createFixtureRepo("git-service-untracked-", { "tracked.txt": "x\n" });
  try {
    writeFileSync(join(repo, "new.txt"), "fresh\n");

    const result = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.changedFiles(repo, allScope)),
        Effect.provide(GitLive),
        Effect.provide(ProcessLive),
      ),
    );

    expect(result.changed.find((entry) => entry.path === "new.txt")?.kind).toBe("untracked");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("Git.parentRef returns the empty tree on a root commit", async () => {
  const repo = createFixtureRepo("git-service-rootcommit-", { "a.txt": "one\n" });
  try {
    const parent = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.parentRef(repo)),
        Effect.provide(GitLive),
        Effect.provide(ProcessLive),
      ),
    );

    expect(parent).toBe(EMPTY_TREE_SHA);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("Git.parentRef returns the prior commit's SHA when one exists", async () => {
  const repo = createFixtureRepo("git-service-parent-", { "a.txt": "one\n" });
  try {
    const first = revParse(repo, "HEAD");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    runGit(repo, ["commit", "-am", "second"]);

    const parent = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.parentRef(repo)),
        Effect.provide(GitLive),
        Effect.provide(ProcessLive),
      ),
    );

    expect(parent).toBe(first);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("Git.headRef returns the current HEAD SHA", async () => {
  const repo = createFixtureRepo("git-service-headref-", { "a.txt": "one\n" });
  try {
    const head = revParse(repo, "HEAD");

    const resolved = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.headRef(repo)),
        Effect.provide(GitLive),
        Effect.provide(ProcessLive),
      ),
    );

    expect(resolved).toBe(head);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

// The signal selectScope relies on to block last-commit when HEAD is unborn: a
// Real repo never yields the empty tree from headRef, so === EMPTY_TREE_SHA means
// "no commits yet".
test("Git.headRef returns the empty tree when HEAD is unborn", async () => {
  const repo = mkdtempSync(join(tmpdir(), "git-service-unborn-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  try {
    const resolved = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.headRef(repo)),
        Effect.provide(GitLive),
        Effect.provide(ProcessLive),
      ),
    );

    expect(resolved).toBe(EMPTY_TREE_SHA);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});
