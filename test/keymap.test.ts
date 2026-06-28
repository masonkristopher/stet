import { afterEach, describe, expect, test } from "bun:test";

import { KeyEvent } from "@opentui/core";
import { batch } from "solid-js";

import { createKeyHandler } from "../src/keymap";
import { state } from "../src/state";

const keyEvent = (overrides: { ctrl?: boolean; name: string }) =>
  new KeyEvent({
    ctrl: false,
    eventType: "press",
    meta: false,
    number: false,
    option: false,
    raw: "",
    sequence: "",
    shift: false,
    source: "raw",
    ...overrides,
  });

describe("createKeyHandler", () => {
  const noop = async () => {};

  afterEach(() => {
    state.seedNav(undefined);
  });

  test("ctrl-c quits", () => {
    let quitCount = 0;
    const handle = createKeyHandler({ openInEditor: noop, quit: () => quitCount++ });

    handle(keyEvent({ ctrl: true, name: "c" }));

    expect(quitCount).toBe(1);
  });

  test("a plain c does not quit", () => {
    let quitCount = 0;
    const handle = createKeyHandler({ openInEditor: noop, quit: () => quitCount++ });

    handle(keyEvent({ name: "c" }));

    expect(quitCount).toBe(0);
  });

  test("e opens the selected file in terminal editor", () => {
    batch(() => state.seedNav("src/foo.ts"));
    const calls: [string, number | undefined, string][] = [];
    const handle = createKeyHandler({
      openInEditor: async (path, line, mode) => {
        calls.push([path, line, mode]);
      },
      quit: noop,
    });

    handle(keyEvent({ name: "e" }));

    expect(calls).toEqual([["src/foo.ts", undefined, "terminal"]]);
  });

  test("e does nothing when no file is selected", () => {
    const calls: unknown[] = [];
    const handle = createKeyHandler({
      openInEditor: async (...args) => {
        calls.push(args);
      },
      quit: noop,
    });

    handle(keyEvent({ name: "e" }));

    expect(calls).toEqual([]);
  });

  test("o opens the selected file in IDE", () => {
    batch(() => state.seedNav("src/bar.ts"));
    const calls: [string, number | undefined, string][] = [];
    const handle = createKeyHandler({
      openInEditor: async (path, line, mode) => {
        calls.push([path, line, mode]);
      },
      quit: noop,
    });

    handle(keyEvent({ name: "o" }));

    expect(calls).toEqual([["src/bar.ts", undefined, "ide"]]);
  });

  test("o does nothing when no file is selected", () => {
    const calls: unknown[] = [];
    const handle = createKeyHandler({
      openInEditor: async (...args) => {
        calls.push(args);
      },
      quit: noop,
    });

    handle(keyEvent({ name: "o" }));

    expect(calls).toEqual([]);
  });

  test("< steps back and > steps forward through history", () => {
    state.selectFile("a.ts");
    state.selectFile("b.ts");
    const handle = createKeyHandler({ openInEditor: noop, quit: noop });

    handle(keyEvent({ name: "<" }));
    expect(state.selectedPath()).toBe("a.ts");

    handle(keyEvent({ name: ">" }));
    expect(state.selectedPath()).toBe("b.ts");
  });

  test("ctrl-t pins; a later navigation opens a fresh preview; { } cycle; ctrl-w closes", () => {
    state.selectFile("a.ts");
    const handle = createKeyHandler({ openInEditor: noop, quit: noop });

    handle(keyEvent({ ctrl: true, name: "t" })); // Pin a.ts (no new tab yet)
    expect(state.tabItems().length).toBe(1);
    expect(state.tabItems()[0].preview).toBe(false);

    state.selectFile("b.ts"); // Fresh preview -> two tabs
    expect(state.tabItems().length).toBe(2);

    const activeBefore = state.tabItems().findIndex((tab) => tab.active);
    handle(keyEvent({ name: "{" }));
    expect(state.tabItems().findIndex((tab) => tab.active)).not.toBe(activeBefore);

    handle(keyEvent({ ctrl: true, name: "w" }));
    expect(state.tabItems().length).toBe(1);
  });

  test("ctrl-t does not fall through to the theme picker", () => {
    state.selectFile("a.ts");
    const handle = createKeyHandler({ openInEditor: noop, quit: noop });

    handle(keyEvent({ ctrl: true, name: "t" }));

    expect(state.themeComboboxOpen()).toBe(false);
  });
});
