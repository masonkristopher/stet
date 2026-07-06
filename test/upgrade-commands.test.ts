import { describe, expect, test } from "bun:test";

import { upgradeInvocation } from "@/upgrade/commands";

describe("upgradeInvocation", () => {
  test("standalone re-runs the install script", () => {
    expect(upgradeInvocation("standalone")?.argv).toEqual([
      "bash",
      "-c",
      "curl -fsSL https://raw.githubusercontent.com/jimmy-guzman/stet/main/install.sh | bash",
    ]);
  });

  test("npm installs the latest published version", () => {
    expect(upgradeInvocation("npm")?.argv).toEqual(["npm", "install", "-g", "stet@latest"]);
  });

  test("brew upgrades the tap formula", () => {
    expect(upgradeInvocation("brew")?.argv).toEqual(["brew", "upgrade", "jimmy-guzman/tap/stet"]);
  });

  test("unknown has no command", () => {
    expect(upgradeInvocation("unknown")).toBeUndefined();
  });
});
