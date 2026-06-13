import { Atom } from "effect/unstable/reactivity"
import { rankFiles } from "../fuzzy"
import { recencyByPathAtom } from "./activity"
import { gitModelAtom } from "./git"
import { paletteOpenAtom, paletteQueryAtom } from "./ui"

const changedPathSetAtom = Atom.make((get) => new Set(get(gitModelAtom).changedByPath.keys()))

const allPathsAtom = Atom.make((get) => {
  const model = get(gitModelAtom)
  return [...new Set([...model.repoFiles.map((file) => file.path), ...model.changedByPath.keys()])]
})

export const paletteResultsAtom = Atom.make((get) => {
  if (!get(paletteOpenAtom)) {
    return []
  }

  return rankFiles(get(paletteQueryAtom), get(allPathsAtom), {
    changed: get(changedPathSetAtom),
    lastChangedAt: get(recencyByPathAtom),
    limit: 50,
  })
})
