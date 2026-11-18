/**
 * Team rooms: create, invite, join, claim a role, start.
 *
 * Authority: a room's membership and roles are a fold over its lobby log
 * (src/game/lobby.ts). Every command reads the whole log, validates against
 * the folded state, and appends ONE event at `lastSeq + 1`; the store refuses
 * a second event at the same position, and a refused writer reads again and
 * decides again. This is the same mechanism the simulation log uses, and it
 * is what makes "at most three participants", "one role each" and "one
 * participant per role" hold when several people click at the same moment:
 * two claims for one role cannot both be decided against the same log.
 *
 * The `team_rooms` row carries a VIEW of that log (status, members) so that
 * participants' browsers can follow the lobby live. It is rewritten after
 * each event and is never read to make a decision.
 *
 * Authorization: `userId` is the verified caller. A room is reachable in two
 * ways only — by its invitation code (to join), or by its id by someone the
 * lobby log already lists as a member. To anyone else a room does not exist.
 * The host can start or abandon the room; the host has no other privilege.
 */

import { RULES_VERSION, SIMULATION_DURATION_MS, finalResult, reduce, type GameEvent, type RoleId } from '../../game/engine.js'
import {
  INVITE_CODE_LENGTH,
  MAX_LOBBY_EVENTS,
  deletableFrom,
  dueExpiry,
  encodeInviteCode,
  memberOf,
  normalizeInviteCode,
  reduceLobby,
  validateAbandon,
  validateClaim,
  validateJoin,
  validateLeave,
  validateRelease,
  validateStart,
  type LobbyEvent,
  type LobbyEventType,
  type LobbyMember,
  type LobbyRefusal,
  type LobbyState,
  type LobbyVerdict,
} from '../../game/lobby.js'
import { SCENARIO_ID, settleSimulation, type GameStore } from './commands.js'
import { describeWait, takeSlot, type RateStore } from './limits.js'

/** The immutable identity of a room. */
export interface RoomRecord {
  id: string
  hostId: string
  inviteCode: string
  scenarioId: string
  rulesVersion: number
  createdAt: number
  /** The view currently on the row, as last read. Never used to decide anything. */
  view: RoomViewData | null
}

export type RoomStatus = 'lobby' | 'active' | 'completed' | 'abandoned'

/** What the server writes onto the room row for members to read. */
export interface RoomViewData {
  status: RoomStatus
  memberIds: string[]
  members: LobbyMember[]
  lobbySeq: number
  startedAt: number | null
  deadlineAt: number | null
  /** Why a closed lobby closed; null while the room is open, running or finished. */
  closedReason: 'host' | 'expired' | null
}

export interface RoomStore {
  getRoom(id: string): Promise<RoomRecord | null>
  findRoomByCommand(hostId: string, createCommandId: string): Promise<RoomRecord | null>
  /** Every room carrying this code. More than one is treated as none. */
  findRoomsByCode(inviteCode: string): Promise<RoomRecord[]>
  /** `conflict` when (hostId, createCommandId) already exists. */
  createRoom(
    data: Omit<RoomRecord, 'id' | 'view'> & { createCommandId: string },
    view: RoomViewData,
  ): Promise<{ status: 'created'; id: string } | { status: 'conflict' }>
  listLobbyEvents(roomId: string): Promise<LobbyEvent[]>
  /** `conflict` when (roomId, event.seq) already exists. Must be atomic. */
  appendLobbyEvent(roomId: string, event: LobbyEvent): Promise<'ok' | 'conflict'>
  writeRoomView(roomId: string, view: RoomViewData): Promise<void>
  /** The simulation log of a started room, to tell whether it has ended. */
  listEvents(simulationId: string): Promise<GameEvent[]>
  /** Rooms whose VIEW says `status`, least recently written first. A hint for the sweep; the log decides. */
  listRoomsByStatus(status: RoomStatus, limit: number): Promise<RoomRecord[]>
  /** Remove a room and its lobby log. The room row goes first, so a half-finished delete cannot leave a room without its log. */
  deleteRoom(roomId: string): Promise<void>
}

export type RoomErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'invalid_invite'
  | 'contention'
  | 'rate_limited'
  | 'room_limit_reached'
  | LobbyRefusal

const MESSAGES: Record<RoomErrorCode, string> = {
  invalid_request: 'The request is malformed.',
  forbidden: 'Room not found, or you are not a participant in it.',
  invalid_invite: 'That invitation code is not valid.',
  contention: 'The room is busy. Try again.',
  rate_limited: 'Too many attempts. Try again later.',
  room_limit_reached: 'This room has had too many changes. Close it and create a new one.',
  room_not_open: 'That room is no longer open.',
  room_full: 'That room already has three participants.',
  not_a_member: 'You are not a participant in that room.',
  not_host: 'Only the host can do that.',
  host_cannot_leave: 'The host cannot leave the room, only close it.',
  roles_locked: 'Roles and membership cannot change once the simulation has started.',
  unknown_role: 'That role does not exist.',
  role_taken: 'Another participant already holds that role.',
  room_not_ready: 'All three roles must be filled before the simulation can start.',
}

export type RoomResult<T> = { ok: true; data: T } | { ok: false; code: RoomErrorCode; message: string }

function refuse<T>(code: RoomErrorCode): RoomResult<T> {
  return { ok: false, code, message: MESSAGES[code] }
}

function rateLimited<T>(retryAfterMs: number): RoomResult<T> {
  return { ok: false, code: 'rate_limited', message: `Too many attempts. Try again in ${describeWait(retryAfterMs)}.` }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const MAX_ATTEMPTS = 16

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** What a member is told about their room. Never sent to a non-member. */
export interface RoomSnapshot {
  roomId: string
  hostId: string
  inviteCode: string
  rulesVersion: number
  status: RoomStatus
  members: LobbyMember[]
  startedAt: number | null
  deadlineAt: number | null
  closedReason: 'host' | 'expired' | null
  lobbySeq: number
  serverNow: number
}

/** A lobby command's answer: the snapshot, and whether this call changed anything. */
export type CommandSnapshot = RoomSnapshot & { applied: boolean }

function viewOf(lobby: LobbyState, completed: boolean): RoomViewData {
  const startedAt = lobby.startedAt ?? null
  return {
    status: lobby.status === 'active' && completed ? 'completed' : lobby.status,
    memberIds: lobby.members.map((member) => member.userId),
    members: lobby.members,
    lobbySeq: lobby.lastSeq,
    startedAt,
    deadlineAt: startedAt === null ? null : startedAt + SIMULATION_DURATION_MS,
    closedReason: lobby.closedReason ?? null,
  }
}

function snapshot(room: RoomRecord, view: RoomViewData, now: number): RoomSnapshot {
  return {
    roomId: room.id,
    hostId: room.hostId,
    inviteCode: room.inviteCode,
    rulesVersion: room.rulesVersion,
    status: view.status,
    members: view.members,
    startedAt: view.startedAt,
    deadlineAt: view.deadlineAt,
    closedReason: view.closedReason,
    lobbySeq: view.lobbySeq,
    serverNow: now,
  }
}

async function foldLobby(store: RoomStore, room: RoomRecord): Promise<LobbyState> {
  return reduceLobby(room.hostId, room.createdAt, await store.listLobbyEvents(room.id))
}

/**
 * The lobby as of `now`: the fold of its log, after first recording that the
 * lobby expired if it has. Expiry is a system event with one exact timestamp
 * (the last lobby event plus the idle limit), written by whoever touches the
 * room next — a command, a sync or the sweep — and always before anything
 * else is decided. If two writers try at once the store keeps one; the other
 * re-reads and finds it done.
 */
async function settledLobby(store: RoomStore, room: RoomRecord, now: number): Promise<LobbyState> {
  for (let attempt = 0; ; attempt++) {
    const lobby = await foldLobby(store, room)
    const expiry = dueExpiry(lobby, now)
    if (!expiry || attempt >= MAX_ATTEMPTS) return lobby
    await store.appendLobbyEvent(room.id, expiry)
  }
}

/** A started room is over once its clock has run out or its log says so. */
async function isCompleted(store: RoomStore, room: RoomRecord, lobby: LobbyState, now: number): Promise<boolean> {
  if (lobby.status !== 'active' || lobby.startedAt === undefined) return false
  if (now >= lobby.startedAt + SIMULATION_DURATION_MS) return true
  return finalResult(reduce(lobby.startedAt, await store.listEvents(room.id))) !== null
}

/**
 * Bring the room row's view up to date with the lobby log and return it.
 *
 * Two writers may race to write views of different ages. Each one re-reads
 * the log after writing and writes again if the log has moved, so the last
 * write always reflects the newest log.
 */
async function publishView(store: RoomStore, room: RoomRecord, now: number): Promise<RoomViewData> {
  let lobby = await settledLobby(store, room, now)
  for (let attempt = 0; ; attempt++) {
    const view = viewOf(lobby, await isCompleted(store, room, lobby, now))
    // Nothing to do when the row already says this (the common case for a sync).
    if (attempt === 0 && room.view && JSON.stringify(room.view) === JSON.stringify(view)) return view
    await store.writeRoomView(room.id, view)
    const latest = await foldLobby(store, room)
    if (latest.lastSeq === lobby.lastSeq || attempt >= MAX_ATTEMPTS) return view
    lobby = latest
  }
}

/**
 * The shared read-decide-append loop for lobby commands. `decide` is the
 * pure verdict for this caller against the folded log. Accepted: one event
 * is appended (or nothing, if the goal already held), the view is published
 * and the member's snapshot returned.
 */
async function lobbyCommand(
  store: RoomStore,
  room: RoomRecord,
  userId: string,
  now: number,
  type: LobbyEventType,
  decide: (lobby: LobbyState) => LobbyVerdict,
  role?: RoleId,
): Promise<RoomResult<CommandSnapshot>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const lobby = await settledLobby(store, room, now)
    const verdict = decide(lobby)
    if (!verdict.ok) return refuse(verdict.code)
    if (!verdict.noop) {
      // Closing the room is always possible; nothing else is once the log is full.
      if (type !== 'abandoned' && lobby.lastSeq >= MAX_LOBBY_EVENTS - 2) return refuse('room_limit_reached')
      const event: LobbyEvent = {
        seq: lobby.lastSeq + 1,
        type,
        at: Math.max(now, lobby.lastEventAt),
        userId,
        ...(role ? { role } : {}),
      }
      if ((await store.appendLobbyEvent(room.id, event)) === 'conflict') continue
    }
    return { ok: true, data: { ...snapshot(room, await publishView(store, room, now), now), applied: !verdict.noop } }
  }
  return refuse('contention')
}

/** The room, if `userId` is one of its members according to the lobby log. Missing and foreign look identical. */
async function loadForMember(store: RoomStore, userId: string, roomId: unknown): Promise<RoomRecord | null> {
  if (!userId || !isId(roomId)) return null
  const room = await store.getRoom(roomId)
  if (!room) return null
  return memberOf(await foldLobby(store, room), userId) ? room : null
}

/**
 * Create a room. The caller becomes its host and first member. `randomBytes`
 * must be a cryptographic source; it is a parameter so that this file reads
 * no global state. Retrying the same commandId returns the same room.
 */
export async function createRoom(
  store: RoomStore & RateStore,
  userId: string,
  params: { commandId?: unknown },
  now: number,
  randomBytes: (length: number) => Uint8Array,
): Promise<RoomResult<RoomSnapshot & { replayed: boolean }>> {
  if (!userId || !isId(params.commandId)) return refuse('invalid_request')
  const commandId = params.commandId
  const describe = async (room: RoomRecord, replayed: boolean): Promise<RoomResult<RoomSnapshot & { replayed: boolean }>> => ({
    ok: true,
    data: { ...snapshot(room, await publishView(store, room, now), now), replayed },
  })

  const existing = await store.findRoomByCommand(userId, commandId)
  if (existing) return describe(existing, true)

  // Counted after the replay check: retrying a command creates nothing.
  const slot = await takeSlot(store, userId, 'create_room', now)
  if (!slot.ok) return rateLimited(slot.retryAfterMs)

  const identity = {
    hostId: userId,
    createCommandId: commandId,
    inviteCode: encodeInviteCode(randomBytes(INVITE_CODE_LENGTH)),
    scenarioId: SCENARIO_ID,
    rulesVersion: RULES_VERSION,
    createdAt: now,
  }
  const created = await store.createRoom(identity, viewOf(reduceLobby(userId, now, []), false))
  if (created.status === 'conflict') {
    const winner = await store.findRoomByCommand(userId, commandId)
    return winner ? describe(winner, true) : refuse('contention')
  }
  return describe({ id: created.id, ...identity, view: null }, false)
}

/**
 * Join the room an invitation code belongs to. Knowing the code is the
 * authorization; nothing else about the room can be learned without it. A
 * participant who joins again (a retry, a second tab) is simply told they
 * are in.
 *
 * Every attempt is counted against the caller before the code is looked at,
 * right or wrong, so the number of codes one account can try is bounded
 * however the requests are timed. A wrong code, a malformed one and one that
 * matches no room all get the same answer.
 */
export async function joinRoom(
  store: RoomStore & RateStore,
  userId: string,
  params: { inviteCode?: unknown },
  now: number,
): Promise<RoomResult<CommandSnapshot>> {
  if (!userId) return refuse('invalid_request')
  const slot = await takeSlot(store, userId, 'join_attempt', now)
  if (!slot.ok) return rateLimited(slot.retryAfterMs)
  const code = normalizeInviteCode(params.inviteCode)
  if (!code) return refuse('invalid_invite')
  const rooms = await store.findRoomsByCode(code)
  if (rooms.length !== 1) return refuse('invalid_invite')
  const [room] = rooms
  if (room.rulesVersion !== RULES_VERSION) return refuse('room_not_open')
  return lobbyCommand(store, room, userId, now, 'member_joined', (lobby) => validateJoin(lobby, userId))
}

export async function leaveRoom(
  store: RoomStore,
  userId: string,
  params: { roomId?: unknown },
  now: number,
): Promise<RoomResult<{ roomId: string; serverNow: number }>> {
  const room = await loadForMember(store, userId, params.roomId)
  if (!room) return refuse('forbidden')
  const result = await lobbyCommand(store, room, userId, now, 'member_left', (lobby) => validateLeave(lobby, userId))
  // The caller is no longer a member, so is told nothing more about the room.
  return result.ok ? { ok: true, data: { roomId: room.id, serverNow: now } } : result
}

/** Take a role, or swap to a free one. Refused once the simulation has started. */
export async function claimRole(
  store: RoomStore,
  userId: string,
  params: { roomId?: unknown; role?: unknown },
  now: number,
): Promise<RoomResult<CommandSnapshot>> {
  const room = await loadForMember(store, userId, params.roomId)
  if (!room) return refuse('forbidden')
  const role = params.role
  return lobbyCommand(store, room, userId, now, 'role_claimed', (lobby) => validateClaim(lobby, userId, role), role as RoleId)
}

export async function releaseRole(
  store: RoomStore,
  userId: string,
  params: { roomId?: unknown },
  now: number,
): Promise<RoomResult<CommandSnapshot>> {
  const room = await loadForMember(store, userId, params.roomId)
  if (!room) return refuse('forbidden')
  return lobbyCommand(store, room, userId, now, 'role_released', (lobby) => validateRelease(lobby, userId))
}

/** Host only, and only with all three roles filled. The simulation's clock starts at this event. */
export async function startRoom(
  store: RoomStore,
  userId: string,
  params: { roomId?: unknown },
  now: number,
): Promise<RoomResult<CommandSnapshot>> {
  const room = await loadForMember(store, userId, params.roomId)
  if (!room) return refuse('forbidden')
  return lobbyCommand(store, room, userId, now, 'started', (lobby) => validateStart(lobby, userId))
}

/** Host only, and only before the start. */
export async function abandonRoom(
  store: RoomStore,
  userId: string,
  params: { roomId?: unknown },
  now: number,
): Promise<RoomResult<CommandSnapshot>> {
  const room = await loadForMember(store, userId, params.roomId)
  if (!room) return refuse('forbidden')
  return lobbyCommand(store, room, userId, now, 'abandoned', (lobby) => validateAbandon(lobby, userId))
}

/** A member's current view of the room; also repairs the row's view if a write was lost. */
export async function syncRoom(
  store: RoomStore,
  userId: string,
  params: { roomId?: unknown },
  now: number,
): Promise<RoomResult<RoomSnapshot>> {
  const room = await loadForMember(store, userId, params.roomId)
  if (!room) return refuse('forbidden')
  return { ok: true, data: snapshot(room, await publishView(store, room, now), now) }
}

// ---------------------------------------------------------------------------
// System operations — no caller. Used by the presence gate, the scheduled
// sweep and the simulation timer. None of them takes anything from a client.
// ---------------------------------------------------------------------------

/** Is `userId` a member of this room according to its lobby log? */
export async function isRoomMember(store: RoomStore, userId: string, roomId: unknown): Promise<boolean> {
  return (await loadForMember(store, userId, roomId)) !== null
}

/** Rewrite a room's view from its log. Used after the timer ends a team simulation with nobody connected. */
export async function refreshRoomView(store: RoomStore, roomId: string, now: number): Promise<RoomViewData | null> {
  if (!isId(roomId)) return null
  const room = await store.getRoom(roomId)
  return room ? publishView(store, room, now) : null
}

export type SweepOutcome = 'kept' | 'expired' | 'completed' | 'deleted'

/**
 * Bring one room up to date with the clock, with nobody present:
 *
 *   - an idle lobby past its limit is recorded as expired;
 *   - a started room past its deadline has its simulation settled, so the log
 *     ends with the finalization event and the room reads `completed`;
 *   - a lobby closed longer ago than the retention period is deleted.
 *
 * Deletion is decided from the lobby LOG alone, and only for a room that was
 * closed before it ever started. A room whose log contains a start — running
 * or finished, however old — is never deleted, and neither is one that has
 * any simulation events at all.
 */
export async function sweepRoom(store: RoomStore & GameStore, roomId: string, now: number): Promise<SweepOutcome> {
  const room = await store.getRoom(roomId)
  if (!room) return 'kept'
  const before = await foldLobby(store, room)
  const lobby = await settledLobby(store, room, now)

  if (lobby.status === 'active') {
    if (lobby.startedAt === undefined || now < lobby.startedAt + SIMULATION_DURATION_MS) return 'kept'
    const alreadyCompleted = room.view?.status === 'completed'
    await settleSimulation(store, room.id, now)
    await publishView(store, room, now)
    return alreadyCompleted ? 'kept' : 'completed'
  }

  if (lobby.status === 'abandoned') {
    const from = deletableFrom(lobby)
    const neverStarted = lobby.startedAt === undefined && (await store.listEvents(room.id)).length === 0
    if (from !== null && now >= from && neverStarted) {
      await store.deleteRoom(room.id)
      return 'deleted'
    }
  }
  await publishView(store, room, now)
  return before.status === 'lobby' && lobby.status === 'abandoned' ? 'expired' : 'kept'
}

export interface SweepReport {
  examined: number
  expired: number
  completed: number
  deleted: number
  failed: number
}

/**
 * The scheduled sweep. Looks at the rooms whose view says they are open,
 * running or closed — least recently written first, a bounded number of each
 * — and applies `sweepRoom`. One room failing does not stop the rest.
 */
export async function sweepRooms(store: RoomStore & GameStore, now: number, perStatus = 100): Promise<SweepReport> {
  const report: SweepReport = { examined: 0, expired: 0, completed: 0, deleted: 0, failed: 0 }
  for (const status of ['lobby', 'active', 'abandoned'] as const) {
    for (const room of await store.listRoomsByStatus(status, perStatus)) {
      report.examined++
      try {
        const outcome = await sweepRoom(store, room.id, now)
        if (outcome !== 'kept') report[outcome]++
      } catch {
        report.failed++
      }
    }
  }
  return report
}
