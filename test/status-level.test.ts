import { afterEach, expect, test } from "bun:test";

import { state } from "@/state";

// State is a global singleton; clear the held notice this test sets.
afterEach(() => state.setNotice(undefined));

test("a notice surfaces its text and level on the status line", () => {
  state.notify("copied src/state.ts", "success");

  expect(state.statusRight()).toBe("copied src/state.ts");
  expect(state.statusRightLevel()).toBe("success");
});

test("a notice defaults to the info level", () => {
  state.notify("showing all files");

  expect(state.statusRight()).toBe("showing all files");
  expect(state.statusRightLevel()).toBe("info");
});

test("an error notice carries the error level for the status bar to color", () => {
  state.notify("couldn't reach the language server", "error");

  expect(state.statusRightLevel()).toBe("error");
});
