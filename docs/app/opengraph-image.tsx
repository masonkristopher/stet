import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ImageResponse } from "next/og";

export const alt = "stet: read-only companion TUI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Turbopack rewrites `require.resolve` to its own module id, so it cannot locate a file on disk;
 * `import.meta.url` it leaves alone. Resolve to a plain string rather than handing `node:fs` a
 * `URL`, which fails its `instanceof` check across the bundler's realm. The read itself stays
 * inside the render: Next imports this module for `alt`/`size` alone when building page metadata,
 * and that import must not touch the filesystem.
 */
const geistMonoPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-SemiBold.ttf",
);

let geistMonoPromise: Promise<Buffer> | undefined;

/**
 * Satori ships no monospace face, so the letters sit in fixed cells rather than trusting the font
 * to advance evenly, and the strike is a div rather than an unreliably colored `text-decoration`.
 * The cell, rule, and strike offsets are Geist Mono's own metrics, read from the TTF: a 0.6em
 * advance, and a 0.05em strikeout 0.32em above a baseline that half-leading drops 0.855em into a
 * 1em line box.
 */
const fontSize = 200;
const cell = fontSize * 0.6;
const rule = fontSize * 0.05;
const strikeTop = fontSize * (0.855 - 0.32) - rule / 2;
const overshoot = fontSize * 0.08;
const dotSize = fontSize * 0.1875;
const dotsTop = fontSize * 0.9375;

const letters = [
  { id: "s", letter: "s" },
  { id: "t1", letter: "t" },
  { id: "e", letter: "e" },
  { id: "t2", letter: "t" },
];

export default async function Image() {
  const geistMono = await (geistMonoPromise ??= readFile(geistMonoPath));

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "80px",
        backgroundColor: "#101214",
        fontFamily: "Geist Mono",
      }}
    >
      <div style={{ display: "flex", position: "relative", width: cell * letters.length }}>
        <div style={{ display: "flex" }}>
          {letters.map(({ id, letter }) => (
            <div
              key={id}
              style={{
                display: "flex",
                width: cell,
                height: fontSize,
                alignItems: "center",
                justifyContent: "center",
                fontSize,
                fontWeight: 600,
                lineHeight: 1,
                color: "#e9ebee",
              }}
            >
              {letter}
            </div>
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            top: strikeTop,
            left: -overshoot,
            right: -overshoot,
            height: rule,
            borderRadius: 9999,
            backgroundColor: "#5c5e60",
          }}
        />
        <div style={{ display: "flex", position: "absolute", top: dotsTop, left: 0, right: 0 }}>
          {letters.map(({ id }) => (
            <div key={id} style={{ display: "flex", width: cell, justifyContent: "center" }}>
              <div
                style={{
                  width: dotSize,
                  height: dotSize,
                  borderRadius: 9999,
                  backgroundColor: "#ffa7d9",
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", marginTop: 72, fontSize: 44, color: "#e9ebee" }}>
        read-only companion TUI
      </div>
      <div style={{ display: "flex", marginTop: 24, fontSize: 30, color: "#848688" }}>
        Inspect an agent's changes as they happen.
      </div>
    </div>,
    {
      ...size,
      fonts: [{ name: "Geist Mono", data: geistMono, weight: 600, style: "normal" }],
    },
  );
}
