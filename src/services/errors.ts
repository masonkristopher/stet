import { Data } from "effect"

export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string
}> {}
