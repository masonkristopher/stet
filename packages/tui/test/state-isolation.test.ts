import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { state } from "@/state";

import { createFixtureRepo, loadModel, runGit, seedState } from "./helpers";

// Bun runs every test file in one process, so `state` outlives each of them. A test that dies on a
// Timeout or a failed assertion never reaches its own cleanup, so whatever it set has to be undone
// For it. These two tests are ordered on purpose: the first leaves the state as a dead test would,
// The second asserts none of it survived. If the preload's reset ever goes away, the second fails,
// Which is the whole point (that leak once turned one dead render test into fifteen CI failures).
test("a dying test leaves the state dirty", () => {
  state.toggleBlame();
  state.setFindOpen(true);
  state.setQuitConfirmOpen(true);
  state.setProblemsOpen(true);
  state.setTerminalWidth(200);

  expect(state.blameEnabled()).toBe(true);
});

test("the next test still starts from the defaults", () => {
  expect(state.blameEnabled()).toBe(false);
  expect(state.findOpen()).toBe(false);
  expect(state.quitConfirmOpen()).toBe(false);
  expect(state.problemsOpen()).toBe(false);
  expect(state.terminalWidth()).toBe(80);
});

// A signal is not the only thing that survives a test. `notify` arms a timer that clears the notice
// 1.5s later, which lands inside whichever test is running by then, so the reset has to disarm it.
test("a dying test leaves a notice timer armed", () => {
  state.notify("stale notice");

  expect(state.statusRightMessage()).toContain("stale notice");
});

// This notice is set directly, so it carries no timer of its own to expire it. If it is gone by the
// Time the sleep ends, the only thing that could have cleared it is the previous test's timer.
test("the armed timer never fires into this test's notice", async () => {
  state.setNotice({ level: "info", text: "fresh notice" });
  await Bun.sleep(1700);

  expect(state.statusRightMessage()).toContain("fresh notice");
});

// The picker loads its worktrees, then writes its rows and kicks a summaries refresh, all after an
// Await. A reset landing in that window has to stop the whole chain: guarding only the refresh is
// Not enough, because it would merely start late, capture the new epoch, and pass its own check.
test("a worktree load in flight when a reset lands never writes into the next test", async () => {
  // The repo has to exist before it can be cleaned up, so its creation is the one step outside the
  // Try; everything that can fail after it (adding the peer worktree, loading, seeding) sits inside,
  // So a setup failure still takes the fixture directories with it.
  const repoRoot = createFixtureRepo("stet-isolation-", { "README.md": "# Fixture\n" });

  try {
    runGit(repoRoot, ["worktree", "add", "-b", "peer", `${repoRoot}-peer`]);
    const model = await loadModel(repoRoot, { kind: "all", ref: "HEAD" });
    seedState(model, { kind: "all", ref: "HEAD" });

    state.openWorktreePicker();
    state.resetState();
    await Bun.sleep(1500);

    expect(state.worktreeSummaries().size).toBe(0);
    expect(state.worktrees()).toBeUndefined();
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
    rmSync(`${repoRoot}-peer`, { force: true, recursive: true });
  }
}, 20_000);
