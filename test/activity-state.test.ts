import { afterEach, expect, test } from "bun:test";

import { emptyActivityLog } from "@/git/activity";
import { state } from "@/state";

// State is a global singleton shared across test files; reset what this test mutates
afterEach(() => state.setActivityLog(emptyActivityLog));

test("recencyByPath maps each path to its last activity timestamp", () => {
  state.setActivityLog({
    events: [
      { at: 1000, kind: "changed", path: "a.txt" },
      { at: 2000, kind: "changed", path: "a.txt" },
      { at: 1500, kind: "appeared", path: "b.txt" },
    ],
  });

  const recency = state.recencyByPath();
  expect(recency.get("a.txt")).toBe(2000);
  expect(recency.get("b.txt")).toBe(1500);
});
