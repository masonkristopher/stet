import { describe, expect, test } from "bun:test";

import { relativeTime } from "@/utils/relative-time";

const NOW = 1_700_000_000;
const ago = (seconds: number) => relativeTime(NOW - seconds, NOW);

describe("relativeTime", () => {
  test("under a minute reads 'now'", () => {
    expect(ago(0)).toBe("now");
    expect(ago(59)).toBe("now");
  });

  test("minutes, hours, days", () => {
    expect(ago(60)).toBe("1m");
    expect(ago(59 * 60)).toBe("59m");
    expect(ago(60 * 60)).toBe("1h");
    expect(ago(23 * 60 * 60)).toBe("23h");
    expect(ago(24 * 60 * 60)).toBe("1d");
    expect(ago(6 * 24 * 60 * 60)).toBe("6d");
  });

  test("weeks, months, years", () => {
    expect(ago(7 * 24 * 60 * 60)).toBe("1w");
    expect(ago(29 * 24 * 60 * 60)).toBe("4w");
    expect(ago(30 * 24 * 60 * 60)).toBe("1mo");
    expect(ago(364 * 24 * 60 * 60)).toBe("12mo");
    expect(ago(365 * 24 * 60 * 60)).toBe("1y");
  });

  test("a future timestamp clamps to 'now'", () => {
    expect(relativeTime(NOW + 5000, NOW)).toBe("now");
  });
});
