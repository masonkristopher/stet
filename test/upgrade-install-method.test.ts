import { describe, expect, test } from "bun:test";

import { classifyInstall } from "@/upgrade/install-method";

describe("classifyInstall", () => {
  test("detects Homebrew on Apple Silicon", () => {
    expect(classifyInstall("/opt/homebrew/Cellar/sideye/0.3.1/bin/sideye")).toBe("brew");
  });

  test("detects Homebrew on Intel", () => {
    expect(classifyInstall("/usr/local/Cellar/sideye/0.3.1/bin/sideye")).toBe("brew");
  });

  test("detects an npm global install", () => {
    expect(classifyInstall("/usr/lib/node_modules/sideye-linux-x64/bin/sideye")).toBe("npm");
  });

  test("treats a Homebrew-prefixed npm install as npm, not brew", () => {
    expect(
      classifyInstall(
        "/opt/homebrew/lib/node_modules/sideye/node_modules/sideye-darwin-arm64/bin/sideye",
      ),
    ).toBe("npm");
  });

  test("detects the curl install directory", () => {
    expect(classifyInstall("/home/alice/.sideye/bin/sideye")).toBe("standalone");
  });

  test("detects an XDG bin install", () => {
    expect(classifyInstall("/home/alice/.local/bin/sideye")).toBe("standalone");
  });

  test("returns unknown for an unrecognized path", () => {
    expect(classifyInstall("/usr/local/bin/sideye")).toBe("unknown");
  });
});
