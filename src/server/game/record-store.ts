/**
 * GameStore backed by the app's RecordRoom, through server-action tools.
 *
 * Each method is one tool call, and each tool call is one synchronous
 * operation inside the room's Durable Object — so `appendEvent`'s uniqueness
 * check and insert cannot be interleaved with another writer's.
 */

import type { ActionTools } from 'deepspace/worker'
import {
  GAME_EVENT_TYPES,
  SIMULATION_DURATION_MS,
  isActionId,
  isIncidentId,
  type GameEvent,
  type GameEventType,
} from '../../game/engine.js'
import { LOBBY_EVENT_TYPES, isRole, reduceLobby, type LobbyEvent, type LobbyEventType } from '../../game/lobby.js'
import type { SimulationEventRow, SimulationRow } from '../../schemas/simulation-schema.js'
import type { RateSlotRow, SimulationFindingRow, TeamRoomEventRow, TeamRoomRow } from '../../schemas/team-schema.js'
import type { Finding, GameStore, NewSimulation, Participant, SimulationRecord } from './commands.js'
import type { RateStore } from './limits.js'
import type { RoomRecord, RoomStatus, RoomStore, RoomViewData } from './rooms.js'

const SIMULATIONS = 'simulations'
const EVENTS = 'simulation_events'
const ROOMS = 'team_rooms'
const ROOM_EVENTS = 'team_room_events'
const FINDINGS = 'simulation_findings'
const RATE_SLOTS = 'rate_slots'
/** The room deletes at most this many rows per `deleteWhere` call. */
const DELETE_PAGE = 500

/** The record operations the store needs. Server actions, the timer and the sweep each supply them. */
export type RecordTools = Pick<ActionTools, 'create' | 'update' | 'get' | 'query' | 'remove' | 'deleteWhere'>

/** The room reports a `uniqueOn` violation as a failed result with this prefix. */
function isDuplicate(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith('Duplicate:')
}

function toSimulation(recordId: string, data: SimulationRow): SimulationRecord {
  return {
    id: recordId,
    ownerId: data.ownerId,
    mode: 'solo',
    members: [],
    scenarioId: data.scenarioId,
    // Only a real number is a version. A missing column reads as null.
    rulesVersion: typeof data.rulesVersion === 'number' ? data.rulesVersion : null,
    startedAt: Number(data.startedAt),
    deadlineAt: Number(data.deadlineAt),
  }
}

function toEvent(data: SimulationEventRow): GameEvent {
  if (!GAME_EVENT_TYPES.includes(data.type as GameEventType)) {
    throw new Error(`Stored event has unknown type: ${data.type}`)
  }
  const type = data.type as GameEventType
  // Empty columns come back as null or '', never as a usable id.
  const actionId = data.actionId || undefined
  const incidentId = data.incidentId || undefined
  if (type === 'incident') {
    if (!isIncidentId(incidentId)) throw new Error(`Stored event has unknown incident: ${incidentId}`)
  } else if (!isActionId(actionId)) {
    throw new Error(`Stored event has unknown action: ${actionId}`)
  }
  return {
    seq: Number(data.seq),
    type,
    ...(isActionId(actionId) ? { actionId } : {}),
    ...(isIncidentId(incidentId) ? { incidentId } : {}),
    at: Number(data.at),
    actorId: data.actorId ?? '',
    commandId: data.commandId ?? '',
    ...(data.finding ? { finding: data.finding } : {}),
  }
}

const ROOM_STATUSES: readonly RoomStatus[] = ['lobby', 'active', 'completed', 'abandoned']

function toRoom(recordId: string, data: TeamRoomRow): RoomRecord {
  const status = ROOM_STATUSES.find((s) => s === data.status)
  const view: RoomViewData | null =
    status && Array.isArray(data.members) && Array.isArray(data.memberIds)
      ? {
          status,
          memberIds: data.memberIds,
          members: data.members.map((m) => ({
            userId: m.userId,
            role: isRole(m.role) ? m.role : null,
            joinedAt: Number(m.joinedAt),
          })),
          lobbySeq: Number(data.lobbySeq ?? 0),
          startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
          deadlineAt: typeof data.deadlineAt === 'number' ? data.deadlineAt : null,
          closedReason: data.closedReason === 'host' || data.closedReason === 'expired' ? data.closedReason : null,
        }
      : null
  return {
    id: recordId,
    hostId: data.hostId,
    inviteCode: data.inviteCode,
    scenarioId: data.scenarioId,
    rulesVersion: Number(data.rulesVersion),
    createdAt: Number(data.createdAt),
    view,
  }
}

function toLobbyEvent(data: TeamRoomEventRow): LobbyEvent {
  if (!LOBBY_EVENT_TYPES.includes(data.type as LobbyEventType)) {
    throw new Error(`Stored lobby event has unknown type: ${data.type}`)
  }
  return {
    seq: Number(data.seq),
    type: data.type as LobbyEventType,
    at: Number(data.at),
    userId: data.userId,
    ...(isRole(data.role) ? { role: data.role } : {}),
  }
}

/** The view columns as written to the row. */
function viewColumns(view: RoomViewData): Record<string, unknown> {
  return {
    status: view.status,
    memberIds: view.memberIds,
    members: view.members,
    lobbySeq: view.lobbySeq,
    ...(view.startedAt === null ? {} : { startedAt: view.startedAt }),
    ...(view.deadlineAt === null ? {} : { deadlineAt: view.deadlineAt }),
    ...(view.closedReason === null ? {} : { closedReason: view.closedReason }),
  }
}

export function createRecordStore(tools: RecordTools): GameStore & RoomStore & RateStore {
  async function getRoom(id: string): Promise<RoomRecord | null> {
    const result = await tools.get<Record<string, unknown>>(ROOMS, id)
    if (!result.success) return null
    return toRoom(result.data.record.recordId, result.data.record.data as unknown as TeamRoomRow)
  }

  async function listLobbyEvents(roomId: string): Promise<LobbyEvent[]> {
    const result = await tools.query<Record<string, unknown>>(ROOM_EVENTS, {
      where: { roomId },
      orderBy: 'seq',
      orderDir: 'asc',
    })
    if (!result.success) throw new Error(`team_room_events query failed: ${result.error}`)
    return result.data.records
      .map((record) => toLobbyEvent(record.data as unknown as TeamRoomEventRow))
      .sort((a, b) => a.seq - b.seq)
  }

  /**
   * A started team room as a simulation. Membership, roles and the start
   * time come from the lobby LOG, not from the view on the row: the log is
   * the authority, and by the time it says `started` it can no longer change.
   */
  async function getTeamSimulation(id: string): Promise<SimulationRecord | null> {
    const room = await getRoom(id)
    if (!room) return null
    const lobby = reduceLobby(room.hostId, room.createdAt, await listLobbyEvents(room.id))
    if (lobby.status !== 'active' || lobby.startedAt === undefined) return null
    const members: Participant[] = []
    for (const member of lobby.members) {
      if (member.role === null) return null // cannot happen: a room starts only with every role filled
      members.push({ userId: member.userId, role: member.role })
    }
    return {
      id: room.id,
      ownerId: room.hostId,
      mode: 'team',
      members,
      scenarioId: room.scenarioId,
      rulesVersion: room.rulesVersion,
      startedAt: lobby.startedAt,
      deadlineAt: lobby.startedAt + SIMULATION_DURATION_MS,
    }
  }

  return {
    getRoom,
    listLobbyEvents,

    async findRoomByCommand(hostId, createCommandId) {
      const result = await tools.query<Record<string, unknown>>(ROOMS, { where: { hostId, createCommandId }, limit: 1 })
      if (!result.success) throw new Error(`team_rooms query failed: ${result.error}`)
      const [record] = result.data.records
      return record ? toRoom(record.recordId, record.data as unknown as TeamRoomRow) : null
    },

    async findRoomsByCode(inviteCode) {
      const result = await tools.query<Record<string, unknown>>(ROOMS, { where: { inviteCode }, limit: 2 })
      if (!result.success) throw new Error(`team_rooms query failed: ${result.error}`)
      return result.data.records.map((record) => toRoom(record.recordId, record.data as unknown as TeamRoomRow))
    },

    async createRoom(data, view) {
      const result = await tools.create(ROOMS, { ...data, ...viewColumns(view) })
      if (result.success) return { status: 'created', id: result.data.recordId }
      if (isDuplicate(result.error)) return { status: 'conflict' }
      throw new Error(`team_rooms create failed: ${result.error}`)
    },

    async appendLobbyEvent(roomId, event) {
      const row: TeamRoomEventRow = {
        roomId,
        seq: event.seq,
        type: event.type,
        userId: event.userId,
        ...(event.role ? { role: event.role } : {}),
        at: event.at,
      }
      const result = await tools.create(ROOM_EVENTS, row as unknown as Record<string, unknown>)
      if (result.success) return 'ok'
      if (isDuplicate(result.error)) return 'conflict'
      throw new Error(`team_room_events create failed: ${result.error}`)
    },

    async writeRoomView(roomId, view) {
      const result = await tools.update(ROOMS, roomId, viewColumns(view))
      if (!result.success) throw new Error(`team_rooms update failed: ${result.error}`)
    },

    async listRoomsByStatus(status, limit) {
      const result = await tools.query<Record<string, unknown>>(ROOMS, {
        where: { status },
        orderBy: 'updatedAt',
        orderDir: 'asc',
        limit,
      })
      if (!result.success) throw new Error(`team_rooms query failed: ${result.error}`)
      return result.data.records.map((record) => toRoom(record.recordId, record.data as unknown as TeamRoomRow))
    },

    async deleteRoom(roomId) {
      // The row first: without it the room is unreachable, and its log can
      // no longer be mistaken for that of a new, empty lobby.
      const removed = await tools.remove(ROOMS, roomId)
      if (!removed.success) throw new Error(`team_rooms delete failed: ${removed.error}`)
      for (;;) {
        const page = await tools.deleteWhere(ROOM_EVENTS, { roomId }, DELETE_PAGE)
        if (!page.success) throw new Error(`team_room_events delete failed: ${page.error}`)
        if (page.data.deleted < DELETE_PAGE) return
      }
    },

    async listSlots(userId, kind, window) {
      const result = await tools.query<Record<string, unknown>>(RATE_SLOTS, { where: { userId, kind, window } })
      if (!result.success) throw new Error(`rate_slots query failed: ${result.error}`)
      return result.data.records.map((record) => Number((record.data as unknown as RateSlotRow).n))
    },

    async createSlot(userId, kind, window, n, at) {
      const row: RateSlotRow = { userId, kind, window, n, at }
      const result = await tools.create(RATE_SLOTS, row as unknown as Record<string, unknown>)
      if (result.success) return 'ok'
      if (isDuplicate(result.error)) return 'conflict'
      throw new Error(`rate_slots create failed: ${result.error}`)
    },

    async deleteSlotsBefore(userId, kind, window) {
      const result = await tools.query<Record<string, unknown>>(RATE_SLOTS, { where: { userId, kind } })
      if (!result.success) return
      const old = new Set<number>()
      for (const record of result.data.records) {
        const w = Number((record.data as unknown as RateSlotRow).window)
        if (w < window) old.add(w)
      }
      for (const w of old) await tools.deleteWhere(RATE_SLOTS, { userId, kind, window: w }, DELETE_PAGE)
    },

    async listFindings(simulationId) {
      const result = await tools.query<Record<string, unknown>>(FINDINGS, { where: { simulationId } })
      if (!result.success) throw new Error(`simulation_findings query failed: ${result.error}`)
      return result.data.records.map((record): Finding => {
        const data = record.data as unknown as SimulationFindingRow
        return {
          eventSeq: Number(data.eventSeq),
          scope: data.scope === 'team' ? 'team' : 'private',
          ownerId: data.ownerId,
          text: data.text,
          ...(data.sharedBy ? { sharedBy: data.sharedBy } : {}),
          at: Number(data.at),
        }
      })
    },

    async createFinding(simulation, finding) {
      const row: SimulationFindingRow = {
        simulationId: simulation.id,
        eventSeq: finding.eventSeq,
        scope: finding.scope,
        ownerId: finding.ownerId,
        // A team finding lists every participant; a private one lists nobody
        // and is readable by its owner alone.
        readers: finding.scope === 'team' ? simulation.members.map((member) => member.userId) : [],
        text: finding.text,
        ...(finding.sharedBy ? { sharedBy: finding.sharedBy } : {}),
        at: finding.at,
      }
      const result = await tools.create(FINDINGS, row as unknown as Record<string, unknown>)
      if (result.success) return 'ok'
      if (isDuplicate(result.error)) return 'conflict'
      throw new Error(`simulation_findings create failed: ${result.error}`)
    },

    async getSimulation(id) {
      const result = await tools.get<Record<string, unknown>>(SIMULATIONS, id)
      if (!result.success) return getTeamSimulation(id)
      return toSimulation(result.data.record.recordId, result.data.record.data as unknown as SimulationRow)
    },

    async findSimulationByCommand(ownerId, createCommandId) {
      const result = await tools.query<Record<string, unknown>>(SIMULATIONS, {
        where: { ownerId, createCommandId },
        limit: 1,
      })
      if (!result.success) throw new Error(`simulations query failed: ${result.error}`)
      const [record] = result.data.records
      return record ? toSimulation(record.recordId, record.data as unknown as SimulationRow) : null
    },

    async createSimulation(data: NewSimulation) {
      // No record id is passed: a caller-chosen id would turn create into an
      // upsert onto an existing row. The room mints the id.
      const row: SimulationRow = { ...data }
      const result = await tools.create(SIMULATIONS, row as unknown as Record<string, unknown>)
      if (result.success) return { status: 'created', id: result.data.recordId }
      if (isDuplicate(result.error)) return { status: 'conflict' }
      throw new Error(`simulations create failed: ${result.error}`)
    },

    async listEvents(simulationId) {
      const result = await tools.query<Record<string, unknown>>(EVENTS, {
        where: { simulationId },
        orderBy: 'seq',
        orderDir: 'asc',
      })
      if (!result.success) throw new Error(`simulation_events query failed: ${result.error}`)
      return result.data.records
        .map((record) => toEvent(record.data as unknown as SimulationEventRow))
        .sort((a, b) => a.seq - b.seq)
    },

    async appendEvent(simulation, event) {
      const row: SimulationEventRow = {
        simulationId: simulation.id,
        seq: event.seq,
        ownerId: simulation.ownerId,
        type: event.type,
        ...(event.actionId ? { actionId: event.actionId } : {}),
        ...(event.incidentId ? { incidentId: event.incidentId } : {}),
        at: event.at,
        actorId: event.actorId,
        commandId: event.commandId,
        ...(event.finding ? { finding: event.finding } : {}),
        // Team: every participant may read the event. Solo: the owner alone.
        ...(simulation.mode === 'team' ? { readers: simulation.members.map((member) => member.userId) } : {}),
      }
      const result = await tools.create(EVENTS, row as unknown as Record<string, unknown>)
      if (result.success) return 'ok'
      if (isDuplicate(result.error)) return 'conflict'
      throw new Error(`simulation_events create failed: ${result.error}`)
    },
  }
}

/** The environment a server-side caller needs to reach the app's record room. */
export interface RecordRoomEnv {
  RECORD_ROOMS: DurableObjectNamespace
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
}

/**
 * Record tools for the server's own work — the simulation timer and the
 * scheduled sweep — which have no caller. Same internal route the action
 * tools use; rows are attributed to the app owner. Never built from, or
 * handed to, anything a client sent.
 */
export function createSystemTools(env: RecordRoomEnv): RecordTools {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
  async function exec<T>(tool: string, params: Record<string, unknown>): Promise<T> {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': env.OWNER_USER_ID, 'X-App-Action': 'true' },
        body: JSON.stringify({ tool, params }),
      }),
    )
    return res.json() as Promise<T>
  }
  return {
    create: (collection, data, recordId) => exec('records.create', { collection, data, recordId }),
    update: (collection, recordId, data) => exec('records.update', { collection, recordId, data }),
    remove: (collection, recordId) => exec('records.delete', { collection, recordId }),
    deleteWhere: (collection, where, limit) => exec('records.deleteWhere', { collection, where, limit }),
    get: (collection, recordId) => exec('records.get', { collection, recordId }),
    query: (collection, options) => exec('records.query', { collection, ...options }),
  }
}
