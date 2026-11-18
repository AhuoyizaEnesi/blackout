/**
 * In-memory stand-in for the RecordRoom store, for unit tests only.
 *
 * It keeps the two guarantees the real room gives (checked against deepspace
 * 0.44.2 and exercised for real in tests/simulation.spec.ts and
 * tests/team.spec.ts): a uniqueness check and its insert are one indivisible
 * step, and everything else can interleave. Every call yields first, in a
 * seeded pseudo-random order, so concurrent commands genuinely interleave
 * between their reads and writes.
 *
 * This proves the command logic. It does not prove the real room: that is
 * what the Playwright suites are for.
 */

import { SIMULATION_DURATION_MS, type GameEvent } from '../../game/engine'
import { reduceLobby, type LobbyEvent } from '../../game/lobby'
import type { Finding, GameStore, NewSimulation, Participant, SimulationRecord } from './commands'
import type { LimitKind, RateStore } from './limits'
import type { RoomRecord, RoomStore, RoomViewData } from './rooms'

export function memoryStore(seed = 1) {
  const simulations = new Map<string, SimulationRecord & { createCommandId: string }>()
  const events = new Map<string, GameEvent[]>()
  const rooms = new Map<string, RoomRecord & { createCommandId: string }>()
  const lobbyEvents = new Map<string, LobbyEvent[]>()
  const findings = new Map<string, Finding[]>()
  const slots: { userId: string; kind: LimitKind; window: number; n: number; at: number }[] = []
  /** When each room row was last written, for `listRoomsByStatus`. */
  const roomWrites = new Map<string, number>()
  let writeClock = 0
  let nextId = 1
  let rng = seed
  const stats = { appendAttempts: 0, appendConflicts: 0, lobbyAttempts: 0, lobbyConflicts: 0, viewWrites: 0 }
  /** Set to make the next `createFinding` calls fail, as if the worker stopped between two writes. */
  const faults = { dropFindings: false }

  const pause = async () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    const turns = rng % 4
    for (let i = 0; i < turns; i++) await Promise.resolve()
  }
  const mint = (prefix: string) => `${prefix}-${String(nextId++).padStart(6, '0')}`

  const store: GameStore & RoomStore & RateStore = {
    async getSimulation(id) {
      await pause()
      const solo = simulations.get(id)
      if (solo) return solo
      const room = rooms.get(id)
      if (!room) return null
      const lobby = reduceLobby(room.hostId, room.createdAt, lobbyEvents.get(id) ?? [])
      if (lobby.status !== 'active' || lobby.startedAt === undefined) return null
      const members: Participant[] = lobby.members.map((m) => ({ userId: m.userId, role: m.role! }))
      return {
        id,
        ownerId: room.hostId,
        mode: 'team',
        members,
        scenarioId: room.scenarioId,
        rulesVersion: room.rulesVersion,
        startedAt: lobby.startedAt,
        deadlineAt: lobby.startedAt + SIMULATION_DURATION_MS,
      }
    },
    async findSimulationByCommand(ownerId, createCommandId) {
      await pause()
      for (const s of simulations.values()) {
        if (s.ownerId === ownerId && s.createCommandId === createCommandId) return s
      }
      return null
    },
    async createSimulation(data: NewSimulation) {
      await pause()
      for (const s of simulations.values()) {
        if (s.ownerId === data.ownerId && s.createCommandId === data.createCommandId) {
          return { status: 'conflict' }
        }
      }
      const id = mint('sim')
      simulations.set(id, { id, members: [], ...data })
      events.set(id, [])
      return { status: 'created', id }
    },
    async listEvents(simulationId) {
      await pause()
      return [...(events.get(simulationId) ?? [])]
    },
    async appendEvent(simulation, event) {
      await pause()
      stats.appendAttempts++
      const log = events.get(simulation.id) ?? []
      events.set(simulation.id, log)
      if (log.some((e) => e.seq === event.seq)) {
        stats.appendConflicts++
        return 'conflict'
      }
      log.push(event)
      return 'ok'
    },
    async listFindings(simulationId) {
      await pause()
      return [...(findings.get(simulationId) ?? [])]
    },
    async createFinding(simulation, finding) {
      await pause()
      if (faults.dropFindings) return 'ok' // the write is lost
      const list = findings.get(simulation.id) ?? []
      findings.set(simulation.id, list)
      if (list.some((f) => f.eventSeq === finding.eventSeq && f.scope === finding.scope)) return 'conflict'
      list.push(finding)
      return 'ok'
    },

    async getRoom(id) {
      await pause()
      return rooms.get(id) ?? null
    },
    async findRoomByCommand(hostId, createCommandId) {
      await pause()
      for (const r of rooms.values()) if (r.hostId === hostId && r.createCommandId === createCommandId) return r
      return null
    },
    async findRoomsByCode(inviteCode) {
      await pause()
      return [...rooms.values()].filter((r) => r.inviteCode === inviteCode)
    },
    async createRoom(data, view) {
      await pause()
      for (const r of rooms.values()) {
        if (r.hostId === data.hostId && r.createCommandId === data.createCommandId) return { status: 'conflict' }
      }
      const id = mint('room')
      rooms.set(id, { id, ...data, view })
      roomWrites.set(id, ++writeClock)
      lobbyEvents.set(id, [])
      return { status: 'created', id }
    },
    async listLobbyEvents(roomId) {
      await pause()
      return [...(lobbyEvents.get(roomId) ?? [])]
    },
    async appendLobbyEvent(roomId, event) {
      await pause()
      stats.lobbyAttempts++
      // The real room refuses an empty value in a required column (deepspace 0.44.2, putRecord).
      if (!event.userId || !event.type) throw new Error('team_room_events create failed: missing required field')
      const log = lobbyEvents.get(roomId) ?? []
      lobbyEvents.set(roomId, log)
      if (log.some((e) => e.seq === event.seq)) {
        stats.lobbyConflicts++
        return 'conflict'
      }
      log.push(event)
      return 'ok'
    },
    async writeRoomView(roomId, view: RoomViewData) {
      await pause()
      stats.viewWrites++
      const room = rooms.get(roomId)
      if (!room) throw new Error('team_rooms update failed: record not found')
      rooms.set(roomId, { ...room, view })
      roomWrites.set(roomId, ++writeClock)
    },
    async listRoomsByStatus(status, limit) {
      await pause()
      return [...rooms.values()]
        .filter((room) => room.view?.status === status)
        .sort((a, b) => (roomWrites.get(a.id) ?? 0) - (roomWrites.get(b.id) ?? 0))
        .slice(0, limit)
    },
    async deleteRoom(roomId) {
      await pause()
      rooms.delete(roomId)
      await pause()
      lobbyEvents.delete(roomId)
    },

    async listSlots(userId, kind, window) {
      await pause()
      return slots.filter((s) => s.userId === userId && s.kind === kind && s.window === window).map((s) => s.n)
    },
    async createSlot(userId, kind, window, n, at) {
      await pause()
      if (slots.some((s) => s.userId === userId && s.kind === kind && s.window === window && s.n === n)) return 'conflict'
      slots.push({ userId, kind, window, n, at })
      return 'ok'
    },
    async deleteSlotsBefore(userId, kind, window) {
      await pause()
      for (let i = slots.length - 1; i >= 0; i--) {
        const s = slots[i]
        if (s.userId === userId && s.kind === kind && s.window < window) slots.splice(i, 1)
      }
    },
  }
  return { store, events, stats, simulations, rooms, lobbyEvents, findings, faults, slots }
}
