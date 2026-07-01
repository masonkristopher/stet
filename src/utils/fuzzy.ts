export interface RankOptions {
  lastChangedAt: Map<string, number>;
  changed: Set<string>;
  limit: number;
}

// Splits by Unicode code point (not UTF-16 code unit), so a surrogate-pair
// Emoji stays one char instead of splitting into two.
function toChars(value: string): string[] {
  const chars: string[] = [];
  for (const char of value) {
    chars.push(char);
  }
  return chars;
}

// A per-string bitset of which ascii letters/digits/hyphens it contains,
// With a 2-bit saturating (0/1/2-or-more) count per letter. Comparing bags
// With a single bitwise AND rejects most non-matching candidates before the
// Real O(query * path) scan below ever runs. Never false-rejects a real
// Match: a bag can only under-count (saturating at 2), never over-count.
function buildCharBag(chars: string[]): bigint {
  let bag = 0n;
  for (const raw of chars) {
    const char = raw.toLowerCase();
    if (char >= "a" && char <= "z") {
      const shift = BigInt((char.charCodeAt(0) - 97) * 2);
      const count = (bag >> shift) & 3n;
      bag |= (((count << 1n) | 1n) & 3n) << shift;
    } else if (char >= "0" && char <= "9") {
      bag |= 1n << BigInt(char.charCodeAt(0) - 48 + 52);
    } else if (char === "-") {
      bag |= 1n << 62n;
    }
  }
  return bag;
}

function bagIsSuperset(candidate: bigint, query: bigint): boolean {
  return (candidate & query) === query;
}

// Splits a query into whitespace-separated terms: every term must
// Independently match somewhere in the path (AND, any relative order), so
// "agents keymap" finds ".agents/.../keymap/core.mdx". Deliberately no
// Backslash-escape for a literal space inside one term, and no quote/anchor/
// Negation modifiers — just plain per-term fuzzy matching.
function queryTerms(query: string): string[] {
  return query.split(/\s+/).filter((term) => term.length > 0);
}

// Requires every prepared term to score > 0 against the candidate (the same
// Gate `fuzzyMatch` used for a single term), short-circuiting on the first
// Failure, and sums the passing scores so a query that matches more terms,
// Or matches them better, ranks higher.
function matchPreparedTerms(prepared: QueryPrep[], candidate: Candidate): number | undefined {
  if (prepared.length === 0) {
    return 0;
  }

  let total = 0;
  for (const term of prepared) {
    if (!bagIsSuperset(candidate.bag, term.bag)) {
      return undefined;
    }

    const score = scorePath(term, candidate);
    if (score <= 0) {
      return undefined;
    }

    total += score;
  }

  return total;
}

interface QueryPrep {
  original: string[];
  lower: string[];
  bag: bigint;
  smartCase: boolean;
}

function prepareQuery(query: string): QueryPrep {
  const original = toChars(query);
  const lower = original.map((char) => char.toLowerCase());
  return {
    bag: buildCharBag(lower),
    lower,
    original,
    smartCase: original.some((char) => char !== char.toLowerCase()),
  };
}

interface Candidate {
  chars: string[];
  lower: string[];
  bag: bigint;
}

// Well above any repo this app targets (100k files), so a session never
// Evicts its current file set — only stale entries from paths renamed or
// Deleted since the process started, which would otherwise accumulate
// Forever (this module has no reload hook to clear them on a file-set change).
const CANDIDATE_CACHE_LIMIT = 200_000;

const candidateCache = new Map<string, Candidate>();

function candidateFor(path: string): Candidate {
  const cached = candidateCache.get(path);
  if (cached !== undefined) {
    return cached;
  }

  const chars = toChars(path);
  const lower = chars.map((char) => char.toLowerCase());
  const candidate = { bag: buildCharBag(lower), chars, lower };

  if (candidateCache.size >= CANDIDATE_CACHE_LIMIT) {
    const oldestPath = candidateCache.keys().next().value;
    if (oldestPath !== undefined) {
      candidateCache.delete(oldestPath);
    }
  }
  candidateCache.set(path, candidate);
  return candidate;
}

// The last position each query char could occupy while leaving enough room
// For the remaining query chars to still match; bounds the DP scan below and
// Doubles as a subsequence existence check (undefined when infeasible).
function findLastPositions(queryLower: string[], pathLower: string[]): number[] | undefined {
  const positions = Array.from<number>({ length: queryLower.length });
  let end = pathLower.length;

  for (let i = queryLower.length - 1; i >= 0; i -= 1) {
    const char = queryLower[i];
    let found = -1;
    for (let j = end - 1; j >= 0; j -= 1) {
      if (pathLower[j] === char) {
        found = j;
        break;
      }
    }
    if (found === -1) {
      return undefined;
    }
    positions[i] = found;
    end = found;
  }

  return positions;
}

const BASE_DISTANCE_PENALTY = 0.6;
const ADDITIONAL_DISTANCE_PENALTY = 0.05;
const MIN_DISTANCE_PENALTY = 0.2;

function isLowercaseLetter(char: string) {
  return char.toLowerCase() === char && char.toUpperCase() !== char;
}

function isUppercaseLetter(char: string) {
  return char.toUpperCase() === char && char.toLowerCase() !== char;
}

function isDigit(char: string) {
  return char >= "0" && char <= "9";
}

// A greedy left-to-right scan commits to the first plausible alignment and
// Can miss a better one (e.g. it can pick the stray "c" in "src" over the
// Real "cli" match); this instead searches every alignment via memoized
// Recursion and keeps the highest-scoring one. Score is the product of
// Per-character scores: 1.0 for a char immediately following the previous
// Match (a consecutive run), tapering bonuses for matches right after a
// Separator/case-transition/dot, and a distance penalty that decays with gap
// Size otherwise. The very first query char is additionally scaled down by
// How deep into the path it was found, so a basename hit outranks the same
// Letters scattered through parent directories.
function scorePath(query: QueryPrep, candidate: Candidate): number {
  const found = findLastPositions(query.lower, candidate.lower);
  if (found === undefined) {
    return 0;
  }
  // Rebound with an explicit non-nullable type: `found` narrows here, but TS
  // Does not carry that narrowing into the nested `recurse` closure below.
  const lastPositions: number[] = found;

  const pathLength = candidate.chars.length;
  const memo = Array.from<number | undefined>({ length: query.lower.length * pathLength });

  function recurse(queryIndex: number, pathIndex: number): number {
    if (queryIndex === query.lower.length) {
      return 1;
    }

    const safeLimit = Math.min(lastPositions[queryIndex], pathLength - 1);
    if (pathIndex > safeLimit) {
      return 0;
    }

    const memoKey = queryIndex * pathLength + pathIndex;
    const memoized = memo[memoKey];
    if (memoized !== undefined) {
      return memoized;
    }

    const queryChar = query.lower[queryIndex];
    let score = 0;
    let lastSlash = 0;

    for (let j = pathIndex; j <= safeLimit; j += 1) {
      const pathChar = candidate.lower[j];
      const isSeparator = pathChar === "/";
      if (queryIndex === 0 && isSeparator) {
        lastSlash = j;
      }

      if (pathChar !== queryChar && !(isSeparator && queryChar === "_")) {
        continue;
      }

      const curr = candidate.chars[j];
      let charScore = 1;
      if (j > pathIndex) {
        const last = candidate.chars[j - 1];
        if (last === "/") {
          charScore = 0.9;
        } else if (
          last === "-" ||
          last === "_" ||
          last === " " ||
          isDigit(last) ||
          (isLowercaseLetter(last) && isUppercaseLetter(curr))
        ) {
          charScore = 0.8;
        } else if (last === ".") {
          charScore = 0.7;
        } else if (queryIndex === 0) {
          charScore = BASE_DISTANCE_PENALTY;
        } else {
          charScore = Math.max(
            MIN_DISTANCE_PENALTY,
            BASE_DISTANCE_PENALTY - (j - pathIndex - 1) * ADDITIONAL_DISTANCE_PENALTY,
          );
        }
      }

      if ((query.smartCase || curr === "/") && query.original[queryIndex] !== curr) {
        charScore *= 0.001;
      }

      const multiplier = queryIndex === 0 ? charScore / (pathLength - lastSlash) : charScore;
      const branchScore = recurse(queryIndex + 1, j + 1) * multiplier;
      if (branchScore > score) {
        score = branchScore;
        if (branchScore === 1) {
          break;
        }
      }
    }

    memo[memoKey] = score;
    return score;
  }

  return recurse(0, 0) * query.lower.length;
}

export function fuzzyMatch(query: string, path: string): number | undefined {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  return matchPreparedTerms(terms.map(prepareQuery), candidateFor(path));
}

export function rankFiles(query: string, paths: string[], options: RankOptions): string[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [...paths]
      .toSorted((a, b) => {
        const recencyDelta =
          (options.lastChangedAt.get(b) ?? 0) - (options.lastChangedAt.get(a) ?? 0);
        if (recencyDelta !== 0) {
          return recencyDelta;
        }

        const changedDelta = (options.changed.has(b) ? 1 : 0) - (options.changed.has(a) ? 1 : 0);
        if (changedDelta !== 0) {
          return changedDelta;
        }

        return a.localeCompare(b);
      })
      .slice(0, options.limit);
  }

  const prepared = terms.map(prepareQuery);

  return paths
    .flatMap((path) => {
      const score = matchPreparedTerms(prepared, candidateFor(path));
      return score === undefined ? [] : [{ path, score }];
    })
    .toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, options.limit)
    .map((match) => match.path);
}
