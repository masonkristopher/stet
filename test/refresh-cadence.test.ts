import { expect, test } from "bun:test";

import { refreshDelay } from "@/utils/refresh-cadence";

const NOW = 1_000_000;

test("polls fast while active when the watcher has never proven itself", () => {
  expect(refreshDelay({ lastChangeAt: NOW - 1000, lastWatcherTickAt: 0, now: NOW })).toBe(
    "750 millis",
  );
});

test("backs off when quiet and the watcher has never proven itself", () => {
  expect(refreshDelay({ lastChangeAt: NOW - 60_000, lastWatcherTickAt: 0, now: NOW })).toBe(
    "2 seconds",
  );
});

test("trusts the watcher (slow) when a recent change was caught by a recent tick", () => {
  expect(refreshDelay({ lastChangeAt: NOW - 500, lastWatcherTickAt: NOW - 500, now: NOW })).toBe(
    "5 seconds",
  );
});

test("falls back to fast when a recent change has no recent tick (watcher missed it)", () => {
  expect(
    refreshDelay({ lastChangeAt: NOW - 1000, lastWatcherTickAt: NOW - 60_000, now: NOW }),
  ).toBe("750 millis");
});

test("stays slow when idle even though the watcher proved itself earlier", () => {
  expect(
    refreshDelay({ lastChangeAt: NOW - 60_000, lastWatcherTickAt: NOW - 60_000, now: NOW }),
  ).toBe("5 seconds");
});
