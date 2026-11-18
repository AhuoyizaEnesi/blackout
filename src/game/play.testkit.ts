/**
 * Test-only driver for the engine: plays a simulation by the clock.
 *
 * It does what the server's command layer does, with no storage: before any
 * command it writes every system event owed up to that moment (in the order
 * `nextDue` gives), then validates the command and appends its event. Times
 * are given in SECONDS since the start, for readable scripts.
 *
 * Not imported by application code.
 */

import {
  ACTIONS,
  ROLES,
  SIMULATION_DURATION_MS,
  applyEvent,
  finalResult,
  initialState,
  nextDue,
  validateApprovalDecision,
  validateApprovalRequest,
  validateExecute,
  type ActionId,
  type FinalResult,
  type GameEvent,
  type GameEventType,
  type RoleId,
  type SimulationState,
} from './engine'

export const T0 = 1_800_000_000_000

export type StepResult = 'ok' | string

export interface Play {
  readonly startedAt: number
  readonly state: SimulationState
  readonly log: GameEvent[]
  /** Write every system event due by `seconds`. */
  settle(seconds: number): void
  /** Start (or, if instant, perform) an action. Returns 'ok' or the refusal code. */
  start(seconds: number, actionId: ActionId | string, roles?: readonly RoleId[]): StepResult
  /** Solo approval: request and grant in one step. */
  approve(seconds: number, actionId: ActionId | string, roles?: readonly RoleId[]): StepResult
  /** Team approval flow, as three separate steps. */
  request(seconds: number, actionId: ActionId | string, roles?: readonly RoleId[]): StepResult
  grant(seconds: number, actionId: ActionId | string, roles?: readonly RoleId[]): StepResult
  deny(seconds: number, actionId: ActionId | string, roles?: readonly RoleId[]): StepResult
  /** Run the clock out and return the result. */
  finish(): FinalResult
}

export function createPlay(startedAt: number = T0): Play {
  let state = initialState(startedAt)
  const log: GameEvent[] = []
  const ms = (seconds: number) => startedAt + Math.round(seconds * 1000)

  const push = (partial: Pick<GameEvent, 'type' | 'at'> & Partial<GameEvent>) => {
    const seq = state.lastSeq + 1
    const event: GameEvent = { actorId: 'user-1', commandId: `cmd-${String(seq).padStart(8, '0')}`, ...partial, seq }
    state = applyEvent(state, event)
    log.push(event)
  }

  const settleTo = (now: number) => {
    for (;;) {
      const due = nextDue(state, now)
      if (!due) return
      if (due.kind === 'incident') {
        push({ type: 'incident', incidentId: due.incidentId, at: due.at, actorId: '', commandId: '' })
      } else {
        const starter = log.find((e) => e.type === 'action_started' && e.actionId === due.actionId)
        push({
          type: 'action_completed',
          actionId: due.actionId,
          at: due.at,
          actorId: starter?.actorId ?? '',
          commandId: starter?.commandId ?? '',
        })
      }
    }
  }

  const command = (
    seconds: number,
    actionId: ActionId | string,
    roles: readonly RoleId[],
    validate: typeof validateExecute | typeof validateApprovalRequest,
    type: (id: ActionId) => GameEventType,
  ): StepResult => {
    const now = ms(seconds)
    settleTo(now)
    const verdict = validate(state, actionId, now, roles)
    if (!verdict.ok) return verdict.code
    push({ type: type(verdict.action.id), actionId: verdict.action.id, at: now })
    return 'ok'
  }

  return {
    startedAt,
    get state() {
      return state
    },
    log,
    settle: (seconds) => settleTo(ms(seconds)),
    start: (seconds, actionId, roles = ROLES) =>
      command(seconds, actionId, roles, validateExecute, (id) =>
        ACTIONS[id].durationMs === 0 ? 'action_completed' : 'action_started',
      ),
    approve: (seconds, actionId, roles = ROLES) =>
      command(seconds, actionId, roles, validateApprovalRequest, () => 'approval_auto_granted'),
    request: (seconds, actionId, roles = ROLES) =>
      command(seconds, actionId, roles, validateApprovalRequest, () => 'approval_requested'),
    grant: (seconds, actionId, roles = ROLES) =>
      command(seconds, actionId, roles, validateApprovalDecision, () => 'approval_granted'),
    deny: (seconds, actionId, roles = ROLES) =>
      command(seconds, actionId, roles, validateApprovalDecision, () => 'approval_denied'),
    finish: () => {
      settleTo(startedAt + SIMULATION_DURATION_MS + 60_000)
      const result = finalResult(state)
      if (!result) throw new Error('simulation did not end')
      return result
    },
  }
}

/** Run a list of steps that must all succeed; throws naming the first that does not. */
export function script(play: Play, steps: readonly [number, 'start' | 'approve', ActionId][]): Play {
  for (const [seconds, verb, actionId] of steps) {
    const outcome = play[verb](seconds, actionId)
    if (outcome !== 'ok') throw new Error(`${verb} ${actionId} at ${seconds}s refused: ${outcome}`)
  }
  return play
}

/**
 * Named strategies. Each is the fastest legal ordering of its idea, played by
 * one person holding all three roles; the tests add delay where they need it.
 */
export const STRATEGIES = {
  /** Investigate, contain both ways, restore, validate, tell customers, confirm. */
  optimal: [
    [0, 'start', 'inspect_access_logs'],
    [0, 'start', 'issue_customer_advisory'],
    [15, 'start', 'correlate_session_events'],
    [35, 'start', 'investigate_signing_access'],
    [35, 'approve', 'revoke_admin_sessions'],
    [55, 'start', 'revoke_admin_sessions'],
    [55, 'approve', 'rotate_signing_keys'],
    [60, 'start', 'rotate_signing_keys'],
    [95, 'start', 'restore_auth'],
    [135, 'start', 'validate_recovery'],
    [155, 'start', 'confirm_resolution'],
  ],
  /** Contains and restores, but never validates or confirms: the clock decides. */
  unvalidated: [
    [0, 'start', 'inspect_access_logs'],
    [15, 'start', 'correlate_session_events'],
    [35, 'start', 'investigate_signing_access'],
    [35, 'approve', 'revoke_admin_sessions'],
    [55, 'start', 'revoke_admin_sessions'],
    [55, 'approve', 'rotate_signing_keys'],
    [60, 'start', 'rotate_signing_keys'],
    [95, 'start', 'restore_auth'],
  ],
  /**
   * Does everything, badly: chases the deployment after the cause is known,
   * leaves the stolen keys valid for five and a half minutes, says nothing to
   * customers.
   */
  slowAndSilent: [
    [0, 'start', 'inspect_access_logs'],
    [15, 'start', 'correlate_session_events'],
    [35, 'start', 'investigate_signing_access'],
    [35, 'approve', 'revoke_admin_sessions'],
    [55, 'start', 'revoke_admin_sessions'],
    [60, 'approve', 'roll_back_release'],
    [65, 'start', 'roll_back_release'],
    [335, 'approve', 'rotate_signing_keys'],
    [340, 'start', 'rotate_signing_keys'],
    [375, 'start', 'restore_auth'],
    [415, 'start', 'validate_recovery'],
    [435, 'start', 'confirm_resolution'],
  ],
  /** Kills the admin session and stops there. */
  revokeOnly: [
    [0, 'start', 'inspect_access_logs'],
    [15, 'start', 'correlate_session_events'],
    [35, 'approve', 'revoke_admin_sessions'],
    [40, 'start', 'revoke_admin_sessions'],
  ],
  /** Both interventions, but the service is never restored. */
  containedNotRestored: [
    [0, 'start', 'inspect_access_logs'],
    [15, 'start', 'correlate_session_events'],
    [35, 'start', 'investigate_signing_access'],
    [35, 'approve', 'revoke_admin_sessions'],
    [55, 'start', 'revoke_admin_sessions'],
    [55, 'approve', 'rotate_signing_keys'],
    [60, 'start', 'rotate_signing_keys'],
  ],
  /** Believes the decoy: reviews and rolls back the deployment, reassures customers, contains nothing. */
  decoyOnly: [
    [0, 'start', 'issue_customer_advisory'],
    [0, 'approve', 'roll_back_release'],
    [5, 'start', 'roll_back_release'],
    [35, 'start', 'review_deployment'],
  ],
  /** Investigates everything and acts on none of it. */
  analysisParalysis: [
    [0, 'start', 'inspect_access_logs'],
    [0, 'start', 'review_deployment'],
    [15, 'start', 'correlate_session_events'],
    [35, 'start', 'investigate_signing_access'],
  ],
  doNothing: [],
} as const satisfies Record<string, readonly [number, 'start' | 'approve', ActionId][]>

/** Deterministic PRNG (mulberry32) for property tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
