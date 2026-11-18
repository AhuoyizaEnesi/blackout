/**
 * Prompt 009: the server's own timer, lobby expiry and cleanup, and the
 * per-user limits. Command logic only, against the in-memory store with an
 * injected clock; the same behaviour is exercised against the real worker in
 * tests/hardening.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { INCIDENTS, SIMULATION_DURATION_MS, type ActionId, type GameEvent } from '../../game/engine'
import {
  CLOSED_LOBBY_RETENTION_MS,
  LOBBY_IDLE_TTL_MS,
  MAX_LOBBY_EVENTS,
  SYSTEM_ACTOR,
  applyLobbyEvent,
  deletableFrom,
  dueExpiry,
  initialLobby,
  lobbyExpiresAt,
  reduceLobby,
  type LobbyEvent,
} from '../../game/lobby'
import { createSoloSimulation, executeAction, settleSimulation, syncSimulation } from './commands'
import { LIMITS, describeWait, isExhausted, takeSlot, windowOf } from './limits'
import {
  abandonRoom,
  claimRole,
  createRoom,
  isRoomMember,
  joinRoom,
  leaveRoom,
  refreshRoomView,
  releaseRole,
  startRoom,
  sweepRoom,
  sweepRooms,
  syncRoom,
  type RoomSnapshot,
} from './rooms'
import { memoryStore } from './store.testkit'
import { runSettleJob } from './timer'

type Store = ReturnType<typeof memoryStore>['store']

const T0 = 1_800_000_000_000
const HOST = 'user-host'
const CMDR = 'user-cmdr'
const INFRA = 'user-infra'
const OUTSIDER = 'user-outsider'
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)
const DEADLINE = T0 + SIMULATION_DURATION_MS

let counter = 0
const cid = () => `cmd-${String(++counter).padStart(8, '0')}`
function byteSource(start = 7) {
  let n = start
  return (length: number) => Uint8Array.from({ length }, () => (n = (n * 73 + 41) % 251))
}
function must<T>(result: { ok: true; data: T } | { ok: false; code: string }): T {
  if (!result.ok) throw new Error(`setup failed: ${result.code}`)
  return result.data
}

async function soloSimulation(store: Store, owner = HOST, now = T0): Promise<string> {
  return must(await createSoloSimulation(store, owner, { commandId: cid() }, now)).simulationId
}
const run = (store: Store, user: string, simulationId: string, actionId: ActionId, now: number) =>
  executeAction(store, user, { simulationId, actionId, commandId: cid() }, now)

async function openRoom(store: Store, host = HOST, now = T0, random = byteSource()): Promise<RoomSnapshot> {
  return must(await createRoom(store, host, { commandId: cid() }, now, random))
}
async function readyRoom(store: Store, now = T0, random = byteSource()) {
  const room = await openRoom(store, HOST, now, random)
  must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, now + 1000))
  must(await joinRoom(store, INFRA, { inviteCode: room.inviteCode }, now + 2000))
  must(await claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, now + 3000))
  must(await claimRole(store, CMDR, { roomId: room.roomId, role: 'commander' }, now + 4000))
  must(await claimRole(store, INFRA, { roomId: room.roomId, role: 'infrastructure' }, now + 5000))
  return room
}
/** A team simulation started at exactly `startAt`. */
async function startedRoom(store: Store, startAt = T0, random = byteSource()) {
  const room = await readyRoom(store, startAt - 60_000, random)
  must(await startRoom(store, HOST, { roomId: room.roomId }, startAt))
  return room
}

/** Run the settle job as the queue would: again and again, each time at the moment it asked for. */
async function runTimerToEnd(store: Store, simulationId: string, startAt: number, lateBy = 0) {
  let now = startAt
  const wakes: number[] = []
  for (let runs = 0; runs < 100; runs++) {
    wakes.push(now)
    let delay: number | null = null
    const outcome = await runSettleJob(store, { simulationId }, now, (afterMs) => (delay = afterMs))
    if (outcome.status !== 'waiting') return { outcome, wakes }
    expect(delay).not.toBeNull()
    now += delay! + lateBy
  }
  throw new Error('the timer never finished')
}

const incidentTimes = (startedAt: number) => INCIDENTS.map((incident) => startedAt + incident.atMs)
const isContiguous = (log: readonly { seq: number }[]) => log.every((event, index) => event.seq === index + 1)

// ---------------------------------------------------------------------------
// Authoritative time
// ---------------------------------------------------------------------------

describe('unattended settling', () => {
  it('finishes a simulation nobody touched, with every incident at its scheduled instant', async () => {
    const { store, events } = memoryStore()
    const id = await soloSimulation(store)
    const settled = await settleSimulation(store, id, DEADLINE + 3_600_000)
    expect(settled).toEqual({ mode: 'solo', ended: true, nextDueAt: null })
    const log = events.get(id)!
    expect(log.map((e) => e.incidentId)).toEqual(INCIDENTS.map((incident) => incident.id))
    expect(log.map((e) => e.at)).toEqual(incidentTimes(T0))
    expect(isContiguous(log)).toBe(true)
  })

  it('writes exactly the log a participant sync would have written', async () => {
    const timer = memoryStore()
    const lazy = memoryStore()
    const a = await soloSimulation(timer.store)
    const b = await soloSimulation(lazy.store)
    for (const [ctx, id] of [[timer, a], [lazy, b]] as const) {
      must(await run(ctx.store, HOST, id, 'inspect_access_logs', T0 + 5_000))
      must(await run(ctx.store, HOST, id, 'review_deployment', T0 + 61_000))
    }
    await settleSimulation(timer.store, a, DEADLINE + 1)
    must(await syncSimulation(lazy.store, HOST, { simulationId: b }, DEADLINE + 1))
    const strip = (log: GameEvent[]) => log.map((event) => ({ ...event, commandId: '' }))
    expect(strip(timer.events.get(a)!)).toEqual(strip(lazy.events.get(b)!))
  })

  it('reports when the next system event falls due', async () => {
    const { store } = memoryStore()
    const id = await soloSimulation(store)
    expect(await settleSimulation(store, id, T0)).toMatchObject({ ended: false, nextDueAt: T0 + 60_000 })
    // A timed action finishes before the next incident: that is what comes next.
    must(await run(store, HOST, id, 'inspect_access_logs', T0 + 10_000))
    expect(await settleSimulation(store, id, T0 + 10_000)).toMatchObject({ nextDueAt: T0 + 25_000 })
    expect(await settleSimulation(store, id, T0 + 25_000)).toMatchObject({ nextDueAt: T0 + 60_000 })
    // After the last scheduled incident, only the deadline is left.
    expect(await settleSimulation(store, id, T0 + 420_000)).toMatchObject({ ended: false, nextDueAt: DEADLINE })
  })

  it('holds the deadline to the millisecond', async () => {
    const { store, events } = memoryStore()
    const id = await soloSimulation(store)
    expect(await settleSimulation(store, id, DEADLINE - 1)).toMatchObject({ ended: false, nextDueAt: DEADLINE })
    expect(events.get(id)!.some((e) => e.incidentId === 'finalization')).toBe(false)
    // One millisecond before the end a command is still accepted…
    expect(await run(store, HOST, id, 'inspect_access_logs', DEADLINE - 1)).toMatchObject({ ok: true })
    // …and at the deadline itself nothing is.
    expect(await run(store, HOST, id, 'review_deployment', DEADLINE)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await settleSimulation(store, id, DEADLINE)).toMatchObject({ ended: true, nextDueAt: null })
    const log = events.get(id)!
    expect(log.at(-1)).toMatchObject({ incidentId: 'finalization', at: DEADLINE })
    // The action begun at the last millisecond would finish after the deadline, so it never does.
    expect(log.some((e) => e.type === 'action_completed')).toBe(false)
  })

  it('an action that completes exactly on the deadline completes, then the simulation is finalized', async () => {
    const { store, events } = memoryStore()
    const id = await soloSimulation(store)
    must(await run(store, HOST, id, 'inspect_access_logs', DEADLINE - 15_000))
    await settleSimulation(store, id, DEADLINE)
    const tail = events.get(id)!.slice(-2)
    expect(tail[0]).toMatchObject({ type: 'action_completed', actionId: 'inspect_access_logs', at: DEADLINE })
    expect(tail[1]).toMatchObject({ incidentId: 'finalization', at: DEADLINE })
  })

  it('is idempotent: settling again writes nothing', async () => {
    const { store, events, stats } = memoryStore()
    const id = await soloSimulation(store)
    await settleSimulation(store, id, DEADLINE)
    const before = structuredClone(events.get(id)!)
    stats.appendAttempts = 0
    for (const later of [DEADLINE, DEADLINE + 1, DEADLINE + 86_400_000]) await settleSimulation(store, id, later)
    expect(events.get(id)!).toEqual(before)
    expect(stats.appendAttempts).toBe(0)
  })

  it('cannot be made to act early: settling at an earlier time writes nothing further', async () => {
    const { store, events } = memoryStore()
    const id = await soloSimulation(store)
    await settleSimulation(store, id, T0 + 125_000)
    const count = events.get(id)!.length
    expect(count).toBe(3)
    await settleSimulation(store, id, T0 + 1_000)
    expect(events.get(id)!).toHaveLength(count)
  })

  it('ignores ids that are not simulations, and simulations under other rules', async () => {
    const { store, events, simulations } = memoryStore()
    for (const bad of [undefined, null, 7, '', 'short', 'x'.repeat(65), { $ne: '' }, 'no-such-simulation']) {
      expect(await settleSimulation(store, bad, DEADLINE)).toBeNull()
    }
    const id = await soloSimulation(store)
    simulations.set(id, { ...simulations.get(id)!, rulesVersion: 1 })
    expect(await settleSimulation(store, id, DEADLINE)).toBeNull()
    expect(events.get(id)!).toHaveLength(0)
    // A lobby that has not started is not a simulation either.
    const room = await openRoom(store)
    expect(await settleSimulation(store, room.roomId, DEADLINE)).toBeNull()
  })

  it('timer, sync and commands arriving together still produce one event per position', async () => {
    for (const seed of SEEDS) {
      const { store, events } = memoryStore(seed)
      const id = await soloSimulation(store)
      const now = T0 + 245_000 // five incidents are owed
      const results = await Promise.all([
        settleSimulation(store, id, now),
        settleSimulation(store, id, now),
        syncSimulation(store, HOST, { simulationId: id }, now),
        run(store, HOST, id, 'inspect_access_logs', now),
        run(store, HOST, id, 'review_deployment', now),
        settleSimulation(store, id, now),
      ])
      expect(results.every((r) => r !== null && (!('ok' in r) || r.ok))).toBe(true)
      const log = events.get(id)!
      expect(isContiguous([...log].sort((a, b) => a.seq - b.seq))).toBe(true)
      const incidents = log.filter((e) => e.type === 'incident')
      expect(incidents.map((e) => e.incidentId)).toEqual(INCIDENTS.slice(0, 5).map((i) => i.id))
      expect(incidents.map((e) => e.at)).toEqual(incidentTimes(T0).slice(0, 5))
      expect(log.filter((e) => e.type === 'action_started')).toHaveLength(2)
    }
  })
})

describe('the settle job', () => {
  it('wakes once per due instant and stops when the simulation has ended', async () => {
    const { store, events } = memoryStore()
    const id = await soloSimulation(store)
    const { outcome, wakes } = await runTimerToEnd(store, id, T0)
    expect(outcome).toEqual({ status: 'finished', mode: 'solo' })
    // Start, then each distinct scheduled instant (two incidents share 05:30).
    expect(wakes).toHaveLength(new Set(INCIDENTS.map((i) => i.atMs)).size)
    const log = events.get(id)!
    expect(log.map((e) => e.at)).toEqual(incidentTimes(T0))
    // Events carry the scheduled instant, never the moment the timer ran.
    expect(wakes.slice(1).every((wake) => !log.some((e) => e.at === wake))).toBe(true)
  })

  it('a timer that always fires late writes the same log', async () => {
    const onTime = memoryStore()
    const late = memoryStore()
    const a = await soloSimulation(onTime.store)
    const b = await soloSimulation(late.store)
    await runTimerToEnd(onTime.store, a, T0)
    await runTimerToEnd(late.store, b, T0 + 90_000, 47_123)
    expect(late.events.get(b)!).toEqual(onTime.events.get(a)!)
  })

  it('picks up completions of actions started while it was waiting', async () => {
    const { store, events } = memoryStore()
    const id = await soloSimulation(store)
    let delay = 0
    await runSettleJob(store, { simulationId: id }, T0, (ms) => (delay = ms))
    must(await run(store, HOST, id, 'inspect_access_logs', T0 + 50_000)) // completes at 65 s, after the 60 s wake
    const second = await runSettleJob(store, { simulationId: id }, T0 + delay, (ms) => (delay = ms))
    expect(second).toEqual({ status: 'waiting', nextDueAt: T0 + 65_000 })
    await runSettleJob(store, { simulationId: id }, T0 + 65_000 + 250, () => {})
    expect(events.get(id)!.find((e) => e.type === 'action_completed')).toMatchObject({ at: T0 + 65_000 })
  })

  it('ignores a payload that is not a simulation id and never asks to run again', async () => {
    const { store } = memoryStore()
    for (const payload of [undefined, null, 'text', 42, {}, { simulationId: 'missing-simulation' }, { simulationId: { $ne: 1 } }]) {
      let asked = false
      expect(await runSettleJob(store, payload, DEADLINE, () => (asked = true))).toEqual({ status: 'ignored' })
      expect(asked).toBe(false)
    }
  })

  it('ends a team simulation and marks the room completed with nobody connected', async () => {
    const { store, events, rooms, findings } = memoryStore()
    const room = await startedRoom(store)
    const { outcome } = await runTimerToEnd(store, room.roomId, T0)
    expect(outcome).toEqual({ status: 'finished', mode: 'team' })
    expect(rooms.get(room.roomId)!.view).toMatchObject({ status: 'completed', closedReason: null })
    const log = events.get(room.roomId)!
    expect(log.at(-1)).toMatchObject({ incidentId: 'finalization', at: DEADLINE })
    // The shared events carry no revealed text; every incident report exists as a team finding.
    expect(log.every((e) => e.finding === undefined)).toBe(true)
    const team = findings.get(room.roomId)!.filter((f) => f.scope === 'team')
    expect(team.length).toBeGreaterThanOrEqual(INCIDENTS.length - 1)
    // The result is there for every participant afterwards.
    for (const user of [HOST, CMDR, INFRA]) {
      const view = must(await syncSimulation(store, user, { simulationId: room.roomId }, DEADLINE + 86_400_000))
      expect(view.result).toMatchObject({ reason: 'deadline' })
    }
  })

  it('repairs findings whose write was lost while it ran', async () => {
    const { store, findings, faults } = memoryStore()
    const room = await startedRoom(store)
    faults.dropFindings = true
    await settleSimulation(store, room.roomId, T0 + 200_000)
    expect(findings.get(room.roomId) ?? []).toHaveLength(0)
    faults.dropFindings = false
    await runTimerToEnd(store, room.roomId, T0 + 200_000)
    const seqs = new Set(findings.get(room.roomId)!.map((f) => f.eventSeq))
    expect(seqs.size).toBeGreaterThanOrEqual(INCIDENTS.length - 1)
  })
})

// ---------------------------------------------------------------------------
// Lobby expiry
// ---------------------------------------------------------------------------

describe('lobby expiry (pure rules)', () => {
  it('expires exactly one idle period after the last lobby event', () => {
    const lobby = initialLobby(HOST, T0)
    expect(lobbyExpiresAt(lobby)).toBe(T0 + LOBBY_IDLE_TTL_MS)
    expect(dueExpiry(lobby, T0 + LOBBY_IDLE_TTL_MS - 1)).toBeNull()
    expect(dueExpiry(lobby, T0 + LOBBY_IDLE_TTL_MS)).toEqual({ seq: 1, type: 'expired', at: T0 + LOBBY_IDLE_TTL_MS, userId: SYSTEM_ACTOR })
    // However late it is noticed, it is stamped with the instant it happened.
    expect(dueExpiry(lobby, T0 + 10 * LOBBY_IDLE_TTL_MS)?.at).toBe(T0 + LOBBY_IDLE_TTL_MS)
  })

  it('activity keeps a lobby open', () => {
    const joined: LobbyEvent = { seq: 1, type: 'member_joined', at: T0 + LOBBY_IDLE_TTL_MS - 1, userId: CMDR }
    const lobby = reduceLobby(HOST, T0, [joined])
    expect(dueExpiry(lobby, T0 + LOBBY_IDLE_TTL_MS)).toBeNull()
    expect(lobbyExpiresAt(lobby)).toBe(joined.at + LOBBY_IDLE_TTL_MS)
  })

  it('a started or closed room cannot expire', () => {
    const closed = reduceLobby(HOST, T0, [{ seq: 1, type: 'abandoned', at: T0 + 5, userId: HOST }])
    expect(lobbyExpiresAt(closed)).toBeNull()
    expect(closed).toMatchObject({ status: 'abandoned', closedReason: 'host', closedAt: T0 + 5 })
    expect(deletableFrom(closed)).toBe(T0 + 5 + CLOSED_LOBBY_RETENTION_MS)
    const open = initialLobby(HOST, T0)
    expect(deletableFrom(open)).toBeNull()
  })

  it('the log refuses an expiry at any other instant, or on a room that is not an open lobby', () => {
    const lobby = initialLobby(HOST, T0)
    const at = T0 + LOBBY_IDLE_TTL_MS
    expect(() => applyLobbyEvent(lobby, { seq: 1, type: 'expired', at: at - 1, userId: SYSTEM_ACTOR })).toThrow()
    expect(() => applyLobbyEvent(lobby, { seq: 1, type: 'expired', at: at + 1, userId: SYSTEM_ACTOR })).toThrow()
    const expired = applyLobbyEvent(lobby, { seq: 1, type: 'expired', at, userId: SYSTEM_ACTOR })
    expect(expired).toMatchObject({ status: 'abandoned', closedReason: 'expired', closedAt: at })
    expect(() => applyLobbyEvent(expired, { seq: 2, type: 'expired', at: at + LOBBY_IDLE_TTL_MS, userId: SYSTEM_ACTOR })).toThrow()
    expect(() => applyLobbyEvent(expired, { seq: 2, type: 'member_joined', at: at + 1, userId: CMDR })).toThrow()
  })
})

describe('lobby expiry (commands)', () => {
  const EXPIRY = T0 + LOBBY_IDLE_TTL_MS

  it('a code works until the instant of expiry and not from it', async () => {
    const open = memoryStore()
    const a = await openRoom(open.store)
    expect(await joinRoom(open.store, CMDR, { inviteCode: a.inviteCode }, EXPIRY - 1)).toMatchObject({ ok: true })

    const shut = memoryStore()
    const b = await openRoom(shut.store)
    expect(await joinRoom(shut.store, CMDR, { inviteCode: b.inviteCode }, EXPIRY)).toMatchObject({ ok: false, code: 'room_not_open' })
    const log = shut.lobbyEvents.get(b.roomId)!
    expect(log).toEqual([{ seq: 1, type: 'expired', at: EXPIRY, userId: SYSTEM_ACTOR }])
  })

  it('the host sees an expired room as closed, and why', async () => {
    const { store, rooms } = memoryStore()
    const room = await openRoom(store)
    const view = must(await syncRoom(store, HOST, { roomId: room.roomId }, EXPIRY + 5_000_000))
    expect(view).toMatchObject({ status: 'abandoned', closedReason: 'expired' })
    expect(rooms.get(room.roomId)!.view).toMatchObject({ status: 'abandoned', closedReason: 'expired' })
    // Nothing can be done in it any more.
    expect(await claimRole(store, HOST, { roomId: room.roomId, role: 'commander' }, EXPIRY + 6_000_000)).toMatchObject({ ok: false, code: 'roles_locked' })
    expect(await startRoom(store, HOST, { roomId: room.roomId }, EXPIRY + 6_000_000)).toMatchObject({ ok: false, code: 'room_not_open' })
  })

  it('a room closed by its host says so', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    expect(must(await abandonRoom(store, HOST, { roomId: room.roomId }, T0 + 1000))).toMatchObject({ status: 'abandoned', closedReason: 'host' })
  })

  it('a full, ready lobby that is never started expires too, and cannot then be started', async () => {
    const { store } = memoryStore()
    const room = await readyRoom(store)
    const lastEvent = T0 + 5000
    expect(await startRoom(store, HOST, { roomId: room.roomId }, lastEvent + LOBBY_IDLE_TTL_MS)).toMatchObject({ ok: false, code: 'room_not_open' })
  })

  it('a started room never expires', async () => {
    const { store, lobbyEvents } = memoryStore()
    const room = await startedRoom(store)
    const year = 365 * 24 * 3_600_000
    expect(must(await syncRoom(store, CMDR, { roomId: room.roomId }, T0 + year)).status).toBe('completed')
    expect(lobbyEvents.get(room.roomId)!.some((e) => e.type === 'expired')).toBe(false)
  })

  it('many people touching an expired lobby at once record its expiry once', async () => {
    for (const seed of SEEDS) {
      const { store, lobbyEvents } = memoryStore(seed)
      const room = await openRoom(store)
      const now = EXPIRY + 1234
      const results = await Promise.all([
        joinRoom(store, CMDR, { inviteCode: room.inviteCode }, now),
        joinRoom(store, INFRA, { inviteCode: room.inviteCode }, now),
        syncRoom(store, HOST, { roomId: room.roomId }, now),
        claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, now),
        sweepRoom(store, room.roomId, now),
      ])
      expect(results[0]).toMatchObject({ ok: false, code: 'room_not_open' })
      expect(results[1]).toMatchObject({ ok: false, code: 'room_not_open' })
      expect(results[2]).toMatchObject({ ok: true, data: { status: 'abandoned', closedReason: 'expired' } })
      expect(lobbyEvents.get(room.roomId)!).toEqual([{ seq: 1, type: 'expired', at: EXPIRY, userId: SYSTEM_ACTOR }])
    }
  })

  it('a lobby log cannot grow without end, but the room can always be closed', async () => {
    const { store, lobbyEvents } = memoryStore()
    const room = await openRoom(store)
    let now = T0
    let refused: unknown = null
    for (let i = 0; i < MAX_LOBBY_EVENTS; i++) {
      now += 1000
      const result =
        i % 2 === 0
          ? await claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, now)
          : await releaseRole(store, HOST, { roomId: room.roomId }, now)
      if (!result.ok) {
        refused = result
        break
      }
    }
    expect(refused).toMatchObject({ ok: false, code: 'room_limit_reached' })
    expect(lobbyEvents.get(room.roomId)!).toHaveLength(MAX_LOBBY_EVENTS - 2)
    expect(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, now + 1)).toMatchObject({ ok: false, code: 'room_limit_reached' })
    expect(must(await abandonRoom(store, HOST, { roomId: room.roomId }, now + 2)).status).toBe('abandoned')
    expect(lobbyEvents.get(room.roomId)!.length).toBeLessThanOrEqual(MAX_LOBBY_EVENTS)
  })
})

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('room sweep', () => {
  const DAY = 24 * 3_600_000

  it('expires idle lobbies, finishes overdue simulations and deletes only long-closed lobbies', async () => {
    const { store, rooms, lobbyEvents, events } = memoryStore()
    const idle = await openRoom(store, HOST, T0, byteSource(1))
    const busy = await openRoom(store, CMDR, T0, byteSource(2))
    const closed = await openRoom(store, INFRA, T0, byteSource(3))
    must(await abandonRoom(store, INFRA, { roomId: closed.roomId }, T0 + 1000))
    const running = await startedRoom(store, T0 + DAY - 60_000, byteSource(4))
    const overdue = await startedRoom(store, T0, byteSource(5))

    // One day on: `busy` saw activity an hour ago and stays open.
    const now = T0 + DAY
    must(await joinRoom(store, OUTSIDER, { inviteCode: busy.inviteCode }, now - 3_600_000))
    const first = await sweepRooms(store, now)
    expect(first).toMatchObject({ expired: 1, completed: 1, deleted: 0, failed: 0 })
    expect(rooms.get(idle.roomId)!.view).toMatchObject({ status: 'abandoned', closedReason: 'expired' })
    expect(rooms.get(busy.roomId)!.view).toMatchObject({ status: 'lobby' })
    expect(rooms.get(closed.roomId)!.view).toMatchObject({ status: 'abandoned', closedReason: 'host' })
    expect(rooms.get(running.roomId)!.view).toMatchObject({ status: 'active' })
    expect(rooms.get(overdue.roomId)!.view).toMatchObject({ status: 'completed' })
    expect(events.get(overdue.roomId)!.at(-1)).toMatchObject({ incidentId: 'finalization', at: T0 + SIMULATION_DURATION_MS })
    expect(events.get(running.roomId) ?? []).toHaveLength(0) // not yet due: the sweep leaves a running game alone

    // Sweeping again changes nothing.
    expect(await sweepRooms(store, now)).toMatchObject({ expired: 0, completed: 0, deleted: 0, failed: 0 })

    // Just short of the retention period: both closed lobbies are still there.
    const closedAt = T0 + 1000
    await sweepRooms(store, closedAt + CLOSED_LOBBY_RETENTION_MS - 1)
    expect(rooms.has(closed.roomId)).toBe(true)
    // At it: the host-closed lobby goes; the expired one closed a day later and stays.
    const second = await sweepRooms(store, closedAt + CLOSED_LOBBY_RETENTION_MS)
    expect(second.deleted).toBe(1)
    expect(rooms.has(closed.roomId)).toBe(false)
    expect(lobbyEvents.has(closed.roomId)).toBe(false)
    expect(rooms.has(idle.roomId)).toBe(true)

    // A year on: every lobby is gone, every game that started is intact.
    const year = T0 + 365 * DAY
    await sweepRooms(store, year)
    await sweepRooms(store, year + 10 * DAY)
    expect(rooms.has(idle.roomId)).toBe(false)
    expect(rooms.has(busy.roomId)).toBe(false)
    for (const game of [running, overdue]) {
      expect(rooms.get(game.roomId)!.view).toMatchObject({ status: 'completed' })
      expect(lobbyEvents.get(game.roomId)!.at(-1)).toMatchObject({ type: 'started' })
      const view = must(await syncSimulation(store, CMDR, { simulationId: game.roomId }, year + 20 * DAY))
      expect(view.result).toMatchObject({ reason: 'deadline' })
      expect(view.events.at(-1)).toMatchObject({ incidentId: 'finalization' })
      expect(view.findings.length).toBeGreaterThan(0)
    }
  })

  it('a deleted lobby is gone for everyone: its id and its code both mean nothing', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 1000))
    must(await abandonRoom(store, HOST, { roomId: room.roomId }, T0 + 2000))
    const later = T0 + 2000 + CLOSED_LOBBY_RETENTION_MS
    expect(await sweepRoom(store, room.roomId, later)).toBe('deleted')
    expect(await syncRoom(store, HOST, { roomId: room.roomId }, later)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await syncRoom(store, CMDR, { roomId: room.roomId }, later)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await joinRoom(store, INFRA, { inviteCode: room.inviteCode }, later)).toMatchObject({ ok: false, code: 'invalid_invite' })
    expect(await sweepRoom(store, room.roomId, later + 1)).toBe('kept')
  })

  it('never deletes a room that started, whatever its row says', async () => {
    const { store, rooms, events } = memoryStore()
    const room = await startedRoom(store)
    must(await run(store, HOST, room.roomId, 'inspect_access_logs', T0 + 1000))
    // A corrupt or stale view claiming the room is a closed lobby must not get it deleted.
    const record = rooms.get(room.roomId)!
    rooms.set(room.roomId, { ...record, view: { ...record.view!, status: 'abandoned', closedReason: 'host' } })
    const farFuture = T0 + 10 * 365 * DAY
    expect((await sweepRooms(store, farFuture)).deleted).toBe(0)
    expect(rooms.get(room.roomId)!.view).toMatchObject({ status: 'completed' })
    expect(events.get(room.roomId)!.length).toBeGreaterThan(0)
  })

  it('sweeping while people use a lobby loses nothing', async () => {
    for (const seed of SEEDS) {
      const { store, rooms, lobbyEvents } = memoryStore(seed)
      const room = await openRoom(store)
      const now = T0 + 5000
      await Promise.all([
        sweepRooms(store, now),
        joinRoom(store, CMDR, { inviteCode: room.inviteCode }, now),
        sweepRoom(store, room.roomId, now),
        claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, now),
        joinRoom(store, INFRA, { inviteCode: room.inviteCode }, now),
      ])
      const lobby = reduceLobby(HOST, T0, lobbyEvents.get(room.roomId)!)
      expect(lobby.status).toBe('lobby')
      expect(lobby.members.map((m) => m.userId).sort()).toEqual([CMDR, HOST, INFRA].sort())
      expect(must(await syncRoom(store, HOST, { roomId: room.roomId }, now + 1)).members).toHaveLength(3)
      expect(rooms.get(room.roomId)!.view?.lobbySeq).toBe(lobby.lastSeq)
    }
  })

  it('refreshRoomView and isRoomMember read the log, not the request', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 1000))
    expect(await isRoomMember(store, HOST, room.roomId)).toBe(true)
    expect(await isRoomMember(store, CMDR, room.roomId)).toBe(true)
    expect(await isRoomMember(store, OUTSIDER, room.roomId)).toBe(false)
    expect(await isRoomMember(store, '', room.roomId)).toBe(false)
    for (const bad of [undefined, null, 5, 'short', { roomId: room.roomId }, 'no-such-room-id']) {
      expect(await isRoomMember(store, HOST, bad)).toBe(false)
    }
    must(await leaveRoom(store, CMDR, { roomId: room.roomId }, T0 + 2000))
    expect(await isRoomMember(store, CMDR, room.roomId)).toBe(false)
    expect(await refreshRoomView(store, 'no-such-room-id', T0)).toBeNull()
    expect(await refreshRoomView(store, room.roomId, T0 + 3000)).toMatchObject({ status: 'lobby', memberIds: [HOST] })
  })
})

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('rate limits', () => {
  const SMALL = { limit: 5, windowMs: 60_000 }

  it('grants exactly the limit, then refuses until the window ends', async () => {
    const { store } = memoryStore()
    const now = 600_000_000 + 12_345
    for (let i = 0; i < SMALL.limit; i++) expect(await takeSlot(store, HOST, 'create_room', now + i, SMALL)).toEqual({ ok: true })
    const refused = await takeSlot(store, HOST, 'create_room', now + 10, SMALL)
    expect(refused.ok).toBe(false)
    const windowEnd = (windowOf(now, SMALL) + 1) * SMALL.windowMs
    expect(refused).toEqual({ ok: false, retryAfterMs: windowEnd - (now + 10) })
    expect(await isExhausted(store, HOST, 'create_room', now + 10, SMALL)).toMatchObject({ ok: false })
    expect(await takeSlot(store, HOST, 'create_room', windowEnd - 1, SMALL)).toMatchObject({ ok: false })
    expect(await takeSlot(store, HOST, 'create_room', windowEnd, SMALL)).toEqual({ ok: true })
  })

  it('counts each person and each kind separately', async () => {
    const { store } = memoryStore()
    for (let i = 0; i < SMALL.limit; i++) await takeSlot(store, HOST, 'create_room', T0, SMALL)
    expect(await takeSlot(store, HOST, 'create_room', T0, SMALL)).toMatchObject({ ok: false })
    expect(await takeSlot(store, CMDR, 'create_room', T0, SMALL)).toEqual({ ok: true })
    expect(await takeSlot(store, HOST, 'join_attempt', T0, SMALL)).toEqual({ ok: true })
  })

  it('never grants more than the limit, however many requests arrive at once', async () => {
    for (const seed of SEEDS) {
      const { store, slots } = memoryStore(seed)
      const results = await Promise.all(Array.from({ length: SMALL.limit * 3 }, () => takeSlot(store, HOST, 'create_room', T0, SMALL)))
      expect(results.filter((r) => r.ok)).toHaveLength(SMALL.limit)
      expect(slots.map((s) => s.n).sort()).toEqual([1, 2, 3, 4, 5])
    }
  })

  it('drops the rows of earlier windows when a new one begins', async () => {
    const { store, slots } = memoryStore()
    for (let i = 0; i < SMALL.limit; i++) await takeSlot(store, HOST, 'create_room', T0, SMALL)
    await takeSlot(store, CMDR, 'create_room', T0, SMALL)
    await takeSlot(store, HOST, 'create_room', T0 + 5 * SMALL.windowMs, SMALL)
    expect(slots.filter((s) => s.userId === HOST)).toHaveLength(1)
    expect(slots.filter((s) => s.userId === CMDR)).toHaveLength(1) // someone else's rows are not touched
  })

  it('describes the wait in whole minutes', () => {
    expect(describeWait(1)).toBe('about a minute')
    expect(describeWait(60_000)).toBe('about a minute')
    expect(describeWait(60_001)).toBe('about 2 minutes')
    expect(describeWait(3_600_000)).toBe('about 60 minutes')
  })

  it('limits how many rooms one person can create; retries of a command stay free', async () => {
    const { store, rooms } = memoryStore()
    const random = byteSource()
    const firstId = cid()
    must(await createRoom(store, HOST, { commandId: firstId }, T0, random))
    for (let i = 1; i < LIMITS.create_room.limit; i++) must(await createRoom(store, HOST, { commandId: cid() }, T0 + i, random))
    const refused = await createRoom(store, HOST, { commandId: cid() }, T0 + 1000, random)
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(refused.ok ? '' : refused.message).toMatch(/Try again in about \d+ minutes?\./)
    expect(rooms.size).toBe(LIMITS.create_room.limit)
    // Repeating an earlier command is not a new room and still answers.
    expect(must(await createRoom(store, HOST, { commandId: firstId }, T0 + 2000, random)).replayed).toBe(true)
    // Someone else is unaffected, and so is this person in the next window.
    expect(await createRoom(store, CMDR, { commandId: cid() }, T0 + 1000, random)).toMatchObject({ ok: true })
    expect(await createRoom(store, HOST, { commandId: cid() }, T0 + LIMITS.create_room.windowMs, random)).toMatchObject({ ok: true })
  })

  it('limits how many simulations one person can start', async () => {
    const { store, simulations } = memoryStore()
    const firstId = cid()
    must(await createSoloSimulation(store, HOST, { commandId: firstId }, T0))
    for (let i = 1; i < LIMITS.create_simulation.limit; i++) must(await createSoloSimulation(store, HOST, { commandId: cid() }, T0 + i))
    expect(await createSoloSimulation(store, HOST, { commandId: cid() }, T0 + 1000)).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(simulations.size).toBe(LIMITS.create_simulation.limit)
    expect(must(await createSoloSimulation(store, HOST, { commandId: firstId }, T0 + 2000)).replayed).toBe(true)
    expect(await createSoloSimulation(store, CMDR, { commandId: cid() }, T0 + 1000)).toMatchObject({ ok: true })
  })

  it('bounds invitation-code attempts: once spent, even the right code is refused', async () => {
    const { store, lobbyEvents } = memoryStore()
    const room = await openRoom(store)
    for (let i = 0; i < LIMITS.join_attempt.limit; i++) {
      expect(await joinRoom(store, OUTSIDER, { inviteCode: '000000000000' }, T0 + i)).toMatchObject({ ok: false, code: 'invalid_invite' })
    }
    expect(await joinRoom(store, OUTSIDER, { inviteCode: '000000000001' }, T0 + 500)).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(await joinRoom(store, OUTSIDER, { inviteCode: room.inviteCode }, T0 + 501)).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(lobbyEvents.get(room.roomId)!).toHaveLength(0)
    // Another person with the real code is not affected by the guesser.
    expect(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 502)).toMatchObject({ ok: true })
    // The guesser can use a real code again in the next window.
    expect(await joinRoom(store, OUTSIDER, { inviteCode: room.inviteCode }, T0 + LIMITS.join_attempt.windowMs)).toMatchObject({ ok: true })
  })

  it('a burst of simultaneous guesses cannot exceed the limit', async () => {
    const { store, slots } = memoryStore(3)
    const room = await openRoom(store)
    const results = await Promise.all(
      Array.from({ length: LIMITS.join_attempt.limit + 30 }, (_, i) =>
        joinRoom(store, OUTSIDER, { inviteCode: String(i).padStart(12, '0') }, T0),
      ),
    )
    expect(results.filter((r) => !r.ok && r.code === 'invalid_invite')).toHaveLength(LIMITS.join_attempt.limit)
    expect(results.filter((r) => !r.ok && r.code === 'rate_limited')).toHaveLength(30)
    expect(slots.filter((s) => s.kind === 'join_attempt')).toHaveLength(LIMITS.join_attempt.limit)
    expect(room.status).toBe('lobby')
  })
})
