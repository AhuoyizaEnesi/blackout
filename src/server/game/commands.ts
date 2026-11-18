/**
 * Authoritative command handling for a simulation.
 *
 * Storage model: a simulation is one immutable row plus an append-only event
 * log. Every state change is exactly ONE appended event, so no command ever
 * needs a multi-record transaction.
 *
 * Concurrency model: the store refuses a second event with the same
 * (simulationId, seq). A writer reads the whole log, decides, and appends at
 * `lastSeq + 1`; if anyone else appended in between, the append is refused
 * and the writer re-reads and decides again. A decision is therefore only
 * ever committed against the exact log it was made from — no lost updates,
 * no double application.
 *
 * Time model: callers pass `now` (server time). Nothing here reads a clock or
 * trusts a client timestamp. Timed completions and scheduled incidents are
 * "system events": each has one exact timestamp and the engine fixes their
 * order (`nextDue`). They are written lazily — by whichever command or sync
 * runs next — but always stamped with the instant they happened, and always
 * before anything later is decided, so a late writer produces the same log an
 * on-time one would have.
 *
 * Roles: in a solo simulation the owner holds all three roles and commander
 * approvals are auto-recorded. In a team simulation each participant holds
 * exactly the role they claimed in the lobby (src/game/lobby.ts, fixed at the
 * start), and every command is checked against that role here, on the server:
 * the engine is told which roles the verified caller holds and refuses the
 * rest. Being the room's host grants nothing in the game.
 *
 * Findings: what an event reveals is hidden scenario text. Solo, it is stored
 * on the event (only the owner can read it). In a team it is stored apart
 * from the shared event, in a row readable by the participant who earned it;
 * that participant may then share it with the team.
 */

import {
  ACTIONS,
  APPROVAL_PROCESSING_MS,
  ROLES,
  RULES_VERSION,
  SIMULATION_DURATION_MS,
  applyEvent,
  finalResult,
  incidentEffects,
  initialState,
  nextDue,
  reduce,
  validateApprovalDecision,
  validateApprovalRequest,
  validateExecute,
  type ActionId,
  type ApprovalRefusal,
  type DueEvent,
  type ExecuteRefusal,
  type FinalResult,
  type GameEvent,
  type RoleId,
  type SimulationState,
} from '../../game/engine.js'
import { describeWait, takeSlot, type RateStore } from './limits.js'
import { actionFinding, incidentReport } from './scenario-secrets.js'

export interface Participant {
  userId: string
  role: RoleId
}

export interface SimulationRecord {
  id: string
  /** Solo: the player. Team: the room's host. */
  ownerId: string
  mode: 'solo' | 'team'
  /** Team: the three participants and their roles, fixed at the start. Solo: empty. */
  members: readonly Participant[]
  scenarioId: string
  /** RULES_VERSION the simulation was created under; null for rows that predate versioning. */
  rulesVersion: number | null
  startedAt: number
  deadlineAt: number
}

export interface NewSimulation {
  ownerId: string
  createCommandId: string
  mode: 'solo'
  scenarioId: string
  rulesVersion: number
  startedAt: number
  deadlineAt: number
}

export type FindingScope = 'private' | 'team'

/** Text revealed by one event of a team simulation, and who may read it. */
export interface Finding {
  eventSeq: number
  /** `private`: `ownerId` alone. `team`: every participant. */
  scope: FindingScope
  ownerId: string
  text: string
  /** On a team finding that began as a private one: who shared it. */
  sharedBy?: string
  at: number
}

export interface GameStore {
  /** A solo simulation, or a team room that has started. Null otherwise. */
  getSimulation(id: string): Promise<SimulationRecord | null>
  findSimulationByCommand(ownerId: string, createCommandId: string): Promise<SimulationRecord | null>
  /** `conflict` when (ownerId, createCommandId) already exists. */
  createSimulation(data: NewSimulation): Promise<{ status: 'created'; id: string } | { status: 'conflict' }>
  listEvents(simulationId: string): Promise<GameEvent[]>
  /** `conflict` when (simulationId, event.seq) already exists. Must be atomic. */
  appendEvent(simulation: SimulationRecord, event: GameEvent): Promise<'ok' | 'conflict'>
  listFindings(simulationId: string): Promise<Finding[]>
  /** `conflict` when (simulationId, eventSeq, scope) already exists. */
  createFinding(simulation: SimulationRecord, finding: Finding): Promise<'ok' | 'conflict'>
}

export type CommandErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'command_id_reused'
  | 'contention'
  | 'rate_limited'
  | 'rules_version_unsupported'
  | 'stale_request'
  | 'not_a_team_simulation'
  | 'finding_not_found'
  | ExecuteRefusal
  | ApprovalRefusal

export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: CommandErrorCode; message: string }

const MESSAGES: Record<CommandErrorCode, string> = {
  invalid_request: 'The request is malformed.',
  forbidden: 'Simulation not found, or you are not a participant in it.',
  command_id_reused: 'This command id was already used for a different command.',
  contention: 'The simulation is busy. Try again.',
  rate_limited: 'Too many simulations started. Try again later.',
  rules_version_unsupported:
    'This simulation was recorded under an earlier version of the scenario rules and can no longer be opened.',
  stale_request: 'That approval request is no longer pending.',
  not_a_team_simulation: 'That is only possible in a team simulation.',
  finding_not_found: 'There is no finding of yours to share for that event.',
  unknown_action: 'That action does not exist.',
  simulation_ended: 'The simulation has ended.',
  wrong_role: 'Your role cannot do that.',
  action_already_used: 'That action has already been used.',
  prerequisite_missing: 'That action is not possible yet.',
  approval_required: 'That action needs the commander’s approval first.',
  approval_pending: 'The approval is still being processed.',
  approval_denied: 'The commander denied that action. Request approval again.',
  role_busy: 'That role is already running an action.',
  approval_not_needed: 'That action does not need approval.',
  approval_already_requested: 'Approval has already been requested for that action.',
  approval_already_granted: 'That action is already approved.',
  no_pending_request: 'There is no pending approval request for that action.',
}

function refuse<T>(code: CommandErrorCode): CommandResult<T> {
  return { ok: false, code, message: MESSAGES[code] }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
export const SCENARIO_ID = 'operation-nightfall'
/**
 * Bound on one command's read-decide-append loop. Settling a simulation that
 * nobody touched for its whole eight minutes takes at most 9 incidents plus
 * 11 completions; the rest is headroom for appends lost to other writers.
 */
const MAX_STEPS = 64

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * The caller must be the simulation's owner. Missing and foreign look
 * identical. A simulation created under any other rules version — including
 * none at all — is the owner's, but its log means something only under the
 * rules that wrote it, so it is refused before a single event is read: never
 * replayed, re-scored or extended under these rules.
 */
async function loadForMember(
  store: GameStore,
  userId: string,
  simulationId: unknown,
): Promise<{ simulation: SimulationRecord } | { refusal: 'forbidden' | 'rules_version_unsupported' }> {
  if (!isId(simulationId)) return { refusal: 'forbidden' }
  const simulation = await store.getSimulation(simulationId)
  if (!simulation || !isParticipant(simulation, userId)) return { refusal: 'forbidden' }
  if (simulation.rulesVersion !== RULES_VERSION) return { refusal: 'rules_version_unsupported' }
  return { simulation }
}

function isParticipant(simulation: SimulationRecord, userId: string): boolean {
  if (!userId) return false
  if (simulation.mode === 'solo') return simulation.ownerId === userId
  return simulation.members.some((member) => member.userId === userId)
}

/**
 * Roles the caller holds in this simulation. Solo: all of them. Team: the one
 * role they claimed before the start — never more, whoever they are.
 */
function rolesFor(simulation: SimulationRecord, userId: string): readonly RoleId[] {
  if (simulation.mode === 'solo') return simulation.ownerId === userId ? ROLES : []
  return simulation.members.filter((member) => member.userId === userId).map((member) => member.role)
}

/**
 * Who may read what an event reveals, in a team simulation. Scheduled
 * incidents and the closing confirmation are announced to everyone. What an
 * investigation or intervention turns up belongs to the participant who ran
 * it, until they share it.
 */
function findingFor(simulation: SimulationRecord, event: GameEvent, text: string): Finding {
  const announced =
    event.type === 'incident' || (event.actionId !== undefined && ACTIONS[event.actionId].terminal === true)
  return announced || !event.actorId
    ? { eventSeq: event.seq, scope: 'team', ownerId: simulation.ownerId, text, at: event.at }
    : { eventSeq: event.seq, scope: 'private', ownerId: event.actorId, text, at: event.at }
}

/** The text an event reveals, recomputed from the log (it is a pure function of the state before the event). */
function revealedText(before: SimulationState, event: GameEvent): string | null {
  if (event.type === 'incident' && event.incidentId) {
    return incidentReport(event.incidentId, incidentEffects(before, event.incidentId) !== null)
  }
  if (event.type === 'action_completed' && event.actionId) return actionFinding(event.actionId, before)
  return null
}

/**
 * Make sure every finding the log has earned exists, and return them all.
 *
 * An event and its finding are two writes, and only the event is the
 * authority. If the worker stopped between them the finding is simply
 * written now: its text and audience are functions of the log, and the
 * store refuses a second row for the same (event, scope).
 */
async function ensureFindings(
  store: GameStore,
  simulation: SimulationRecord,
  events: readonly GameEvent[],
): Promise<Finding[]> {
  const findings = await store.listFindings(simulation.id)
  const have = new Set(findings.map((finding) => finding.eventSeq))
  let state = initialState(simulation.startedAt)
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!have.has(event.seq)) {
      const text = revealedText(state, event)
      if (text) {
        const finding = findingFor(simulation, event, text)
        await store.createFinding(simulation, finding)
        findings.push(finding)
      }
    }
    state = applyEvent(state, event)
  }
  return findings
}

function visibleTo(findings: readonly Finding[], userId: string): Finding[] {
  return findings
    .filter((finding) => finding.scope === 'team' || finding.ownerId === userId)
    .sort((a, b) => a.eventSeq - b.eventSeq || a.scope.localeCompare(b.scope))
}

/** The stored form of a system event, with the text it reveals. */
function systemEvent(state: SimulationState, events: readonly GameEvent[], due: DueEvent): GameEvent {
  if (due.kind === 'incident') {
    return {
      seq: state.lastSeq + 1,
      type: 'incident',
      incidentId: due.incidentId,
      at: due.at,
      actorId: '',
      commandId: '',
      finding: incidentReport(due.incidentId, incidentEffects(state, due.incidentId) !== null),
    }
  }
  const started = events.find((e) => e.type === 'action_started' && e.actionId === due.actionId)
  return {
    seq: state.lastSeq + 1,
    type: 'action_completed',
    actionId: due.actionId,
    at: due.at,
    actorId: started?.actorId ?? '',
    commandId: started?.commandId ?? '',
    finding: actionFinding(due.actionId, state),
  }
}

type Decision<T> =
  | { result: CommandResult<T> | Promise<CommandResult<T>> }
  | { append: GameEvent; then: (event: GameEvent) => CommandResult<T> }

function withoutFinding(event: GameEvent): GameEvent {
  if (event.finding === undefined) return event
  const rest = { ...event }
  delete rest.finding
  return rest
}

/**
 * The shared read-decide-append loop.
 *
 * Reads the log, writes every system event owed up to `now` (one append
 * each), then asks `decide` what the command does against that settled state.
 * `decide` either answers outright or names one event to append; a lost
 * append re-reads and decides again. `at` is `now`, never earlier than the
 * last event in the log, so the log's time never runs backwards.
 */
async function run<T>(
  store: GameStore,
  simulation: SimulationRecord,
  now: number,
  decide: (state: SimulationState, events: GameEvent[], at: number) => Decision<T>,
): Promise<CommandResult<T>> {
  let events = await store.listEvents(simulation.id)
  let state = reduce(simulation.startedAt, events)

  for (let step = 0; step < MAX_STEPS; step++) {
    const at = Math.max(now, state.lastEventAt)
    const due = nextDue(state, at)
    const decision: Decision<T> | null = due ? null : decide(state, events, at)
    if (decision && 'result' in decision) return decision.result

    const revealed = due ? systemEvent(state, events, due) : decision!.append
    // In a team the shared event never carries revealed text.
    const event = simulation.mode === 'team' ? withoutFinding(revealed) : revealed
    if ((await store.appendEvent(simulation, event)) === 'conflict') {
      events = await store.listEvents(simulation.id)
      state = reduce(simulation.startedAt, events)
      continue
    }
    if (simulation.mode === 'team' && revealed.finding) {
      // Second write; `ensureFindings` repairs it if this one is lost.
      await store.createFinding(simulation, findingFor(simulation, event, revealed.finding))
    }
    // Our append at lastSeq + 1 was accepted, so the log is exactly what we
    // read plus this event: no need to read it back.
    events = [...events, event]
    state = applyEvent(state, event)
    if (decision) return decision.then(event)
  }
  return refuse('contention')
}

export interface CreateResult {
  simulationId: string
  /** The rules the simulation runs under; null if a retried command found a pre-versioning simulation. */
  rulesVersion: number | null
  startedAt: number
  deadlineAt: number
  serverNow: number
  replayed: boolean
}

/** Create a solo simulation and start it at `now`. Retrying the same commandId returns the same simulation. */
export async function createSoloSimulation(
  store: GameStore & RateStore,
  userId: string,
  params: { commandId?: unknown },
  now: number,
): Promise<CommandResult<CreateResult>> {
  if (!userId || !isId(params.commandId)) return refuse('invalid_request')
  const commandId = params.commandId
  const durationMs = SIMULATION_DURATION_MS

  const describe = (s: SimulationRecord, replayed: boolean): CommandResult<CreateResult> => ({
    ok: true,
    data: {
      simulationId: s.id,
      rulesVersion: s.rulesVersion,
      startedAt: s.startedAt,
      deadlineAt: s.deadlineAt,
      serverNow: now,
      replayed,
    },
  })

  const existing = await store.findSimulationByCommand(userId, commandId)
  if (existing) return describe(existing, true)

  // Counted after the replay check: retrying a command creates nothing.
  const slot = await takeSlot(store, userId, 'create_simulation', now)
  if (!slot.ok) {
    return {
      ok: false,
      code: 'rate_limited',
      message: `Too many simulations started. Try again in ${describeWait(slot.retryAfterMs)}.`,
    }
  }

  const created = await store.createSimulation({
    ownerId: userId,
    createCommandId: commandId,
    mode: 'solo',
    scenarioId: SCENARIO_ID,
    rulesVersion: RULES_VERSION,
    startedAt: now,
    deadlineAt: now + durationMs,
  })
  if (created.status === 'conflict') {
    const winner = await store.findSimulationByCommand(userId, commandId)
    return winner ? describe(winner, true) : refuse('contention')
  }
  return {
    ok: true,
    data: {
      simulationId: created.id,
      rulesVersion: RULES_VERSION,
      startedAt: now,
      deadlineAt: now + durationMs,
      serverNow: now,
      replayed: false,
    },
  }
}

export interface ExecuteResult {
  simulationId: string
  actionId: ActionId
  startedAt: number
  completesAt: number
  seq: number
  serverNow: number
  replayed: boolean
  /** Set when this action ended the simulation. */
  result: FinalResult | null
}

/**
 * Start an action (or, for an instant one, perform it). Idempotent per
 * commandId; safe under concurrent submission.
 */
export async function executeAction(
  store: GameStore,
  userId: string,
  params: { simulationId?: unknown; actionId?: unknown; commandId?: unknown },
  now: number,
): Promise<CommandResult<ExecuteResult>> {
  if (!isId(params.commandId) || typeof params.actionId !== 'string') return refuse('invalid_request')
  const commandId = params.commandId
  const loaded = await loadForMember(store, userId, params.simulationId)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const { simulation } = loaded

  const describe = (event: GameEvent, state: SimulationState, replayed: boolean): CommandResult<ExecuteResult> => {
    const actionId = event.actionId as ActionId
    return {
      ok: true,
      data: {
        simulationId: simulation.id,
        actionId,
        startedAt: event.at,
        completesAt: event.at + ACTIONS[actionId].durationMs,
        seq: event.seq,
        serverNow: now,
        replayed,
        result: ACTIONS[actionId].terminal ? finalResult(state) : null,
      },
    }
  }

  return run<ExecuteResult>(store, simulation, now, (state, events, at) => {
    // Same command seen before: report what it did, do nothing new. The first
    // event carrying a command id is the one that command wrote (a timed
    // action's completion repeats its starter's id, but comes later).
    const prior = events.find((e) => e.commandId === commandId)
    if (prior) {
      const sameCommand =
        (prior.type === 'action_started' || prior.type === 'action_completed') &&
        prior.actionId === params.actionId &&
        prior.actorId === userId
      return { result: sameCommand ? describe(prior, state, true) : refuse('command_id_reused') }
    }

    const verdict = validateExecute(state, params.actionId, at, rolesFor(simulation, userId))
    if (!verdict.ok) return { result: refuse(verdict.code) }

    const instant = verdict.action.durationMs === 0
    const event: GameEvent = {
      seq: state.lastSeq + 1,
      type: instant ? 'action_completed' : 'action_started',
      actionId: verdict.action.id,
      at,
      actorId: userId,
      commandId,
      ...(instant ? { finding: actionFinding(verdict.action.id, state) } : {}),
    }
    return { append: event, then: (written) => describe(written, applyEvent(state, written), false) }
  })
}

export interface ApprovalResult {
  simulationId: string
  actionId: ActionId
  /**
   * Solo: `approved` — recorded on the spot, in effect at `effectiveAt`.
   * Team: `requested` — pending until the commander decides; `requestSeq`
   * identifies this request and must be quoted by the decision.
   */
  status: 'approved' | 'requested'
  effectiveAt: number | null
  requestSeq: number | null
  seq: number
  serverNow: number
  replayed: boolean
}

/**
 * Ask for the commander's approval of one action. In a solo simulation the
 * player is the commander, so the approval is recorded in the same step; it
 * still takes the standard processing time to come into effect. In a team
 * simulation this only records the request: the participant holding the
 * commander role decides it with `decideApproval`. Idempotent per commandId.
 */
export async function requestApproval(
  store: GameStore,
  userId: string,
  params: { simulationId?: unknown; actionId?: unknown; commandId?: unknown },
  now: number,
): Promise<CommandResult<ApprovalResult>> {
  if (!isId(params.commandId) || typeof params.actionId !== 'string') return refuse('invalid_request')
  const commandId = params.commandId
  const loaded = await loadForMember(store, userId, params.simulationId)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const { simulation } = loaded

  const solo = simulation.mode === 'solo'
  const eventType = solo ? 'approval_auto_granted' : 'approval_requested'
  const describe = (event: GameEvent, replayed: boolean): CommandResult<ApprovalResult> => ({
    ok: true,
    data: {
      simulationId: simulation.id,
      actionId: event.actionId as ActionId,
      status: solo ? 'approved' : 'requested',
      effectiveAt: solo ? event.at + APPROVAL_PROCESSING_MS : null,
      requestSeq: solo ? null : event.seq,
      seq: event.seq,
      serverNow: now,
      replayed,
    },
  })

  return run<ApprovalResult>(store, simulation, now, (state, events, at) => {
    const prior = events.find((e) => e.commandId === commandId)
    if (prior) {
      const sameCommand = prior.type === eventType && prior.actionId === params.actionId && prior.actorId === userId
      return { result: sameCommand ? describe(prior, true) : refuse('command_id_reused') }
    }

    const verdict = validateApprovalRequest(state, params.actionId, at, rolesFor(simulation, userId))
    if (!verdict.ok) return { result: refuse(verdict.code) }

    const event: GameEvent = {
      seq: state.lastSeq + 1,
      type: eventType,
      actionId: verdict.action.id,
      at,
      actorId: userId,
      commandId,
    }
    return { append: event, then: (written) => describe(written, false) }
  })
}

export interface DecisionResult {
  simulationId: string
  actionId: ActionId
  decision: 'approved' | 'denied'
  /** The request this decided. */
  requestSeq: number
  /** When the decision comes into effect. */
  effectiveAt: number
  seq: number
  serverNow: number
  replayed: boolean
}

/**
 * The commander approves or denies ONE pending request.
 *
 * The caller must hold the commander role in this simulation (checked by the
 * engine against the roles the server resolved for the verified caller). The
 * decision must name both the operation (`actionId`) and the request itself
 * (`requestSeq`, the position of the request event in the log): a decision
 * for a request that was never made, was already decided, or has since been
 * replaced by a newer request is refused and writes nothing. Idempotent per
 * commandId.
 */
export async function decideApproval(
  store: GameStore,
  userId: string,
  params: { simulationId?: unknown; actionId?: unknown; requestSeq?: unknown; decision?: unknown; commandId?: unknown },
  now: number,
): Promise<CommandResult<DecisionResult>> {
  if (!isId(params.commandId) || typeof params.actionId !== 'string') return refuse('invalid_request')
  if (params.decision !== 'approve' && params.decision !== 'deny') return refuse('invalid_request')
  if (typeof params.requestSeq !== 'number' || !Number.isInteger(params.requestSeq) || params.requestSeq < 1) {
    return refuse('invalid_request')
  }
  const commandId = params.commandId
  const requestSeq = params.requestSeq
  const eventType = params.decision === 'approve' ? 'approval_granted' : 'approval_denied'
  const loaded = await loadForMember(store, userId, params.simulationId)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const { simulation } = loaded
  if (simulation.mode !== 'team') return refuse('not_a_team_simulation')

  const describe = (event: GameEvent, decided: number, replayed: boolean): CommandResult<DecisionResult> => ({
    ok: true,
    data: {
      simulationId: simulation.id,
      actionId: event.actionId as ActionId,
      decision: event.type === 'approval_granted' ? 'approved' : 'denied',
      requestSeq: decided,
      effectiveAt: event.at + APPROVAL_PROCESSING_MS,
      seq: event.seq,
      serverNow: now,
      replayed,
    },
  })
  /** The request a decision event answered: the last request for that action before it. */
  const requestBefore = (events: readonly GameEvent[], actionId: unknown, beforeSeq: number) =>
    events
      .filter((e) => e.type === 'approval_requested' && e.actionId === actionId && e.seq < beforeSeq)
      .reduce<GameEvent | null>((latest, e) => (latest === null || e.seq > latest.seq ? e : latest), null)

  return run<DecisionResult>(store, simulation, now, (state, events, at) => {
    const prior = events.find((e) => e.commandId === commandId)
    if (prior) {
      const sameCommand =
        prior.type === eventType &&
        prior.actionId === params.actionId &&
        prior.actorId === userId &&
        requestBefore(events, prior.actionId, prior.seq)?.seq === requestSeq
      return { result: sameCommand ? describe(prior, requestSeq, true) : refuse('command_id_reused') }
    }

    const verdict = validateApprovalDecision(state, params.actionId, at, rolesFor(simulation, userId))
    if (!verdict.ok) return { result: refuse(verdict.code) }
    // The engine has confirmed a request for this action is pending; it must
    // be the very request the commander was looking at.
    const pending = requestBefore(events, verdict.action.id, Number.MAX_SAFE_INTEGER)
    if (!pending || pending.seq !== requestSeq) return { result: refuse('stale_request') }

    const event: GameEvent = {
      seq: state.lastSeq + 1,
      type: eventType,
      actionId: verdict.action.id,
      at,
      actorId: userId,
      commandId,
    }
    return { append: event, then: (written) => describe(written, requestSeq, false) }
  })
}

export interface ShareResult {
  simulationId: string
  eventSeq: number
  serverNow: number
  replayed: boolean
}

/**
 * Share one of the caller's own private findings with the whole team.
 *
 * Only the participant who earned a finding can share it; the text is copied
 * by the server from the private row, never taken from the request. Sharing
 * is not a game event — it changes who can read, not what happened — so it
 * is allowed at any time, including after the simulation has ended. Sharing
 * twice is the same as sharing once.
 */
export async function shareFinding(
  store: GameStore,
  userId: string,
  params: { simulationId?: unknown; eventSeq?: unknown },
  now: number,
): Promise<CommandResult<ShareResult>> {
  if (typeof params.eventSeq !== 'number' || !Number.isInteger(params.eventSeq) || params.eventSeq < 1) {
    return refuse('invalid_request')
  }
  const eventSeq = params.eventSeq
  const loaded = await loadForMember(store, userId, params.simulationId)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const { simulation } = loaded
  if (simulation.mode !== 'team') return refuse('not_a_team_simulation')

  const findings = await ensureFindings(store, simulation, await store.listEvents(simulation.id))
  const mine = findings.find((f) => f.eventSeq === eventSeq && f.scope === 'private' && f.ownerId === userId)
  // Someone else's private finding and no finding at all look the same.
  if (!mine) return refuse('finding_not_found')
  const data = { simulationId: simulation.id, eventSeq, serverNow: now }
  if (findings.some((f) => f.eventSeq === eventSeq && f.scope === 'team')) {
    return { ok: true, data: { ...data, replayed: true } }
  }
  const created = await store.createFinding(simulation, {
    eventSeq,
    scope: 'team',
    ownerId: simulation.ownerId,
    text: mine.text,
    sharedBy: userId,
    at: now,
  })
  return { ok: true, data: { ...data, replayed: created === 'conflict' } }
}

export interface SyncResult {
  simulationId: string
  rulesVersion: number
  mode: 'solo' | 'team'
  startedAt: number
  deadlineAt: number
  serverNow: number
  events: GameEvent[]
  /**
   * Team only: the findings the caller may read — the team's, and their own
   * private ones. (Solo findings are on the events themselves.)
   */
  findings: Finding[]
  /** The ending and score once the simulation is over; null while it runs. */
  result: FinalResult | null
}

/** Write every system event that is due at `now`, then return the member's view of the log. */
export async function syncSimulation(
  store: GameStore,
  userId: string,
  params: { simulationId?: unknown },
  now: number,
): Promise<CommandResult<SyncResult>> {
  const loaded = await loadForMember(store, userId, params.simulationId)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const { simulation } = loaded

  return run<SyncResult>(store, simulation, now, (state, events) => ({
    result: (async (): Promise<CommandResult<SyncResult>> => ({
      ok: true,
      data: {
        simulationId: simulation.id,
        rulesVersion: RULES_VERSION,
        mode: simulation.mode,
        startedAt: simulation.startedAt,
        deadlineAt: simulation.deadlineAt,
        serverNow: now,
        events: [...events].sort((a, b) => a.seq - b.seq),
        findings:
          simulation.mode === 'team' ? visibleTo(await ensureFindings(store, simulation, events), userId) : [],
        result: finalResult(state),
      },
    }))(),
  }))
}

export interface SettleResult {
  mode: 'solo' | 'team'
  /** The simulation is over: its log ends with the confirmation or the finalization. */
  ended: boolean
  /** When the next system event falls due — an incident, a completion or the deadline. Null once ended. */
  nextDueAt: number | null
}

/**
 * Write every system event that is due at `now`, on nobody's behalf.
 *
 * This is what the server's own timer calls (src/jobs.ts), so that a
 * simulation is brought to its end even if every browser has gone. It is the
 * same loop a participant's sync runs and writes the same events with the
 * same timestamps — each one stamped with the instant it fell due, never with
 * the time the timer happened to fire — so it does not matter which of them
 * gets there first, or whether both do: the store keeps one event per
 * position.
 *
 * It takes a simulation id and nothing else, gives the caller no data, and
 * can only record what the clock has already made true. Returns null for an
 * id that is not a simulation under the current rules.
 */
export async function settleSimulation(
  store: GameStore,
  simulationId: unknown,
  now: number,
): Promise<SettleResult | null> {
  if (!isId(simulationId)) return null
  const simulation = await store.getSimulation(simulationId)
  if (!simulation || simulation.rulesVersion !== RULES_VERSION) return null

  const settled = await run<SettleResult & { events: GameEvent[] }>(store, simulation, now, (state, events) => ({
    result: {
      ok: true,
      data: {
        mode: simulation.mode,
        ended: state.endedAt !== undefined,
        // With no horizon but the deadline, `nextDue` names whatever comes next.
        nextDueAt: nextDue(state, Number.MAX_SAFE_INTEGER)?.at ?? null,
        events,
      },
    },
  }))
  if (!settled.ok) throw new Error(`Could not settle simulation ${simulation.id}: ${settled.code}`)
  const { events, ...result } = settled.data
  // A finding is a second write after its event; make sure none was lost.
  if (simulation.mode === 'team' && result.ended) await ensureFindings(store, simulation, events)
  return result
}
