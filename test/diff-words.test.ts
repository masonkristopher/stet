import { expect, test } from "bun:test";

import { firstWord, lastWord, nextWord, prevWord, wordAt, words, wordStarts } from "@/diff/words";

const line = "const user = getUser(id)";
// Words:        const(0-5) user(6-10) getUser(13-20) id(21-23)

test("splits a line into identifier runs, skipping punctuation and spaces", () => {
  expect(words(line)).toEqual([
    { end: 5, start: 0 },
    { end: 10, start: 6 },
    { end: 20, start: 13 },
    { end: 23, start: 21 },
  ]);
  expect(wordStarts(line)).toEqual([0, 6, 13, 21]);
});

test("treats unicode letters and digits, _ and $ as identifier characters", () => {
  expect(words("café $x _y2")).toEqual([
    { end: 4, start: 0 },
    { end: 7, start: 5 },
    { end: 11, start: 8 },
  ]);
});

test("keeps an astral identifier glyph whole (no surrogate-pair split)", () => {
  // "x𝐀y": 𝐀 (U+1D400) is a \p{L} letter spanning two UTF-16 units, so the word
  // Runs 0..4 (x=1, 𝐀=2, y=1) rather than breaking on the lone surrogate halves.
  const astral = "x\u{1D400}y";
  expect(words(astral)).toEqual([{ end: 4, start: 0 }]);
  expect(wordAt(astral, 1)).toEqual({ end: 4, start: 0 });
});

test("a blank or whitespace-only line has no words; the caret home is 0", () => {
  expect(words("   ")).toEqual([]);
  expect(wordStarts("")).toEqual([]);
  expect(firstWord("   ")).toBe(0);
  expect(firstWord(line)).toBe(0);
  expect(firstWord("  hi")).toBe(2);
});

test("firstWord and lastWord bracket the line's words for caret wrapping", () => {
  expect(firstWord(line)).toBe(0);
  expect(lastWord(line)).toBe(21);
  expect(lastWord("   ")).toBe(0);
  expect(lastWord("one")).toBe(0);
});

test("wordAt returns the owning word, or undefined inside a gap", () => {
  expect(wordAt(line, 0)).toEqual({ end: 5, start: 0 });
  expect(wordAt(line, 15)).toEqual({ end: 20, start: 13 }); // Mid getUser
  expect(wordAt(line, 5)).toBeUndefined(); // The space after const
  expect(wordAt(line, 20)).toBeUndefined(); // The "(" after getUser
  expect(wordAt(line, 99)).toBeUndefined();
});

test("nextWord hops to the following word start, then stays at the last", () => {
  expect(nextWord(line, 0)).toBe(6);
  expect(nextWord(line, 6)).toBe(13);
  expect(nextWord(line, 8)).toBe(13); // From mid-word
  expect(nextWord(line, 21)).toBe(21); // Already on the last word
});

test("prevWord hops to the preceding word start, then stays at the first", () => {
  expect(prevWord(line, 21)).toBe(13);
  expect(prevWord(line, 13)).toBe(6);
  expect(prevWord(line, 8)).toBe(6); // From mid-word jumps to that word's start
  expect(prevWord(line, 0)).toBe(0); // Already on the first word
});

test("from a gap with no word ahead/behind, the helpers stay put (so the caret wraps lines)", () => {
  // "x = y": words x(0), y(4). A trailing gap (index 5, past y) has no word ahead;
  // A leading gap (index 0 of "  x", before x at 2) has no word behind. Both must
  // Return the index unchanged so caretNextWord/caretPrevWord take the line-wrap branch.
  expect(nextWord("x = y", 5)).toBe(5);
  expect(prevWord("  x", 0)).toBe(0);
});
