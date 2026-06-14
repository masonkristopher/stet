import { describe, expect, test } from "bun:test";

import { fileIcon, folderIcon } from "../src/utils/file-icon";

describe("fileIcon", () => {
  test("matches by extension", () => {
    expect(fileIcon("main.ts")).toBe("\u{e8ca}");
    expect(fileIcon("App.tsx")).toBe("\u{e7ba}");
    expect(fileIcon("readme.css")).toBe("\u{e749}");
  });

  test("prefers an exact filename over its extension", () => {
    // Package.json is a json file, but the stem entry beats the .json extension glyph.
    expect(fileIcon("package.json")).toBe("\u{e718}");
    expect(fileIcon("package.json")).not.toBe(fileIcon("generic.json"));
  });

  test("matches dotfiles by full name", () => {
    expect(fileIcon(".gitignore")).toBe("\u{e702}");
  });

  test("is case-insensitive", () => {
    expect(fileIcon("MAIN.TS")).toBe(fileIcon("main.ts"));
    expect(fileIcon("Dockerfile")).toBe(fileIcon("dockerfile"));
  });

  test("falls back to a generic file glyph", () => {
    expect(fileIcon("notes.xyz")).toBe("\u{ea7b}");
    expect(fileIcon("AUTHORS")).toBe("\u{ea7b}");
  });
});

describe("folderIcon", () => {
  test("reflects expanded state", () => {
    expect(folderIcon(true)).toBe("\u{f07c}");
    expect(folderIcon(false)).toBe("\u{f07b}");
    expect(folderIcon(true)).not.toBe(folderIcon(false));
  });
});
