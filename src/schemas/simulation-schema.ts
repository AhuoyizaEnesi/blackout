/**
 * BLACKOUT simulation storage.
 *
 * Both collections are written ONLY by server actions (src/actions), which
 * bypass role permissions. No client role may create, update or delete, so a
 * browser can never write game state, timestamps or metrics. Clients read
 * rows over the realtime connection, which is how the UI stays in sync:
 *   - simulations (solo): the owner only (`read: 'own'` against `ownerId`).
 *   - simulation_events: the owner, plus anyone the server listed in the
 *     row's `readers` (`read: 'collaborator'`). A solo row lists nobody, so
 *     it is still owner-only; a team row lists the room's three participants
 *     (see team-schema.ts for how the room checks this).
 *
 * The room still enforces `uniqueOn` and `immutable` on server-action writes
 * (verified in deepspace 0.44.2, putRecord). The game depends on both:
 *   - simulations: one row per (ownerId, createCommandId) makes creation
 *     idempotent; the start time can never be rewritten.
 *   - simulation_events: one row per (simulationId, seq) makes the log
 *     append-only with no duplicate positions, which is what serialises
 *     concurrent commands.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const CLOSED: RolePermissions = { read: false, create: false, update: false, delete: false }
const READ_OWN: RolePermissions = { read: 'own', create: false, update: false, delete: false }
const READ_LISTED: RolePermissions = { read: 'collaborator', create: false, update: false, delete: false }

export const simulationsSchema: CollectionSchema = {
  name: 'simulations',
  columns: [
    { name: 'ownerId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'createCommandId', storage: 'text', interpretation: 'plain', immutable: true, required: true, maxLength: 64 },
    { name: 'mode', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'scenarioId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    // RULES_VERSION of the engine that created the simulation. Not `required`:
    // rows created before versioning have none, and are refused as legacy.
    { name: 'rulesVersion', storage: 'number', interpretation: 'plain', immutable: true },
    { name: 'startedAt', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'deadlineAt', storage: 'number', interpretation: 'plain', immutable: true, required: true },
  ],
  uniqueOn: ['ownerId', 'createCommandId'],
  ownerField: 'ownerId',
  permissions: { '*': CLOSED, viewer: CLOSED, member: READ_OWN, admin: READ_OWN },
}

export const simulationEventsSchema: CollectionSchema = {
  name: 'simulation_events',
  columns: [
    { name: 'simulationId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'seq', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'type', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    // One of these two is set: `actionId` on action and approval events,
    // `incidentId` on scheduled incidents.
    { name: 'actionId', storage: 'text', interpretation: 'plain', immutable: true },
    { name: 'incidentId', storage: 'text', interpretation: 'plain', immutable: true },
    { name: 'at', storage: 'number', interpretation: 'plain', immutable: true, required: true },
    { name: 'actorId', storage: 'text', interpretation: 'plain', immutable: true },
    { name: 'commandId', storage: 'text', interpretation: 'plain', immutable: true },
    // Solo only. In a team simulation revealed text is not on the shared
    // event: it lives in simulation_findings, where it can be private.
    { name: 'finding', storage: 'text', interpretation: 'plain', immutable: true, maxLength: 500 },
    // Team only: the participants' user ids. Fixed when the row is written,
    // which is after the room has started and membership can no longer change.
    { name: 'readers', storage: 'text', interpretation: { kind: 'json' }, immutable: true },
  ],
  uniqueOn: ['simulationId', 'seq'],
  ownerField: 'ownerId',
  collaboratorsField: 'readers',
  permissions: { '*': CLOSED, viewer: CLOSED, member: READ_LISTED, admin: READ_LISTED },
}

/** Row shapes as stored (`record.data`). */
export interface SimulationRow {
  ownerId: string
  createCommandId: string
  mode: 'solo'
  scenarioId: string
  /** Absent on rows created before rules were versioned. */
  rulesVersion?: number | null
  startedAt: number
  deadlineAt: number
}

export interface SimulationEventRow {
  simulationId: string
  seq: number
  ownerId: string
  /** A GameEventType from src/game/engine.ts. */
  type: string
  actionId?: string
  incidentId?: string
  at: number
  actorId?: string
  commandId?: string
  finding?: string
  readers?: string[]
}
