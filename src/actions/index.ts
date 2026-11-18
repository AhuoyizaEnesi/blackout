/**
 * Server actions — the only way game state changes.
 *
 * The action route (src/server/action-routes.ts) has already verified the
 * caller's JWT; `userId` is that verified subject. Everything else in `params`
 * is untrusted: handlers take only ids from it, never roles, metrics,
 * timestamps or state. Time is always this worker's clock.
 */

import { enqueueJob } from 'deepspace/worker'
import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  createSoloSimulation,
  executeAction,
  requestApproval,
  shareFinding,
  decideApproval,
  syncSimulation,
  type CommandResult,
} from '../server/game/commands.js'
import { createRecordStore } from '../server/game/record-store.js'
import {
  abandonRoom,
  claimRole,
  createRoom,
  joinRoom,
  leaveRoom,
  releaseRole,
  startRoom,
  sweepRoom,
  syncRoom,
  type RoomResult,
} from '../server/game/rooms.js'
import { SETTLE_JOB, SETTLE_JOB_ATTEMPTS } from '../server/game/timer.js'

/** Invitation codes come from the platform's cryptographic random source. */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function respond<T>(result: CommandResult<T> | RoomResult<T>): ActionResult {
  return result.ok
    ? { success: true, data: result.data }
    : { success: false, error: result.message, code: result.code }
}

/**
 * Start the server's own timer for a simulation that has just begun
 * (src/server/game/timer.ts). The simulation already exists and is correct
 * without it, so a failure here is logged and never fails the command: the
 * events are then written by the next sync, with the same timestamps.
 */
async function startTimer(env: Env, simulationId: string): Promise<void> {
  try {
    await enqueueJob(env.JOB_ROOMS, `app:${env.DEEPSPACE_APP_ID}`, SETTLE_JOB, { simulationId }, {
      maxAttempts: SETTLE_JOB_ATTEMPTS,
    })
  } catch (error) {
    console.error(`[timer] could not queue ${simulationId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const actions: Record<string, ActionHandler<Env>> = {
  createSoloSimulation: async ({ userId, params, tools, env }) => {
    const result = await createSoloSimulation(createRecordStore(tools), userId, params, Date.now())
    if (result.ok && !result.data.replayed) await startTimer(env, result.data.simulationId)
    return respond(result)
  },

  executeAction: async ({ userId, params, tools }) =>
    respond(await executeAction(createRecordStore(tools), userId, params, Date.now())),

  requestApproval: async ({ userId, params, tools }) =>
    respond(await requestApproval(createRecordStore(tools), userId, params, Date.now())),

  syncSimulation: async ({ userId, params, tools }) =>
    respond(await syncSimulation(createRecordStore(tools), userId, params, Date.now())),

  // --- Team simulations: commander decisions and shared findings ---
  decideApproval: async ({ userId, params, tools }) =>
    respond(await decideApproval(createRecordStore(tools), userId, params, Date.now())),

  shareFinding: async ({ userId, params, tools }) =>
    respond(await shareFinding(createRecordStore(tools), userId, params, Date.now())),

  // --- Team rooms: lobby ---
  createRoom: async ({ userId, params, tools }) =>
    respond(await createRoom(createRecordStore(tools), userId, params, Date.now(), randomBytes)),

  joinRoom: async ({ userId, params, tools }) =>
    respond(await joinRoom(createRecordStore(tools), userId, params, Date.now())),

  leaveRoom: async ({ userId, params, tools }) =>
    respond(await leaveRoom(createRecordStore(tools), userId, params, Date.now())),

  claimRole: async ({ userId, params, tools }) =>
    respond(await claimRole(createRecordStore(tools), userId, params, Date.now())),

  releaseRole: async ({ userId, params, tools }) =>
    respond(await releaseRole(createRecordStore(tools), userId, params, Date.now())),

  startRoom: async ({ userId, params, tools, env }) => {
    const result = await startRoom(createRecordStore(tools), userId, params, Date.now())
    // Only the call that actually started the room starts its timer.
    if (result.ok && result.data.applied) await startTimer(env, result.data.roomId)
    return respond(result)
  },

  abandonRoom: async ({ userId, params, tools }) =>
    respond(await abandonRoom(createRecordStore(tools), userId, params, Date.now())),

  syncRoom: async ({ userId, params, tools }) =>
    respond(await syncRoom(createRecordStore(tools), userId, params, Date.now())),
}

/**
 * LOCAL TESTING ONLY — never part of a production build.
 *
 * Lobby expiry and the deletion of long-closed lobbies happen after 24 hours
 * and 7 days. To exercise those paths against the real record room, a test
 * may run the sweep for ONE room it hosts as if the clock were ahead.
 *
 * Two independent switches must both be on, and neither can be in
 * production: `import.meta.env.DEV` is replaced with `false` by `vite build`,
 * so this whole block is removed from the built worker (the build check in
 * the test evidence greps for the action's name); and `ALLOW_DEBUG_ROUTES`
 * is set only by the local dev server.
 */
if (import.meta.env.DEV) {
  actions.debugSweepRoom = async ({ userId, params, tools, env }) => {
    if (env.ALLOW_DEBUG_ROUTES !== 'true') return { success: false, error: 'Action not found', code: 'not_found' }
    const { roomId, advanceMs } = params
    if (typeof roomId !== 'string' || typeof advanceMs !== 'number' || !(advanceMs >= 0 && advanceMs <= 1e12)) {
      return { success: false, error: 'The request is malformed.', code: 'invalid_request' }
    }
    const store = createRecordStore(tools)
    const room = await store.getRoom(roomId)
    if (!room || room.hostId !== userId) return { success: false, error: 'Room not found.', code: 'forbidden' }
    return { success: true, data: { outcome: await sweepRoom(store, roomId, Date.now() + advanceMs) } }
  }
}
