import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  ACTION_IDS,
  APPROVAL_PROCESSING_MS,
  INCIDENTS,
  INITIAL_METRICS,
  METRIC_NAMES,
  ROLES,
  RULES_VERSION,
  SIMULATION_DURATION_MS,
  applyEvent,
  evaluateOutcome,
  facts,
  finalResult,
  initialState,
  nextDue,
  reduce,
  scoreBreakdown,
  trustScore,
  validateExecute,
  type ActionId,
  type ActionStatus,
  type GameEvent,
  type IncidentId,
  type OutcomeId,
  type SimulationState,
} from './engine'
import { STRATEGIES, T0, createPlay, prng, script, type Play } from './play.testkit'

const DEADLINE = T0 + SIMULATION_DURATION_MS

/** State just before and just after the event at `index` in a play's log. */
function around(play: Play, index: number) {
  return { before: reduce(T0, play.log.slice(0, index)), after: reduce(T0, play.log.slice(0, index + 1)) }
}

function completionIndex(play: Play, actionId: ActionId): number {
  const index = play.log.findIndex((e) => e.type === 'action_completed' && e.actionId === actionId)
  if (index < 0) throw new Error(`${actionId} never completed`)
  return index
}

function incidentIndex(play: Play, incidentId: IncidentId): number {
  const index = play.log.findIndex((e) => e.type === 'incident' && e.incidentId === incidentId)
  if (index < 0) throw new Error(`${incidentId} never fired`)
  return index
}

function metricDelta(before: SimulationState, after: SimulationState) {
  const delta: Record<string, number> = {}
  for (const name of METRIC_NAMES) {
    if (after.metrics[name] !== before.metrics[name]) delta[name] = after.metrics[name] - before.metrics[name]
  }
  return delta
}

/**
 * Bring `actionId` to the point where it can start, doing its prerequisites
 * one after another (slowly, never in parallel). Returns the time in seconds
 * at which it may start.
 */
function prepare(play: Play, actionId: ActionId, cursor = { t: 0 }): number {
  const definition = ACTIONS[actionId]
  for (const required of definition.requires) {
    if (play.state.actions[required].status === 'completed') continue
    const startAt = prepare(play, required, cursor)
    expect(play.start(startAt, required)).toBe('ok')
    cursor.t = startAt + ACTIONS[required].durationMs / 1000
    play.settle(cursor.t)
  }
  if (definition.needsApproval) {
    expect(play.approve(cursor.t, actionId)).toBe('ok')
    cursor.t += APPROVAL_PROCESSING_MS / 1000
  }
  return cursor.t
}

// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('matches the scenario baseline', () => {
    const state = initialState(T0)
    expect(state.metrics).toEqual({ health: 82, containment: 20, trust: 64, evidence: 10 })
    expect(state.deadlineAt).toBe(T0 + 480_000)
    expect(SIMULATION_DURATION_MS).toBe(480_000)
    for (const id of ACTION_IDS) expect(state.actions[id].status).toBe('available')
    expect(facts(state)).toMatchObject({
      adminRevoked: false,
      keysRotated: false,
      serviceRestored: false,
      recoveryValidated: false,
    })
  })

  it('has twelve actions: five security, five infrastructure, two commander', () => {
    expect(ACTION_IDS).toHaveLength(12)
    const byRole = (role: string) => ACTION_IDS.filter((id) => ACTIONS[id].role === role).length
    expect([byRole('security'), byRole('infrastructure'), byRole('commander')]).toEqual([5, 5, 2])
  })

  it('exactly three actions need commander approval', () => {
    expect(ACTION_IDS.filter((id) => ACTIONS[id].needsApproval).sort()).toEqual(
      ['revoke_admin_sessions', 'roll_back_release', 'rotate_signing_keys'].sort(),
    )
  })

  it('the prerequisite graph has no cycles and every action is reachable', () => {
    const play = createPlay()
    const cursor = { t: 0 }
    for (const id of ACTION_IDS) {
      if (play.state.actions[id].status !== 'available') continue
      const startAt = prepare(play, id, cursor)
      expect(play.start(startAt, id)).toBe('ok')
      cursor.t = startAt + ACTIONS[id].durationMs / 1000
      play.settle(cursor.t)
      if (play.state.endedAt !== undefined) break
    }
    // confirm_resolution is last in the catalog and ends the run.
    for (const id of ACTION_IDS) expect(play.state.actions[id].status).toBe('completed')
    expect(cursor.t).toBeLessThan(480)
  })
})

describe('every action: duration, prerequisites, effects', () => {
  const expected: Record<ActionId, { seconds: number; delta: Record<string, number> }> = {
    inspect_access_logs: { seconds: 15, delta: { evidence: 15 } },
    correlate_session_events: { seconds: 20, delta: { evidence: 20 } },
    investigate_signing_access: { seconds: 20, delta: { evidence: 25 } },
    revoke_admin_sessions: { seconds: 25, delta: { containment: 40 } },
    validate_containment: { seconds: 15, delta: { evidence: 10 } },
    review_deployment: { seconds: 15, delta: { evidence: 10 } },
    roll_back_release: { seconds: 30, delta: { health: 18 } },
    rotate_signing_keys: { seconds: 35, delta: { containment: 35, trust: -3 } },
    restore_auth: { seconds: 40, delta: { health: 35 } },
    validate_recovery: { seconds: 20, delta: { health: 10 } },
    issue_customer_advisory: { seconds: 15, delta: { trust: 8 } },
    confirm_resolution: { seconds: 0, delta: {} },
  }

  for (const id of ACTION_IDS) {
    it(`${id}: takes ${expected[id].seconds}s and changes exactly ${JSON.stringify(expected[id].delta)}`, () => {
      expect(ACTIONS[id].durationMs).toBe(expected[id].seconds * 1000)

      const play = createPlay()
      // Pin health and trust low enough that no clamp hides a delta, by
      // waiting out the two unconditional-in-practice penalties first.
      const cursor = { t: 185 }
      play.settle(cursor.t)
      const startAt = prepare(play, id, cursor)

      const startIndex = play.log.length
      expect(play.start(startAt, id)).toBe('ok')
      // Starting changes no metric.
      if (ACTIONS[id].durationMs > 0) {
        const started = around(play, startIndex)
        expect(metricDelta(started.before, started.after)).toEqual({})
        expect(started.after.actions[id]).toEqual({
          status: 'in_progress',
          startedAt: T0 + startAt * 1000,
          completesAt: T0 + startAt * 1000 + ACTIONS[id].durationMs,
        })
        // One millisecond early it is still running.
        play.settle(startAt + expected[id].seconds - 0.001)
        expect(play.state.actions[id].status).toBe('in_progress')
      }
      play.settle(startAt + expected[id].seconds)
      const { before, after } = around(play, completionIndex(play, id))
      expect(ACTIONS[id].effects).toEqual(expected[id].delta)
      if (id === 'validate_recovery') {
        // The rule is +10, but health is never below 99 once the service is
        // restored (worst case 82 - 8 - 10 + 35), so the clamp at 100 leaves
        // room for 1. What validation really buys is the flag: 15 points and
        // eligibility for Complete Recovery.
        expect(before.metrics.health).toBe(99)
        expect(metricDelta(before, after)).toEqual({ health: 1 })
      } else {
        expect(metricDelta(before, after)).toEqual(expected[id].delta)
      }
      expect(after.actions[id].status).toBe('completed')
      expect(after.actions[id].completedAt).toBe(T0 + (startAt + expected[id].seconds) * 1000)
    })
  }

  const blockedAtStart: [ActionId, string][] = [
    ['correlate_session_events', 'prerequisite_missing'],
    ['investigate_signing_access', 'prerequisite_missing'],
    ['revoke_admin_sessions', 'prerequisite_missing'],
    ['validate_containment', 'prerequisite_missing'],
    ['roll_back_release', 'approval_required'],
    ['rotate_signing_keys', 'prerequisite_missing'],
    ['restore_auth', 'prerequisite_missing'],
    ['validate_recovery', 'prerequisite_missing'],
    ['confirm_resolution', 'prerequisite_missing'],
  ]
  for (const [id, code] of blockedAtStart) {
    it(`${id} cannot start from a fresh simulation (${code}) and a refusal changes nothing`, () => {
      const play = createPlay()
      play.settle(1)
      const snapshot = structuredClone(play.state)
      expect(play.start(1, id)).toBe(code)
      expect(play.state).toEqual(snapshot)
    })
  }

  it('each prerequisite is individually necessary', () => {
    for (const id of ACTION_IDS) {
      for (const missing of ACTIONS[id].requires) {
        // Complete everything the action needs except `missing` (and whatever needs `missing`).
        const play = createPlay()
        const cursor = { t: 0 }
        for (const other of ACTIONS[id].requires) {
          if (other === missing || ACTIONS[other].requires.includes(missing)) continue
          if (play.state.actions[other].status === 'completed') continue
          const startAt = prepare(play, other, cursor)
          if (play.state.actions[missing].status === 'completed') break
          expect(play.start(startAt, other)).toBe('ok')
          cursor.t = startAt + ACTIONS[other].durationMs / 1000
          play.settle(cursor.t)
        }
        if (play.state.actions[missing].status === 'completed') continue // unavoidable transitive prerequisite
        expect(validateExecute(play.state, id, T0 + cursor.t * 1000)).toEqual({ ok: false, code: 'prerequisite_missing' })
      }
    }
  })

  it('restoring needs BOTH interventions: revoked-only and rotated-only are each refused', () => {
    const revoked = script(createPlay(), STRATEGIES.revokeOnly)
    revoked.settle(100)
    expect(revoked.start(100, 'restore_auth')).toBe('prerequisite_missing')

    const play = script(createPlay(), [
      [0, 'start', 'inspect_access_logs'],
      [15, 'start', 'correlate_session_events'],
      [35, 'start', 'investigate_signing_access'],
      [55, 'approve', 'rotate_signing_keys'],
      [60, 'start', 'rotate_signing_keys'],
    ])
    play.settle(100)
    expect(facts(play.state)).toMatchObject({ keysRotated: true, adminRevoked: false })
    expect(play.start(100, 'restore_auth')).toBe('prerequisite_missing')
  })
})

describe('one use per action, one timed action per role', () => {
  it('an action in progress or completed cannot be started again', () => {
    const play = createPlay()
    expect(play.start(1, 'inspect_access_logs')).toBe('ok')
    expect(play.start(2, 'inspect_access_logs')).toBe('action_already_used')
    expect(play.start(30, 'inspect_access_logs')).toBe('action_already_used')
    expect(play.log.filter((e) => e.type === 'action_started' && e.actionId === 'inspect_access_logs')).toHaveLength(1)
    expect(play.state.metrics.evidence).toBe(25)
  })

  it('a role runs one timed action at a time; other roles are unaffected', () => {
    const play = createPlay()
    expect(play.approve(0, 'roll_back_release')).toBe('ok')
    expect(play.start(5, 'review_deployment')).toBe('ok') // infrastructure, 5s to 20s
    expect(play.start(6, 'roll_back_release')).toBe('role_busy')
    expect(play.start(6, 'inspect_access_logs')).toBe('ok') // security
    expect(play.start(6, 'issue_customer_advisory')).toBe('ok') // commander
    expect(play.start(19.999, 'roll_back_release')).toBe('role_busy')
    expect(play.start(20, 'roll_back_release')).toBe('ok') // free the instant the review completes
  })

  it('an actor may only run actions of a role they hold', () => {
    const state = initialState(T0)
    expect(validateExecute(state, 'inspect_access_logs', T0 + 1, ['security'])).toMatchObject({ ok: true })
    expect(validateExecute(state, 'inspect_access_logs', T0 + 1, ['infrastructure', 'commander'])).toEqual({ ok: false, code: 'wrong_role' })
    expect(validateExecute(state, 'review_deployment', T0 + 1, ['security'])).toEqual({ ok: false, code: 'wrong_role' })
    expect(validateExecute(state, 'issue_customer_advisory', T0 + 1, ['security', 'infrastructure'])).toEqual({ ok: false, code: 'wrong_role' })
    expect(validateExecute(state, 'issue_customer_advisory', T0 + 1, [])).toEqual({ ok: false, code: 'wrong_role' })
    expect(validateExecute(state, 'inspect_access_logs', T0 + 1, ROLES)).toMatchObject({ ok: true })
  })

  it('refuses unknown actions, including prototype keys', () => {
    for (const bad of ['rotate_keys', 'constructor', '__proto__', '', 42, null, undefined]) {
      expect(validateExecute(initialState(T0), bad, T0 + 1)).toEqual({ ok: false, code: 'unknown_action' })
    }
  })
})

describe('commander approval', () => {
  const security = ['security'] as const
  const infrastructure = ['infrastructure'] as const
  const commander = ['commander'] as const

  function correlated(): Play {
    return script(createPlay(), [
      [0, 'start', 'inspect_access_logs'],
      [15, 'start', 'correlate_session_events'],
    ])
  }

  it('a gated action cannot start without approval', () => {
    const play = correlated()
    expect(play.start(36, 'revoke_admin_sessions')).toBe('approval_required')
  })

  it('team flow: request, grant, five seconds of processing, then start', () => {
    const play = correlated()
    expect(play.request(36, 'revoke_admin_sessions', security)).toBe('ok')
    expect(play.start(37, 'revoke_admin_sessions', security)).toBe('approval_required') // requested is not approved
    expect(play.grant(40, 'revoke_admin_sessions', commander)).toBe('ok')
    expect(play.state.approvals.revoke_admin_sessions).toEqual({
      status: 'approved',
      decidedAt: T0 + 40_000,
      effectiveAt: T0 + 45_000,
      auto: false,
    })
    expect(play.start(44.999, 'revoke_admin_sessions', security)).toBe('approval_pending')
    expect(play.start(45, 'revoke_admin_sessions', security)).toBe('ok')
  })

  it('only the performing role may request; only the commander may decide', () => {
    const play = correlated()
    expect(play.request(36, 'revoke_admin_sessions', infrastructure)).toBe('wrong_role')
    expect(play.request(36, 'revoke_admin_sessions', commander)).toBe('wrong_role')
    expect(play.request(36, 'revoke_admin_sessions', security)).toBe('ok')
    expect(play.grant(37, 'revoke_admin_sessions', security)).toBe('wrong_role')
    expect(play.deny(37, 'revoke_admin_sessions', infrastructure)).toBe('wrong_role')
    expect(play.grant(37, 'revoke_admin_sessions', commander)).toBe('ok')
  })

  it('there is nothing to decide without a pending request', () => {
    const play = correlated()
    expect(play.grant(36, 'revoke_admin_sessions', commander)).toBe('no_pending_request')
    expect(play.deny(36, 'revoke_admin_sessions', commander)).toBe('no_pending_request')
    expect(play.request(36, 'revoke_admin_sessions', security)).toBe('ok')
    expect(play.grant(37, 'revoke_admin_sessions', commander)).toBe('ok')
    expect(play.grant(38, 'revoke_admin_sessions', commander)).toBe('no_pending_request') // already decided
    expect(play.deny(38, 'revoke_admin_sessions', commander)).toBe('no_pending_request')
  })

  it('approval can only be requested once the action is otherwise possible', () => {
    const play = createPlay()
    expect(play.request(1, 'revoke_admin_sessions')).toBe('prerequisite_missing')
    expect(play.request(1, 'rotate_signing_keys')).toBe('prerequisite_missing')
    expect(play.request(1, 'roll_back_release')).toBe('ok') // no prerequisites
  })

  it('actions that need no approval cannot have one requested', () => {
    const play = createPlay()
    for (const id of ACTION_IDS.filter((a) => !ACTIONS[a].needsApproval)) {
      expect(play.request(1, id)).toBe('approval_not_needed')
      expect(play.grant(1, id)).toBe('approval_not_needed')
    }
    expect(play.request(1, 'not_an_action')).toBe('unknown_action')
  })

  it('an approval is scoped to its exact action', () => {
    const play = script(createPlay(), [
      [0, 'start', 'inspect_access_logs'],
      [15, 'start', 'correlate_session_events'],
      [35, 'start', 'investigate_signing_access'],
      [35, 'approve', 'revoke_admin_sessions'],
    ])
    play.settle(60)
    expect(play.start(60, 'rotate_signing_keys')).toBe('approval_required')
    expect(play.start(60, 'roll_back_release')).toBe('approval_required')
    expect(play.start(60, 'revoke_admin_sessions')).toBe('ok')
  })

  it('a request cannot be duplicated, and an approved action cannot be re-requested', () => {
    const play = correlated()
    expect(play.request(36, 'revoke_admin_sessions')).toBe('ok')
    expect(play.request(37, 'revoke_admin_sessions')).toBe('approval_already_requested')
    expect(play.grant(38, 'revoke_admin_sessions')).toBe('ok')
    expect(play.request(39, 'revoke_admin_sessions')).toBe('approval_already_granted')
    expect(play.approve(39, 'revoke_admin_sessions')).toBe('approval_already_granted')
  })

  it('a denial blocks the action, takes five seconds too, and can then be re-requested', () => {
    const play = correlated()
    expect(play.request(36, 'revoke_admin_sessions')).toBe('ok')
    expect(play.deny(40, 'revoke_admin_sessions')).toBe('ok')
    expect(play.start(41, 'revoke_admin_sessions')).toBe('approval_pending')
    expect(play.request(41, 'revoke_admin_sessions')).toBe('approval_pending')
    expect(play.start(45, 'revoke_admin_sessions')).toBe('approval_denied')
    expect(play.start(200, 'revoke_admin_sessions')).toBe('approval_denied') // a denial does not expire
    expect(play.request(200, 'revoke_admin_sessions')).toBe('ok')
    expect(play.grant(201, 'revoke_admin_sessions')).toBe('ok')
    expect(play.start(206, 'revoke_admin_sessions')).toBe('ok')
  })

  it('solo: one step records request and approval; it still takes five seconds', () => {
    const play = correlated()
    expect(play.approve(36, 'revoke_admin_sessions')).toBe('ok')
    expect(play.state.approvals.revoke_admin_sessions).toEqual({
      status: 'approved',
      decidedAt: T0 + 36_000,
      effectiveAt: T0 + 41_000,
      auto: true,
    })
    expect(play.start(40.999, 'revoke_admin_sessions')).toBe('approval_pending')
    expect(play.start(41, 'revoke_admin_sessions')).toBe('ok')
  })

  it('approval once used is spent: the action cannot run twice', () => {
    const play = correlated()
    expect(play.approve(36, 'revoke_admin_sessions')).toBe('ok')
    expect(play.start(41, 'revoke_admin_sessions')).toBe('ok')
    expect(play.start(42, 'revoke_admin_sessions')).toBe('action_already_used')
    expect(play.request(42, 'revoke_admin_sessions')).toBe('action_already_used')
    expect(play.start(70, 'revoke_admin_sessions')).toBe('action_already_used')
  })

  it('approvals do not occupy the commander', () => {
    const play = correlated()
    expect(play.approve(36, 'revoke_admin_sessions')).toBe('ok')
    expect(play.approve(36, 'roll_back_release')).toBe('ok')
    expect(play.start(36, 'issue_customer_advisory')).toBe('ok')
  })
})

describe('scheduled incidents', () => {
  it('the schedule is the documented one', () => {
    expect(INCIDENTS.map((i) => [i.id, i.atMs / 1000])).toEqual([
      ['initial_alert', 0],
      ['service_degradation', 60],
      ['attacker_activity', 120],
      ['outage_spreads', 180],
      ['attacker_escalation', 240],
      ['token_replay', 330],
      ['communication_gap', 330],
      ['deadline_warning', 420],
      ['finalization', 480],
    ])
  })

  it('with nobody acting, every incident fires once, in order, at its exact time, with its penalty', () => {
    const play = createPlay()
    play.finish()
    expect(play.log.map((e) => [e.incidentId, (e.at - T0) / 1000])).toEqual(INCIDENTS.map((i) => [i.id, i.atMs / 1000]))
    const deltas = INCIDENTS.map((i) => {
      const { before, after } = around(play, incidentIndex(play, i.id))
      return [i.id, metricDelta(before, after)]
    })
    expect(deltas).toEqual([
      ['initial_alert', {}],
      ['service_degradation', { health: -8, trust: -5 }],
      ['attacker_activity', { containment: -5 }],
      ['outage_spreads', { health: -10, trust: -5 }],
      ['attacker_escalation', { containment: -10 }],
      ['token_replay', { trust: -8 }],
      ['communication_gap', { trust: -5 }],
      ['deadline_warning', {}],
      ['finalization', {}],
    ])
    expect(play.state.metrics).toEqual({ health: 64, containment: 5, trust: 41, evidence: 10 })
  })

  it('each conditional incident is skipped when its condition is already resolved', () => {
    // Contained by 95s, restored by 135s, advisory out: nothing after 01:00 applies.
    const play = script(createPlay(), STRATEGIES.optimal.slice(0, -1)) // everything but the confirmation
    play.finish()
    const applied = Object.fromEntries(INCIDENTS.map((i) => [i.id, play.state.incidents[i.id]?.applied]))
    expect(applied).toEqual({
      initial_alert: false,
      service_degradation: true, // unavoidable: nothing can be restored within a minute
      attacker_activity: false,
      outage_spreads: false,
      attacker_escalation: false,
      token_replay: false,
      communication_gap: false,
      deadline_warning: false,
      finalization: false,
    })
  })

  it('02:00 looks at full containment; 04:00 only at the admin session', () => {
    const revoked = script(createPlay(), STRATEGIES.revokeOnly)
    revoked.finish()
    expect(revoked.state.incidents.attacker_activity?.applied).toBe(true) // keys still exposed
    expect(revoked.state.incidents.attacker_escalation?.applied).toBe(false) // session is gone
    expect(revoked.state.incidents.token_replay?.applied).toBe(true)
  })

  it('the replay penalty and the communication penalty are independent', () => {
    const cases: [boolean, boolean, number][] = [
      // [keys rotated by 05:30, advisory issued by 05:30, trust lost at 05:30]
      [false, false, 13],
      [false, true, 8],
      [true, false, 5],
      [true, true, 0],
    ]
    for (const [rotate, advise, lost] of cases) {
      const play = script(createPlay(), rotate ? STRATEGIES.containedNotRestored : STRATEGIES.revokeOnly)
      if (advise) expect(play.start(200, 'issue_customer_advisory')).toBe('ok')
      play.settle(329.999)
      const before = play.state.metrics.trust
      play.settle(330)
      expect(before - play.state.metrics.trust).toBe(lost)
      expect(play.state.incidents.token_replay?.applied).toBe(!rotate)
      expect(play.state.incidents.communication_gap?.applied).toBe(!advise)
    }
  })

  it('01:00 and 03:00 stop hurting once the service is restored, and only then', () => {
    const play = script(createPlay(), STRATEGIES.unvalidated) // restored at 135s
    play.finish()
    expect(play.state.incidents.service_degradation?.applied).toBe(true)
    expect(play.state.incidents.outage_spreads?.applied).toBe(false)
    // A rollback makes health look better but is not a restoration.
    const decoy = script(createPlay(), STRATEGIES.decoyOnly)
    decoy.finish()
    expect(decoy.state.incidents.service_degradation?.applied).toBe(true)
    expect(decoy.state.incidents.outage_spreads?.applied).toBe(true)
  })

  it('no incident fires after the simulation is confirmed resolved', () => {
    const play = script(createPlay(), STRATEGIES.optimal) // confirmed at 155s
    const length = play.log.length
    play.settle(10_000)
    expect(play.log).toHaveLength(length)
    expect(nextDue(play.state, DEADLINE + 1)).toBeNull()
    expect(Object.keys(play.state.incidents)).toEqual(['initial_alert', 'service_degradation', 'attacker_activity'])
  })
})

describe('conditional consequences', () => {
  it('a rollback ordered before the diagnosis costs no trust; one ordered after costs 4', () => {
    const early = script(createPlay(), STRATEGIES.decoyOnly)
    early.settle(40)
    const a = around(early, completionIndex(early, 'roll_back_release'))
    expect(metricDelta(a.before, a.after)).toEqual({ health: 18 })

    const late = script(createPlay(), STRATEGIES.slowAndSilent.slice(0, 7))
    late.settle(100)
    const b = around(late, completionIndex(late, 'roll_back_release'))
    expect(metricDelta(b.before, b.after)).toEqual({ health: 18, trust: -4 })
  })

  it('what counts is what was known when the rollback was ordered, not when it finished', () => {
    const play = script(createPlay(), [
      [0, 'start', 'inspect_access_logs'],
      [0, 'approve', 'roll_back_release'],
      [15, 'start', 'correlate_session_events'], // confirms the compromise at 35s
      [34.999, 'start', 'roll_back_release'], // ordered a millisecond before that
    ])
    play.settle(70)
    expect(facts(play.state).sessionCompromiseConfirmed).toBe(true)
    const { before, after } = around(play, completionIndex(play, 'roll_back_release'))
    expect(metricDelta(before, after)).toEqual({ health: 18 })

    const after35 = script(createPlay(), [
      [0, 'start', 'inspect_access_logs'],
      [0, 'approve', 'roll_back_release'],
      [15, 'start', 'correlate_session_events'],
      [35, 'start', 'roll_back_release'], // the completion at 35s is applied first
    ])
    after35.settle(70)
    const c = around(after35, completionIndex(after35, 'roll_back_release'))
    expect(metricDelta(c.before, c.after)).toEqual({ health: 18, trust: -4 })
  })

  it('a rollback is not containment and not restoration', () => {
    const play = script(createPlay(), STRATEGIES.decoyOnly)
    play.settle(50)
    expect(facts(play.state)).toMatchObject({ rolledBack: true, anyContainment: false, serviceRestored: false })
    expect(play.start(50, 'validate_recovery')).toBe('prerequisite_missing')
    expect(play.start(50, 'confirm_resolution')).toBe('prerequisite_missing')
  })

  it('metrics are clamped to 0..100', () => {
    const play = script(createPlay(), STRATEGIES.optimal.slice(0, -1))
    play.settle(160)
    // 82 - 8 + 35 + 10 would be 119.
    expect(play.state.metrics.health).toBe(100)
    const drained: SimulationState = { ...initialState(T0), metrics: { health: 3, containment: 2, trust: 4, evidence: 0 } }
    const alert: GameEvent = { seq: 1, type: 'incident', incidentId: 'initial_alert', at: T0, actorId: '', commandId: '' }
    const hit: GameEvent = { seq: 2, type: 'incident', incidentId: 'service_degradation', at: T0 + 60_000, actorId: '', commandId: '' }
    const after = applyEvent(applyEvent(drained, alert), hit)
    expect(after.metrics).toEqual({ health: 0, containment: 2, trust: 0, evidence: 0 })
  })

  it('irreversible: nothing can be undone or repeated, and penalties are never refunded', () => {
    const play = script(createPlay(), STRATEGIES.slowAndSilent)
    // Trust lost to the rollback, the replay and the silence is still lost at the end.
    expect(play.state.metrics.trust).toBe(34)
    for (const id of ACTION_IDS) {
      if (play.state.actions[id].status === 'completed') {
        expect(validateExecute({ ...play.state, endedAt: undefined }, id, T0 + 440_000)).toEqual({ ok: false, code: 'action_already_used' })
      }
    }
  })
})

describe('endings', () => {
  const expectations: [keyof typeof STRATEGIES, OutcomeId, number, Record<string, number>][] = [
    ['optimal', 'complete_recovery', 100, { health: 100, containment: 95, trust: 64, evidence: 70 }],
    ['unvalidated', 'costly_recovery', 82, { health: 100, containment: 95, trust: 51, evidence: 70 }],
    ['slowAndSilent', 'costly_recovery', 95, { health: 100, containment: 90, trust: 34, evidence: 70 }],
    ['revokeOnly', 'partial_containment', 32, { health: 64, containment: 55, trust: 41, evidence: 45 }],
    ['containedNotRestored', 'partial_containment', 53, { health: 64, containment: 95, trust: 46, evidence: 70 }],
    ['decoyOnly', 'incident_escalation', 16, { health: 82, containment: 5, trust: 54, evidence: 20 }],
    ['analysisParalysis', 'incident_escalation', 22, { health: 64, containment: 5, trust: 41, evidence: 80 }],
    ['doNothing', 'incident_escalation', 12, { health: 64, containment: 5, trust: 41, evidence: 10 }],
  ]

  for (const [name, outcome, score, metrics] of expectations) {
    it(`strategy "${name}" ends in ${outcome} with ${score} points`, () => {
      const play = script(createPlay(), STRATEGIES[name])
      const result = play.finish()
      expect(play.state.metrics).toEqual(metrics)
      expect(result.outcome).toBe(outcome)
      expect(result.score).toBe(score)
    })
  }

  it('all four endings are reached by the strategies above', () => {
    const reached = new Set(expectations.map(([name]) => script(createPlay(), STRATEGIES[name]).finish().outcome))
    expect([...reached].sort()).toEqual(
      ['complete_recovery', 'costly_recovery', 'incident_escalation', 'partial_containment'].sort(),
    )
  })

  it('the ending is a total, exclusive function of the final state (full truth table)', () => {
    const status = (done: boolean): { status: ActionStatus } => ({ status: done ? 'completed' : 'available' })
    let checked = 0
    for (const revoked of [false, true])
      for (const rotated of [false, true])
        for (const restored of [false, true])
          for (const validated of [false, true])
            // Health is swept to show it plays no part in the ending.
            for (const health of [0, 69, 70, 100])
              for (const trust of [0, 39, 40, 100]) {
                const base = initialState(T0)
                const state: SimulationState = {
                  ...base,
                  metrics: { ...base.metrics, health, trust },
                  actions: {
                    ...base.actions,
                    revoke_admin_sessions: status(revoked),
                    rotate_signing_keys: status(rotated),
                    restore_auth: status(restored),
                    validate_recovery: status(validated),
                  },
                }
                const predicates: Record<OutcomeId, boolean> = {
                  complete_recovery: revoked && rotated && restored && validated && trust >= 40,
                  costly_recovery: revoked && rotated && restored && !(validated && trust >= 40),
                  partial_containment: (revoked || rotated) && !(revoked && rotated && restored),
                  incident_escalation: !revoked && !rotated,
                }
                const holding = (Object.keys(predicates) as OutcomeId[]).filter((k) => predicates[k])
                expect(holding).toHaveLength(1) // the four definitions partition every state
                expect(evaluateOutcome(state)).toBe(holding[0])
                checked++
              }
    expect(checked).toBe(256)
  })

  it('both interventions without a restored service is Partial Containment, not Escalation', () => {
    const play = script(createPlay(), STRATEGIES.containedNotRestored)
    expect(play.finish().outcome).toBe('partial_containment')
    expect(facts(play.state)).toMatchObject({ fullyContained: true, serviceRestored: false })
  })

  it('validated recovery with trust below 40 is Costly, not Complete', () => {
    const play = script(createPlay(), STRATEGIES.slowAndSilent)
    expect(facts(play.state)).toMatchObject({ fullyContained: true, serviceRestored: true, recoveryValidated: true })
    expect(play.state.metrics.trust).toBeLessThan(40)
    expect(play.finish().outcome).toBe('costly_recovery')
  })

  it('there is no result while the simulation is running', () => {
    const play = script(createPlay(), STRATEGIES.unvalidated)
    play.settle(479.999)
    expect(finalResult(play.state)).toBeNull()
    play.settle(480)
    expect(finalResult(play.state)).toMatchObject({ reason: 'deadline', endedAt: DEADLINE })
  })

  it('confirming ends the simulation at once, with the ending the state has earned', () => {
    const play = script(createPlay(), STRATEGIES.optimal)
    expect(finalResult(play.state)).toMatchObject({
      outcome: 'complete_recovery',
      reason: 'confirmed',
      endedAt: T0 + 155_000,
    })
    expect(play.start(156, 'validate_containment')).toBe('simulation_ended')
    expect(play.approve(156, 'roll_back_release')).toBe('simulation_ended')
  })

  it('confirmation needs both interventions, restoration and validation — nothing less', () => {
    const play = script(createPlay(), STRATEGIES.unvalidated)
    play.settle(140)
    expect(play.start(140, 'confirm_resolution')).toBe('prerequisite_missing') // restored but not validated
    expect(play.start(140, 'validate_recovery')).toBe('ok')
    expect(play.start(159.999, 'confirm_resolution')).toBe('prerequisite_missing')
    expect(play.start(160, 'confirm_resolution')).toBe('ok')
    expect(finalResult(play.state)?.outcome).toBe('complete_recovery')
  })

  it('a complete recovery left unconfirmed is still a Complete Recovery at the deadline', () => {
    const play = script(createPlay(), STRATEGIES.optimal.slice(0, -1))
    expect(play.finish()).toMatchObject({ outcome: 'complete_recovery', reason: 'deadline', score: 100 })
  })
})

describe('score', () => {
  it('is the documented 100-point breakdown', () => {
    const play = script(createPlay(), STRATEGIES.optimal)
    expect(scoreBreakdown(play.state)).toEqual({
      containment: 30,
      restoration: 25,
      validation: 15,
      evidence: 10,
      trust: 10,
      health: 10,
      total: 100,
    })
  })

  it('trust is scored as trust retained: 10 at the starting level, one point less per 6 lost', () => {
    const points = (trust: number) => trustScore(trust)
    expect([100, 65, 64].map(points)).toEqual([10, 10, 10]) // nothing above the starting level earns more
    expect([63, 58].map(points)).toEqual([9, 9])
    expect([57, 52, 51, 46, 45].map(points)).toEqual([8, 8, 7, 7, 6])
    // The Complete Recovery threshold is a step boundary.
    expect([40, 39, 34, 33].map(points)).toEqual([6, 5, 5, 4])
    expect([10, 9, 4, 3, 0].map(points)).toEqual([1, 0, 0, 0, 0])
    // Monotone: more trust never scores less.
    for (let t = 1; t <= 100; t++) expect(points(t)).toBeGreaterThanOrEqual(points(t - 1))
  })

  it('caps the trust and health components at 10 each and the total at 100', () => {
    const base = script(createPlay(), STRATEGIES.optimal).state
    const perfect = scoreBreakdown({ ...base, metrics: { ...base.metrics, trust: 100, health: 100 } })
    expect(perfect).toMatchObject({ trust: 10, health: 10, total: 100 })
    const empty = scoreBreakdown({ ...initialState(T0), metrics: { health: 0, containment: 0, trust: 0, evidence: 0 } })
    expect(empty.total).toBe(0)
  })

  it('critical evidence is 5 for the session compromise and 5 for the signing exposure, not the evidence meter', () => {
    const play = createPlay()
    expect(play.start(0, 'inspect_access_logs')).toBe('ok')
    expect(play.start(0, 'review_deployment')).toBe('ok')
    play.settle(15)
    expect(play.state.metrics.evidence).toBe(35)
    expect(scoreBreakdown(play.state).evidence).toBe(0) // clues, but neither critical finding
    expect(play.start(15, 'correlate_session_events')).toBe('ok')
    play.settle(35)
    expect(scoreBreakdown(play.state).evidence).toBe(5)
    expect(play.start(35, 'investigate_signing_access')).toBe('ok')
    play.settle(55)
    expect(scoreBreakdown(play.state).evidence).toBe(10)
  })

  it('gives no credit for work that was started but never finished', () => {
    const play = script(createPlay(), STRATEGIES.containedNotRestored)
    expect(play.start(440.001, 'restore_auth')).toBe('ok') // would finish 1ms after the deadline
    const result = play.finish()
    expect(play.state.actions.restore_auth.status).toBe('in_progress')
    expect(result.breakdown.restoration).toBe(0)
    expect(result.outcome).toBe('partial_containment')
  })

  it('each containment intervention is worth 15: one scores 15, both score 30, none 0', () => {
    expect(script(createPlay(), STRATEGIES.revokeOnly).finish().breakdown.containment).toBe(15)
    expect(script(createPlay(), STRATEGIES.containedNotRestored).finish().breakdown.containment).toBe(30)
    expect(script(createPlay(), STRATEGIES.analysisParalysis).finish().breakdown.containment).toBe(0)
  })
})

/**
 * 100 is reachable, only by doing the right things, and no wrong thing helps.
 * The score bands of the four endings do not overlap, so a score can never
 * contradict its label.
 */
describe('score balance: the perfect run, what costs points, and the bands', () => {
  type Steps = readonly [number, 'start' | 'approve', ActionId][]
  const run = (steps: Steps) => {
    // Steps may be listed by idea; they are played in time order (ties keep their listed order).
    const play = script(createPlay(), [...steps].sort((a, b) => a[0] - b[0]))
    const result = play.finish()
    return { ...result, metrics: play.state.metrics }
  }
  const optimal: Steps = STRATEGIES.optimal
  const without = (id: ActionId): Steps => optimal.filter(([, , action]) => action !== id)

  it('the optimal strategy scores exactly 100', () => {
    expect(run(optimal)).toMatchObject({ outcome: 'complete_recovery', score: 100, reason: 'confirmed' })
  })

  it('every part of the optimal strategy is needed for 100', () => {
    // No advisory: 8 trust short of the starting level.
    expect(run(without('issue_customer_advisory'))).toMatchObject({ outcome: 'complete_recovery', score: 98 })
    // Not validated (so it cannot be confirmed either): Costly Recovery.
    expect(run(optimal.filter(([, , a]) => a !== 'validate_recovery' && a !== 'confirm_resolution'))).toMatchObject({
      outcome: 'costly_recovery',
      score: 85,
    })
    // Service back only after the outage spread at 03:00: 5 more trust lost.
    const lateRestore: Steps = [
      ...optimal.slice(0, 8),
      [181, 'start', 'restore_auth'],
      [221, 'start', 'validate_recovery'],
      [241, 'start', 'confirm_resolution'],
    ]
    expect(run(lateRestore)).toMatchObject({ outcome: 'complete_recovery', score: 99 })
  })

  it('validated but unconfirmed still scores 100: confirming ends the run, it is not worth points', () => {
    expect(run(optimal.slice(0, -1))).toMatchObject({ outcome: 'complete_recovery', score: 100, reason: 'deadline' })
  })

  it('the decoy never helps: a rollback adds nothing to a perfect run and costs points once the cause is known', () => {
    const earlyRollback: Steps = [[0, 'approve', 'roll_back_release'], [5, 'start', 'roll_back_release'], ...optimal]
    expect(run(earlyRollback).score).toBe(100) // harmless before the diagnosis, and worth nothing
    // After the diagnosis, in the infrastructure engineer's idle time: trust -4.
    const lateRollback: Steps = [
      ...optimal.slice(0, 3),
      [35, 'approve', 'roll_back_release'],
      [40, 'start', 'roll_back_release'],
      [35, 'start', 'investigate_signing_access'],
      [35, 'approve', 'revoke_admin_sessions'],
      [55, 'start', 'revoke_admin_sessions'],
      [55, 'approve', 'rotate_signing_keys'],
      [70, 'start', 'rotate_signing_keys'],
      [105, 'start', 'restore_auth'],
      [145, 'start', 'validate_recovery'],
      [165, 'start', 'confirm_resolution'],
    ]
    const result = run([...lateRollback].sort((a, b) => a[0] - b[0]))
    expect(result).toMatchObject({ outcome: 'complete_recovery', score: 99 })
    expect(result.metrics.trust).toBe(60)
  })

  it('extra investigation neither helps nor hurts the score', () => {
    const thorough: Steps = [[0, 'start', 'review_deployment'], ...optimal.slice(0, -1), [80, 'start', 'validate_containment'], [155, 'start', 'confirm_resolution']]
    expect(run([...thorough].sort((a, b) => a[0] - b[0])).score).toBe(100)
  })

  // The best and the worst play that lands in each ending.
  const extremes: [string, OutcomeId, number, Steps][] = [
    ['worst Complete Recovery: late, silent, rolled back after the diagnosis, but validated with trust 42', 'complete_recovery', 96, [
      [0, 'start', 'inspect_access_logs'],
      [15, 'start', 'correlate_session_events'],
      [35, 'start', 'investigate_signing_access'],
      [35, 'approve', 'revoke_admin_sessions'],
      [40, 'approve', 'roll_back_release'],
      [45, 'start', 'roll_back_release'],
      [55, 'start', 'revoke_admin_sessions'],
      [75, 'approve', 'rotate_signing_keys'],
      [80, 'start', 'rotate_signing_keys'],
      [181, 'start', 'restore_auth'],
      [221, 'start', 'validate_recovery'],
      [331, 'start', 'confirm_resolution'],
    ]],
    ['best Costly Recovery: everything done and validated, but trust fell to 34', 'costly_recovery', 95, STRATEGIES.slowAndSilent],
    ['worst Costly Recovery: restored late, never validated, silent, keys rotated after the replay', 'costly_recovery', 79, [
      [0, 'start', 'inspect_access_logs'],
      [15, 'start', 'correlate_session_events'],
      [35, 'start', 'investigate_signing_access'],
      [35, 'approve', 'revoke_admin_sessions'],
      [55, 'start', 'revoke_admin_sessions'],
      [335, 'approve', 'rotate_signing_keys'],
      [340, 'start', 'rotate_signing_keys'],
      [375, 'start', 'restore_auth'],
    ]],
    ['best Partial Containment: both interventions, advisory, early rollback — but never restored', 'partial_containment', 57, [
      [0, 'start', 'issue_customer_advisory'],
      [0, 'approve', 'roll_back_release'],
      [5, 'start', 'roll_back_release'],
      ...STRATEGIES.containedNotRestored,
    ]],
    ['worst Partial Containment: one intervention and nothing else', 'partial_containment', 32, STRATEGIES.revokeOnly],
    ['best Incident Escalation: full investigation, advisory, early rollback — and no containment', 'incident_escalation', 26, [
      [0, 'start', 'issue_customer_advisory'],
      [0, 'approve', 'roll_back_release'],
      [5, 'start', 'roll_back_release'],
      [0, 'start', 'inspect_access_logs'],
      [15, 'start', 'correlate_session_events'],
      [35, 'start', 'investigate_signing_access'],
    ]],
    ['worst Incident Escalation: nothing at all', 'incident_escalation', 12, STRATEGIES.doNothing],
  ]
  for (const [name, outcome, score, steps] of extremes) {
    it(`${name} scores ${score}`, () => {
      expect(run([...steps].sort((a, b) => a[0] - b[0]))).toMatchObject({ outcome, score })
    })
  }

  const BANDS: Record<OutcomeId, [number, number]> = {
    incident_escalation: [12, 26],
    partial_containment: [32, 57],
    costly_recovery: [79, 95],
    complete_recovery: [96, 100],
  }

  it('the bands are disjoint and ordered like the endings', () => {
    expect(BANDS.incident_escalation[1]).toBeLessThan(BANDS.partial_containment[0])
    expect(BANDS.partial_containment[1]).toBeLessThan(BANDS.costly_recovery[0])
    expect(BANDS.costly_recovery[1]).toBeLessThan(BANDS.complete_recovery[0])
  })

  /**
   * A player with a plan of random quality: random pace, random omissions,
   * random distractions. Unlike uniform random play this regularly reaches
   * the two recovery endings.
   */
  function plannedPlay(seed: number) {
    const random = prng(seed)
    const chance = (p: number) => random() < p
    const core: ['start' | 'approve', ActionId][] = [
      ['start', 'inspect_access_logs'],
      ['start', 'correlate_session_events'],
      ['approve', 'revoke_admin_sessions'],
      ['start', 'investigate_signing_access'],
      ['start', 'revoke_admin_sessions'],
      ['approve', 'rotate_signing_keys'],
      ['start', 'rotate_signing_keys'],
      ['start', 'restore_auth'],
      ['start', 'validate_recovery'],
      ['start', 'confirm_resolution'],
    ]
    // Give up part-way through the plan, sometimes.
    const plan = core.slice(0, chance(0.5) ? core.length : Math.floor(random() * (core.length + 1)))
    const extras: ['start' | 'approve', ActionId][] = []
    if (chance(0.5)) extras.push(['start', 'issue_customer_advisory'])
    if (chance(0.4)) extras.push(['approve', 'roll_back_release'], ['start', 'roll_back_release'])
    if (chance(0.3)) extras.push(['start', 'review_deployment'])
    if (chance(0.3)) extras.push(['start', 'validate_containment'])
    const extrasFirst = chance(0.5)
    const priority = extrasFirst ? [...extras, ...plan] : [...plan, ...extras]
    const pace = random() * 40
    const idleUntil = chance(0.3) ? random() * 300 : 0

    const play = createPlay()
    let readyAt = idleUntil
    for (let t = 0; t < 480 && play.state.endedAt === undefined; t++) {
      if (t < readyAt) continue
      for (const [verb, id] of priority) {
        if (play[verb](t, id) === 'ok') {
          readyAt = t + random() * pace
          break
        }
      }
    }
    const result = play.finish()
    return { result, state: play.state }
  }

  it('every score sits inside the band of its ending, over 1500 planned plays', { timeout: 60_000 }, () => {
    const seen: Record<OutcomeId, { count: number; min: number; max: number }> = {
      incident_escalation: { count: 0, min: 101, max: -1 },
      partial_containment: { count: 0, min: 101, max: -1 },
      costly_recovery: { count: 0, min: 101, max: -1 },
      complete_recovery: { count: 0, min: 101, max: -1 },
    }
    let perfect = 0
    for (let seed = 1; seed <= 1500; seed++) {
      const { result, state } = plannedPlay(seed)
      const [low, high] = BANDS[result.outcome]
      expect(result.score, `seed ${seed} (${result.outcome})`).toBeGreaterThanOrEqual(low)
      expect(result.score, `seed ${seed} (${result.outcome})`).toBeLessThanOrEqual(high)
      const s = seen[result.outcome]
      s.count++
      s.min = Math.min(s.min, result.score)
      s.max = Math.max(s.max, result.score)

      // 100 is only ever a validated, fully contained recovery with customers
      // told, the service back before the outage spread, and no trust lost
      // to the decoy.
      if (result.score === 100) {
        perfect++
        const f = facts(state)
        expect(result.outcome).toBe('complete_recovery')
        expect(f).toMatchObject({ fullyContained: true, serviceRestored: true, recoveryValidated: true, advisoryIssued: true })
        expect(state.incidents.outage_spreads?.applied ?? false).toBe(false)
        expect(state.rollbackAfterDiagnosis && f.rolledBack).toBe(false)
        expect(state.metrics.trust).toBe(64)
      }
      // No play ends with more trust than it started with once the service is restored.
      if (facts(state).serviceRestored) expect(state.metrics.trust).toBeLessThanOrEqual(INITIAL_METRICS.trust)
    }
    // The sample really does cover all four endings, and perfect runs occur in it.
    for (const outcome of Object.keys(seen) as OutcomeId[]) expect(seen[outcome].count, outcome).toBeGreaterThan(50)
    expect(perfect).toBeGreaterThan(0)
    expect(seen.complete_recovery.max).toBe(100)
  })
})

describe('rules version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(RULES_VERSION) && RULES_VERSION > 0).toBe(true)
  })

  /**
   * A digest of everything that gives a stored log its meaning: the catalog,
   * the schedule, the constants, and the full result of every named strategy
   * (which exercises ordering, incident conditions, endings and score).
   *
   * If this fails you changed the rules. Stored simulations carry the version
   * they were played under, so: bump RULES_VERSION in src/game/engine.ts,
   * then record the new digest here against the new version. Do not update
   * the digest without the bump.
   */
  it('the rulebook has not changed without a version bump', () => {
    const golden = (Object.keys(STRATEGIES) as (keyof typeof STRATEGIES)[]).map((name) => {
      const play = script(createPlay(), STRATEGIES[name])
      const result = play.finish()
      return [name, result, play.state.metrics, play.log.map((e) => [e.seq, e.type, e.actionId ?? e.incidentId, e.at - T0])]
    })
    const rulebook = JSON.stringify({
      ACTIONS,
      INCIDENTS,
      INITIAL_METRICS,
      SIMULATION_DURATION_MS,
      APPROVAL_PROCESSING_MS,
      trust: Array.from({ length: 101 }, (_, t) => trustScore(t)),
      golden,
    })
    // FNV-1a, 32 bits, over two differently seeded passes: plenty to notice an edit.
    const fnv = (text: string, seed: number) => {
      let h = seed >>> 0
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
      return h.toString(16).padStart(8, '0')
    }
    const digest = fnv(rulebook, 0x811c9dc5) + fnv(rulebook, 0x01234567)
    const RECORDED: Record<number, string> = {
      2: '1afb4f58b291e456',
    }
    expect(RECORDED[RULES_VERSION], `no digest recorded for rules version ${RULES_VERSION}`).toBeDefined()
    expect(digest, 'the rules changed: bump RULES_VERSION, then record the new digest').toBe(RECORDED[RULES_VERSION])
  })
})

describe('time boundaries and ordering', () => {
  it('refuses commands at and after the deadline, allows one millisecond before', () => {
    const state = createPlay()
    state.settle(479.999)
    expect(validateExecute(state.state, 'inspect_access_logs', DEADLINE - 1)).toMatchObject({ ok: true })
    expect(validateExecute(state.state, 'inspect_access_logs', DEADLINE)).toEqual({ ok: false, code: 'simulation_ended' })
    expect(validateExecute(state.state, 'inspect_access_logs', DEADLINE + 1)).toEqual({ ok: false, code: 'simulation_ended' })
    expect(createPlay().start(480, 'inspect_access_logs')).toBe('simulation_ended')
    expect(createPlay().approve(480, 'roll_back_release')).toBe('simulation_ended')
  })

  it('an action finishing exactly on the deadline counts; one millisecond later it does not', () => {
    const onTime = script(createPlay(), STRATEGIES.unvalidated)
    expect(onTime.start(460, 'validate_recovery')).toBe('ok') // completes at 480.000
    const a = onTime.finish()
    expect(a.outcome).toBe('complete_recovery')
    const tail = onTime.log.slice(-2).map((e) => [e.type, e.actionId ?? e.incidentId, e.at])
    expect(tail).toEqual([
      ['action_completed', 'validate_recovery', DEADLINE],
      ['incident', 'finalization', DEADLINE], // terminal evaluation is last
    ])

    const late = script(createPlay(), STRATEGIES.unvalidated)
    expect(late.start(460.001, 'validate_recovery')).toBe('ok')
    expect(late.finish().outcome).toBe('costly_recovery')
    expect(late.state.actions.validate_recovery.status).toBe('in_progress')
  })

  it('on the same millisecond an incident fires before an action completes', () => {
    // An advisory finishing exactly at 05:30 is too late to prevent the silence penalty.
    const tie = createPlay()
    expect(tie.start(315, 'issue_customer_advisory')).toBe('ok')
    tie.settle(330)
    expect(tie.state.incidents.communication_gap?.applied).toBe(true)
    const order = tie.log.filter((e) => e.at === T0 + 330_000).map((e) => e.incidentId ?? e.actionId)
    expect(order).toEqual(['token_replay', 'communication_gap', 'issue_customer_advisory'])

    const early = createPlay()
    expect(early.start(314.999, 'issue_customer_advisory')).toBe('ok')
    early.settle(330)
    expect(early.state.incidents.communication_gap?.applied).toBe(false)
  })

  it('completions on the same millisecond are ordered by the catalog, however they were started', () => {
    for (const order of [
      ['issue_customer_advisory', 'review_deployment', 'inspect_access_logs'],
      ['inspect_access_logs', 'issue_customer_advisory', 'review_deployment'],
    ] as ActionId[][]) {
      const play = createPlay()
      for (const id of order) expect(play.start(3, id)).toBe('ok')
      play.settle(18)
      expect(play.log.filter((e) => e.type === 'action_completed').map((e) => e.actionId)).toEqual([
        'inspect_access_logs',
        'review_deployment',
        'issue_customer_advisory',
      ])
    }
  })

  it('a command at an instant sees everything that happened at that instant first', () => {
    const play = createPlay()
    expect(play.start(0, 'inspect_access_logs')).toBe('ok')
    // At exactly 15s the logs are inspected, so correlation may start at 15s.
    expect(play.start(14.999, 'correlate_session_events')).toBe('prerequisite_missing')
    expect(play.start(15, 'correlate_session_events')).toBe('ok')
    expect(play.log.map((e) => e.type)).toEqual(['incident', 'action_started', 'action_completed', 'action_started'])
  })

  it('nextDue yields nothing early, the exact instant when due, and nothing twice', () => {
    const play = createPlay()
    play.settle(0)
    expect(play.start(2, 'inspect_access_logs')).toBe('ok')
    expect(nextDue(play.state, T0 + 16_999)).toBeNull()
    expect(nextDue(play.state, T0 + 17_000)).toEqual({ kind: 'completion', actionId: 'inspect_access_logs', at: T0 + 17_000 })
    // Noticed late, it is still stamped with the exact completion instant, and comes before the 01:00 incident.
    expect(nextDue(play.state, T0 + 300_000)).toEqual({ kind: 'completion', actionId: 'inspect_access_logs', at: T0 + 17_000 })
    play.settle(17)
    expect(nextDue(play.state, T0 + 59_999)).toBeNull()
    expect(nextDue(play.state, T0 + 60_000)).toEqual({ kind: 'incident', incidentId: 'service_degradation', at: T0 + 60_000 })
  })
})

describe('determinism and replay', () => {
  it('the same play gives the same log and state however lazily it is written down', () => {
    const eager = createPlay()
    const lazy = createPlay()
    for (const [seconds, verb, actionId] of STRATEGIES.slowAndSilent) {
      // The eager player syncs every second; the lazy one only when it acts.
      for (let s = 0; s <= seconds; s++) eager.settle(s)
      expect(eager[verb](seconds, actionId)).toBe('ok')
      expect(lazy[verb](seconds, actionId)).toBe('ok')
    }
    for (let s = 0; s <= 600; s += 7) eager.settle(s)
    expect(lazy.finish()).toEqual(eager.finish())
    expect(lazy.log).toEqual(eager.log)
    expect(lazy.state).toEqual(eager.state)
  })

  it('folding a log reproduces the state, in any input order, without mutating anything', () => {
    for (const name of Object.keys(STRATEGIES) as (keyof typeof STRATEGIES)[]) {
      const play = script(createPlay(), STRATEGIES[name])
      play.finish()
      const snapshot = structuredClone(play.log)
      expect(reduce(T0, play.log)).toEqual(play.state)
      expect(reduce(T0, [...play.log].reverse())).toEqual(play.state)
      expect(reduce(T0, play.log)).toEqual(reduce(T0, play.log))
      expect(play.log).toEqual(snapshot)
    }
  })

  it('applyEvent does not mutate the state it is given', () => {
    const play = script(createPlay(), STRATEGIES.optimal)
    let state = initialState(T0)
    for (const event of play.log) {
      const snapshot = structuredClone(state)
      const next = applyEvent(state, event)
      expect(state).toEqual(snapshot)
      state = next
    }
  })

  it('rejects any log the rules could not have produced', () => {
    const play = script(createPlay(), STRATEGIES.optimal)
    const log = play.log
    const renumber = (events: GameEvent[]) => events.map((e, i) => ({ ...e, seq: i + 1 }))
    const without = (predicate: (e: GameEvent) => boolean) => renumber(log.filter((e) => !predicate(e)))

    expect(() => reduce(T0, log)).not.toThrow()
    // A gap, a repeat.
    expect(() => reduce(T0, log.slice(1))).toThrow(/out of sequence/)
    expect(() => reduce(T0, [...log, log[log.length - 1]])).toThrow(/out of sequence/)
    // A missing incident: the next player event was recorded while it was owed.
    expect(() => reduce(T0, without((e) => e.incidentId === 'initial_alert'))).toThrow(/still owed/)
    expect(() => reduce(T0, without((e) => e.incidentId === 'service_degradation'))).toThrow(/still owed|not the next/)
    // A missing completion: what depended on it is refused.
    expect(() => reduce(T0, without((e) => e.type === 'action_completed' && e.actionId === 'inspect_access_logs'))).toThrow()
    // A missing approval.
    expect(() => reduce(T0, without((e) => e.type === 'approval_auto_granted' && e.actionId === 'rotate_signing_keys'))).toThrow(/approval_required/)
    // A completion at the wrong time, or of something not running.
    const shifted = log.map((e) => (e.type === 'action_completed' && e.actionId === 'restore_auth' ? { ...e, at: e.at - 1 } : e))
    expect(() => reduce(T0, shifted)).toThrow()
    const alert: GameEvent = { seq: 1, type: 'incident', incidentId: 'initial_alert', at: T0, actorId: '', commandId: '' }
    const done = (seq: number, at: number): GameEvent => ({ seq, type: 'action_completed', actionId: 'inspect_access_logs', at, actorId: 'u', commandId: 'c' })
    const begin = (seq: number, at: number): GameEvent => ({ seq, type: 'action_started', actionId: 'inspect_access_logs', at, actorId: 'u', commandId: 'c' })
    expect(() => reduce(T0, [alert, done(2, T0 + 15_000)])).toThrow(/available/)
    expect(() => reduce(T0, [alert, begin(2, T0), begin(3, T0)])).toThrow(/in_progress/)
    expect(() => reduce(T0, [alert, begin(2, T0), done(3, T0 + 15_000), done(4, T0 + 15_000)])).toThrow(/completed/)
    // Time running backwards, an unknown type, anything after the end.
    expect(() => reduce(T0, [alert, begin(2, T0 + 5000), { ...alert, seq: 3, at: T0 + 4000 }])).toThrow(/backwards/)
    expect(() => reduce(T0, [alert, { ...begin(2, T0), type: 'metrics_set' as never }])).toThrow(/Unknown event type/)
    expect(() => reduce(T0, [...log, { ...begin(log.length + 1, T0 + 156_000), actionId: 'validate_containment' }])).toThrow(/has ended/)
    // An incident fired early, or out of order.
    expect(() => reduce(T0, [alert, { ...alert, seq: 2, incidentId: 'service_degradation', at: T0 + 59_999 }])).toThrow(/not the next/)
    expect(() => reduce(T0, [alert, { ...alert, seq: 2, incidentId: 'attacker_activity', at: T0 + 120_000 }])).toThrow(/not the next/)
  })
})

describe('strategies and solo feasibility', () => {
  it('the fastest complete recovery takes 155 seconds', () => {
    const play = script(createPlay(), STRATEGIES.optimal)
    expect(finalResult(play.state)).toMatchObject({ outcome: 'complete_recovery', endedAt: T0 + 155_000 })
  })

  /**
   * A single player who does one thing, then needs `reaction` seconds before
   * doing the next, always picking the first sensible thing available.
   */
  function soloPlayer(reaction: number) {
    const priority: ['start' | 'approve', ActionId][] = [
      ['start', 'inspect_access_logs'],
      ['start', 'correlate_session_events'],
      ['approve', 'revoke_admin_sessions'],
      ['start', 'investigate_signing_access'],
      ['start', 'revoke_admin_sessions'],
      ['approve', 'rotate_signing_keys'],
      ['start', 'rotate_signing_keys'],
      ['start', 'restore_auth'],
      ['start', 'validate_recovery'],
      ['start', 'confirm_resolution'],
      ['start', 'issue_customer_advisory'],
    ]
    const play = createPlay()
    let readyAt = reaction // also needs time to read the first alert
    for (let t = 0; t < 480 && play.state.endedAt === undefined; t++) {
      if (t < readyAt) continue
      for (const [verb, id] of priority) {
        if (play[verb](t, id) === 'ok') {
          readyAt = t + reaction
          break
        }
      }
    }
    return play.finish()
  }

  it('a solo player reaches Complete Recovery within eight minutes at human pace', () => {
    for (const reaction of [0, 5, 10, 15, 20]) {
      const result = soloPlayer(reaction)
      expect(result.outcome, `reaction ${reaction}s`).toBe('complete_recovery')
      expect(result.reason).toBe('confirmed')
      expect(result.endedAt).toBeLessThan(DEADLINE)
    }
  })

  it('a solo player who takes 20 seconds per decision still confirms with over a minute to spare', () => {
    const result = soloPlayer(20)
    expect((result.endedAt - T0) / 1000).toBeLessThanOrEqual(410)
  })

  it('a solo player too slow to finish does not get Complete Recovery', () => {
    expect(soloPlayer(45).outcome).not.toBe('complete_recovery')
  })

  it('better play never scores worse: optimal > mediocre > bad', () => {
    const score = (name: keyof typeof STRATEGIES) => script(createPlay(), STRATEGIES[name]).finish().score
    expect(score('optimal')).toBeGreaterThan(score('slowAndSilent'))
    expect(score('slowAndSilent')).toBeGreaterThan(score('unvalidated'))
    expect(score('unvalidated')).toBeGreaterThan(score('containedNotRestored'))
    expect(score('containedNotRestored')).toBeGreaterThan(score('revokeOnly'))
    expect(score('revokeOnly')).toBeGreaterThan(score('decoyOnly'))
    expect(score('decoyOnly')).toBeGreaterThan(score('doNothing'))
  })
})

describe('properties over random play', () => {
  const RUNS = 400

  function randomPlay(seed: number): Play {
    const random = prng(seed)
    const play = createPlay()
    let t = 0
    // Some runs are busy, some are nearly idle.
    const stride = 1 + random() * 24
    while (t < 500) {
      t += random() * stride
      const id = ACTION_IDS[Math.floor(random() * ACTION_IDS.length)]
      const roll = random()
      const at = Math.round(t * 1000) / 1000
      if (roll < 0.5) play.start(at, id)
      else if (roll < 0.75) play.approve(at, id)
      else if (roll < 0.85) play.request(at, id)
      else if (roll < 0.95) play.grant(at, id)
      else play.deny(at, id)
    }
    play.finish()
    return play
  }

  it('holds every invariant on every run', () => {
    const outcomes = new Set<OutcomeId>()
    for (let seed = 1; seed <= RUNS; seed++) {
      const play = randomPlay(seed)
      const { state, log } = play
      const result = finalResult(state)!
      outcomes.add(result.outcome)

      // Metrics stay in range at every step; time never runs backwards; seq is contiguous.
      let replay = initialState(T0)
      for (const [i, event] of log.entries()) {
        expect(event.seq).toBe(i + 1)
        expect(event.at).toBeGreaterThanOrEqual(replay.lastEventAt)
        expect(event.at).toBeLessThanOrEqual(DEADLINE)
        replay = applyEvent(replay, event)
        for (const name of METRIC_NAMES) {
          expect(replay.metrics[name]).toBeGreaterThanOrEqual(0)
          expect(replay.metrics[name]).toBeLessThanOrEqual(100)
        }
      }
      // Replay is exact.
      expect(replay).toEqual(state)

      // No action starts or completes twice; nothing completes that did not start; durations are exact.
      for (const id of ACTION_IDS) {
        const starts = log.filter((e) => e.type === 'action_started' && e.actionId === id)
        const completions = log.filter((e) => e.type === 'action_completed' && e.actionId === id)
        expect(starts.length).toBeLessThanOrEqual(1)
        expect(completions.length).toBeLessThanOrEqual(1)
        if (ACTIONS[id].durationMs > 0 && completions.length === 1) {
          expect(starts).toHaveLength(1)
          expect(completions[0].at - starts[0].at).toBe(ACTIONS[id].durationMs)
        }
        // Every prerequisite was completed before the action began.
        const began = starts[0] ?? completions[0]
        if (began) {
          for (const required of ACTIONS[id].requires) {
            const met = log.find((e) => e.type === 'action_completed' && e.actionId === required)
            expect(met && met.seq < began.seq).toBe(true)
          }
        }
      }

      // Incidents: each at most once, in schedule order, at its exact time.
      const fired = log.filter((e) => e.type === 'incident')
      expect(fired.map((e) => e.incidentId)).toEqual(INCIDENTS.slice(0, fired.length).map((i) => i.id))
      for (const [i, event] of fired.entries()) expect(event.at).toBe(T0 + INCIDENTS[i].atMs)

      // The run ended exactly once, and the result is consistent with the facts.
      expect(state.endedAt).toBeDefined()
      const f = facts(state)
      expect(f.serviceRestored && !f.fullyContained).toBe(false)
      expect(f.recoveryValidated && !f.serviceRestored).toBe(false)
      expect(result.score).toBe(scoreBreakdown(state).total)
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThanOrEqual(100)
      if (result.reason === 'confirmed') expect(f.recoveryValidated).toBe(true)
      if (result.outcome === 'incident_escalation') expect(f.anyContainment).toBe(false)
      if (result.outcome === 'complete_recovery') expect(result.score).toBeGreaterThanOrEqual(96)
      // Once the service is restored, health is always at least 99. This is
      // why the endings carry no health condition: "restored" already implies
      // it. If a rule change ever breaks this, the endings need revisiting.
      if (f.serviceRestored) expect(state.metrics.health).toBeGreaterThanOrEqual(99)
    }
    // Random play alone reaches the three endings that need no plan.
    expect(outcomes.has('incident_escalation')).toBe(true)
    expect(outcomes.has('partial_containment')).toBe(true)
  })

  it('is deterministic: the same seed gives the same log', () => {
    for (const seed of [1, 17, 123]) {
      expect(randomPlay(seed).log).toEqual(randomPlay(seed).log)
    }
  })
})
