import { preloadDiffHighlighter } from "@/diff/engine";

// Tests never auto-download a language server (no network, no slow installs). The provisioner's own
// Tests toggle this explicitly and restore it.
process.env.SIDEYE_NO_LSP_DOWNLOAD = "1";

// Warm the diff highlighter once so render tests don't race the one-time Shiki
// Load (the first diff would otherwise time out the settle helper).
await preloadDiffHighlighter();
