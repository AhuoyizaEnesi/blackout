/**
 * Cron task definitions — registered into the AppCronRoom DO at construction
 * time (worker.ts). The DO alarm fires `runTask(name, env)` on the schedule
 * declared here; the DO itself records executions and tracks history.
 *
 * Each task declares EITHER `intervalMinutes` (run every N minutes) OR
 * `schedule` + `timezone` (5-field cron expression). CronRoom validates
 * the config at construction time and throws on ambiguous declarations.
 *
 * BLACKOUT has one task, the room sweep (src/server/game/rooms.ts,
 * `sweepRooms`). With nobody connected it:
 *   - records the expiry of lobbies left unused past their idle limit;
 *   - finishes started simulations that are past their deadline, as a safety
 *     net for a simulation timer that was lost (src/server/game/timer.ts);
 *   - deletes lobbies that were closed before starting, once the retention
 *     period has passed. A room that started is never deleted.
 *
 * Everything the sweep records carries the instant it became true, not the
 * time the sweep ran, so how often it runs affects promptness only.
 */

import type { CronTask } from 'deepspace/worker'
import { createRecordStore, createSystemTools, type RecordRoomEnv } from './server/game/record-store.js'
import { sweepRooms } from './server/game/rooms.js'

export const ROOM_SWEEP_TASK = 'room-sweep'

export const tasks: CronTask[] = [{ name: ROOM_SWEEP_TASK, intervalMinutes: 10 }]

export async function runTask(name: string, env: RecordRoomEnv): Promise<void> {
  if (name !== ROOM_SWEEP_TASK) return
  const report = await sweepRooms(createRecordStore(createSystemTools(env)), Date.now())
  console.info(`[cron] ${ROOM_SWEEP_TASK} ${JSON.stringify(report)}`)
  // Recorded as a failed run in the cron history, and tried again next time.
  if (report.failed > 0) throw new Error(`${report.failed} room(s) could not be swept`)
}
