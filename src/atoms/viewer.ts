import { Effect } from "effect"
import { Atom, AsyncResult } from "effect/unstable/reactivity"
import { contentToContextPatch, type FileContent } from "../file-view"
import { renderPatch } from "../patch"
import { File } from "../services/file"
import { Git } from "../services/git"
import { gitModelAtom } from "./git"
import { runtime } from "./runtime"
import { fileViewAtom, fullContentPathsAtom, scopeAtom, selectedPathAtom } from "./ui"

export const selectedFileAtom = Atom.make((get) => {
  const selectedPath = get(selectedPathAtom)
  return selectedPath === undefined ? undefined : get(gitModelAtom).changedByPath.get(selectedPath)
})

export const showFileContentAtom = Atom.make(
  (get) => get(selectedPathAtom) !== undefined && (get(selectedFileAtom) === undefined || get(fileViewAtom)),
)

const fileContentResultAtom = runtime.atom((get) => {
  const selectedPath = get(selectedPathAtom)
  if (!get(showFileContentAtom) || selectedPath === undefined) {
    return Effect.succeed<FileContent | undefined>(undefined)
  }

  const scope = get(scopeAtom)
  const gitSpec =
    get(selectedFileAtom)?.kind === "deleted"
      ? scope.kind === "unstaged"
        ? `:${selectedPath}`
        : `${scope.ref}:${selectedPath}`
      : undefined
  return File.pipe(
    Effect.flatMap((file) =>
      file.content(get(gitModelAtom).repoRoot, selectedPath, { full: get(fullContentPathsAtom).has(selectedPath), gitSpec }),
    ),
  )
})

// Unwrap to a plain value so the rest of the graph stays synchronous; the last
// Good content shows during the (sub-frame, local) load.
export const fileContentAtom = Atom.make((get) => {
  const result = get(fileContentResultAtom)
  return AsyncResult.isSuccess(result) ? result.value : undefined
})

const selectedDiffResultAtom = runtime.atom((get) => {
  const selectedPath = get(selectedPathAtom)
  if (selectedPath === undefined) {
    return Effect.succeed("")
  }

  if (get(showFileContentAtom)) {
    const fileContent = get(fileContentAtom)
    return Effect.succeed(fileContent?.kind === "text" ? contentToContextPatch(selectedPath, fileContent.content) : "")
  }

  const selectedFile = get(selectedFileAtom)
  if (selectedFile === undefined) {
    return Effect.succeed("")
  }

  return Git.pipe(
    Effect.flatMap((git) => git.fileDiff(get(gitModelAtom).repoRoot, get(scopeAtom), selectedFile)),
    Effect.catch(() => Effect.succeed("")),
  )
})

const selectedDiffAtom = Atom.make((get) => {
  const result = get(selectedDiffResultAtom)
  return AsyncResult.isSuccess(result) ? result.value : ""
})

export const renderedPatchAtom = Atom.make((get) => {
  const selectedPath = get(selectedPathAtom)
  return renderPatch(get(selectedDiffAtom), {
    full: get(showFileContentAtom) || (selectedPath !== undefined && get(fullContentPathsAtom).has(selectedPath)),
    maxLines: 1600,
  })
})

export const navigableLinesAtom = Atom.make((get) => {
  const renderedPatch = get(renderedPatchAtom)
  return renderedPatch.parsed.hunks.flatMap((hunk) => hunk.lines).slice(0, renderedPatch.bodyLineCount)
})

export const truncatedAtom = Atom.make((get) => {
  const fileContent = get(fileContentAtom)
  return get(renderedPatchAtom).truncated || (fileContent?.kind === "text" && fileContent.truncated)
})
