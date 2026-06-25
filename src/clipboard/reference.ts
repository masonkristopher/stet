export interface CopyReferencePayload {
  path: string;
  line?: number;
}

export function formatCopyReference(payload: CopyReferencePayload) {
  if (payload.line === undefined) {
    return payload.path;
  }

  return `${payload.path}:${payload.line}`;
}

const LINUX_CLIPBOARD_COMMANDS = [
  ["wl-copy"],
  ["xclip", "-selection", "clipboard"],
  ["xsel", "--clipboard", "--input"],
];

export function clipboardCommand() {
  if (process.platform === "darwin") {
    return ["pbcopy"];
  }

  return LINUX_CLIPBOARD_COMMANDS.find((command) => Bun.which(command[0] ?? "") !== null);
}
