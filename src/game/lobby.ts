/**
 * Team room lobby — membership and roles before a multiplayer simulation
 * starts. Pure and deterministic, like the scenario engine: no storage, no
 * clock, no randomness.
 *
 * A room's lobby is a fold over its own append-only event log. Every rule
 * below (three participants at most, one role per participant, one
 * participant per role, nothing changes after the start) is enforced by
 * validating each command against the folded state and committing it as one
 * event; the server serialises those commits (see src/server/game/rooms.ts).
 *
 * This file knows nothing about Operation Nightfall's rules. It decides who
 * is in the room and which role each person holds; the engine decides what a
 * role may do.
 */

import { ROLES, type RoleId } from './engine'

export const MAX_MEMBERS = 3

/**
 * A lobby nobody has touched for this long closes by itself. Measured from
 * the room's last lobby event, so any join, leave or role change keeps it
 * open. Applies before the start only: a started room never expires.
 */
export const LOBBY_IDLE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a closed lobby (by its host, or by expiry) is kept before the
 * server may delete it. A room that started is never deleted.
 */
export const CLOSED_LOBBY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The most events one lobby log may hold. A real lobby needs about ten;
 * this only stops a room being used to write rows without end. The last two
 * positions are kept for closing the room.
 */
export const MAX_LOBBY_EVENTS = 200

export type LobbyEventType =
  | 'member_joined'
  | 'member_left'
  | 'role_claimed'
  | 'role_released'
  | 'started'
  | 'abandoned'
  | 'expired'

export const LOBBY_EVENT_TYPES: readonly LobbyEventType[] = [
  'member_joined',
  'member_left',
  'role_claimed',
  'role_released',
  'started',
  'abandoned',
  'expired',
]

export interface LobbyEvent {
  /** 1-based, contiguous position in the room's lobby log. */
  seq: number
  type: LobbyEventType
  /** Server time the event was recorded. */
  at: number
  /** Who did it. `SYSTEM_ACTOR` on `expired`, which nobody does: the server records it. */
  userId: string
  /** Set on `role_claimed` only. */
  role?: RoleId
}

export interface LobbyMember {
  userId: string
  role: RoleId | null
  joinedAt: number
}

/** `completed` is not a lobby state: it is derived from the simulation's own log. */
export type LobbyStatus = 'lobby' | 'active' | 'abandoned'

export interface LobbyState {
  hostId: string
  createdAt: number
  status: LobbyStatus
  /** In joining order; the host is always first. */
  members: LobbyMember[]
  /** Set when the host starts the simulation: the simulation's clock starts here. */
  startedAt?: number
  /** Set once the lobby is closed: by its host, or by going unused. */
  closedReason?: 'host' | 'expired'
  closedAt?: number
  lastSeq: number
  lastEventAt: number
}

/** A new room: the host is its first member and holds no role yet. */
export function initialLobby(hostId: string, createdAt: number): LobbyState {
  return {
    hostId,
    createdAt,
    status: 'lobby',
    members: [{ userId: hostId, role: null, joinedAt: createdAt }],
    lastSeq: 0,
    lastEventAt: createdAt,
  }
}

export function isRole(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export function memberOf(state: LobbyState, userId: string): LobbyMember | undefined {
  return state.members.find((member) => member.userId === userId)
}

/** Every seat taken and every role held by exactly one participant. */
export function isReady(state: LobbyState): boolean {
  if (state.members.length !== MAX_MEMBERS) return false
  return ROLES.every((role) => state.members.filter((member) => member.role === role).length === 1)
}

/**
 * The instant an open lobby expires, or null if it cannot (it has started or
 * is already closed). The lobby is open strictly before this instant and
 * closed from it on.
 */
export function lobbyExpiresAt(state: LobbyState): number | null {
  return state.status === 'lobby' ? state.lastEventAt + LOBBY_IDLE_TTL_MS : null
}

/** Recorded as the actor of an event nobody did. Not a user id: real ids never take this form. */
export const SYSTEM_ACTOR = 'system'

/** The `expired` event owed at `now`, or null. It is stamped with the instant of expiry, not with `now`. */
export function dueExpiry(state: LobbyState, now: number): LobbyEvent | null {
  const at = lobbyExpiresAt(state)
  if (at === null || now < at) return null
  return { seq: state.lastSeq + 1, type: 'expired', at, userId: SYSTEM_ACTOR }
}

/** The instant from which a closed lobby may be deleted, or null if the room must be kept. */
export function deletableFrom(state: LobbyState): number | null {
  if (state.status !== 'abandoned' || state.closedAt === undefined) return null
  return state.closedAt + CLOSED_LOBBY_RETENTION_MS
}

export type LobbyRefusal =
  | 'room_not_open'
  | 'room_full'
  | 'not_a_member'
  | 'not_host'
  | 'host_cannot_leave'
  | 'roles_locked'
  | 'unknown_role'
  | 'role_taken'
  | 'room_not_ready'

/**
 * `ok` with `noop` means the command's goal already holds (joining a room you
 * are in, claiming the role you have): nothing is written and the caller is
 * told it succeeded. That is what makes every lobby command safe to repeat,
 * from a retry or from a second tab.
 */
export type LobbyVerdict = { ok: true; noop: boolean } | { ok: false; code: LobbyRefusal }

const accept: LobbyVerdict = { ok: true, noop: false }
const already: LobbyVerdict = { ok: true, noop: true }
const refuse = (code: LobbyRefusal): LobbyVerdict => ({ ok: false, code })

export function validateJoin(state: LobbyState, userId: string): LobbyVerdict {
  if (memberOf(state, userId)) return already
  if (state.status !== 'lobby') return refuse('room_not_open')
  if (state.members.length >= MAX_MEMBERS) return refuse('room_full')
  return accept
}

export function validateLeave(state: LobbyState, userId: string): LobbyVerdict {
  if (!memberOf(state, userId)) return refuse('not_a_member')
  if (state.status !== 'lobby') return refuse('roles_locked')
  if (userId === state.hostId) return refuse('host_cannot_leave')
  return accept
}

/** Take a role, or swap the one you hold for a free one. Never possible after the start. */
export function validateClaim(state: LobbyState, userId: string, role: unknown): LobbyVerdict {
  const member = memberOf(state, userId)
  if (!member) return refuse('not_a_member')
  if (!isRole(role)) return refuse('unknown_role')
  if (state.status !== 'lobby') return refuse('roles_locked')
  if (member.role === role) return already
  if (state.members.some((other) => other.role === role)) return refuse('role_taken')
  return accept
}

export function validateRelease(state: LobbyState, userId: string): LobbyVerdict {
  const member = memberOf(state, userId)
  if (!member) return refuse('not_a_member')
  if (state.status !== 'lobby') return refuse('roles_locked')
  return member.role === null ? already : accept
}

/** Only the host starts the room, and only once all three roles are filled. */
export function validateStart(state: LobbyState, userId: string): LobbyVerdict {
  if (!memberOf(state, userId)) return refuse('not_a_member')
  if (userId !== state.hostId) return refuse('not_host')
  if (state.status === 'active') return already
  if (state.status !== 'lobby') return refuse('room_not_open')
  if (!isReady(state)) return refuse('room_not_ready')
  return accept
}

/** Only the host closes the room, and only before it starts. */
export function validateAbandon(state: LobbyState, userId: string): LobbyVerdict {
  if (!memberOf(state, userId)) return refuse('not_a_member')
  if (userId !== state.hostId) return refuse('not_host')
  if (state.status === 'abandoned') return already
  if (state.status !== 'lobby') return refuse('roles_locked')
  return accept
}

function fail(event: LobbyEvent, reason: string): never {
  throw new Error(`Invalid lobby event ${event.seq} (${event.type}): ${reason}`)
}

/**
 * Apply one event. Throws on anything a valid lobby log cannot contain, so a
 * corrupt log is loud rather than quietly producing a fourth member or a
 * role held twice.
 */
export function applyLobbyEvent(state: LobbyState, event: LobbyEvent): LobbyState {
  if (event.seq !== state.lastSeq + 1) {
    throw new Error(`Lobby log out of sequence: expected ${state.lastSeq + 1}, got ${event.seq}`)
  }
  if (event.at < state.lastEventAt) fail(event, 'time runs backwards')
  const stamped = { ...state, lastSeq: event.seq, lastEventAt: event.at }
  const check = (verdict: LobbyVerdict) => {
    if (!verdict.ok) fail(event, verdict.code)
    if (verdict.noop) fail(event, 'records something that was already true')
  }
  const setRole = (role: RoleId | null) =>
    state.members.map((member) => (member.userId === event.userId ? { ...member, role } : member))

  switch (event.type) {
    case 'member_joined':
      check(validateJoin(state, event.userId))
      return { ...stamped, members: [...state.members, { userId: event.userId, role: null, joinedAt: event.at }] }
    case 'member_left':
      check(validateLeave(state, event.userId))
      return { ...stamped, members: state.members.filter((member) => member.userId !== event.userId) }
    case 'role_claimed':
      check(validateClaim(state, event.userId, event.role))
      return { ...stamped, members: setRole(event.role as RoleId) }
    case 'role_released':
      check(validateRelease(state, event.userId))
      return { ...stamped, members: setRole(null) }
    case 'started':
      check(validateStart(state, event.userId))
      return { ...stamped, status: 'active', startedAt: event.at }
    case 'abandoned':
      check(validateAbandon(state, event.userId))
      return { ...stamped, status: 'abandoned', closedReason: 'host', closedAt: event.at }
    case 'expired':
      if (state.status !== 'lobby') fail(event, 'room_not_open')
      if (event.at !== lobbyExpiresAt(state)) fail(event, 'not the instant of expiry')
      return { ...stamped, status: 'abandoned', closedReason: 'expired', closedAt: event.at }
    default:
      throw new Error(`Unknown lobby event type: ${String(event.type)}`)
  }
}

/** Fold a lobby log (any order) into state. */
export function reduceLobby(hostId: string, createdAt: number, events: readonly LobbyEvent[]): LobbyState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  return ordered.reduce(applyLobbyEvent, initialLobby(hostId, createdAt))
}

// ---------------------------------------------------------------------------
// Invitation codes
// ---------------------------------------------------------------------------

/** Crockford base32: no I, L, O or U, so a code survives being read aloud. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const INVITE_CODE_LENGTH = 12

/**
 * Turn `INVITE_CODE_LENGTH` random bytes into a code. 32 symbols, so each
 * byte's low five bits pick a symbol with no bias: 60 bits of entropy. The
 * bytes must come from a cryptographic source; this function only encodes.
 */
export function encodeInviteCode(bytes: Uint8Array): string {
  if (bytes.length !== INVITE_CODE_LENGTH) throw new Error(`An invite code needs ${INVITE_CODE_LENGTH} random bytes`)
  let code = ''
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31]
  return code
}

/** What a person typed, as the stored form — or null if it cannot be a code. */
export function normalizeInviteCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (code.length !== INVITE_CODE_LENGTH) return null
  for (const char of code) if (!CODE_ALPHABET.includes(char)) return null
  return code
}

/** `ABCD-EFGH-JKMN`, for display. */
export function formatInviteCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-')
}
