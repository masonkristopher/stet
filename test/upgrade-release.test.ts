import { describe, expect, test } from "bun:test";

import { formatUpdateNotice, isNewer, tagToVersion } from "@/upgrade/release";

describe("tagToVersion", () => {
  test("strips the release-please component prefix and the v", () => {
    expect(tagToVersion("stet-v0.4.0")).toBe("0.4.0");
  });

  test("strips a plain v prefix", () => {
    expect(tagToVersion("v0.4.0")).toBe("0.4.0");
  });

  test("leaves a bare version untouched", () => {
    expect(tagToVersion("0.4.0")).toBe("0.4.0");
  });

  test("returns undefined for a tag with no valid version", () => {
    expect(tagToVersion("nightly")).toBeUndefined();
  });
});

describe("isNewer", () => {
  test("a higher version is newer", () => {
    expect(isNewer("0.4.0", "0.3.3")).toBe(true);
  });

  test("an equal version is not newer", () => {
    expect(isNewer("0.3.3", "0.3.3")).toBe(false);
  });

  test("a lower version is not newer", () => {
    expect(isNewer("0.3.0", "0.3.3")).toBe(false);
  });

  test("a stable release is newer than its prerelease", () => {
    expect(isNewer("0.4.0", "0.4.0-rc.1")).toBe(true);
  });
});

describe("formatUpdateNotice", () => {
  test("stacks the versions, upgrade hint, and releases link on their own lines", () => {
    expect(formatUpdateNotice({ current: "0.3.3", latest: "0.4.0" }).split("\n")).toEqual([
      "A new release of stet is available: 0.3.3 -> 0.4.0",
      '  run "stet upgrade" to update',
      "  https://github.com/jimmy-guzman/stet/releases/latest",
    ]);
  });
});
