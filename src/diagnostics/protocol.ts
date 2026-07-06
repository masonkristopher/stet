/**
 * LSP wire types for diagnostics and the mapping onto stet's domain `Diagnostic` shape. Pure: the
 * caller relativizes the absolute path later (via `stateForResolvedChecker`), mirroring how the tsc
 * parser emits absolute paths today.
 */
import { fileURLToPath } from "node:url";

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  /** 1 Error, 2 Warning, 3 Information, 4 Hint; omitted means the client decides. */
  severity?: number;
  message: string;
  source?: string;
  code?: number | string;
}

export interface MappedDiagnostic {
  path: string;
  line: number;
  /** 1-based start column (LSP `start.character` is a 0-based UTF-16 offset). */
  column: number;
  /** 1-based end of the range, kept for caret placement and future range highlighting. */
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

function mapSeverity(severity: number | undefined): "error" | "warning" | "info" {
  if (severity === 2) {
    return "warning";
  }
  if (severity === 3 || severity === 4) {
    return "info";
  }
  // Error (1) and an omitted severity both surface as an error.
  return "error";
}

export function mapLspDiagnostic(diagnostic: LspDiagnostic, uri: string): MappedDiagnostic {
  return {
    column: diagnostic.range.start.character + 1,
    endColumn: diagnostic.range.end.character + 1,
    endLine: diagnostic.range.end.line + 1,
    line: diagnostic.range.start.line + 1,
    message: diagnostic.message,
    path: fileURLToPath(uri),
    severity: mapSeverity(diagnostic.severity),
    source: diagnostic.source,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows an item from a diagnostic report to the fields the mapping reads. */
export function isLspDiagnostic(value: unknown): value is LspDiagnostic {
  if (!isObject(value) || typeof value.message !== "string" || !isObject(value.range)) {
    return false;
  }
  return isPosition(value.range.start) && isPosition(value.range.end);
}

function isPosition(value: unknown): value is LspPosition {
  return isObject(value) && typeof value.line === "number" && typeof value.character === "number";
}
