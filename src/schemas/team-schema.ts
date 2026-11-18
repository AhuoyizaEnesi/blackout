/**
 * BLACKOUT multiplayer storage.
 *
 * As with the solo collections, every row here is written ONLY by server
 * actions. No client role may create, update or delete anything.
 *
 * Who may READ a row is decided per row by the room (deepspace 0.44.2,
 * `checkPermissionLevel`): `read: 'collaborator'` passes for the row's owner
 * (`ownerField`) and for any user id listed in its `collaboratorsField`, a
 * JSON array. The check runs on every query and again for every socket on
 * every live broadcast, so a row reaches exactly the people the server listed
 * on it — which is how three participants share a room and nobody else sees
 * it, and how a private finding reaches one participant only.
 *
 *   team_rooms         one row per room. The immutable columns are its
 *                      identity; the rest is a VIEW of the lobby log that the
 *                      server rewrites after each lobby event. Readable by
 *                      the current members.
 *   team_room_events   the lobby log — the authority on membership and
 *                      roles. One row per (roomId, seq). Read by nobody: the
 *                      server folds it; clients get the view above.
 *   simulation_findings what an investigation or incident revealed. A
 *                      `private` row is readable by the participant who
 *                      earned it; a `team` row by every participant.
 *
 * The simulation's own event log stays in `simulation_events`
 * (simulation-schema.ts), with the participants listed on each row.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const CLOSED: RolePermissions = { read: false, create: false, update: false, delete: false }
const READ_LISTED: RolePermissions = { read: 'collaborator', create: false, update: false, delete: false }

export const teamRoomsSchema: CollectionSchema = {
  name: 'team_rooms',
  columns: [
    // Identity — set once at creation.
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'createCommandId', storage: 'text', interpretation: 'plain', immutable: true, required: true, maxLength: 64 },
    { name: 'inviteCode', storage: 'text', interpretation: 'plain', immutable: true, required: true, maxLength: 32 },
    { name: 'scenarioId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'rulesVersion', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'createdAt', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    // View of the lobby log — rewritten by the server, never authoritative.
    { name: 'status', storage: 'text', interpretation: 'plain', required: true },
    { name: 'memberIds', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'members', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'lobbySeq', storage: 'number', interpretation: 'plain' },
    { name: 'startedAt', storage: 'number', interpretation: 'plain' },
    { name: 'deadlineAt', storage: 'number', interpretation: 'plain' },
    // On a closed lobby: 'host' (closed by its host) or 'expired' (left unused).
    { name: 'closedReason', storage: 'text', interpretation: 'plain' },
  ],
  uniqueOn: ['hostId', 'createCommandId'],
  ownerField: 'hostId',
  collaboratorsField: 'memberIds',
  permissions: { '*': CLOSED, viewer: CLOSED, member: READ_LISTED, admin: READ_LISTED },
}

export const teamRoomEventsSchema: CollectionSchema = {
  name: 'team_room_events',
  columns: [
    { name: 'roomId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'seq', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'type', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'role', storage: 'text', interpretation: 'plain', immutable: true },
    { name: 'at', storage: 'number', interpretation: 'plain', immutable: true, required: true },
  ],
  uniqueOn: ['roomId', 'seq'],
  permissions: { '*': CLOSED, viewer: CLOSED, member: CLOSED, admin: CLOSED },
}

export const simulationFindingsSchema: CollectionSchema = {
  name: 'simulation_findings',
  columns: [
    { name: 'simulationId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    // The event (in simulation_events) this text belongs to.
    { name: 'eventSeq', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    // 'private' — for `ownerId` alone; 'team' — for every participant.
    { name: 'scope', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'readers', storage: 'text', interpretation: { kind: 'json' }, immutable: true },
    { name: 'text', storage: 'text', interpretation: 'plain', immutable: true, required: true, maxLength: 500 },
    // On a team row made by sharing a private finding: who shared it.
    { name: 'sharedBy', storage: 'text', interpretation: 'plain', immutable: true },
    { name: 'at', storage: 'number', interpretation: 'plain', immutable: true, required: true },
  ],
  uniqueOn: ['simulationId', 'eventSeq', 'scope'],
  ownerField: 'ownerId',
  collaboratorsField: 'readers',
  permissions: { '*': CLOSED, viewer: CLOSED, member: READ_LISTED, admin: READ_LISTED },
}

/**
 * Per-user counters behind the server's abuse limits (src/server/game/limits.ts).
 * One row per slot taken; `uniqueOn` is what stops two requests taking the
 * same slot. Server-only: no client can read or write it.
 */
export const rateSlotsSchema: CollectionSchema = {
  name: 'rate_slots',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'kind', storage: 'text', interpretation: 'plain', immutable: true, required: true, maxLength: 32 },
    { name: 'window', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'n', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'at', storage: 'number', interpretation: 'plain', immutable: true, required: true },
  ],
  uniqueOn: ['userId', 'kind', 'window', 'n'],
  permissions: { '*': CLOSED, viewer: CLOSED, member: CLOSED, admin: CLOSED },
}

export interface RateSlotRow {
  userId: string
  kind: string
  window: number
  n: number
  at: number
}

export interface TeamRoomMemberView {
  userId: string
  /** 'commander' | 'security' | 'infrastructure', or null while unassigned. */
  role: string | null
  joinedAt: number
}

/** Row shapes as stored (`record.data`). */
export interface TeamRoomRow {
  hostId: string
  createCommandId: string
  inviteCode: string
  scenarioId: string
  rulesVersion: number
  createdAt: number
  /** 'lobby' | 'active' | 'completed' | 'abandoned' */
  status: string
  memberIds?: string[]
  members?: TeamRoomMemberView[]
  lobbySeq?: number
  startedAt?: number | null
  deadlineAt?: number | null
  closedReason?: string | null
}

export interface TeamRoomEventRow {
  roomId: string
  seq: number
  type: string
  userId: string
  role?: string
  at: number
}

export interface SimulationFindingRow {
  simulationId: string
  eventSeq: number
  scope: string
  ownerId: string
  readers?: string[]
  text: string
  sharedBy?: string
  at: number
}
