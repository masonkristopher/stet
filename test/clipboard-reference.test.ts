import { describe, expect, test } from "bun:test";

import { formatCopyReference } from "@/clipboard/reference";

describe("copy reference formatting", () => {
  test("formats path-only fallback", () => {
    expect(formatCopyReference({ path: "src/a.ts" })).toBe("src/a.ts");
  });

  test("formats path and line", () => {
    expect(formatCopyReference({ line: 2, path: "src/a.ts" })).toBe("src/a.ts:2");
  });

  test("formats path, line, and column", () => {
    expect(formatCopyReference({ column: 7, line: 2, path: "src/a.ts" })).toBe("src/a.ts:2:7");
  });

  test("drops a column with no line", () => {
    expect(formatCopyReference({ column: 7, path: "src/a.ts" })).toBe("src/a.ts");
  });
});
