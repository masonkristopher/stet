import { beforeEach } from "bun:test";

import { preloadDiffHighlighter } from "@/diff/engine";
import { state } from "@/state";

// Tests never auto-download a language server (no network, no slow installs). The provisioner's own
// Tests toggle this explicitly and restore it.
process.env.STET_NO_LSP_DOWNLOAD = "1";

// Bun runs every test file in one process, so `state` (a singleton) outlives each file. A test that
// Dies mid-flight, on a timeout or a failed assertion, never reaches its own cleanup, and whatever
// It left set poisoned every file after it: one timed-out provenance test left the rail on, and the
// Blame inspector then owned the status bar in unrelated status tests. Registering here means this
// Runs before any file's own hooks, so no test can inherit another's state, however it ended.
beforeEach(() => {
  state.resetState();
});

// A production exit must become a test failure, never a successful early exit
// That lets Bun report a false green without its suite summary.
process.exit = (code) => {
  throw new Error(`unexpected process.exit(${String(code)}) during tests`);
};

// Warm the diff highlighter once so render tests don't race the one-time Shiki
// Load (the first diff would otherwise time out the settle helper).
await preloadDiffHighlighter();
