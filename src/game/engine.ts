/**
 * BLACKOUT scenario engine — Operation Nightfall. Pure and deterministic.
 *
 * No network, no storage, no clock, no randomness: every function takes the
 * time it should reason about as an argument. The server runs it to validate
 * and apply commands; the browser runs the same reducer over the events it is
 * allowed to read so it can render state.
 *
 * What lives here is the RULEBOOK (actions, durations, prerequisites, metric
 * effects, the incident schedule, endings, score). What does not live here is
 * the scenario's narrative truth — what an investigation actually finds, what
 * an incident report says. That text is server-only (src/server/game) and
 * reaches a player only inside an event they have earned.
 *
 * Rules are specified in blackout flow/05_SCENARIO_BASELINE.md, as reconciled
 * by decisions D-009 and D-010 in blackout flow/03_DECISIONS.md.
 *
 * Model
 * -----
 * State is a fold over an append-only event log. Events are either
 *   - player events: an action start, an instant action, an approval step; or
 *   - system events: a timed action completing, a scheduled incident firing.
 * System events are not stored when they happen — nothing is running then —
 * but each has one exact timestamp, and `nextDue` yields them in one canonical
 * order. A log is valid only if every system event appears exactly where that
 * order puts it, so the same play always produces the same log and the same
 * log always produces the same state, no matter how late it was written down.
 */

// ---------------------------------------------------------------------------
// Constants and vocabulary
// ---------------------------------------------------------------------------

/**
 * Version of this rulebook. Every simulation is stamped with the version it
 * was created under, and a stored event log is only ever replayed, scored or
 * extended by the version that produced it.
 *
 * Bump this whenever anything in this file changes what a log means: the
 * catalog, durations, prerequisites, effects, the incident schedule or its
 * conditions, event ordering, endings, or the score. A test pins a digest of
 * the rulebook to this number, so a rule change without a bump fails.
 *
 *   (unversioned)  the one-action slice, then the D-009 rules — never stamped
 *   2              D-010: trust scored as trust retained, containment scored
 *                  per intervention, health threshold removed from endings
 */
export const RULES_VERSION = 2

export const SIMULATION_DURATION_MS = 480_000
/** A commander decision takes effect this long after it is recorded. */
export const APPROVAL_PROCESSING_MS = 5_000

export type MetricName = 'health' | 'containment' | 'trust' | 'evidence'
export type Metrics = Record<MetricName, number>
export const METRIC_NAMES: readonly MetricName[] = ['health', 'containment', 'trust', 'evidence']

export const INITIAL_METRICS: Metrics = {
  health: 82,
  containment: 20,
  trust: 64,
  evidence: 10,
}

export type RoleId = 'commander' | 'security' | 'infrastructure'
export const ROLES: readonly RoleId[] = ['commander', 'security', 'infrastructure']
export const ROLE_LABELS: Record<RoleId, string> = {
  commander: 'Incident Commander',
  security: 'Security Engineer',
  infrastructure: 'Infrastructure Engineer',
}

export type ActionId =
  | 'inspect_access_logs'
  | 'correlate_session_events'
  | 'investigate_signing_access'
  | 'revoke_admin_sessions'
  | 'validate_containment'
  | 'review_deployment'
  | 'roll_back_release'
  | 'rotate_signing_keys'
  | 'restore_auth'
  | 'validate_recovery'
  | 'issue_customer_advisory'
  | 'confirm_resolution'

export interface ActionDefinition {
  id: ActionId
  role: RoleId
  label: string
  /** 0 means instant: the action completes in the event that starts it. */
  durationMs: number
  /** Actions that must be completed before this one can start. */
  requires: readonly ActionId[]
  /** Needs a commander approval scoped to this exact action. */
  needsApproval: boolean
  /** Metric changes applied once, when the action completes. */
  effects: Partial<Metrics>
  /** Completing this action ends the simulation. */
  terminal?: boolean
}

/** Extra trust lost by a rollback ordered after the session compromise was confirmed. */
export const ROLLBACK_AFTER_DIAGNOSIS_TRUST_PENALTY = -4

/**
 * The catalog. Order matters: it is the tie-break for completions that land
 * on the same millisecond.
 */
export const ACTIONS: Record<ActionId, ActionDefinition> = {
  // --- Security Engineer ---
  inspect_access_logs: {
    id: 'inspect_access_logs',
    role: 'security',
    label: 'Inspect access logs',
    durationMs: 15_000,
    requires: [],
    needsApproval: false,
    effects: { evidence: 15 },
  },
  correlate_session_events: {
    id: 'correlate_session_events',
    role: 'security',
    label: 'Correlate session events',
    durationMs: 20_000,
    requires: ['inspect_access_logs'],
    needsApproval: false,
    effects: { evidence: 20 },
  },
  investigate_signing_access: {
    id: 'investigate_signing_access',
    role: 'security',
    label: 'Investigate signing-material access',
    durationMs: 20_000,
    requires: ['correlate_session_events'],
    needsApproval: false,
    effects: { evidence: 25 },
  },
  revoke_admin_sessions: {
    id: 'revoke_admin_sessions',
    role: 'security',
    label: 'Revoke admin sessions',
    durationMs: 25_000,
    requires: ['correlate_session_events'],
    needsApproval: true,
    effects: { containment: 40 },
  },
  validate_containment: {
    id: 'validate_containment',
    role: 'security',
    label: 'Validate containment',
    durationMs: 15_000,
    requires: ['revoke_admin_sessions'],
    needsApproval: false,
    effects: { evidence: 10 },
  },
  // --- Infrastructure Engineer ---
  review_deployment: {
    id: 'review_deployment',
    role: 'infrastructure',
    label: 'Review deployment',
    durationMs: 15_000,
    requires: [],
    needsApproval: false,
    effects: { evidence: 10 },
  },
  roll_back_release: {
    id: 'roll_back_release',
    role: 'infrastructure',
    label: 'Roll back release',
    durationMs: 30_000,
    requires: [],
    needsApproval: true,
    // Plus ROLLBACK_AFTER_DIAGNOSIS_TRUST_PENALTY, conditionally — see applyEvent.
    effects: { health: 18 },
  },
  rotate_signing_keys: {
    id: 'rotate_signing_keys',
    role: 'infrastructure',
    label: 'Rotate signing keys',
    durationMs: 35_000,
    requires: ['investigate_signing_access'],
    needsApproval: true,
    effects: { containment: 35, trust: -3 },
  },
  restore_auth: {
    id: 'restore_auth',
    role: 'infrastructure',
    label: 'Restore authentication service',
    durationMs: 40_000,
    requires: ['revoke_admin_sessions', 'rotate_signing_keys'],
    needsApproval: false,
    effects: { health: 35 },
  },
  validate_recovery: {
    id: 'validate_recovery',
    role: 'infrastructure',
    label: 'Validate recovery',
    durationMs: 20_000,
    requires: ['restore_auth'],
    needsApproval: false,
    effects: { health: 10 },
  },
  // --- Incident Commander ---
  issue_customer_advisory: {
    id: 'issue_customer_advisory',
    role: 'commander',
    label: 'Issue customer advisory',
    durationMs: 15_000,
    requires: [],
    needsApproval: false,
    effects: { trust: 8 },
  },
  confirm_resolution: {
    id: 'confirm_resolution',
    role: 'commander',
    label: 'Confirm resolution',
    durationMs: 0,
    requires: ['revoke_admin_sessions', 'rotate_signing_keys', 'restore_auth', 'validate_recovery'],
    needsApproval: false,
    effects: {},
    terminal: true,
  },
}

export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[]

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value)
}

// ---------------------------------------------------------------------------
// Scheduled incidents
// ---------------------------------------------------------------------------

export type IncidentId =
  | 'initial_alert'
  | 'service_degradation'
  | 'attacker_activity'
  | 'outage_spreads'
  | 'attacker_escalation'
  | 'token_replay'
  | 'communication_gap'
  | 'deadline_warning'
  | 'finalization'

export interface IncidentDefinition {
  id: IncidentId
  /** Milliseconds after the simulation started. */
  atMs: number
}

/**
 * The schedule, in firing order. Two incidents share 05:30; they fire in the
 * order listed. `finalization` is last and is special: it fires after any
 * action that completes exactly on the deadline, and it ends the simulation.
 */
export const INCIDENTS: readonly IncidentDefinition[] = [
  { id: 'initial_alert', atMs: 0 },
  { id: 'service_degradation', atMs: 60_000 },
  { id: 'attacker_activity', atMs: 120_000 },
  { id: 'outage_spreads', atMs: 180_000 },
  { id: 'attacker_escalation', atMs: 240_000 },
  { id: 'token_replay', atMs: 330_000 },
  { id: 'communication_gap', atMs: 330_000 },
  { id: 'deadline_warning', atMs: 420_000 },
  { id: 'finalization', atMs: SIMULATION_DURATION_MS },
]

export function isIncidentId(value: unknown): value is IncidentId {
  return typeof value === 'string' && INCIDENTS.some((incident) => incident.id === value)
}

// ---------------------------------------------------------------------------
// Events and state
// ---------------------------------------------------------------------------

export type GameEventType =
  | 'action_started'
  | 'action_completed'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  /** Solo play: the request and the commander's approval recorded as one step. */
  | 'approval_auto_granted'
  | 'incident'

export const GAME_EVENT_TYPES: readonly GameEventType[] = [
  'action_started',
  'action_completed',
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'approval_auto_granted',
  'incident',
]

export interface GameEvent {
  /** 1-based, contiguous position in the simulation's log. */
  seq: number
  type: GameEventType
  /** Server time (ms since epoch) the event takes effect. */
  at: number
  /** Set on every event except incidents. */
  actionId?: ActionId
  /** Set on incident events only. */
  incidentId?: IncidentId
  /** Who caused it; empty for incidents. A completion carries its starter. */
  actorId: string
  /** Client-chosen idempotency key of the command that caused the event. */
  commandId: string
  /** Text revealed to the player by this event, if any. Written by the server. */
  finding?: string
}

export type ActionStatus = 'available' | 'in_progress' | 'completed'

export interface ActionState {
  status: ActionStatus
  startedAt?: number
  completesAt?: number
  completedAt?: number
}

export type ApprovalState =
  | { status: 'none' }
  | { status: 'requested'; requestedAt: number }
  | { status: 'approved' | 'denied'; decidedAt: number; effectiveAt: number; auto: boolean }

export type EndReason = 'confirmed' | 'deadline'

export interface SimulationState {
  startedAt: number
  deadlineAt: number
  metrics: Metrics
  actions: Record<ActionId, ActionState>
  /** One entry per action that needs approval. */
  approvals: Partial<Record<ActionId, ApprovalState>>
  /** Incidents that have fired, and whether their conditional effect applied. */
  incidents: Partial<Record<IncidentId, { at: number; applied: boolean }>>
  /** How many entries of INCIDENTS have fired; they fire strictly in order. */
  incidentsFired: number
  /** The rollback was ordered after the session compromise was confirmed. */
  rollbackAfterDiagnosis: boolean
  endedAt?: number
  endReason?: EndReason
  lastSeq: number
  lastEventAt: number
}

export function initialState(startedAt: number): SimulationState {
  const actions = {} as Record<ActionId, ActionState>
  const approvals: Partial<Record<ActionId, ApprovalState>> = {}
  for (const id of ACTION_IDS) {
    actions[id] = { status: 'available' }
    if (ACTIONS[id].needsApproval) approvals[id] = { status: 'none' }
  }
  return {
    startedAt,
    deadlineAt: startedAt + SIMULATION_DURATION_MS,
    metrics: { ...INITIAL_METRICS },
    actions,
    approvals,
    incidents: {},
    incidentsFired: 0,
    rollbackAfterDiagnosis: false,
    lastSeq: 0,
    lastEventAt: startedAt,
  }
}

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

export interface Facts {
  /** The admin sign-in anomaly has been seen. */
  adminClue: boolean
  /** Critical evidence 1 of 2. */
  sessionCompromiseConfirmed: boolean
  /** Critical evidence 2 of 2. */
  signingExposureFound: boolean
  deploymentReviewed: boolean
  /** Containment intervention 1 of 2. */
  adminRevoked: boolean
  /** Containment intervention 2 of 2. */
  keysRotated: boolean
  /** Both interventions. */
  fullyContained: boolean
  /** At least one intervention. */
  anyContainment: boolean
  rolledBack: boolean
  serviceRestored: boolean
  recoveryValidated: boolean
  advisoryIssued: boolean
}

/** Every flag is "that action completed" — there is no second source of truth to drift. */
export function facts(state: SimulationState): Facts {
  const done = (id: ActionId) => state.actions[id].status === 'completed'
  const adminRevoked = done('revoke_admin_sessions')
  const keysRotated = done('rotate_signing_keys')
  return {
    adminClue: done('inspect_access_logs'),
    sessionCompromiseConfirmed: done('correlate_session_events'),
    signingExposureFound: done('investigate_signing_access'),
    deploymentReviewed: done('review_deployment'),
    adminRevoked,
    keysRotated,
    fullyContained: adminRevoked && keysRotated,
    anyContainment: adminRevoked || keysRotated,
    rolledBack: done('roll_back_release'),
    serviceRestored: done('restore_auth'),
    recoveryValidated: done('validate_recovery'),
    advisoryIssued: done('issue_customer_advisory'),
  }
}

/**
 * The metric change an incident makes against `state`, or null when its
 * condition does not hold. Evaluated at the instant the incident fires.
 */
export function incidentEffects(state: SimulationState, id: IncidentId): Partial<Metrics> | null {
  const f = facts(state)
  switch (id) {
    case 'service_degradation':
      return f.serviceRestored ? null : { health: -8, trust: -5 }
    case 'attacker_activity':
      return f.fullyContained ? null : { containment: -5 }
    case 'outage_spreads':
      return f.serviceRestored ? null : { health: -10, trust: -5 }
    case 'attacker_escalation':
      return f.adminRevoked ? null : { containment: -10 }
    case 'token_replay':
      return f.keysRotated ? null : { trust: -8 }
    case 'communication_gap':
      return f.advisoryIssued ? null : { trust: -5 }
    case 'initial_alert':
    case 'deadline_warning':
    case 'finalization':
      return null
  }
}

export function isEnded(state: SimulationState, now: number): boolean {
  return state.endedAt !== undefined || now >= state.deadlineAt
}

// ---------------------------------------------------------------------------
// The canonical order of system events
// ---------------------------------------------------------------------------

export type DueEvent =
  | { kind: 'incident'; incidentId: IncidentId; at: number }
  | { kind: 'completion'; actionId: ActionId; at: number }

/**
 * The next system event that has happened by `now` and is not in the log yet,
 * or null when the log is settled up to `now`.
 *
 * Order: earliest timestamp first. On the same millisecond, incidents fire
 * before action completions, and completions go in catalog order. Nothing
 * happens after the deadline: an action that would finish later never does.
 * Finalization is the last thing at the deadline, after any completion that
 * lands exactly on it.
 */
export function nextDue(state: SimulationState, now: number): DueEvent | null {
  if (state.endedAt !== undefined) return null
  const horizon = Math.min(now, state.deadlineAt)
  let best: DueEvent | null = null

  const incident = INCIDENTS[state.incidentsFired]
  if (incident && incident.id !== 'finalization') {
    const at = state.startedAt + incident.atMs
    if (at <= horizon) best = { kind: 'incident', incidentId: incident.id, at }
  }
  for (const id of ACTION_IDS) {
    const action = state.actions[id]
    if (action.status !== 'in_progress' || action.completesAt === undefined) continue
    // Strictly earlier only: a tie keeps the incident, or the earlier catalog action.
    if (action.completesAt <= horizon && (best === null || action.completesAt < best.at)) {
      best = { kind: 'completion', actionId: id, at: action.completesAt }
    }
  }
  if (best) return best

  if (incident?.id === 'finalization' && now >= state.deadlineAt) {
    return { kind: 'incident', incidentId: 'finalization', at: state.deadlineAt }
  }
  return null
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

export type ExecuteRefusal =
  | 'unknown_action'
  | 'simulation_ended'
  | 'wrong_role'
  | 'action_already_used'
  | 'prerequisite_missing'
  | 'approval_required'
  | 'approval_pending'
  | 'approval_denied'
  | 'role_busy'

export type ApprovalRefusal =
  | 'unknown_action'
  | 'simulation_ended'
  | 'wrong_role'
  | 'approval_not_needed'
  | 'action_already_used'
  | 'prerequisite_missing'
  | 'approval_already_requested'
  | 'approval_already_granted'
  | 'approval_pending'
  | 'no_pending_request'

function prerequisitesMet(state: SimulationState, definition: ActionDefinition): boolean {
  return definition.requires.every((id) => state.actions[id].status === 'completed')
}

function roleBusy(state: SimulationState, role: RoleId): boolean {
  return ACTION_IDS.some((id) => ACTIONS[id].role === role && state.actions[id].status === 'in_progress')
}

/**
 * Can `actionId` start at `now`, for an actor holding `roles`?
 *
 * Each action is usable once. A role runs one timed action at a time. An
 * action that needs approval can start only once an approval for that exact
 * action has taken effect. Which roles a given user holds is the caller's
 * business; a solo player holds all three.
 */
export function validateExecute(
  state: SimulationState,
  actionId: unknown,
  now: number,
  roles: readonly RoleId[] = ROLES,
): { ok: true; action: ActionDefinition } | { ok: false; code: ExecuteRefusal } {
  if (!isActionId(actionId)) return { ok: false, code: 'unknown_action' }
  if (isEnded(state, now)) return { ok: false, code: 'simulation_ended' }
  const definition = ACTIONS[actionId]
  if (!roles.includes(definition.role)) return { ok: false, code: 'wrong_role' }
  if (state.actions[actionId].status !== 'available') return { ok: false, code: 'action_already_used' }
  if (!prerequisitesMet(state, definition)) return { ok: false, code: 'prerequisite_missing' }
  if (definition.needsApproval) {
    const approval = state.approvals[actionId] ?? { status: 'none' }
    if (approval.status === 'none' || approval.status === 'requested') return { ok: false, code: 'approval_required' }
    if (now < approval.effectiveAt) return { ok: false, code: 'approval_pending' }
    if (approval.status === 'denied') return { ok: false, code: 'approval_denied' }
  }
  if (roleBusy(state, definition.role)) return { ok: false, code: 'role_busy' }
  return { ok: true, action: definition }
}

/**
 * Can the holder of `roles` ask the commander to approve `actionId` at `now`?
 *
 * Only the role that would perform the action may ask, and only once the
 * action's other prerequisites are met — an approval is for an operation that
 * can actually run, not a blank cheque taken out at 00:00. After a denial has
 * taken effect the request may be made again.
 */
export function validateApprovalRequest(
  state: SimulationState,
  actionId: unknown,
  now: number,
  roles: readonly RoleId[] = ROLES,
): { ok: true; action: ActionDefinition } | { ok: false; code: ApprovalRefusal } {
  if (!isActionId(actionId)) return { ok: false, code: 'unknown_action' }
  if (isEnded(state, now)) return { ok: false, code: 'simulation_ended' }
  const definition = ACTIONS[actionId]
  if (!definition.needsApproval) return { ok: false, code: 'approval_not_needed' }
  if (!roles.includes(definition.role)) return { ok: false, code: 'wrong_role' }
  if (state.actions[actionId].status !== 'available') return { ok: false, code: 'action_already_used' }
  if (!prerequisitesMet(state, definition)) return { ok: false, code: 'prerequisite_missing' }
  const approval = state.approvals[actionId] ?? { status: 'none' }
  if (approval.status === 'requested') return { ok: false, code: 'approval_already_requested' }
  if (approval.status === 'approved') return { ok: false, code: 'approval_already_granted' }
  if (approval.status === 'denied' && now < approval.effectiveAt) return { ok: false, code: 'approval_pending' }
  return { ok: true, action: definition }
}

/** Can the holder of `roles` decide (approve or deny) the pending request for `actionId`? */
export function validateApprovalDecision(
  state: SimulationState,
  actionId: unknown,
  now: number,
  roles: readonly RoleId[] = ROLES,
): { ok: true; action: ActionDefinition } | { ok: false; code: ApprovalRefusal } {
  if (!isActionId(actionId)) return { ok: false, code: 'unknown_action' }
  if (isEnded(state, now)) return { ok: false, code: 'simulation_ended' }
  const definition = ACTIONS[actionId]
  if (!definition.needsApproval) return { ok: false, code: 'approval_not_needed' }
  if (!roles.includes('commander')) return { ok: false, code: 'wrong_role' }
  if (state.approvals[actionId]?.status !== 'requested') return { ok: false, code: 'no_pending_request' }
  return { ok: true, action: definition }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function clampMetric(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function withEffects(metrics: Metrics, effects: Partial<Metrics>): Metrics {
  const next = { ...metrics }
  for (const name of METRIC_NAMES) {
    const delta = effects[name]
    if (delta !== undefined) next[name] = clampMetric(next[name] + delta)
  }
  return next
}

function fail(event: GameEvent, reason: string): never {
  throw new Error(`Invalid event ${event.seq} (${event.type}): ${reason}`)
}

function isSystemEvent(event: GameEvent): boolean {
  if (event.type === 'incident') return true
  return event.type === 'action_completed' && isActionId(event.actionId) && ACTIONS[event.actionId].durationMs > 0
}

function complete(state: SimulationState, actionId: ActionId, at: number): SimulationState {
  const definition = ACTIONS[actionId]
  let effects = definition.effects
  if (actionId === 'roll_back_release' && state.rollbackAfterDiagnosis) {
    effects = { ...effects, trust: (effects.trust ?? 0) + ROLLBACK_AFTER_DIAGNOSIS_TRUST_PENALTY }
  }
  const next: SimulationState = {
    ...state,
    metrics: withEffects(state.metrics, effects),
    actions: { ...state.actions, [actionId]: { ...state.actions[actionId], status: 'completed', completedAt: at } },
  }
  if (definition.terminal) {
    next.endedAt = at
    next.endReason = 'confirmed'
  }
  return next
}

/**
 * Apply one event. Throws on anything a valid log can never contain: a gap or
 * repeat in `seq`, time running backwards, anything after the end, a player
 * event the rules refuse, a player event recorded while a system event was
 * still owed, or a system event that is not exactly the next one due. A
 * corrupt or hand-edited log is loud, never silently mis-scored.
 */
export function applyEvent(state: SimulationState, event: GameEvent): SimulationState {
  if (event.seq !== state.lastSeq + 1) {
    throw new Error(`Event log out of sequence: expected ${state.lastSeq + 1}, got ${event.seq}`)
  }
  if (state.endedAt !== undefined) fail(event, 'the simulation has ended')
  if (event.at < state.lastEventAt) fail(event, 'time runs backwards')
  if (!GAME_EVENT_TYPES.includes(event.type)) throw new Error(`Unknown event type: ${String(event.type)}`)

  const stamped: SimulationState = { ...state, lastSeq: event.seq, lastEventAt: event.at }

  if (isSystemEvent(event)) {
    const due = nextDue(state, event.at)
    if (event.type === 'incident') {
      if (!isIncidentId(event.incidentId)) fail(event, `unknown incident ${String(event.incidentId)}`)
      if (!due || due.kind !== 'incident' || due.incidentId !== event.incidentId || due.at !== event.at) {
        fail(event, `incident ${event.incidentId} is not the next system event due`)
      }
      const effects = incidentEffects(state, event.incidentId)
      const next: SimulationState = {
        ...stamped,
        metrics: effects ? withEffects(state.metrics, effects) : state.metrics,
        incidents: { ...state.incidents, [event.incidentId]: { at: event.at, applied: effects !== null } },
        incidentsFired: state.incidentsFired + 1,
      }
      if (event.incidentId === 'finalization') {
        next.endedAt = event.at
        next.endReason = 'deadline'
      }
      return next
    }
    const actionId = event.actionId as ActionId
    if (state.actions[actionId].status !== 'in_progress') {
      fail(event, `completes ${actionId}, which is ${state.actions[actionId].status}`)
    }
    if (!due || due.kind !== 'completion' || due.actionId !== actionId || due.at !== event.at) {
      fail(event, `completion of ${actionId} is not the next system event due`)
    }
    return complete(stamped, actionId, event.at)
  }

  // Player events.
  if (!isActionId(event.actionId)) fail(event, `unknown action ${String(event.actionId)}`)
  const actionId = event.actionId
  if (nextDue(state, event.at)) fail(event, 'recorded while an earlier system event was still owed')

  switch (event.type) {
    case 'action_started':
    case 'action_completed': {
      const verdict = validateExecute(state, actionId, event.at)
      if (!verdict.ok) {
        // Keep the status in the message: it is the most useful thing to know.
        fail(event, `${verdict.code} — ${actionId} is ${state.actions[actionId].status}`)
      }
      const instant = verdict.action.durationMs === 0
      if (instant !== (event.type === 'action_completed')) fail(event, 'wrong event type for this action')
      if (instant) return complete(stamped, actionId, event.at)
      return {
        ...stamped,
        actions: {
          ...state.actions,
          [actionId]: { status: 'in_progress', startedAt: event.at, completesAt: event.at + verdict.action.durationMs },
        },
        rollbackAfterDiagnosis:
          actionId === 'roll_back_release' ? facts(state).sessionCompromiseConfirmed : state.rollbackAfterDiagnosis,
      }
    }
    case 'approval_requested':
    case 'approval_auto_granted': {
      const verdict = validateApprovalRequest(state, actionId, event.at)
      if (!verdict.ok) fail(event, verdict.code)
      const approval: ApprovalState =
        event.type === 'approval_requested'
          ? { status: 'requested', requestedAt: event.at }
          : { status: 'approved', decidedAt: event.at, effectiveAt: event.at + APPROVAL_PROCESSING_MS, auto: true }
      return { ...stamped, approvals: { ...state.approvals, [actionId]: approval } }
    }
    case 'approval_granted':
    case 'approval_denied': {
      const verdict = validateApprovalDecision(state, actionId, event.at)
      if (!verdict.ok) fail(event, verdict.code)
      const approval: ApprovalState = {
        status: event.type === 'approval_granted' ? 'approved' : 'denied',
        decidedAt: event.at,
        effectiveAt: event.at + APPROVAL_PROCESSING_MS,
        auto: false,
      }
      return { ...stamped, approvals: { ...state.approvals, [actionId]: approval } }
    }
    default:
      return fail(event, 'unhandled event type')
  }
}

/** Fold a log (any order) into state. */
export function reduce(startedAt: number, events: readonly GameEvent[]): SimulationState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  return ordered.reduce(applyEvent, initialState(startedAt))
}

// ---------------------------------------------------------------------------
// Endings and score
// ---------------------------------------------------------------------------

export type OutcomeId = 'complete_recovery' | 'costly_recovery' | 'partial_containment' | 'incident_escalation'

export const OUTCOME_LABELS: Record<OutcomeId, string> = {
  complete_recovery: 'Complete Recovery',
  costly_recovery: 'Costly Recovery',
  partial_containment: 'Partial Containment',
  incident_escalation: 'Incident Escalation',
}

export const COMPLETE_RECOVERY_MIN_TRUST = 40

/**
 * The ending `state` maps to. A total function checked in priority order, so
 * every state has exactly one ending:
 *
 *   1. Complete Recovery   — both interventions, service restored, recovery
 *                            validated, and trust >= 40.
 *   2. Costly Recovery     — both interventions and service restored, but not
 *                            everything Complete Recovery asks for.
 *   3. Partial Containment — at least one intervention, without a restored
 *                            service. Includes "both interventions done, but
 *                            the service never came back".
 *   4. Incident Escalation — neither intervention.
 *
 * There is no health condition. The draft asked for health >= 70, but health
 * is at least 99 whenever the service is restored (worst case 82 - 8 - 10 +
 * 35), so the condition could never fail; "service restored" is the health
 * criterion. A test keeps that implication true.
 */
export function evaluateOutcome(state: SimulationState): OutcomeId {
  const f = facts(state)
  if (f.fullyContained && f.serviceRestored) {
    const complete = f.recoveryValidated && state.metrics.trust >= COMPLETE_RECOVERY_MIN_TRUST
    return complete ? 'complete_recovery' : 'costly_recovery'
  }
  if (f.anyContainment) return 'partial_containment'
  return 'incident_escalation'
}

/** Trust lost per point of the trust score. */
export const TRUST_SCORE_STEP = 6

export interface ScoreBreakdown {
  /** 15 for each containment intervention completed (revoke, rotate). */
  containment: number
  /** 25 — authentication service restored. */
  restoration: number
  /** 15 — recovery validated. */
  validation: number
  /** 5 for confirming the session compromise + 5 for finding the signing exposure. */
  evidence: number
  /** Trust retained: 10 at the starting level or above, 1 less for every 6 trust lost (part of a step counts). */
  trust: number
  /** floor(health / 10), at most 10. */
  health: number
  total: number
}

/**
 * Points for customer trust: how much of the trust the company had when the
 * incident began is still there. Full marks need the starting level (64), not
 * 100 — a response cannot be credited for trust that was never there to keep,
 * and no legitimate play ends above 64 once the service has been restored.
 * The steps are aligned so that the Complete Recovery threshold (40) is a
 * step boundary: 40 scores 6, 39 scores 5.
 */
export function trustScore(trust: number): number {
  const lost = Math.max(0, INITIAL_METRICS.trust - trust)
  return Math.max(0, 10 - Math.ceil(lost / TRUST_SCORE_STEP))
}

/**
 * The 100-point score. Credit only for completed work; nothing for attempts.
 *
 * The endings occupy separate bands, so a score never contradicts its label:
 * Incident Escalation 12 to 26, Partial Containment 32 to 57, Costly
 * Recovery 79 to 95, Complete Recovery 96 to 100.
 */
export function scoreBreakdown(state: SimulationState): ScoreBreakdown {
  const f = facts(state)
  const parts = {
    containment: (f.adminRevoked ? 15 : 0) + (f.keysRotated ? 15 : 0),
    restoration: f.serviceRestored ? 25 : 0,
    validation: f.recoveryValidated ? 15 : 0,
    evidence: (f.sessionCompromiseConfirmed ? 5 : 0) + (f.signingExposureFound ? 5 : 0),
    trust: trustScore(state.metrics.trust),
    health: Math.min(10, Math.floor(state.metrics.health / 10)),
  }
  const total = parts.containment + parts.restoration + parts.validation + parts.evidence + parts.trust + parts.health
  return { ...parts, total }
}

export interface FinalResult {
  outcome: OutcomeId
  score: number
  breakdown: ScoreBreakdown
  endedAt: number
  reason: EndReason
}

/** The result of a finished simulation; null while it is still running. */
export function finalResult(state: SimulationState): FinalResult | null {
  if (state.endedAt === undefined || state.endReason === undefined) return null
  const breakdown = scoreBreakdown(state)
  return {
    outcome: evaluateOutcome(state),
    score: breakdown.total,
    breakdown,
    endedAt: state.endedAt,
    reason: state.endReason,
  }
}
