"use client";

import { Check, Copy, X } from "lucide-react";
import { useRef, useState } from "react";

export function InstallCommand({ command }: { command: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function copy() {
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    resetTimer.current = setTimeout(() => setStatus("idle"), 1500);
  }

  const label =
    status === "copied" ? "Copied" : status === "error" ? "Copy failed" : "Copy install command";

  return (
    <div className="flex w-full max-w-xl items-center gap-3 rounded-lg border border-fd-border bg-fd-card px-4 py-3 text-left font-mono text-sm">
      <span className="text-fd-muted-foreground select-none">$</span>
      <code className="flex-1 overflow-x-auto whitespace-nowrap text-fd-foreground">{command}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        className="shrink-0 text-fd-muted-foreground transition-colors hover:text-fd-foreground"
      >
        {status === "copied" ? (
          <Check className="size-4 text-fd-primary" />
        ) : status === "error" ? (
          <X className="size-4 text-fd-muted-foreground" />
        ) : (
          <Copy className="size-4" />
        )}
      </button>
    </div>
  );
}
