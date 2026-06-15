import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, Layer, Stream } from "effect";

import { Diagnostics, DiagnosticsLive } from "../src/diagnostics/service";
import { ProcessLive } from "../src/process";
import { createFixtureRepo, loadModel } from "./helpers";

test("Diagnostics.run streams a state for each configured checker", async () => {
  const repo = createFixtureRepo("diag-service-", {
    "a.ts": "const a = 1\n",
    "package.json": `${JSON.stringify({ scripts: { lint: "exit 0", typecheck: "exit 0" } })}\n`,
  });
  try {
    writeFileSync(join(repo, "a.ts"), "const a = 2\n");
    const model = await loadModel(repo, { kind: "all", ref: "HEAD" });

    const updates = await Effect.runPromise(
      Diagnostics.pipe(
        Effect.flatMap((diagnostics) => Stream.runCollect(diagnostics.run(repo, model.changed))),
        Effect.provide(DiagnosticsLive.pipe(Layer.provide(ProcessLive))),
      ),
    );

    const checkers = [...updates].map((update) => update.checker);
    expect(checkers).toContain("lint");
    expect(checkers).toContain("typecheck");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});
