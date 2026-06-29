import { describe, expect, test } from "bun:test";

import { flattenLineSpans } from "@/diff/hast";

function span(color: string, value: string) {
  return {
    children: [{ type: "text", value }],
    properties: { style: `color:${color}` },
    type: "element",
  };
}

describe("flattenLineSpans", () => {
  test("flattens a line div of colored token spans into ordered spans", () => {
    const line = { children: [span("#F97583", "const"), span("#79B8FF", " b")], type: "element" };
    expect(flattenLineSpans(line)).toEqual([
      { fg: "#F97583", text: "const" },
      { fg: "#79B8FF", text: " b" },
    ]);
  });

  test("inherits color from an ancestor span when a child has none", () => {
    const line = {
      children: [
        {
          children: [{ type: "text", value: "nested" }],
          properties: { style: "color:#abcdef" },
          type: "element",
        },
      ],
      type: "element",
    };
    expect(flattenLineSpans(line)).toEqual([{ fg: "#abcdef", text: "nested" }]);
  });

  test("emits an uncolored span for plain text without a color style", () => {
    const line = { children: [{ type: "text", value: "plain" }], type: "element" };
    expect(flattenLineSpans(line)).toEqual([{ text: "plain" }]);
  });

  test("strips a trailing newline from the final span", () => {
    const line = { children: [span("#fff", "end\n")], type: "element" };
    expect(flattenLineSpans(line)).toEqual([{ fg: "#fff", text: "end" }]);
  });

  test("returns no spans for a missing or empty line node", () => {
    expect(flattenLineSpans(undefined)).toEqual([]);
    expect(flattenLineSpans({ children: [], type: "element" })).toEqual([]);
  });
});
