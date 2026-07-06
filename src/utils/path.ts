/**
 * An LSP `uri` decodes to an absolute path; stet's tree/viewer key off repo-relative paths. A path
 * outside the repo (a definition in `node_modules`) stays absolute, so callers can detect it.
 */
export function relativize(path: string, repoRoot: string) {
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return (path.startsWith(prefix) ? path.slice(prefix.length) : path).replace(/^\.\//, "");
}
