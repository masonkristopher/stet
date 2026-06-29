import { afterEach, expect, test } from "bun:test";

import { batch } from "solid-js";

import { state } from "@/state";

// State is a global singleton shared across test files; restore the sidebar
// Defaults (open, no override, 80-col terminal) after each case.
afterEach(() => {
  batch(() => {
    state.setSidebarOpen(true);
    state.resetSidebarWidth();
    state.setTerminalWidth(80);
  });
});

test("with no override the width is the responsive default", () => {
  state.setTerminalWidth(80);
  expect(state.sidebarWidth()).toBe(34);
});

test("on a medium terminal the auto width is capped so growing never shrinks it", () => {
  // At 60 cols the responsive default (34) exceeds the viewer-preserving max (32),
  // So it caps to 32 and a grow nudge cannot push the rendered width below that.
  state.setTerminalWidth(60);
  expect(state.sidebarWidth()).toBe(32);

  state.nudgeSidebarWidth(2);
  expect(state.sidebarWidth()).toBe(32);
});

test("nudging seeds from the current width then steps by the delta", () => {
  state.setTerminalWidth(80);

  state.nudgeSidebarWidth(2);
  expect(state.sidebarWidth()).toBe(36);

  state.nudgeSidebarWidth(-4);
  expect(state.sidebarWidth()).toBe(32);
});

test("growing is clamped to the viewer-preserving max", () => {
  state.setTerminalWidth(80);

  state.nudgeSidebarWidth(100);
  expect(state.sidebarWidth()).toBe(52);
});

test("shrinking past the minimum collapses the sidebar instead of clamping", () => {
  state.setTerminalWidth(80);

  state.nudgeSidebarWidth(-100);
  expect(state.sidebarOpen()).toBe(false);
  expect(state.sidebarWidth()).toBe(0);
});

test("shrinking step by step rests at the minimum before collapsing", () => {
  state.setTerminalWidth(80);

  // 34 -> 24 lands on the minimum, still open
  state.nudgeSidebarWidth(-10);
  expect(state.sidebarOpen()).toBe(true);
  expect(state.sidebarWidth()).toBe(24);

  // One more step would dip below the minimum, so it collapses
  state.nudgeSidebarWidth(-2);
  expect(state.sidebarOpen()).toBe(false);
});

test("reset returns to the responsive default", () => {
  state.nudgeSidebarWidth(11);
  expect(state.sidebarWidth()).toBe(45);

  state.resetSidebarWidth();
  expect(state.sidebarWidth()).toBe(34);
});

test("a manual width survives a shrink-and-grow without overflowing", () => {
  state.setTerminalWidth(80);
  state.nudgeSidebarWidth(16);
  expect(state.sidebarWidth()).toBe(50);

  state.setTerminalWidth(40);
  expect(state.sidebarWidth()).toBe(24);

  state.setTerminalWidth(80);
  expect(state.sidebarWidth()).toBe(50);
});

test("a width set before collapsing is restored when the sidebar reopens", () => {
  state.setTerminalWidth(80);
  state.nudgeSidebarWidth(16); // 34 -> 50, stored
  state.nudgeSidebarWidth(-100); // Collapses, override untouched
  expect(state.sidebarOpen()).toBe(false);

  state.setSidebarOpen(true);
  expect(state.sidebarWidth()).toBe(50);
});

test("a closed sidebar has zero width regardless of override", () => {
  state.nudgeSidebarWidth(11);
  state.setSidebarOpen(false);
  expect(state.sidebarWidth()).toBe(0);
});
