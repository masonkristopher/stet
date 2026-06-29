import { describe, expect, test } from "bun:test";

import { lerpHex } from "@/utils/color";

describe("lerpHex", () => {
  test("returns the endpoints at t=0 and t=1", () => {
    expect(lerpHex("#ff4fb8", "#000000", 0)).toBe("#ff4fb8");
    expect(lerpHex("#ff4fb8", "#000000", 1)).toBe("#000000");
  });

  test("interpolates each channel at the midpoint", () => {
    expect(lerpHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("clamps t outside [0, 1] to the nearest endpoint", () => {
    expect(lerpHex("#112233", "#445566", -1)).toBe("#112233");
    expect(lerpHex("#112233", "#445566", 2)).toBe("#445566");
  });
});
