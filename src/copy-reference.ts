export interface CopyReferencePayload {
  path: string
  line?: number
  snippet?: string
}

export function formatCopyReference(payload: CopyReferencePayload) {
  if (payload.line === undefined) {
    return payload.path
  }

  const reference = `${payload.path}:${payload.line}`
  if (payload.snippet === undefined || payload.snippet === "") {
    return reference
  }

  return `${reference}\n${payload.snippet}`
}

const LINUX_CLIPBOARD_COMMANDS = [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]

export function clipboardCommand() {
  if (process.platform === "darwin") {
    return ["pbcopy"]
  }

  return LINUX_CLIPBOARD_COMMANDS.find((command) => Bun.which(command[0] ?? "") !== null)
}
