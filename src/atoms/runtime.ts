import { Layer } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ClipboardLive } from "../services/clipboard"
import { DiagnosticsLive } from "../services/diagnostics"
import { FileLive } from "../services/file"
import { GitLive } from "../services/git"
import { ProcessLive } from "../services/process"

// Shared runtime for effect-backed atoms; holds the service layer so atoms built
// With runtime.fn / runtime.atom can reach the domain services and the Process
// They compose over.
const AppLayer = Layer.mergeAll(DiagnosticsLive, GitLive, FileLive, ClipboardLive).pipe(Layer.provide(ProcessLive))

export const runtime = Atom.runtime(AppLayer)
