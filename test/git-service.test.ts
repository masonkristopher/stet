import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { EMPTY_TREE_SHA } from "@/git/model";
import { Git, GitLive } from "@/git/service";
import { ProcessLive } from "@/process";
import { stripGitEnv } from "@/utils/env";

import { createFixtureRepo, runGit } from "./helpers";

const allScope = { kind: "all", ref: "HEAD" } as const;

function revParse(repo: string, ref: string) {
  return execFileSync("git", ["rev-parse", ref], {
    cwd: repo,
    encoding: "utf8",
    env: stripGitEnv(process.env),
  }).trim();
}

test("Git.loadModel reports a modified file with churn counts", async () => {
  const repo = createFixtureRepo("git-service-modified-", { "a.txt": "one\n" });
  try {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const model = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.loadModel(repo, allScope)),
        Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
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
        Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
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
        Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
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
        Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
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
        Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
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
  runGit(repo, ["init"]);
  try {
    const resolved = await Effect.runPromise(
      Git.pipe(
        Effect.flatMap((git) => git.headRef(repo)),
        Effect.provide(GitLive.pipe(Layer.provide(ProcessLive))),
      ),
    );

    expect(resolved).toBe(EMPTY_TREE_SHA);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

// GIT_DIR overrides cwd-based repo discovery for any git invocation that inherits it, even
// One passed an explicit, correct cwd. A git hook (e.g. lefthook's pre-push) sets GIT_DIR in
// Its own environment so its own git commands target the right repo; a child process that
// Inherits that environment (any execFileSync without an explicit env) has its own, unrelated
// Git commands silently redirected to that same repo instead. This is what let dozens of
// Fixture-repo commits land on a real branch during a real `git push` (see PR description).
test("an inherited GIT_DIR silently redirects an unsanitized git invocation", () => {
  const decoy = createFixtureRepo("git-env-decoy-", { "a.txt": "one\n" });
  const other = mkdtempSync(join(tmpdir(), "git-env-hostile-"));
  const before = revParse(decoy, "HEAD");
  const hostileEnv = { ...process.env, GIT_DIR: join(decoy, ".git") };
  const gitConfig = ["-c", "user.name=Stet Test", "-c", "user.email=stet-test@example.com"];

  try {
    writeFileSync(join(other, "b.txt"), "two\n");
    execFileSync("git", [...gitConfig, "init"], { cwd: other, env: hostileEnv, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: other, env: hostileEnv, stdio: "ignore" });
    execFileSync("git", [...gitConfig, "commit", "-m", "leak"], {
      cwd: other,
      env: hostileEnv,
      stdio: "ignore",
    });

    // Proves the vulnerability is real: cwd pointed at `other` the whole time, yet the
    // Commit landed in `decoy` because GIT_DIR was inherited unsanitized.
    expect(revParse(decoy, "HEAD")).not.toBe(before);
  } finally {
    rmSync(decoy, { force: true, recursive: true });
    rmSync(other, { force: true, recursive: true });
  }
});

test("stripGitEnv neutralizes that same inherited GIT_DIR", () => {
  const decoy = createFixtureRepo("git-env-decoy2-", { "a.txt": "one\n" });
  const other = mkdtempSync(join(tmpdir(), "git-env-sanitized-"));
  const before = revParse(decoy, "HEAD");
  const hostileEnv = { ...process.env, GIT_DIR: join(decoy, ".git") };
  const gitConfig = ["-c", "user.name=Stet Test", "-c", "user.email=stet-test@example.com"];
  // The exact pattern runGit uses: an explicit, freshly-computed env replaces whatever the
  // Process inherited, rather than relying on execFileSync's default env passthrough.
  const opts = { cwd: other, env: stripGitEnv(hostileEnv), stdio: "ignore" as const };

  try {
    writeFileSync(join(other, "b.txt"), "two\n");
    execFileSync("git", [...gitConfig, "init"], opts);
    execFileSync("git", ["add", "."], opts);
    execFileSync("git", [...gitConfig, "commit", "-m", "child"], opts);

    expect(revParse(decoy, "HEAD")).toBe(before);
    expect(revParse(other, "HEAD")).not.toBe("");
  } finally {
    rmSync(decoy, { force: true, recursive: true });
    rmSync(other, { force: true, recursive: true });
  }
});
