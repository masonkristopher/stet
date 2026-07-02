export type ActivityEventKind = "changed" | "appeared" | "removed";

export interface ActivityEvent {
  path: string;
  at: number;
  kind: ActivityEventKind;
}

export interface ActivityLog {
  events: ActivityEvent[];
}

export type RecencyLevel = "fresh" | "recent" | "none";

export const FRESH_MS = 5000;
export const RECENT_MS = 30_000;

const MAX_EVENTS = 1000;

export const emptyActivityLog: ActivityLog = { events: [] };

export function recordActivity(
  log: ActivityLog,
  entries: { path: string; kind: ActivityEventKind }[],
  now: number,
): ActivityLog {
  if (entries.length === 0) {
    return log;
  }

  const events = [
    ...log.events,
    ...entries.map((entry) => ({ at: now, kind: entry.kind, path: entry.path })),
  ];
  return { events: events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events };
}

export function lastChangedAt(log: ActivityLog) {
  return new Map(log.events.map((event) => [event.path, event.at]));
}

/**
 * Max descendant activity per directory (every ancestor gets a key), one pass over the recency map,
 * so a collapsed directory row does an O(1) lookup instead of scanning all entries per row.
 */
export function directoryRecency(recencyByPath: Map<string, number>) {
  const byDirectory = new Map<string, number>();
  for (const [path, at] of recencyByPath) {
    const parts = path.split("/");
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      const current = byDirectory.get(prefix);
      if (current === undefined || at > current) {
        byDirectory.set(prefix, at);
      }
    }
  }
  return byDirectory;
}

export function latestActivity(log: ActivityLog): ActivityEvent | undefined {
  return log.events.at(-1);
}

export function recencyLevel(at: number | undefined, now: number): RecencyLevel {
  if (at === undefined || now - at >= RECENT_MS) {
    return "none";
  }

  return now - at < FRESH_MS ? "fresh" : "recent";
}

/**
 * Position of an activity within its decay window, 0 (just now) to 1 (about to Age out), or
 * undefined once it has aged past RECENT_MS (no dot). Drives the Recency dot's continuous color
 * ramp.
 */
export function recencyFraction(at: number | undefined, now: number) {
  if (at === undefined) {
    return undefined;
  }

  const elapsed = now - at;
  return elapsed >= RECENT_MS ? undefined : Math.max(0, elapsed / RECENT_MS);
}
