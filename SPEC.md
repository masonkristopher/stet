# sideye: implementation spec

The README is the source of truth for what sideye does, its keys, and its non-goals. This file holds the invariants behind those features, the contract the README doesn't state. Read it before changing tree construction, the viewer, recency, diagnostics, scopes, or worktree handling.

## Architecture invariant

Git output is the synchronous source of truth. The git-backed file tree renders first; diagnostics arrive later as independent async decorations over the stable tree, so the basic view stays useful while checks run.

## Tree construction

- Source the tree from `git ls-files` (tracked) plus `git ls-files --others --exclude-standard` (untracked, gitignore respected), union'd with the changed set so staged deletions stay visible.
- Ordering is directories-first, then alphabetical, always: stable under polling by construction, so the list never reorders under the cursor.
- Flatten single-child directory chains into one row.
- Tag each changed file with its stage state (staged, unstaged, mixed, untracked) from `git status`.
- Include untracked files in the changed set (except in the `staged` scope) and render them as all-added diffs.
- Go-to-file (`ctrl-p`) searches the same file universe as the tree.

## Scopes

`sideye [ref]` defaults to `all` (worktree vs `HEAD`). `--staged` / `--unstaged` set the initial scope; `s` cycles. `unstaged` is plain `git diff` and ignores the ref.

## Worktrees

`w` switches the active worktree in place and re-points the tree, diffs, polling, and checks at it, with no restart. The picker lists worktrees and marks prunable ones. [confirm: source command for the list, and how a removed or pruned worktree is handled mid-session]

## Live view

Poll git and refresh the tree, diff, and file content while the user watches. Preserve selection by path and the cursor across refreshes; reset the cursor only on a file switch.

## Viewer

- Unchanged files render full content read-only. `v` toggles a changed file between diff and full content.
- Full files render through the diff viewer as synthesized all-context patches.
- Binary, missing, and oversized files render explicit placeholders, never raw bytes. `f` loads full content when truncated.
- `/` opens an in-buffer find over the rendered lines: smart-case substring match (case-insensitive unless the query has an uppercase char), `n`/`N` cycle, `esc` clears, and a file switch ends it. Matches are highlighted at the line level; the diff renderable exposes only per-line colors, so substring-range highlighting is out of scope until OpenTUI offers it.

## Content search

- `ctrl-f` opens a project content search backed by `git grep` (literal `-F`, smart-case, `-I` to skip binary, `--untracked` so it covers the tree's universe). It searches working-tree file content, not diffs.
- Scope defaults to the changed set (pathspec-limited to `git status`'s changed files, so it follows the active all/staged/unstaged scope); `ctrl-a` toggles between the changed set and the whole repo. Results group by file; `enter` routes through the same `jumpTarget` path as problems navigation, landing on the line and escalating to full-file view when the line is outside the diff.
- The query is debounced and runs through the interruptible `Process` service, holding the previous results until the new ones resolve. Results are capped to keep the panel bounded; hitting the cap is surfaced as a trailing `+` on the count.

## Recency

Recency markers come from an append-only in-memory activity event log (the seam for a future persistence layer). They decay silently: fresh under 5s, recent under 30s. `.` jumps to the latest activity. A scope switch is not activity.

## Diagnostics

- Diagnostics come from language servers (LSP) over stdio, collapsed into one source; each diagnostic keeps its LSP `source` label (e.g. `typescript`, `oxc`). The registry is data-driven and servers may overlap on a file type: `typescript-language-server` type-checks and `oxlint --lsp` lints the same JS/TS family, so a changed file runs through every server that claims its extension and the per-file results merge (union the findings; the strongest badge state wins, so a degraded server never overrides another's real result). Adding a disjoint language stays one registry entry plus its extensions.
- Push is the retrieval baseline. After `didOpen`, the server pushes `textDocument/publishDiagnostics`; the run waits for every opened document to publish (a short settle, capped, then `didClose`), and the client must advertise `publishDiagnostics` and `synchronization` in `initialize` or servers stay silent. A server that pulls its settings (oxlint) also needs `workspace.configuration` advertised and its `workspace/configuration` request answered, supplied per server in the registry. Pull diagnostics (`textDocument/diagnostic`) are a deferred enhancement for servers that advertise `diagnosticProvider`; the capability is detected but unused for now.
- Discovery has three tiers, preferring the target repo: a repo-local binary (`node_modules/.bin`), then one on `PATH`, then a server sideye downloads into its own cache (`~/.cache/sideye/lsp/<language>`) if neither is present, never `bunx`. The download is a one-time background `npm install`, deduped per language, so diagnostics work out-of-the-box without a manual server install (the way Zed and opencode provision); opt out with `--no-lsp-download` or `SIDEYE_NO_LSP_DOWNLOAD`. Each server is pooled per `(language, repoRoot)` and kept warm across the many poll-driven runs; a worktree switch re-keys to a fresh server, and a server that crashes mid-session is rebuilt on the next run.
- Formatting is intentionally not a diagnostic: it is an action, not a finding, and sideye only inspects.
- Retain findings for every reported path, not just changed files (a change can surface errors elsewhere).
- Surface in the problems panel (`p`), as inline line markers in the viewer, and as per-file markers in the tree. `n` jumps to the next file with findings.
- Late diagnostics fill badges and markers in place and never reorder the tree.
- Badge states are explicit: `pending`, `clean`, `findings`, `failed`, `unavailable`. Missing or empty diagnostics never render as clean: a file the server has not published for yet (cold start) or whose server is still downloading stays `pending` (clean means the server published an empty set), a file whose language has no server or whose server cannot start (or download is disabled) is `unavailable`, and a file that changes returns its badges to `pending` until checks re-run.
- Checks run at startup, on `r`, and automatically once the repo has been quiet for ~2s after activity. New-vs-baseline diagnostics are deferred.
