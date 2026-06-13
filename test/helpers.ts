import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { RegistryProvider } from "@effect/atom-react"
import { Effect, Layer } from "effect"
import { createElement, type ReactElement } from "react"
import type { DiffScope } from "../src/cli"
import type { ChangedFile } from "../src/git"
import { Git, GitLive } from "../src/services/git"
import { ProcessLive } from "../src/services/process"
import type { SyntaxConfig } from "../src/syntax"

export const disabledSyntax: SyntaxConfig = { enabled: false, status: "syntax disabled for tests" }

const GitTestLive = GitLive.pipe(Layer.provide(ProcessLive))

// Run the Git service against a fixture repo, the same path the app uses, so
// Tests exercise the production load instead of a mock.
export function loadModel(repoRoot: string, scope: DiffScope) {
  return Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.loadModel(repoRoot, scope)),
      Effect.provide(GitTestLive),
    ),
  )
}

export function loadWorktrees(repoRoot: string) {
  return Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.worktrees(repoRoot)),
      Effect.provide(GitTestLive),
    ),
  )
}

export function loadFileDiff(repoRoot: string, scope: DiffScope, changed: ChangedFile) {
  return Effect.runPromise(
    Git.pipe(
      Effect.flatMap((git) => git.fileDiff(repoRoot, scope, changed)),
      Effect.provide(GitTestLive),
    ),
  )
}

// Each render test gets its own atom registry so module-global atoms (the git
// Model, etc.) do not leak between tests sharing the default registry.
export function withRegistry(node: ReactElement) {
  return createElement(RegistryProvider, null, node)
}

export function runGit(repoRoot: string, args: string[]) {
  execFileSync("git", ["-c", "user.name=Sideye Test", "-c", "user.email=sideye-test@example.com", ...args], {
    cwd: repoRoot,
    stdio: "ignore",
  })
}

export function createFixtureRepo(prefix: string, files: Record<string, string>) {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix))

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true })
    writeFileSync(join(repoRoot, path), content)
  }

  runGit(repoRoot, ["init"])
  runGit(repoRoot, ["add", "."])
  runGit(repoRoot, ["commit", "-m", "fixture"])

  return repoRoot
}

interface FrameSource {
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
}

export function makeSettleUntil({ renderOnce, captureCharFrame }: FrameSource) {
  return async (label: string, predicate: (frame: string) => boolean, minAttempts = 1) => {
    let frame = ""
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling retry: each tick must complete before the next check
      await new Promise((resolve) => setTimeout(resolve, 10))
      // oxlint-disable-next-line no-await-in-loop -- polling retry: each tick must complete before the next check
      await renderOnce()
      frame = captureCharFrame()
      if (attempt + 1 >= minAttempts && predicate(frame)) {
        return frame
      }
    }

    throw new Error(`timed out waiting for ${label}\n\n${frame}`)
  }
}
