export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

// `git grep` over working-tree content. `-F` keeps the query literal (find, not
// Regex); smart-case mirrors the in-buffer find. `--untracked` widens the search
// To untracked-but-not-ignored files so it covers the same universe as the tree.
// A `paths` list scopes the search to the changed set; `undefined` is whole-repo.
export function searchArgs(query: string, paths: readonly string[] | undefined) {
  const smartCase = query === query.toLowerCase() ? ["-i"] : [];
  return [
    "git",
    "grep",
    "--no-color",
    "-I",
    "-n",
    "-z",
    "-F",
    "--untracked",
    ...smartCase,
    "-e",
    query,
    ...(paths === undefined ? [] : ["--", ...paths]),
  ];
}

// With `-n -z` each record is `path\0line\0text`, one per line. The text is a
// Single source line, so splitting on the first two NULs keeps colons and other
// Delimiters in the matched text intact.
export function parseSearchOutput(stdout: string): SearchMatch[] {
  return stdout
    .split("\n")
    .filter((record) => record !== "")
    .flatMap((record) => {
      const firstNul = record.indexOf("\0");
      const secondNul = record.indexOf("\0", firstNul + 1);
      if (firstNul === -1 || secondNul === -1) {
        return [];
      }
      const line = Number.parseInt(record.slice(firstNul + 1, secondNul), 10);
      return Number.isNaN(line)
        ? []
        : [{ line, path: record.slice(0, firstNul), text: record.slice(secondNul + 1) }];
    });
}
