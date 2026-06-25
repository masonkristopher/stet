import { describe, expect, test } from "bun:test";

import { formatCopyReference } from "../src/clipboard/reference";

describe("copy reference formatting", () => {
  test("formats path-only fallback", () => {
    expect(formatCopyReference({ path: "src/a.ts" })).toBe("src/a.ts");
  });

  test("formats path and line", () => {
    expect(formatCopyReference({ line: 2, path: "src/a.ts" })).toBe("src/a.ts:2");
  });
});
