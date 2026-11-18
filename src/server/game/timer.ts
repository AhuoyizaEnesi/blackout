/**
 * The server's own timer for a simulation.
 *
 * Without it, a simulation's scheduled events are written "lazily": by the
 * next command or sync from a participant. That is always correct — every
 * event carries the instant it fell due, not the time it was written — but
 * it means a simulation nobody is watching sits unfinished until someone
 * looks.
 *
 * With it, starting a simulation queues one job in the app's JobRoom (a
 * DeepSpace Durable Object that persists jobs in its own SQLite storage and
 * runs them from its alarm). Each run settles the log, then asks to be run
 * again when the next system event falls due — the next incident, the next
 * action completion, or the deadline. The last run finds the simulation
 * ended, brings a team room's row up to date, and stops.
 *
 * Safety:
 *   - The job does only what `settleSimulation` does: record what the clock
 *     has already made true, each event once, at its own timestamp. A timer
 *     that fires late, twice, or alongside a participant's sync changes
 *     nothing about the log.
 *   - The payload is one id. It is validated like any id from outside, and a
 *     job for an id that is not a simulation ends at once.
 *   - It is an addition, not a replacement: lazy settling still happens on
 *     every command and sync, so a lost or failed job costs only promptness.
 */

import type { GameStore } from './commands.js'
import { settleSimulation } from './commands.js'
import { refreshRoomView, type RoomStore } from './rooms.js'

export const SETTLE_JOB = 'settle-simulation'
/**
 * The queue counts every run of a job as an attempt, including each planned wake-up (verified in
 * deepspace 0.44.2, JobRoom.executeJob), and gives up on a failure once the count reaches this. A
 * simulation needs about twenty wake-ups, so this leaves room for those and for retries. A job that
 * fails for good costs only promptness: lazy settling still writes the same events.
 */
export const SETTLE_JOB_ATTEMPTS = 64
/** Wake this long after the due instant, so a timer that fires a touch early still finds the event due. */
const WAKE_MARGIN_MS = 250

export type SettleJobOutcome =
  | { status: 'ignored' }
  | { status: 'waiting'; nextDueAt: number }
  | { status: 'finished'; mode: 'solo' | 'team' }

/**
 * One run of the settle job. `again(afterMs)` asks the queue to run the job
 * once more after that delay.
 */
export async function runSettleJob(
  store: GameStore & RoomStore,
  payload: unknown,
  now: number,
  again: (afterMs: number) => void,
): Promise<SettleJobOutcome> {
  const simulationId =
    typeof payload === 'object' && payload !== null ? (payload as { simulationId?: unknown }).simulationId : undefined
  const settled = await settleSimulation(store, simulationId, now)
  if (!settled) return { status: 'ignored' }
  if (!settled.ended && settled.nextDueAt !== null) {
    again(Math.max(0, settled.nextDueAt - now) + WAKE_MARGIN_MS)
    return { status: 'waiting', nextDueAt: settled.nextDueAt }
  }
  // Over. A team room's row should say so without waiting for a visitor.
  if (settled.mode === 'team') await refreshRoomView(store, simulationId as string, now)
  return { status: 'finished', mode: settled.mode }
}
