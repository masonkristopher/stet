import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runUpgrade } from "@/upgrade/run";

// Only the up-to-date short-circuit is exercised here: it returns before any Bun.spawn, so it
// Stays network- and process-free. The newer / fetch-failure branches reduce to the predicate
// `latest === undefined || isNewer(...)`, covered by upgrade-release.test.ts; reaching them in
// `runUpgrade` would spawn a real npm/brew/curl. fetchLatestVersion (the only networked call) is
// Deliberately not unit-tested. The injected `fetchLatest` is the seam that keeps this offline.
describe("runUpgrade short-circuit", () => {
  const logs: string[] = [];
  const realLog = console.log;

  beforeEach(() => {
    logs.length = 0;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  });

  afterEach(() => {
    console.log = realLog;
  });

  test("does nothing and reports up to date when already on the latest version", async () => {
    const code = await runUpgrade({
      currentVersion: "0.3.3",
      execPath: "/home/alice/.local/bin/stet",
      fetchLatest: async () => "0.3.3",
    });

    expect(code).toBe(0);
    expect(logs.some((line) => line.includes("stet 0.3.3 is already up to date"))).toBe(true);
  });

  test("does nothing when the current version is ahead of the latest release", async () => {
    const code = await runUpgrade({
      currentVersion: "0.3.3",
      execPath: "/home/alice/.local/bin/stet",
      fetchLatest: async () => "0.3.0",
    });

    expect(code).toBe(0);
    expect(logs.some((line) => line.includes("stet 0.3.3 is already up to date"))).toBe(true);
  });
});
