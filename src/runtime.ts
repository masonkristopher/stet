import { Layer, ManagedRuntime } from "effect";

import { ClipboardLive } from "./clipboard/service";
import { DiagnosticsLive } from "./diagnostics/service";
import { FileLive } from "./file/service";
import { GitLive } from "./git/service";
import { ProcessLive } from "./process";

// One long-lived Effect runtime holding the service layer. Solid signals and
// Effects run service effects through `runtime.runPromise` / `runtime.runFork`
// Instead of the old effect-atom registry; this is the only Effect↔Solid seam.
// ProvideMerge keeps Process in the runtime context (not just wired into the
// Other services) so startup effects can spawn git directly.
const AppLayer = Layer.mergeAll(DiagnosticsLive, GitLive, FileLive, ClipboardLive).pipe(
  Layer.provideMerge(ProcessLive),
);

export const runtime = ManagedRuntime.make(AppLayer);
