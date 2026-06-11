import type { ChangedFile, RepoFile, StageState } from "./git"

export type FileNode = {
  type: "file"
  id: string
  name: string
  path: string
  tracked: boolean
  changed: ChangedFile | undefined
}

export type DirectoryNode = {
  type: "directory"
  id: string
  name: string
  path: string
  additions: number
  deletions: number
  fileCount: number
  changedCount: number
  stage: StageState | undefined
  warnings: string[]
  children: FileTreeNode[]
}

export type FileTreeNode = DirectoryNode | FileNode

export type FileTreeRow = {
  node: FileTreeNode
  index: number
  depth: number
}

export type BuildTreeOptions = {
  changesOnly: boolean
}

export function buildFileTree(repoFiles: RepoFile[], changedByPath: Map<string, ChangedFile>, options: BuildTreeOptions): FileTreeNode[] {
  const root = makeDirectory("", "")
  const directories = new Map<string, DirectoryNode>([["", root]])
  const seen = new Set<string>()

  const insert = (path: string, tracked: boolean) => {
    const changed = changedByPath.get(path)
    if (options.changesOnly && changed === undefined) {
      return
    }

    const parts = path.split("/")
    let parent = root
    let currentPath = ""

    for (const directoryName of parts.slice(0, -1)) {
      currentPath = currentPath === "" ? directoryName : `${currentPath}/${directoryName}`
      let directory = directories.get(currentPath)

      if (directory === undefined) {
        directory = makeDirectory(directoryName, currentPath)
        directories.set(currentPath, directory)
        parent.children.push(directory)
      }

      parent = directory
    }

    parent.children.push({
      type: "file",
      id: `file:${path}`,
      name: parts.at(-1) ?? path,
      path,
      tracked,
      changed,
    })
  }

  for (const file of repoFiles) {
    seen.add(file.path)
    insert(file.path, file.tracked)
  }

  // staged deletions vanish from ls-files; keep them visible via the changed set
  for (const path of changedByPath.keys()) {
    if (!seen.has(path)) {
      insert(path, true)
    }
  }

  aggregateDirectory(root)
  sortTree(root)
  return root.children.map(flattenSingleChildChains)
}

export function defaultExpandedDirectories(changedPaths: string[]) {
  let expanded = new Set<string>()
  for (const path of changedPaths) {
    expanded = expandAncestorsForPath(expanded, path)
  }

  return expanded
}

export function expandAncestorsForPath(expanded: Set<string>, path: string) {
  const next = new Set(expanded)
  const parts = path.split("/")

  for (let index = 1; index < parts.length; index += 1) {
    next.add(`dir:${parts.slice(0, index).join("/")}`)
  }

  return next
}

export function flattenTree(nodes: FileTreeNode[], expanded: Set<string>) {
  const rows: FileTreeRow[] = []

  const visit = (node: FileTreeNode, depth: number) => {
    rows.push({ node, index: rows.length, depth })

    if (node.type === "directory" && expanded.has(node.id)) {
      for (const child of node.children) {
        visit(child, depth + 1)
      }
    }
  }

  for (const node of nodes) {
    visit(node, 0)
  }

  return rows
}

export function findRowIndexForPath(rows: FileTreeRow[], path: string) {
  return rows.findIndex((row) => row.node.type === "file" && row.node.path === path)
}

export function firstFileInNode(node: FileTreeNode): FileNode | undefined {
  if (node.type === "file") {
    return node
  }

  for (const child of node.children) {
    const file = firstFileInNode(child)
    if (file !== undefined) {
      return file
    }
  }

  return undefined
}

function makeDirectory(name: string, path: string): DirectoryNode {
  return {
    type: "directory",
    id: `dir:${path}`,
    name,
    path,
    additions: 0,
    deletions: 0,
    fileCount: 0,
    changedCount: 0,
    stage: undefined,
    warnings: [],
    children: [],
  }
}

function aggregateDirectory(directory: DirectoryNode) {
  const warnings = new Set<string>()
  const stages = new Set<StageState>()
  let additions = 0
  let deletions = 0
  let fileCount = 0
  let changedCount = 0

  for (const child of directory.children) {
    if (child.type === "directory") {
      aggregateDirectory(child)
      additions += child.additions
      deletions += child.deletions
      fileCount += child.fileCount
      changedCount += child.changedCount
      if (child.stage !== undefined) {
        stages.add(child.stage)
      }
      for (const warning of child.warnings) {
        warnings.add(warning)
      }
      continue
    }

    fileCount += 1
    if (child.changed !== undefined) {
      changedCount += 1
      additions += child.changed.additions
      deletions += child.changed.deletions
      stages.add(child.changed.stage)
      for (const warning of child.changed.warnings) {
        warnings.add(warning)
      }
    }
  }

  directory.additions = additions
  directory.deletions = deletions
  directory.fileCount = fileCount
  directory.changedCount = changedCount
  directory.stage = stages.size === 0 ? undefined : stages.size === 1 ? [...stages][0] : "mixed"
  directory.warnings = Array.from(warnings)
}

function sortTree(directory: DirectoryNode) {
  directory.children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1
    }

    return a.name.localeCompare(b.name)
  })

  for (const child of directory.children) {
    if (child.type === "directory") {
      sortTree(child)
    }
  }
}

function flattenSingleChildChains(node: FileTreeNode): FileTreeNode {
  if (node.type === "file") {
    return node
  }

  let current = node
  while (current.children.length === 1 && current.children[0]?.type === "directory") {
    const child = current.children[0]
    current = { ...child, name: `${current.name}/${child.name}` }
  }

  return { ...current, children: current.children.map(flattenSingleChildChains) }
}
