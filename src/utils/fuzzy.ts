const separators = new Set(["/", ".", "-", "_"]);

export interface RankOptions {
  lastChangedAt: Map<string, number>;
  changed: Set<string>;
  limit: number;
}

export function fuzzyMatch(query: string, path: string): number | undefined {
  if (query === "") {
    return 0;
  }

  const q = query.toLowerCase();
  const p = path.toLowerCase();

  // Greedy scanning from the first occurrence alone mis-scores paths like
  // "src/cli.ts" for "cli" (the stray c in "src" eats the match), so try each
  // Occurrence of the first query char and keep the best alignment
  let best: number | undefined;
  for (let index = 0; index < p.length; index += 1) {
    if (p[index] !== q[0]) {
      continue;
    }

    const score = scanFrom(q, p, path, index);
    if (score !== undefined && (best === undefined || score > best)) {
      best = score;
    }
  }

  return best === undefined ? undefined : best - path.length * 0.01;
}

function scanFrom(q: string, p: string, path: string, start: number): number | undefined {
  const basenameStart = path.lastIndexOf("/") + 1;
  let score = 0;
  let queryIndex = 0;
  let lastMatch = -2;
  let allInBasename = true;

  for (let pathIndex = start; pathIndex < p.length && queryIndex < q.length; pathIndex += 1) {
    if (p[pathIndex] === q[queryIndex]) {
      score += 1;
      if (pathIndex === lastMatch + 1) {
        score += 3;
      }
      if (pathIndex === 0 || separators.has(p[pathIndex - 1] ?? "")) {
        score += 2;
      }
      if (pathIndex < basenameStart) {
        allInBasename = false;
      }
      lastMatch = pathIndex;
      queryIndex += 1;
    } else if (lastMatch >= 0) {
      score -= 0.05;
    }
  }

  if (queryIndex < q.length) {
    return undefined;
  }

  return allInBasename ? score + 5 : score;
}

export function rankFiles(query: string, paths: string[], options: RankOptions): string[] {
  if (query.trim() === "") {
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

  return paths
    .flatMap((path) => {
      const score = fuzzyMatch(query, path);
      return score === undefined ? [] : [{ path, score }];
    })
    .toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, options.limit)
    .map((match) => match.path);
}
