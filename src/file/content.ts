import { readFileSync, statSync } from "node:fs";

export type FileContent =
  | { kind: "text"; content: string; lineCount: number; truncated: boolean }
  | { kind: "binary" }
  | { kind: "missing" }
  | { kind: "too-large"; bytes: number };

const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILE_LINES = 5000;

export interface LoadFileContentOptions {
  full: boolean;
  gitSpec?: string;
}

// Local-file reads only; the File service intercepts the gitSpec (git show) path
// And routes it through the Process service for interruptibility.
export function loadFileContent(
  repoRoot: string,
  path: string,
  options: { full: boolean },
): FileContent {
  const absolutePath = `${repoRoot}/${path}`;
  let size: number;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      return { kind: "binary" };
    }
    size = stat.size;
  } catch {
    return { kind: "missing" };
  }

  if (size > MAX_FILE_BYTES && !options.full) {
    return { bytes: size, kind: "too-large" };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    return { kind: "missing" };
  }

  return classifyFileBytes(buffer, options);
}

// Byte-level binary/size classification shared by the local-read path and the
// File service's git-show path, so deleted binaries are caught before decoding.
export function classifyFileBytes(bytes: Uint8Array, options: { full: boolean }): FileContent {
  if (bytes.byteLength > MAX_FILE_BYTES && !options.full) {
    return { bytes: bytes.byteLength, kind: "too-large" };
  }

  if (bytes.subarray(0, 8000).includes(0)) {
    return { kind: "binary" };
  }

  return textContent(new TextDecoder().decode(bytes), options.full);
}

export function textContent(content: string, full: boolean): FileContent {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = normalized === "" ? [] : normalized.split("\n");

  if (!full && lines.length > MAX_FILE_LINES) {
    return {
      content: lines.slice(0, MAX_FILE_LINES).join("\n"),
      kind: "text",
      lineCount: lines.length,
      truncated: true,
    };
  }

  return { content: normalized, kind: "text", lineCount: lines.length, truncated: false };
}

export function contentToContextPatch(path: string, content: string) {
  const header = [`--- a/${path}`, `+++ b/${path}`];
  if (content === "") {
    return header.join("\n");
  }

  const lines = content.split("\n");
  return [
    ...header,
    `@@ -1,${lines.length} +1,${lines.length} @@`,
    ...lines.map((line) => ` ${line}`),
  ].join("\n");
}
