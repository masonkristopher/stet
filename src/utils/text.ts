export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateLeft(text: string, max: number) {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return max === 1 ? "…" : "";
  }
  return `…${text.slice(text.length - (max - 1))}`;
}

export function truncateName(name: string, max: number) {
  if (name.length <= max) {
    return name;
  }
  if (max <= 1) {
    return max === 1 ? "…" : "";
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const keep = max - 1 - ext.length;
  if (keep <= 0) {
    return `${name.slice(0, max - 1)}…`;
  }
  return `${name.slice(0, keep)}…${ext}`;
}

export function collapseHome(path: string) {
  const home = Bun.env.HOME;
  if (home === undefined || home === "") {
    return path;
  }
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
