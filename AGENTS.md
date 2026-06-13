# Agent instructions

`sideye` is a read-only companion TUI for CLI coding agents (claude code, opencode, codex). You run an agent in one terminal pane and `sideye` in another to inspect what changed: everything an IDE shows you, nothing it does for you. **It only inspects. It never reviews, explains, approves, rejects, gates, talks to an agent, or writes to the repo.** That constraint shapes every change here.

See `README.md` for what sideye does, its keys, and its non-goals; see `SPEC.md` for the implementation invariants behind those features. Read SPEC before changing tree construction, the viewer, recency, diagnostics, scopes, or worktrees.

## Stack

- Bun for runtime, scripts, dependencies, tests, and build.
- TypeScript with `strict` enabled.
- `@opentui/core` and `@opentui/react`; JSX configured with `jsxImportSource: "@opentui/react"`.
- Git output is the source of truth for the file map: the initial model loads at startup before the first render, and the poll keeps it current. The git-backed file map renders before any checker or diagnostic resolves; diagnostics are independent async decorations over the stable git file list, never blocking it.
- v1 is macOS-first (clipboard via `pbcopy`).

## Conventions

- Read the relevant `SKILL.md` under `.agents/skills` before related work: `bun` before any dependency/script/build change, `opentui` before any OpenTUI code.
- Prefer `bun run`, `bun test`, `bun install`, `bun add`, `bun add -d`, `bun remove`, `bun build`. No Node/npm/Jest/esbuild wrappers unless explicitly requested. Runtime flags go before `run` (e.g. `bun --watch run <script>`).
- Keep `bun.lock` changes paired with dependency changes. Declare direct dependencies in `package.json`; don't rely on transitive ones.
- Lint and format are oxlint and oxfmt (`bun run lint`, `bun run format`); do not add ESLint or Prettier.
- Dead exports are caught by knip (`bun run knip`, also part of `bun run check`). Remove the `export` keyword rather than suppressing.
- Use `===` and `!==`; never `== null` or `!= null`.
- No explicit return type annotations unless needed for exported API clarity, recursion, overloads, or inference limits.
- Rely on type inference; avoid explicit annotations or interfaces unless needed for exports or clarity, and inline single-use values rather than naming them.
- Prefer `const`; use ternaries or early returns instead of reassignment, and early returns instead of `else`.
- Prefer functional array methods (`map`/`filter`/`flatMap`) over loops; use type guards on `filter` to keep inference downstream.
- Use Bun APIs where they exist (`Bun.file`, and so on).
- Never alias imports (no `import { x as y }`).
- Prefer dynamic imports for heavy modules on startup-sensitive paths; bind them at the top of the narrowest scope that needs them, and keep branch-specific imports inside their branch so the git tree renders before anything heavy loads.
- Do not reach for `as`, `!`, or `any` without first exhausting proper solutions.
- Do not silence lint or type errors with rule overrides or casts. Fix the root cause.
- Comments are JSDoc or `TODO`/`FIXME` only; keep them sparse and useful, and do not narrate obvious code.
- Prefer small typed modules (git parsing, diagnostics, clipboard, CLI args, UI state), and structured parsing over ad hoc string manipulation when a command offers machine-readable output.
- Conventional commit style for commits and PR titles: `type(scope): summary`, with types `feat`/`fix`/`docs`/`chore`/`refactor`/`test` and an optional scope.
- No AI-generated sign-offs in commits, PR text, docs, or generated content.

## Effect conventions

State and async work use Effect v4 (beta). `effect` and `@effect/atom-react` are pinned to exact, matching beta versions and move together; `effect/unstable/*` can break on minor bumps.

- Wrap existing pure functions in services; do not rewrite the pure logic, so its tests stay intact.
- Define services with `Context.Service` plus a `Layer` (there is no `Effect.Service` in v4); define errors with `Data.TaggedError`, one tag per distinct failure. Domain IO lives in `src/services/`; effect-backed atoms run through the shared `runtime` in `src/atoms/runtime.ts`.
- Prefer the data-last pipe form for combinators (`x.pipe(Effect.flatMap(f))`) over the data-first form (`Effect.flatMap(x, f)`); the two-argument data-first form trips `unicorn/no-array-method-this-argument`.
- All app state lives in atoms under `src/atoms/` (writable, derived, and effect-backed); `App` holds no `useState` or `useMemo`, it reads atoms and owns only effects and refs. Components read atoms via `@effect/atom-react` hooks. Atoms initialized from props or startup are seeded with `useAtomInitialValues` in `App`.
- The keymap dispatches through the atom registry: `createKeyHandler(registry, ctx)` reads and writes atoms via `registry.get`/`registry.set` (call them as methods, never destructured, to keep `this`), so a keypress sees the latest state, not a render-time snapshot. The `ctx` carries only non-atom dependencies.
- Long-running effect work (the git poll, the diagnostics run) uses fiber interruption for cancellation: a `runtime.fn` atom's latest call interrupts the prior fiber. Do not reintroduce manual `AbortController` or generation-counter bookkeeping.
- Every subprocess runs through the `Process` service (`src/services/process.ts`), an interruptible `Effect.acquireUseRelease` over `Bun.spawn` whose release kills the child; the git, file, and clipboard services and the startup load all compose it. There is no synchronous `Bun.spawnSync` path. Retry only transient git failures (the `index.lock` class), bounded, via `Effect.retry`; do not blanket-retry, a bad ref should fail fast.
- A `runtime.fn` atom dispatched from the keymap through `registry.set` only runs while the atom is mounted, so `App` mounts each one with `useAtomMount` (e.g. `copyAtom`, `loadWorktreesAtom`). An unmounted dispatch silently no-ops.

## Code design

- **Extraction is a design decision, not a refactor.** When you see duplication, surface it and propose. Do not extract shared helpers, types, or components unprompted, regardless of usage count. Whether two similar blocks are one concept or two is a judgment you don't have the context to make alone.
- **Inline by default; extract only when it earns a name.** Don't pull out single-use helpers preemptively: inline at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller. When a function grows several branches, let the main function read as the happy path and move supporting detail into small named helpers (`requireConfig`, `readMetadata`) kept just below it.
- **No speculative generality.** Don't add config options, generic parameters, or extension points for use cases that don't exist yet. The right abstraction for a future need is almost never the one you'd guess before seeing it.
- **Duplication is cheaper than the wrong abstraction.** Code that looks similar isn't necessarily the same thing. Deduping two unrelated pieces couples their futures; when one needs to change and the other doesn't, the abstraction has to grow conditionals or split back apart, both of which are worse than having kept them separate.

## Testing

- **Test behavior, not implementation.** Assert what a caller or user observes, not how the code achieves it. "Caller" and "user" scale with the unit under test: for a component it's the person clicking, for a function it's the code calling it. Tests that assert internals break on every refactor and prove nothing about whether the code works.
- **Prefer clarity over DRY in tests.** Inline setup, repeat literals, skip shared fixtures when they'd obscure the case under test. A test's job is to be readable in isolation; the pull toward DRY that makes production code better usually makes tests worse.
- **Test real behavior, not hypothetical behavior.** Cover the cases the contract actually promises. Do not manufacture edge cases the code doesn't claim to handle just to pad coverage.
- **Avoid mocks.** Test the actual implementation; reach for a mock only when a real dependency is genuinely unavailable, and never duplicate the code's own logic into the test.

## Writing

- **No em dashes.** Use a comma, period, or restructure the sentence instead.
- **No horizontal rules as section dividers.** Don't use `---` to separate sections when a heading is already doing that job. Exception: `---` is fine as a thematic break when there is no heading on either side.
- **No curly/smart quotes in prose.** Use straight quotes (`"`) not curly quotes. Applies to prose only; code blocks are verbatim and exempt.
- **Sentence case subheadings.** Write `## Like this` not `## Like This`. Exception: proper nouns and acronyms follow their standard casing.

## Docs

- **After introducing a new pattern, feature, convention, or structural change, ask whether `AGENTS.md` and/or `README.md` should be updated, then apply the changes.** Docs rot the moment the code moves without them. Catching the update at the point of change is the only time it reliably happens.

## Deciding what to do

Judge every piece of work by whether it **should** be done (is it correct, is the current state wrong or inconsistent, does it serve the goal), and **never by ROI, cost, effort, or "is it worth it."** Do not label a known-wrong thing "low-value," "marginal," "an edge case," or "not worth it" to justify leaving it unfixed; reasoning by ROI is exactly what keeps work mediocre. ("The reference / competitor also gets it wrong" is a _gap_ argument, not a correctness one; it never makes a wrong thing acceptable.)

The only valid reason to stop short of doing the right thing is that it **provably cannot** be done: a demonstrated limit of the model or tools, not an assumed or cost-based one. "Hard," "heavy," "expensive," or "a lot of work" is never a reason to stop; "proven impossible / blocked" is. When unsure which it is, find out (try it, measure it, prove it) before deciding, and never declare a limit you have not proven.

Present choices by correctness and feasibility (real impossibilities, real _capability_ tradeoffs like portability or expressiveness), not by ROI.

## Fixing bugs

Assume a correct architecture has no bugs, so every bug is evidence that the architecture _permits_ it to exist, not merely that one code path is wrong. **Before fixing any bug, first diagnose the root cause: ask why the architecture allowed this bug to exist at all,** and whether it is one instance of a whole _class_ of bugs the same structure would keep producing.

Prefer fixes that remove the structural condition that let the bug exist, so this bug and others like it can no longer occur, over patches at the symptom layer (a guard, a special case, or a workaround that leaves the enabling structure in place). Reach for a symptom-layer patch only when the root-cause fix is **provably** infeasible or genuinely belongs in a separate change, never merely because it is larger or harder; when you do, say so and name the root cause you are deferring.

This is a thinking-first rule, not a mandate to refactor on every fix: the root-cause analysis is **always** required; reshaping the architecture to act on it is frequent but conditional on its being the right and feasible move.

## Pausing

- **Between phases:** after completing a discrete chunk of work, stop. Post a short summary, then ask before starting the next.
- **On uncertainty:** if a decision is not covered by existing rules or context, do not invent. Stop and ask.
- **On a debug loop:** if the same error persists after 3 consecutive fix attempts, stop. Report the error, what was tried, and the likely cause. Do not attempt a fourth fix without input.

## Scope guardrails (v1)

Do not implement an LSP client, web preview, PR workflow, accept/reject protocol, agent integration, or a database. The tool must work in any git repo, not only this one or agent-created worktrees.

## Verification

- `bun run check`: default pre-submit command.
- `bun run build`: Bun compile smoke check.
- `bun run src/main.tsx --help`: CLI smoke check.
- `bun install` after package or lockfile changes.
- Add focused tests for git parsing, CLI argument handling, diagnostic parsing, checker state transitions, and copy-reference formatting. Keep OpenTUI rendering tests separate from pure parsing/state tests where practical.
