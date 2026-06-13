import { Schedule, Stream } from "effect"
import { Atom, AsyncResult } from "effect/unstable/reactivity"
import { emptyActivityLog, lastChangedAt, latestActivity, RECENT_MS } from "../activity"

export const activityLogAtom = Atom.make(emptyActivityLog).pipe(Atom.keepAlive)

export const recencyByPathAtom = Atom.make((get) => lastChangedAt(get(activityLogAtom)))

// Ticks once a second to keep "Ns ago" labels fresh while activity is recent,
// Then the stream ends so an idle session stays quiescent. Re-keys (and resumes
// Ticking) whenever new activity is recorded.
const nowTickAtom = Atom.make((get) => {
  const latest = latestActivity(get(activityLogAtom))
  if (latest === undefined || Date.now() - latest.at >= RECENT_MS) {
    return Stream.make(Date.now())
  }

  return Stream.fromSchedule(Schedule.spaced("1 second")).pipe(
    Stream.map(() => Date.now()),
    Stream.takeWhile(() => Date.now() - latest.at < RECENT_MS),
  )
}).pipe(Atom.keepAlive)

export const nowAtom = Atom.make((get) => {
  const tick = get(nowTickAtom)
  return AsyncResult.isSuccess(tick) ? tick.value : Date.now()
})
