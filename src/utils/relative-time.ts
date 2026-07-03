const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * A timestamp as a compact age relative to `now` (both unix seconds): `now`, `5m`, `3h`, `2d`,
 * `3w`, `4mo`, `2y`. `now` is a parameter so callers stay testable.
 */
export function relativeTime(unixSeconds: number, now: number) {
  const elapsed = Math.max(0, now - unixSeconds);
  if (elapsed < MINUTE) {
    return "now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h`;
  }
  if (elapsed < WEEK) {
    return `${Math.floor(elapsed / DAY)}d`;
  }
  if (elapsed < MONTH) {
    return `${Math.floor(elapsed / WEEK)}w`;
  }
  if (elapsed < YEAR) {
    return `${Math.floor(elapsed / MONTH)}mo`;
  }
  return `${Math.floor(elapsed / YEAR)}y`;
}
