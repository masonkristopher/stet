import { describe, expect, test } from "bun:test";

import {
  emptyActivityLog,
  FRESH_MS,
  lastChangedAt,
  latestActivity,
  recencyLevel,
  recordActivity,
  RECENT_MS,
} from "../src/git/activity";

describe("recordActivity", () => {
  test("returns the same log when nothing changed", () => {
    expect(recordActivity(emptyActivityLog, [], 1000)).toBe(emptyActivityLog);
  });

  test("appends events with the injected clock", () => {
    const log = recordActivity(emptyActivityLog, [{ kind: "changed", path: "a.ts" }], 1000);
    expect(log.events).toEqual([{ at: 1000, kind: "changed", path: "a.ts" }]);
  });

  test("caps the log at the most recent events", () => {
    let log = emptyActivityLog;
    for (let index = 0; index < 1200; index += 1) {
      log = recordActivity(log, [{ kind: "changed", path: `f${index}.ts` }], index);
    }

    expect(log.events.length).toBe(1000);
    expect(log.events[0]?.path).toBe("f200.ts");
  });
});

describe("derived views", () => {
  test("lastChangedAt keeps the latest timestamp per path", () => {
    let log = recordActivity(emptyActivityLog, [{ kind: "appeared", path: "a.ts" }], 1000);
    log = recordActivity(
      log,
      [
        { kind: "changed", path: "a.ts" },
        { kind: "changed", path: "b.ts" },
      ],
      2000,
    );

    expect(lastChangedAt(log).get("a.ts")).toBe(2000);
    expect(lastChangedAt(log).get("b.ts")).toBe(2000);
  });

  test("latestActivity returns the newest event", () => {
    let log = recordActivity(emptyActivityLog, [{ kind: "changed", path: "a.ts" }], 1000);
    log = recordActivity(log, [{ kind: "removed", path: "b.ts" }], 2000);

    expect(latestActivity(log)).toEqual({ at: 2000, kind: "removed", path: "b.ts" });
  });
});

describe("recencyLevel", () => {
  test("decays from fresh to recent to none", () => {
    expect(recencyLevel(1000, 1000)).toBe("fresh");
    expect(recencyLevel(1000, 1000 + FRESH_MS - 1)).toBe("fresh");
    expect(recencyLevel(1000, 1000 + FRESH_MS)).toBe("recent");
    expect(recencyLevel(1000, 1000 + RECENT_MS - 1)).toBe("recent");
    expect(recencyLevel(1000, 1000 + RECENT_MS)).toBe("none");
    expect(recencyLevel(undefined, 1000)).toBe("none");
  });
});
