import { describe, expect, test } from "bun:test";

import { mergeDeep } from "@/theme/merge";

describe("mergeDeep", () => {
  test("recurses into nested objects and replaces leaves", () => {
    expect(
      mergeDeep(
        { accent: { primary: "#000000" }, surface: { base: "#111111", panel: "#222222" } },
        { surface: { base: "#abcdef" } },
      ),
    ).toEqual({
      accent: { primary: "#000000" },
      surface: { base: "#abcdef", panel: "#222222" },
    });
  });

  test("adds keys the base does not have", () => {
    expect(mergeDeep({ a: "1" }, { b: "2" })).toEqual({ a: "1", b: "2" });
  });

  test("a non-object override replaces the base entirely", () => {
    expect(mergeDeep({ a: "1" }, "scalar")).toBe("scalar");
  });

  test("does not mutate the base", () => {
    const base = { surface: { base: "#111111" } };
    mergeDeep(base, { surface: { base: "#abcdef" } });
    expect(base.surface.base).toBe("#111111");
  });
});
