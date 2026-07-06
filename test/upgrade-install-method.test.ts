import { describe, expect, test } from "bun:test";

import { classifyInstall } from "@/upgrade/install-method";

describe("classifyInstall", () => {
  test("detects Homebrew on Apple Silicon", () => {
    expect(classifyInstall("/opt/homebrew/Cellar/stet/0.3.1/bin/stet")).toBe("brew");
  });

  test("detects Homebrew on Intel", () => {
    expect(classifyInstall("/usr/local/Cellar/stet/0.3.1/bin/stet")).toBe("brew");
  });

  test("detects an npm global install", () => {
    expect(classifyInstall("/usr/lib/node_modules/stet-linux-x64/bin/stet")).toBe("npm");
  });

  test("treats a Homebrew-prefixed npm install as npm, not brew", () => {
    expect(
      classifyInstall(
        "/opt/homebrew/lib/node_modules/stet/node_modules/stet-darwin-arm64/bin/stet",
      ),
    ).toBe("npm");
  });

  test("detects the curl install directory", () => {
    expect(classifyInstall("/home/alice/.stet/bin/stet")).toBe("standalone");
  });

  test("detects an XDG bin install", () => {
    expect(classifyInstall("/home/alice/.local/bin/stet")).toBe("standalone");
  });

  test("returns unknown for an unrecognized path", () => {
    expect(classifyInstall("/usr/local/bin/stet")).toBe("unknown");
  });
});
