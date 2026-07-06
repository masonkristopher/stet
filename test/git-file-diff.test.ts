import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DiffScope } from "@/cli";
import { structureDiff } from "@/diff/engine";
import type { NavigableLine } from "@/diff/rows";
import { diffArgs, untrackedDiffArgs } from "@/git/model";
import type { ChangedFile } from "@/git/model";
import { stripGitEnv } from "@/utils/env";

import { createFixtureRepo, loadFileDiff, loadModel, runGit } from "../test/helpers";

// The slow pathspec invocation this change replaced, captured directly so a test
// Asserts the in-process patch renders the same rows git's own diff would.
function pathspecDiff(repoRoot: string, scope: DiffScope, file: ChangedFile) {
  const args =
    file.kind === "untracked"
      ? untrackedDiffArgs(file.path).slice(1)
      : [
          ...diffArgs(scope).slice(1),
          "--",
          ...(file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]),
        ];
  // `git diff` exits 1 when there are differences (and always with --no-index),
  // Which execFileSync throws on; the patch text is still on stdout.
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: stripGitEnv(process.env),
    });
  } catch (error) {
    if (error !== null && typeof error === "object" && "stdout" in error) {
      return String(error.stdout);
    }
    throw error;
  }
}

function rows(patch: string): NavigableLine[] {
  return structureDiff({ full: true, maxLines: 4000, patch }).navigable;
}

async function changedFile(repoRoot: string, scope: DiffScope, path: string) {
  const model = await loadModel(repoRoot, scope);
  const file = model.changedByPath.get(path);
  if (file === undefined) {
    throw new Error(`${path} not in the ${scope.kind} changed set`);
  }
  return file;
}

// The in-process fileDiff and git's own pathspec diff must render identical rows.
// Row equality (not patch bytes) tolerates legitimate equal-cost hunk-placement
// Drift between jsdiff's Myers and git's xdiff.
async function expectSameRows(repoRoot: string, scope: DiffScope, path: string) {
  const file = await changedFile(repoRoot, scope, path);
  const inProcess = await loadFileDiff(repoRoot, scope, file);
  expect(rows(inProcess)).toEqual(rows(pathspecDiff(repoRoot, scope, file)));
  return inProcess;
}

const head = (repoRoot: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: stripGitEnv(process.env),
  }).trim();

describe("in-process fileDiff matches git", () => {
  test("modified file, all scope", async () => {
    const repoRoot = createFixtureRepo("stet-fd-mod-", {
      "src/a.ts": "one\ntwo\nthree\nfour\nfive\n",
    });
    writeFileSync(join(repoRoot, "src/a.ts"), "one\ntwo\nCHANGED\nfour\nfive\n");
    await expectSameRows(repoRoot, { kind: "all", ref: "HEAD" }, "src/a.ts");
  });

  test("modified file, unstaged scope diffs against the index", async () => {
    const repoRoot = createFixtureRepo("stet-fd-unstaged-", {
      "src/a.ts": "one\ntwo\nthree\n",
    });
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nstaged\nthree\n");
    runGit(repoRoot, ["add", "src/a.ts"]);
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nstaged\nworktree\n");
    await expectSameRows(repoRoot, { kind: "unstaged", ref: "HEAD" }, "src/a.ts");
  });

  test("staged edit does not leak the worktree edit stacked on top", async () => {
    const repoRoot = createFixtureRepo("stet-fd-staged-", {
      "src/a.ts": "one\ntwo\nthree\n",
    });
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nSTAGED\nthree\n");
    runGit(repoRoot, ["add", "src/a.ts"]);
    // A further worktree-only edit that must NOT appear in the staged diff.
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nSTAGED\nWORKTREE\n");

    const scope: DiffScope = { kind: "staged", ref: "HEAD" };
    const inProcess = await expectSameRows(repoRoot, scope, "src/a.ts");
    expect(inProcess).toContain("+STAGED");
    expect(inProcess).not.toContain("WORKTREE");
  });

  test("added file, staged scope", async () => {
    const repoRoot = createFixtureRepo("stet-fd-add-staged-", {
      "src/keep.ts": "keep\n",
    });
    writeFileSync(join(repoRoot, "src/new.ts"), "hello\nworld\n");
    runGit(repoRoot, ["add", "src/new.ts"]);
    await expectSameRows(repoRoot, { kind: "staged", ref: "HEAD" }, "src/new.ts");
  });

  test("added file tracked in the all scope", async () => {
    const repoRoot = createFixtureRepo("stet-fd-add-all-", {
      "src/keep.ts": "keep\n",
    });
    writeFileSync(join(repoRoot, "src/new.ts"), "hello\nworld\n");
    runGit(repoRoot, ["add", "src/new.ts"]);
    await expectSameRows(repoRoot, { kind: "all", ref: "HEAD" }, "src/new.ts");
  });

  test("deleted file, unstaged scope", async () => {
    const repoRoot = createFixtureRepo("stet-fd-del-", {
      "src/a.ts": "one\ntwo\nthree\n",
    });
    rmSync(join(repoRoot, "src/a.ts"));
    await expectSameRows(repoRoot, { kind: "unstaged", ref: "HEAD" }, "src/a.ts");
  });

  test("deleted file, staged scope (git rm)", async () => {
    const repoRoot = createFixtureRepo("stet-fd-del-staged-", {
      "src/a.ts": "one\ntwo\nthree\n",
    });
    runGit(repoRoot, ["rm", "src/a.ts"]);
    await expectSameRows(repoRoot, { kind: "staged", ref: "HEAD" }, "src/a.ts");
  });

  test("renamed file with an edit, staged scope", async () => {
    const repoRoot = createFixtureRepo("stet-fd-rename-", {
      "src/old.ts": "keep\nbefore\nkeep2\n",
    });
    runGit(repoRoot, ["mv", "src/old.ts", "src/new.ts"]);
    writeFileSync(join(repoRoot, "src/new.ts"), "keep\nafter\nkeep2\n");
    runGit(repoRoot, ["add", "src/new.ts"]);
    await expectSameRows(repoRoot, { kind: "staged", ref: "HEAD" }, "src/new.ts");
  });

  test("no trailing newline change", async () => {
    const repoRoot = createFixtureRepo("stet-fd-nonl-", {
      "a.txt": "line\n",
    });
    writeFileSync(join(repoRoot, "a.txt"), "line\nmore");
    await expectSameRows(repoRoot, { kind: "all", ref: "HEAD" }, "a.txt");
  });

  test("CRLF on both sides diffs in-process without falling back", async () => {
    const repoRoot = createFixtureRepo("stet-fd-crlf-", {
      "a.txt": "one\r\ntwo\r\nthree\r\n",
    });
    writeFileSync(join(repoRoot, "a.txt"), "one\r\nCHANGED\r\nthree\r\n");
    await expectSameRows(repoRoot, { kind: "all", ref: "HEAD" }, "a.txt");
  });

  test("path with spaces and non-ASCII characters", async () => {
    const repoRoot = createFixtureRepo("stet-fd-space-", {
      "src/a file café.ts": "one\ntwo\n",
    });
    writeFileSync(join(repoRoot, "src/a file café.ts"), "one\nCHANGED\n");
    await expectSameRows(repoRoot, { kind: "all", ref: "HEAD" }, "src/a file café.ts");
  });

  test("untracked file still routes through the /dev/null diff", async () => {
    const repoRoot = createFixtureRepo("stet-fd-untracked-", {
      "src/keep.ts": "keep\n",
    });
    writeFileSync(join(repoRoot, "src/new.ts"), "brand\nnew\n");
    const inProcess = await expectSameRows(
      repoRoot,
      { kind: "unstaged", ref: "HEAD" },
      "src/new.ts",
    );
    expect(rows(inProcess)).toEqual([
      { content: "brand", newLine: 1, oldLine: undefined, type: "add" },
      { content: "new", newLine: 2, oldLine: undefined, type: "add" },
    ]);
  });

  test("binary file renders empty, like git's Binary files differ", async () => {
    const repoRoot = createFixtureRepo("stet-fd-bin-", {
      "keep.ts": "keep\n",
    });
    writeFileSync(join(repoRoot, "img.bin"), new Uint8Array([1, 2, 0, 3, 255, 0, 7]));
    runGit(repoRoot, ["add", "img.bin"]);
    const scope: DiffScope = { kind: "staged", ref: "HEAD" };
    const file = await changedFile(repoRoot, scope, "img.bin");
    expect(file.binary).toBe(true);
    expect(rows(await loadFileDiff(repoRoot, scope, file))).toEqual([]);
  });

  test("last-commit scope diffs the two committed trees", async () => {
    const repoRoot = createFixtureRepo("stet-fd-lastcommit-", {
      "src/a.ts": "one\ntwo\nthree\n",
    });
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nCOMMITTED\nthree\n");
    writeFileSync(join(repoRoot, "src/added.ts"), "fresh\n");
    runGit(repoRoot, ["add", "."]);
    runGit(repoRoot, ["commit", "-m", "second"]);

    const parent = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: stripGitEnv(process.env),
    }).trim();
    const scope: DiffScope = { headRef: "HEAD", kind: "last-commit", ref: parent };
    await expectSameRows(repoRoot, scope, "src/a.ts");
    await expectSameRows(repoRoot, scope, "src/added.ts");
  });

  test("session scope diffs the worktree against the pinned base SHA across a commit", async () => {
    const repoRoot = createFixtureRepo("stet-fd-session-", {
      "src/a.ts": "one\ntwo\nthree\n",
    });
    const base = head(repoRoot);
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nCOMMITTED\nthree\n");
    runGit(repoRoot, ["add", "."]);
    runGit(repoRoot, ["commit", "-m", "mid-session commit"]);
    writeFileSync(join(repoRoot, "src/a.ts"), "one\nCOMMITTED\nWORKTREE\n");

    await expectSameRows(repoRoot, { kind: "session", ref: base }, "src/a.ts");
  });
});
