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

export function latestActivity(log: ActivityLog): ActivityEvent | undefined {
  return log.events.at(-1);
}

export function recencyLevel(at: number | undefined, now: number): RecencyLevel {
  if (at === undefined || now - at >= RECENT_MS) {
    return "none";
  }

  return now - at < FRESH_MS ? "fresh" : "recent";
}
