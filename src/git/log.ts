import { EMPTY_TREE_SHA } from "./model";

export interface Commit {
  sha: string;
  shortSha: string;
  /** The first parent's SHA (the diff base), or the empty tree for a root commit. */
  parent: string;
  author: string;
  /** Author date in unix seconds. */
  authorTime: number;
  subject: string;
}

// Commits are NUL-separated (`-z`) and fields within a commit are split on the
// ASCII Unit Separator (0x1F), which never appears in a sha, a digit, an author
// Name, or a one-line subject. A bare `-z` with %x00 field separators could not
// Tell a field break from a commit break; 0x1F keeps the two unambiguous.
const FIELD = "\x1f";

export function logArgs(limit: number) {
  return [
    "git",
    "log",
    "-z",
    `--max-count=${limit}`,
    `--format=%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%s`,
  ];
}

export function parseLog(stdout: string): Commit[] {
  return stdout
    .split("\0")
    .filter((record) => record !== "")
    .flatMap((record) => {
      const [sha, shortSha, parents, author, authorTime, ...subject] = record.split(FIELD);
      const time = Number.parseInt(authorTime ?? "", 10);
      if (sha === undefined || Number.isNaN(time)) {
        return [];
      }
      return [
        {
          author: author ?? "",
          authorTime: time,
          parent: parents === undefined || parents === "" ? EMPTY_TREE_SHA : parents.split(" ")[0],
          sha,
          shortSha: shortSha ?? "",
          subject: subject.join(FIELD),
        },
      ];
    });
}
