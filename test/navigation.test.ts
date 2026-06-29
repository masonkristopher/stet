import { describe, expect, test } from "bun:test";

import {
  back,
  canBack,
  canForward,
  closeTab,
  currentLocation,
  forward,
  initialNav,
  navigate,
  nextTab,
  openTab,
  pinTab,
  prevTab,
  previewTab,
  unpinTab,
  recall,
  recordCurrent,
  remember,
  selectTab,
} from "@/viewer/navigation";
import type { Location } from "@/viewer/navigation";

function loc(
  path: string,
  kind: "browse" | "jump" = "jump",
  over: Partial<Location> = {},
): Location {
  return {
    cursorLine: undefined,
    fileView: false,
    fullContent: false,
    kind,
    path,
    viewport: { scrollTop: 0, scrollX: 0 },
    ...over,
  };
}

const open = (nav: ReturnType<typeof initialNav>, path: string, kind: "browse" | "jump" = "jump") =>
  navigate(nav, loc(path, kind));

describe("history stack", () => {
  test("a fresh open pushes a new current entry", () => {
    const nav = open(initialNav(loc("a")), "b");
    expect(currentLocation(nav)?.path).toBe("b");
    expect(canBack(nav)).toBe(true);
    expect(canForward(nav)).toBe(false);
  });

  test("back then forward returns to where you were", () => {
    const nav = open(open(initialNav(loc("a")), "b"), "c");
    const backOne = back(nav);
    expect(currentLocation(backOne)?.path).toBe("b");
    expect(canForward(backOne)).toBe(true);
    expect(currentLocation(forward(backOne))?.path).toBe("c");
  });

  test("back is bounded at the first entry, forward at the last", () => {
    const nav = open(initialNav(loc("a")), "b");
    const atStart = back(back(nav));
    expect(currentLocation(atStart)?.path).toBe("a");
    expect(canBack(atStart)).toBe(false);
    expect(currentLocation(back(atStart))?.path).toBe("a");

    const atEnd = forward(forward(nav));
    expect(currentLocation(atEnd)?.path).toBe("b");
    expect(canForward(atEnd)).toBe(false);
  });

  test("opening after going back truncates the forward entries", () => {
    const nav = open(open(initialNav(loc("a")), "b"), "c");
    const reopened = open(back(nav), "d");
    expect(currentLocation(reopened)?.path).toBe("d");
    expect(canForward(reopened)).toBe(false);
    // "c" is gone: forward no longer reaches it.
    expect(currentLocation(back(reopened))?.path).toBe("b");
  });
});

describe("browse coalescing", () => {
  test("consecutive browse entries collapse into one", () => {
    const nav = open(open(open(initialNav(loc("a")), "b", "browse"), "c", "browse"), "d", "browse");
    expect(currentLocation(nav)?.path).toBe("d");
    // One step back from the coalesced browse head lands on the original "a".
    expect(currentLocation(back(nav))?.path).toBe("a");
    expect(canBack(back(nav))).toBe(false);
  });

  test("a jump after browsing pushes rather than coalescing", () => {
    const nav = open(open(initialNav(loc("a")), "b", "browse"), "c", "jump");
    expect(currentLocation(back(nav))?.path).toBe("b");
  });

  test("browse does not coalesce onto a forward-truncated middle entry", () => {
    // After going back, the head is not at the end of the stack, so a browse pushes.
    const nav = open(open(initialNav(loc("a")), "b"), "c");
    const browsed = open(back(nav), "d", "browse");
    expect(currentLocation(browsed)?.path).toBe("d");
    expect(currentLocation(back(browsed))?.path).toBe("b");
  });
});

describe("recordCurrent", () => {
  test("overwrites the current entry, so back restores the recorded spot", () => {
    const nav = open(initialNav(loc("a")), "b");
    const recorded = recordCurrent(
      nav,
      loc("b", "jump", { cursorLine: 42, viewport: { scrollTop: 9, scrollX: 3 } }),
    );
    const backOne = back(recorded);
    // The "b" entry we left now carries the recorded cursor/scroll.
    expect(currentLocation(forward(backOne))?.cursorLine).toBe(42);
    expect(currentLocation(forward(backOne))?.viewport).toEqual({ scrollTop: 9, scrollX: 3 });
  });

  test("is a no-op on an empty tab", () => {
    const empty = initialNav(undefined);
    expect(recordCurrent(empty, loc("a"))).toEqual(empty);
    expect(currentLocation(recordCurrent(empty, loc("a")))).toBeUndefined();
  });
});

describe("MRU viewports", () => {
  test("remember then recall returns the stored position", () => {
    const nav = remember(initialNav(loc("a")), "a", {
      cursorLine: 7,
      viewport: { scrollTop: 5, scrollX: 1 },
    });
    expect(recall(nav, "a")).toEqual({ cursorLine: 7, viewport: { scrollTop: 5, scrollX: 1 } });
    expect(recall(nav, "b")).toBeUndefined();
  });

  test("a back entry's own viewport can differ from the MRU for that path", () => {
    // Leaving "a" records scroll 9 into its entry; a later visit bumps the MRU to
    // 20. Going back must restore the entry's 9, not the MRU's 20.
    const left = recordCurrent(
      initialNav(loc("a")),
      loc("a", "jump", { viewport: { scrollTop: 9, scrollX: 0 } }),
    );
    const nav = remember(open(left, "b"), "a", {
      cursorLine: undefined,
      viewport: { scrollTop: 20, scrollX: 0 },
    });
    expect(currentLocation(back(nav))?.viewport.scrollTop).toBe(9);
    expect(recall(nav, "a")?.viewport.scrollTop).toBe(20);
  });
});

describe("preview / pin", () => {
  test("the seeded tab is a preview tab", () => {
    const nav = initialNav(loc("a"));
    expect(previewTab(nav)?.id).toBe("0");
  });

  test("pinTab clears the preview flag and is idempotent", () => {
    const pinned = pinTab(initialNav(loc("a")), "0");
    expect(previewTab(pinned)).toBeUndefined();
    expect(pinTab(pinned, "0")).toEqual(pinned);
  });

  test("unpinTab makes a tab the sole preview, discarding a stale preview", () => {
    // Tab 0 pinned (active), tab 1 a leftover preview.
    const nav = openTab(pinTab(initialNav(loc("a")), "0"), loc("b"), "1", true);
    const unpinned = unpinTab(nav, "0");
    expect(previewTab(unpinned)?.id).toBe("0");
    expect(unpinned.tabs.filter((tab) => tab.preview)).toHaveLength(1);
    expect(unpinned.tabs.some((tab) => tab.id === "1")).toBe(false);
  });

  test("a freshly opened preview tab is the only preview", () => {
    const nav = openTab(pinTab(initialNav(loc("a")), "0"), loc("b"), "1", true);
    expect(previewTab(nav)?.id).toBe("1");
    expect(nav.tabs.filter((tab) => tab.preview)).toHaveLength(1);
  });

  test("opening a new preview replaces the existing preview", () => {
    const nav = openTab(initialNav(loc("a")), loc("b"), "1", true);
    expect(nav.tabs).toHaveLength(1);
    expect(previewTab(nav)?.id).toBe("1");
  });

  test("closeTab and unpinTab are no-ops for an unknown id", () => {
    const nav = initialNav(loc("a"));
    expect(closeTab(nav, "nope")).toEqual(nav);
    expect(unpinTab(nav, "nope")).toEqual(nav);
  });
});

describe("tabs", () => {
  test("openTab appends a tab and activates it", () => {
    const nav = openTab(initialNav(loc("a")), loc("b"), "1", false);
    expect(nav.tabs).toHaveLength(2);
    expect(nav.activeTabId).toBe("1");
    expect(currentLocation(nav)?.path).toBe("b");
  });

  test("each tab keeps its own independent history", () => {
    let nav = navigate(initialNav(loc("a")), loc("c", "jump")); // Tab 0: a -> c
    nav = openTab(nav, loc("b"), "1", false); // Tab 1: b
    nav = selectTab(nav, "0");
    expect(currentLocation(nav)?.path).toBe("c");
    nav = back(nav);
    expect(currentLocation(nav)?.path).toBe("a");
    // Tab 1 stays untouched by tab 0's back.
    nav = selectTab(nav, "1");
    expect(currentLocation(nav)?.path).toBe("b");
    expect(canBack(nav)).toBe(false);
  });

  test("closeTab of the active rightmost tab activates the left neighbor", () => {
    let nav = openTab(openTab(initialNav(loc("a")), loc("b"), "1", false), loc("c"), "2", false);
    nav = closeTab(nav, "2");
    expect(nav.tabs).toHaveLength(2);
    expect(nav.activeTabId).toBe("1");
    expect(currentLocation(nav)?.path).toBe("b");
  });

  test("closeTab of an active middle tab activates the right neighbor", () => {
    let nav = openTab(openTab(initialNav(loc("a")), loc("b"), "1", false), loc("c"), "2", false);
    nav = selectTab(nav, "1");
    nav = closeTab(nav, "1");
    expect(nav.activeTabId).toBe("2");
  });

  test("closeTab of the last remaining tab reverts it to a preview", () => {
    const pinned = pinTab(initialNav(loc("a")), "0");
    const closed = closeTab(pinned, "0");
    expect(closed.tabs).toHaveLength(1);
    expect(previewTab(closed)?.id).toBe("0");
  });

  test("nextTab and prevTab cycle with wrap-around", () => {
    const two = openTab(initialNav(loc("a")), loc("b"), "1", false); // Active "1"
    expect(nextTab(two).activeTabId).toBe("0");
    expect(prevTab(two).activeTabId).toBe("0");
    const onZero = selectTab(two, "0");
    expect(nextTab(onZero).activeTabId).toBe("1");
    expect(prevTab(onZero).activeTabId).toBe("1");
  });

  test("selectTab ignores an unknown id", () => {
    const nav = initialNav(loc("a"));
    expect(selectTab(nav, "nope")).toEqual(nav);
  });
});

describe("initialNav", () => {
  test("seeds a single tab with the given location", () => {
    const nav = initialNav(loc("a"));
    expect(nav.tabs).toHaveLength(1);
    expect(currentLocation(nav)?.path).toBe("a");
    expect(canBack(nav)).toBe(false);
  });

  test("with no location seeds an empty single tab", () => {
    const nav = initialNav(undefined);
    expect(nav.tabs).toHaveLength(1);
    expect(currentLocation(nav)).toBeUndefined();
  });
});
