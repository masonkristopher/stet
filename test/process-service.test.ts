import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { CommandError, Process, ProcessLive } from "../src/services/process"

test("Process.run returns stdout for a successful command", async () => {
  const result = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) => process.run(["git", "--version"], import.meta.dir)),
      Effect.provide(ProcessLive),
    ),
  )

  expect(result.stdout).toContain("git version")
  expect(result.exitCode).toBe(0)
})

test("Process.run fails with CommandError on a disallowed exit code", async () => {
  const error = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) => process.run(["git", "rev-parse", "--verify", "no-such-ref"], import.meta.dir)),
      Effect.flip,
      Effect.provide(ProcessLive),
    ),
  )

  expect(error).toBeInstanceOf(CommandError)
  expect(error.exitCode).not.toBe(0)
})

test("Process.run fails with CommandError when the executable is missing", async () => {
  // Bun.spawn throws synchronously here; Effect.flip only resolves if that
  // Surfaces as a typed failure rather than an escaping defect.
  const error = await Effect.runPromise(
    Process.pipe(
      Effect.flatMap((process) => process.run(["sideye-no-such-binary"], import.meta.dir)),
      Effect.flip,
      Effect.provide(ProcessLive),
    ),
  )

  expect(error).toBeInstanceOf(CommandError)
})

test("Process.run kills the child when the fiber is interrupted", async () => {
  const start = Date.now()
  const fiber = Effect.runFork(
    Process.pipe(
      Effect.flatMap((process) => process.run(["sleep", "5"], import.meta.dir)),
      Effect.provide(ProcessLive),
    ),
  )

  await new Promise((resolve) => setTimeout(resolve, 100))
  await Effect.runPromise(Fiber.interrupt(fiber))

  // The child is killed on interrupt, so we never wait the full 5s
  expect(Date.now() - start).toBeLessThan(3000)
})
