import { expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "@/App";
import type { GitModel } from "@/git/model";

import { makeSettleUntil, seedState } from "./helpers";

const allScope = { kind: "all", ref: "HEAD" } as const;

const emptyModel: GitModel = {
  changed: [],
  changedByPath: new Map(),
  repoFiles: [],
  repoFilesKey: "",
  repoRoot: "",
  scopeKey: "",
};

// Startup paints the shell from the empty model before the git load resolves (the
// Non-blocking first paint), then seeds the model when it lands. An empty repoRoot
// And undefined selection must render without throwing — every effect (refresh,
// Diff, title, recovery) guards on that pre-load state.
test("renders the shell before any model is seeded", async () => {
  seedState(emptyModel, allScope);
  const { renderer, renderOnce, captureCharFrame } = await testRender(() => <App />, {
    height: 24,
    width: 100,
  });
  try {
    const settleUntil = makeSettleUntil({ captureCharFrame, renderOnce });

    // The status bar's quit hint is part of the always-present chrome, so it proves
    // The shell painted even with no files to show.
    const frame = await settleUntil("shell", (current) => current.includes("q quit"));
    expect(frame).toContain("q quit");
  } finally {
    renderer.destroy();
  }
});
