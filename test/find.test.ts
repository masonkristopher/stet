import { describe, expect, test } from "bun:test";

import { findMatches } from "@/utils/find";

const lines = ["const findMatches = () => {", "  return MATCHES;", "}", "// find me"];

describe("findMatches", () => {
  test("empty query matches nothing", () => {
    expect(findMatches(lines, "")).toEqual([]);
  });

  test("a lowercase query folds case", () => {
    expect(findMatches(lines, "matches")).toEqual([0, 1]);
  });

  test("an uppercase character makes the query case-sensitive", () => {
    expect(findMatches(lines, "MATCHES")).toEqual([1]);
  });

  test("returns every matching line index", () => {
    expect(findMatches(lines, "find")).toEqual([0, 3]);
  });

  test("a query with no hits returns no indices", () => {
    expect(findMatches(lines, "zzz")).toEqual([]);
  });
});
