import { describe, expect, it } from 'vitest'
import { INCIDENTS, RULES_VERSION, finalResult, reduce, type ActionId, type GameEvent } from '../../game/engine'
import { STRATEGIES, createPlay, script } from '../../game/play.testkit'
import {
  createSoloSimulation,
  executeAction,
  requestApproval,
  syncSimulation,
  type GameStore,
} from './commands'
import type { RateStore } from './limits'
import { memoryStore } from './store.testkit'

const T0 = 1_800_000_000_000
const ALICE = 'user-alice'
const BOB = 'user-bob'
const ALERT = { seq: 1, type: 'incident', incidentId: 'initial_alert', at: T0 }

async function newSimulation(store: GameStore & RateStore, owner = ALICE, now = T0) {
  const result = await createSoloSimulation(store, owner, { commandId: `create-${owner}-0001` }, now)
  if (!result.ok) throw new Error(`setup failed: ${result.code}`)
  return result.data.simulationId
}

function expectContiguous(log: GameEvent[]) {
  expect(log.map((e) => e.seq).sort((a, b) => a - b)).toEqual(log.map((_, i) => i + 1))
}

/** Everything a player did; the scheduled incidents are left out. */
function playerEvents(log: GameEvent[]) {
  return log.filter((e) => e.type !== 'incident')
}

let commandCounter = 0
const nextCommandId = () => `cmd-${String(++commandCounter).padStart(8, '0')}`

/** Play one of the engine's named strategies through the command layer. */
async function playThroughCommands(store: GameStore, simulationId: string, name: keyof typeof STRATEGIES) {
  for (const [seconds, verb, actionId] of STRATEGIES[name]) {
    const command = verb === 'start' ? executeAction : requestApproval
    const result = await command(store, ALICE, { simulationId, actionId, commandId: nextCommandId() }, T0 + seconds * 1000)
    if (!result.ok) throw new Error(`${verb} ${actionId} at ${seconds}s refused: ${result.code}`)
  }
}

describe('createSoloSimulation', () => {
  it('starts the simulation at the server time it was given', async () => {
    const { store } = memoryStore()
    const result = await createSoloSimulation(store, ALICE, { commandId: 'create-0000001' }, T0)
    expect(result).toMatchObject({ ok: true, data: { startedAt: T0, deadlineAt: T0 + 480_000, replayed: false } })
  })

  it('stamps the simulation with the current rules version, whatever the client sends', async () => {
    const { store } = memoryStore()
    const result = await createSoloSimulation(store, ALICE, { commandId: 'create-0000001', rulesVersion: 1 } as never, T0)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.rulesVersion).toBe(RULES_VERSION)
    expect((await store.getSimulation(result.data.simulationId))?.rulesVersion).toBe(RULES_VERSION)
  })

  it('ignores any client-supplied start time, owner or metrics', async () => {
    const { store } = memoryStore()
    const hostile = { commandId: 'create-0000001', startedAt: 1, deadlineAt: 9e15, ownerId: BOB, evidence: 100 }
    const result = await createSoloSimulation(store, ALICE, hostile, T0)
    if (!result.ok) throw new Error('expected ok')
    const stored = await store.getSimulation(result.data.simulationId)
    expect(stored).toMatchObject({ ownerId: ALICE, startedAt: T0, deadlineAt: T0 + 480_000 })
  })

  it('is idempotent: a retry returns the same simulation and the original start time', async () => {
    const { store } = memoryStore()
    const first = await createSoloSimulation(store, ALICE, { commandId: 'create-0000001' }, T0)
    const retry = await createSoloSimulation(store, ALICE, { commandId: 'create-0000001' }, T0 + 5000)
    if (!first.ok || !retry.ok) throw new Error('expected ok')
    expect(retry.data.simulationId).toBe(first.data.simulationId)
    expect(retry.data.startedAt).toBe(T0)
    expect(retry.data.replayed).toBe(true)
  })

  it('concurrent retries of one create produce one simulation', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { store } = memoryStore(seed)
      const results = await Promise.all(
        Array.from({ length: 6 }, () => createSoloSimulation(store, ALICE, { commandId: 'create-0000001' }, T0)),
      )
      const ids = new Set(results.map((r) => (r.ok ? r.data.simulationId : 'failed')))
      expect(ids.size).toBe(1)
      expect(ids.has('failed')).toBe(false)
    }
  })

  it('rejects a missing or malformed command id', async () => {
    const { store } = memoryStore()
    for (const commandId of [undefined, '', 'short', 'has spaces in it', 'x'.repeat(65), 12345678]) {
      expect(await createSoloSimulation(store, ALICE, { commandId }, T0)).toMatchObject({ ok: false, code: 'invalid_request' })
    }
  })
})

describe('executeAction — success path', () => {
  it('records the initial alert, then starts the action at server time with exactly one event', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const result = await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 3000)
    expect(result).toMatchObject({
      ok: true,
      data: { startedAt: T0 + 3000, completesAt: T0 + 18_000, seq: 2, replayed: false, result: null },
    })
    const log = events.get(simulationId)!
    expect(log[0]).toMatchObject(ALERT)
    expect(log[0].finding).toMatch(/Sign-in failures/)
    expect(log.slice(1)).toEqual([
      { seq: 2, type: 'action_started', actionId: 'inspect_access_logs', at: T0 + 3000, actorId: ALICE, commandId: 'cmd-00000001' },
    ])
  })

  it('ignores client-supplied timestamps, roles and state', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const hostile = {
      simulationId,
      actionId: 'inspect_access_logs',
      commandId: 'cmd-00000001',
      at: 1,
      startedAt: 1,
      role: 'commander',
      roles: ['commander'],
      evidence: 100,
      type: 'action_completed',
      finding: 'forged',
    }
    await executeAction(store, ALICE, hostile, T0 + 3000)
    const log = playerEvents(events.get(simulationId)!)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ type: 'action_started', at: T0 + 3000, actorId: ALICE })
    expect(log[0].finding).toBeUndefined()
    expect(reduce(T0, events.get(simulationId)!).metrics.evidence).toBe(10)
  })
})

describe('executeAction — authorization and validation', () => {
  it('refuses a non-member and writes nothing', async () => {
    const { store, events, stats } = memoryStore()
    const simulationId = await newSimulation(store)
    const result = await executeAction(store, BOB, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    expect(result).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await requestApproval(store, BOB, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000002' }, T0 + 1000)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(events.get(simulationId)).toEqual([])
    expect(stats.appendAttempts).toBe(0)
  })

  it('answers a missing simulation exactly like a foreign one', async () => {
    const { store } = memoryStore()
    const simulationId = await newSimulation(store)
    const foreign = await executeAction(store, BOB, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0)
    const missing = await executeAction(store, BOB, { simulationId: 'sim-does-not-exist', actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0)
    expect(missing).toEqual(foreign)
  })

  it('refuses an empty caller identity', async () => {
    const { store } = memoryStore()
    const simulationId = await newSimulation(store)
    expect(
      await executeAction(store, '', { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0),
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('refuses unknown actions and malformed requests; nothing a player did is recorded', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    expect(await executeAction(store, ALICE, { simulationId, actionId: 'rotate_keys', commandId: 'cmd-00000001' }, T0)).toMatchObject({ ok: false, code: 'unknown_action' })
    expect(await executeAction(store, ALICE, { simulationId, actionId: 'constructor', commandId: 'cmd-00000002' }, T0)).toMatchObject({ ok: false, code: 'unknown_action' })
    expect(await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs' }, T0)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(await executeAction(store, ALICE, { simulationId, actionId: 42, commandId: 'cmd-00000003' }, T0)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(await executeAction(store, ALICE, { simulationId: { $ne: '' }, actionId: 'inspect_access_logs', commandId: 'cmd-00000004' }, T0)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(playerEvents(events.get(simulationId)!)).toEqual([])
  })

  it('refuses actions whose prerequisites or approval are missing, with the engine’s reason', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const attempt = (actionId: string) => executeAction(store, ALICE, { simulationId, actionId, commandId: nextCommandId() }, T0 + 1000)
    expect(await attempt('correlate_session_events')).toMatchObject({ ok: false, code: 'prerequisite_missing' })
    expect(await attempt('restore_auth')).toMatchObject({ ok: false, code: 'prerequisite_missing' })
    expect(await attempt('confirm_resolution')).toMatchObject({ ok: false, code: 'prerequisite_missing' })
    expect(await attempt('roll_back_release')).toMatchObject({ ok: false, code: 'approval_required' })
    expect(playerEvents(events.get(simulationId)!)).toEqual([])
  })

  it('refuses commands at or after the deadline; only the schedule is written', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const params = { simulationId, actionId: 'inspect_access_logs' }
    expect(await executeAction(store, ALICE, { ...params, commandId: 'cmd-00000003' }, T0 + 479_999)).toMatchObject({ ok: true })
    expect(await executeAction(store, ALICE, { simulationId, actionId: 'review_deployment', commandId: 'cmd-00000001' }, T0 + 480_000)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await executeAction(store, ALICE, { simulationId, actionId: 'review_deployment', commandId: 'cmd-00000002' }, T0 + 999_999)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000004' }, T0 + 480_000)).toMatchObject({ ok: false, code: 'simulation_ended' })
    const log = events.get(simulationId)!
    expect(playerEvents(log)).toHaveLength(1)
    expect(log[log.length - 1]).toMatchObject({ type: 'incident', incidentId: 'finalization', at: T0 + 480_000 })
  })
})

describe('executeAction — duplicates', () => {
  it('the same command twice applies once and reports the original result', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const params = { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }
    const first = await executeAction(store, ALICE, params, T0 + 1000)
    const again = await executeAction(store, ALICE, params, T0 + 4000)
    if (!first.ok || !again.ok) throw new Error('expected ok')
    expect(again.data).toMatchObject({ startedAt: T0 + 1000, completesAt: T0 + 16_000, seq: 2, replayed: true })
    expect(playerEvents(events.get(simulationId)!)).toHaveLength(1)
  })

  it('a replay after completion still succeeds and adds nothing', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const params = { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }
    await executeAction(store, ALICE, params, T0 + 1000)
    await syncSimulation(store, ALICE, { simulationId }, T0 + 20_000)
    expect(await executeAction(store, ALICE, params, T0 + 30_000)).toMatchObject({ ok: true, data: { replayed: true, startedAt: T0 + 1000 } })
    expect(playerEvents(events.get(simulationId)!)).toHaveLength(2)
  })

  it('a different command for an action already used is refused', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    expect(
      await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000002' }, T0 + 2000),
    ).toMatchObject({ ok: false, code: 'action_already_used' })
    expect(
      await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000003' }, T0 + 40_000),
    ).toMatchObject({ ok: false, code: 'action_already_used' })
    expect(events.get(simulationId)!.filter((e) => e.type === 'action_started')).toHaveLength(1)
  })

  it('a command id cannot be reused for a different action or a different kind of command', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    expect(
      await executeAction(store, ALICE, { simulationId, actionId: 'review_deployment', commandId: 'cmd-00000001' }, T0 + 2000),
    ).toMatchObject({ ok: false, code: 'command_id_reused' })
    expect(
      await requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000001' }, T0 + 2000),
    ).toMatchObject({ ok: false, code: 'command_id_reused' })
    await requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000002' }, T0 + 3000)
    expect(
      await executeAction(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000002' }, T0 + 9000),
    ).toMatchObject({ ok: false, code: 'command_id_reused' })
    expect(playerEvents(events.get(simulationId)!)).toHaveLength(2)
  })
})

describe('requestApproval (solo)', () => {
  it('records the approval in one event; the action can start five seconds later, not before', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const approval = await requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000001' }, T0 + 2000)
    expect(approval).toMatchObject({ ok: true, data: { status: 'approved', effectiveAt: T0 + 7000, seq: 2, replayed: false } })
    expect(playerEvents(events.get(simulationId)!)).toEqual([
      { seq: 2, type: 'approval_auto_granted', actionId: 'roll_back_release', at: T0 + 2000, actorId: ALICE, commandId: 'cmd-00000001' },
    ])
    const start = (commandId: string, now: number) => executeAction(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId }, now)
    expect(await start('cmd-00000002', T0 + 6999)).toMatchObject({ ok: false, code: 'approval_pending' })
    expect(await start('cmd-00000003', T0 + 7000)).toMatchObject({ ok: true, data: { startedAt: T0 + 7000 } })
  })

  it('is idempotent per command id and refuses a second, different request', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const params = { simulationId, actionId: 'roll_back_release', commandId: 'cmd-00000001' }
    const first = await requestApproval(store, ALICE, params, T0 + 2000)
    const again = await requestApproval(store, ALICE, params, T0 + 4000)
    if (!first.ok || !again.ok) throw new Error('expected ok')
    expect(again.data).toMatchObject({ effectiveAt: T0 + 7000, seq: 2, replayed: true })
    expect(await requestApproval(store, ALICE, { ...params, commandId: 'cmd-00000002' }, T0 + 5000)).toMatchObject({ ok: false, code: 'approval_already_granted' })
    expect(playerEvents(events.get(simulationId)!)).toHaveLength(1)
  })

  it('refuses what the engine refuses', async () => {
    const { store } = memoryStore()
    const simulationId = await newSimulation(store)
    const ask = (actionId: unknown) => requestApproval(store, ALICE, { simulationId, actionId, commandId: nextCommandId() }, T0 + 1000)
    expect(await ask('revoke_admin_sessions')).toMatchObject({ ok: false, code: 'prerequisite_missing' })
    expect(await ask('inspect_access_logs')).toMatchObject({ ok: false, code: 'approval_not_needed' })
    expect(await ask('nope')).toMatchObject({ ok: false, code: 'unknown_action' })
    expect(await ask(7)).toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('concurrent requests for one approval record it once', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { store, events } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: `cmd-0000000${i}` }, T0 + 1000 + i),
        ),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      for (const r of results) if (!r.ok) expect(r.code).toBe('approval_already_granted')
      expect(playerEvents(events.get(simulationId)!)).toHaveLength(1)
      expectContiguous(events.get(simulationId)!)
    }
  })
})

describe('completion — exact time boundary', () => {
  async function startedSimulation() {
    const ctx = memoryStore()
    const simulationId = await newSimulation(ctx.store)
    await executeAction(ctx.store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    return { ...ctx, simulationId }
  }

  it('one millisecond early: nothing is completed, evidence unchanged', async () => {
    const { store, events, simulationId } = await startedSimulation()
    const result = await syncSimulation(store, ALICE, { simulationId }, T0 + 1000 + 14_999)
    expect(result).toMatchObject({ ok: true })
    expect(playerEvents(events.get(simulationId)!)).toHaveLength(1)
    expect(reduce(T0, events.get(simulationId)!).metrics.evidence).toBe(10)
  })

  it('at exactly 15 seconds: completed once, +15 evidence, finding revealed', async () => {
    const { store, events, simulationId } = await startedSimulation()
    await syncSimulation(store, ALICE, { simulationId }, T0 + 1000 + 15_000)
    const log = events.get(simulationId)!
    expect(log).toHaveLength(3)
    expect(log[2]).toMatchObject({ seq: 3, type: 'action_completed', at: T0 + 16_000, actorId: ALICE, commandId: 'cmd-00000001' })
    expect(log[2].finding).toMatch(/07:42/)
    expect(reduce(T0, log).metrics.evidence).toBe(25)
  })

  it('noticed late: stamped with the exact completion instant, not the time it was noticed', async () => {
    const { store, events, simulationId } = await startedSimulation()
    await syncSimulation(store, ALICE, { simulationId }, T0 + 200_000)
    const completion = events.get(simulationId)!.find((e) => e.type === 'action_completed')!
    expect(completion.at).toBe(T0 + 16_000)
    // And it sits before the incidents that happened after it.
    expect(events.get(simulationId)!.map((e) => e.incidentId ?? e.type)).toEqual([
      'initial_alert',
      'action_started',
      'action_completed',
      'service_degradation',
      'attacker_activity',
      'outage_spreads',
    ])
  })

  it('repeated syncs never complete it twice', async () => {
    const { store, events, simulationId } = await startedSimulation()
    for (const offset of [16_000, 16_001, 30_000, 400_000, 900_000]) {
      await syncSimulation(store, ALICE, { simulationId }, T0 + offset)
    }
    const log = events.get(simulationId)!
    expect(log.filter((e) => e.type === 'action_completed')).toHaveLength(1)
    expect(reduce(T0, log).metrics.evidence).toBe(25)
  })

  it('a non-member cannot sync or read the log, and their attempt settles nothing', async () => {
    const { store, events, simulationId } = await startedSimulation()
    expect(await syncSimulation(store, BOB, { simulationId }, T0 + 60_000)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(events.get(simulationId)).toHaveLength(2)
  })

  it('the finding is absent until the action completes', async () => {
    const { store, simulationId } = await startedSimulation()
    const early = await syncSimulation(store, ALICE, { simulationId }, T0 + 5000)
    if (!early.ok) throw new Error('expected ok')
    expect(JSON.stringify(early.data.events)).not.toMatch(/07:42/)
  })
})

describe('scheduled incidents through the command layer', () => {
  it('a simulation nobody touched is settled in full by one late sync: every incident once, then the result', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const first = await syncSimulation(store, ALICE, { simulationId }, T0 + 3_600_000)
    if (!first.ok) throw new Error('expected ok')
    expect(first.data.events.map((e) => [e.incidentId, e.at - T0])).toEqual(INCIDENTS.map((i) => [i.id, i.atMs]))
    expect(first.data.result).toMatchObject({ outcome: 'incident_escalation', score: 12, reason: 'deadline', endedAt: T0 + 480_000 })
    const again = await syncSimulation(store, ALICE, { simulationId }, T0 + 7_200_000)
    expect(again).toMatchObject({ ok: true, data: { result: { outcome: 'incident_escalation', score: 12 } } })
    expect(events.get(simulationId)).toHaveLength(INCIDENTS.length)
  })

  it('incident reports describe the branch that actually happened', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    await playThroughCommands(store, simulationId, 'revokeOnly')
    await syncSimulation(store, ALICE, { simulationId }, T0 + 480_000)
    const report = (id: string) => events.get(simulationId)!.find((e) => e.incidentId === id)!.finding
    expect(report('attacker_activity')).toMatch(/Something still has access/) // keys still exposed
    expect(report('attacker_escalation')).toMatch(/No administrator sessions are active/) // session revoked
    expect(report('token_replay')).toMatch(/being replayed/)
    expect(report('communication_gap')).toMatch(/heard nothing/)
  })

  it('no incident text is revealed before its time', async () => {
    const { store, simulationId } = await (async () => {
      const ctx = memoryStore()
      return { ...ctx, simulationId: await newSimulation(ctx.store) }
    })()
    const view = await syncSimulation(store, ALICE, { simulationId }, T0 + 59_999)
    if (!view.ok) throw new Error('expected ok')
    expect(view.data.events.map((e) => e.incidentId)).toEqual(['initial_alert'])
    expect(JSON.stringify(view.data)).not.toMatch(/replayed|signing|administrator session/i)
    expect(view.data.result).toBeNull()
  })

  it('many syncs racing over a long-overdue simulation write each event exactly once', async () => {
    let conflictsSeen = 0
    for (let seed = 1; seed <= 20; seed++) {
      const { store, events, stats } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
      const results = await Promise.all(
        Array.from({ length: 6 }, () => syncSimulation(store, ALICE, { simulationId }, T0 + 500_000)),
      )
      const log = events.get(simulationId)!
      expectContiguous(log)
      expect(log).toHaveLength(INCIDENTS.length + 2)
      for (const r of results) {
        expect(r).toMatchObject({ ok: true, data: { result: { outcome: 'incident_escalation' } } })
        if (r.ok) expect(r.data.events).toHaveLength(log.length)
      }
      conflictsSeen += stats.appendConflicts
    }
    expect(conflictsSeen).toBeGreaterThan(0)
  })
})

describe('full runs through the command layer', () => {
  const runs: [keyof typeof STRATEGIES, string, number][] = [
    ['optimal', 'complete_recovery', 100],
    ['unvalidated', 'costly_recovery', 82],
    ['slowAndSilent', 'costly_recovery', 95],
    ['revokeOnly', 'partial_containment', 32],
    ['containedNotRestored', 'partial_containment', 53],
    ['decoyOnly', 'incident_escalation', 16],
    ['analysisParalysis', 'incident_escalation', 22],
    ['doNothing', 'incident_escalation', 12],
  ]

  for (const [name, outcome, score] of runs) {
    it(`"${name}" ends in ${outcome} (${score}) and stores the same log the engine predicts`, async () => {
      const { store, events } = memoryStore()
      const simulationId = await newSimulation(store)
      await playThroughCommands(store, simulationId, name)
      const final = await syncSimulation(store, ALICE, { simulationId }, T0 + 600_000)
      expect(final).toMatchObject({ ok: true, data: { result: { outcome, score } } })

      const predicted = script(createPlay(T0), STRATEGIES[name])
      predicted.finish()
      const shape = (log: GameEvent[]) => log.map((e) => [e.seq, e.type, e.actionId ?? e.incidentId, e.at])
      expect(shape(events.get(simulationId)!)).toEqual(shape(predicted.log))
      expect(finalResult(reduce(T0, events.get(simulationId)!))).toEqual(finalResult(predicted.state))
    })
  }

  it('confirming resolution ends the run immediately and returns the result; nothing further is accepted', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    const steps = STRATEGIES.optimal
    await playThroughCommands(store, simulationId, 'optimal')
    const length = events.get(simulationId)!.length
    const last = events.get(simulationId)![length - 1]
    expect(last).toMatchObject({ type: 'action_completed', actionId: 'confirm_resolution', at: T0 + 155_000, actorId: ALICE })

    // Replaying the confirming command reports the same result.
    const replay = await executeAction(store, ALICE, { simulationId, actionId: 'confirm_resolution', commandId: last.commandId }, T0 + 200_000)
    expect(replay).toMatchObject({ ok: true, data: { replayed: true, result: { outcome: 'complete_recovery', score: 100, reason: 'confirmed' } } })

    expect(await executeAction(store, ALICE, { simulationId, actionId: 'validate_containment', commandId: nextCommandId() }, T0 + 160_000)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await syncSimulation(store, ALICE, { simulationId }, T0 + 900_000)).toMatchObject({ ok: true, data: { result: { outcome: 'complete_recovery' } } })
    expect(events.get(simulationId)).toHaveLength(length) // no incidents after the end
    expect(steps[steps.length - 1][2]).toBe('confirm_resolution')
  })

  it('every completed action carries a finding; findings appear only on completions and incidents', async () => {
    const { store, events } = memoryStore()
    const simulationId = await newSimulation(store)
    await playThroughCommands(store, simulationId, 'optimal')
    for (const event of events.get(simulationId)!) {
      const revealing = event.type === 'action_completed' || event.type === 'incident'
      expect(typeof event.finding === 'string' && event.finding.length > 0).toBe(revealing)
      if (event.finding) expect(event.finding.length).toBeLessThanOrEqual(500) // the column's limit
    }
  })

  it('conditional findings follow the state: containment validation names the keys while they are still exposed', async () => {
    const finding = async (name: keyof typeof STRATEGIES, at: number) => {
      const { store, events } = memoryStore()
      const simulationId = await newSimulation(store)
      await playThroughCommands(store, simulationId, name)
      const started = await executeAction(store, ALICE, { simulationId, actionId: 'validate_containment', commandId: nextCommandId() }, T0 + at)
      expect(started).toMatchObject({ ok: true })
      await syncSimulation(store, ALICE, { simulationId }, T0 + at + 15_000)
      return events.get(simulationId)!.find((e) => e.type === 'action_completed' && e.actionId === 'validate_containment')!.finding
    }
    expect(await finding('revokeOnly', 70_000)).toMatch(/still valid/)
    expect(await finding('containedNotRestored', 100_000)).toMatch(/Containment holds/)
  })
})

describe('concurrency — no lost updates, no double application', () => {
  it('many different commands at once: exactly one starts the action', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { store, events } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: `cmd-0000000${i}` }, T0 + 1000 + i),
        ),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      for (const r of results) if (!r.ok) expect(r.code).toBe('action_already_used')
      const log = events.get(simulationId)!
      expect(playerEvents(log)).toHaveLength(1)
      expectContiguous(log)
    }
  })

  it('the same command submitted many times at once applies once and every caller succeeds', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { store, events } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000),
        ),
      )
      expect(results.every((r) => r.ok)).toBe(true)
      expect(new Set(results.map((r) => (r.ok ? r.data.seq : -1)))).toEqual(new Set([2]))
      expect(playerEvents(events.get(simulationId)!)).toHaveLength(1)
    }
  })

  it('actions of different roles submitted at once all start, each exactly once', async () => {
    const actions: ActionId[] = ['inspect_access_logs', 'review_deployment', 'issue_customer_advisory']
    for (let seed = 1; seed <= 40; seed++) {
      const { store, events } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      const results = await Promise.all(
        actions.flatMap((actionId) =>
          [0, 1].map((n) => executeAction(store, ALICE, { simulationId, actionId, commandId: `cmd-${actionId.slice(0, 6)}-000${n}` }, T0 + 1000)),
        ),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(3)
      const log = events.get(simulationId)!
      expect(log.filter((e) => e.type === 'action_started').map((e) => e.actionId).sort()).toEqual([...actions].sort())
      expectContiguous(log)
      expect(() => reduce(T0, log)).not.toThrow()
    }
  })

  it('two actions of the same role submitted at once: one starts, the other is told the role is busy', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { store, events } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      await requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: 'cmd-approve-01' }, T0)
      const results = await Promise.all(
        (['review_deployment', 'roll_back_release'] as ActionId[]).map((actionId, i) =>
          executeAction(store, ALICE, { simulationId, actionId, commandId: `cmd-infra-000${i}` }, T0 + 6000),
        ),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.find((r) => !r.ok)).toMatchObject({ code: 'role_busy' })
      expect(events.get(simulationId)!.filter((e) => e.type === 'action_started')).toHaveLength(1)
    }
  })

  it('many syncs at the completion instant: completed exactly once', async () => {
    let conflictsSeen = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { store, events, stats } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
      const results = await Promise.all(
        Array.from({ length: 8 }, () => syncSimulation(store, ALICE, { simulationId }, T0 + 16_000)),
      )
      expect(results.every((r) => r.ok)).toBe(true)
      const log = events.get(simulationId)!
      expect(log.filter((e) => e.type === 'action_completed')).toHaveLength(1)
      expectContiguous(log)
      expect(reduce(T0, log).metrics.evidence).toBe(25)
      conflictsSeen += stats.appendConflicts
    }
    // The interleaving must actually have produced write races, or this test proves nothing.
    expect(conflictsSeen).toBeGreaterThan(0)
  })

  it('every caller sees the completed log, including the ones that lost the race', async () => {
    const { store } = memoryStore(7)
    const simulationId = await newSimulation(store)
    await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => syncSimulation(store, ALICE, { simulationId }, T0 + 16_000)),
    )
    for (const r of results) {
      if (!r.ok) throw new Error('expected ok')
      expect(r.data.events.map((e) => e.type)).toEqual(['incident', 'action_started', 'action_completed'])
    }
  })

  it('two confirmations at once end the run once', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { store, events } = memoryStore(seed)
      const simulationId = await newSimulation(store)
      for (const [seconds, verb, actionId] of STRATEGIES.optimal.slice(0, -1)) {
        const command = verb === 'start' ? executeAction : requestApproval
        await command(store, ALICE, { simulationId, actionId, commandId: nextCommandId() }, T0 + seconds * 1000)
      }
      const results = await Promise.all(
        [0, 1, 2].map((n) => executeAction(store, ALICE, { simulationId, actionId: 'confirm_resolution', commandId: `cmd-confirm-000${n}` }, T0 + 155_000 + n)),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      for (const r of results) if (!r.ok) expect(r.code).toBe('simulation_ended')
      expect(events.get(simulationId)!.filter((e) => e.actionId === 'confirm_resolution')).toHaveLength(1)
    }
  })

  it('two simulations never share or leak events', async () => {
    const { store, events } = memoryStore()
    const a = await newSimulation(store, ALICE)
    const b = await newSimulation(store, BOB)
    await executeAction(store, ALICE, { simulationId: a, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    expect(events.get(b)).toEqual([])
    const view = await syncSimulation(store, BOB, { simulationId: b }, T0 + 30_000)
    if (!view.ok) throw new Error('expected ok')
    expect(view.data.events.map((e) => e.incidentId ?? e.type)).toEqual(['initial_alert'])
    expect(JSON.stringify(view.data)).not.toContain('07:42')
  })
})

describe('rules version: simulations recorded under other rules', () => {
  /**
   * A simulation as an earlier build left it: a complete, internally valid
   * log, on a row with no rules version (or a different one).
   */
  async function legacySimulation(rulesVersion: number | null) {
    const ctx = memoryStore()
    const simulationId = await newSimulation(ctx.store)
    await playThroughCommands(ctx.store, simulationId, 'optimal')
    const stored = ctx.simulations.get(simulationId)!
    ctx.simulations.set(simulationId, { ...stored, rulesVersion })
    const before = structuredClone(ctx.events.get(simulationId)!)
    ctx.stats.appendAttempts = 0
    return { ...ctx, simulationId, before }
  }

  for (const version of [null, 1, RULES_VERSION + 1]) {
    it(`a simulation with rules version ${version} is refused by every command, and its log is neither read out nor extended`, async () => {
      const { store, events, stats, simulationId, before } = await legacySimulation(version)
      const refusal = { ok: false, code: 'rules_version_unsupported' }

      const synced = await syncSimulation(store, ALICE, { simulationId }, T0 + 600_000)
      expect(synced).toMatchObject(refusal)
      // No events, no result, no score: nothing is replayed under these rules.
      expect(synced).not.toHaveProperty('data')
      expect(await executeAction(store, ALICE, { simulationId, actionId: 'validate_containment', commandId: nextCommandId() }, T0 + 100_000)).toMatchObject(refusal)
      expect(await requestApproval(store, ALICE, { simulationId, actionId: 'roll_back_release', commandId: nextCommandId() }, T0 + 100_000)).toMatchObject(refusal)
      // Even a replay of a command that simulation once accepted.
      const confirm = before[before.length - 1]
      expect(await executeAction(store, ALICE, { simulationId, actionId: 'confirm_resolution', commandId: confirm.commandId }, T0 + 200_000)).toMatchObject(refusal)

      expect(events.get(simulationId)).toEqual(before)
      expect(stats.appendAttempts).toBe(0)
    })
  }

  it('an unfinished legacy simulation is not settled: no incident or completion is written to it', async () => {
    const { store, events, stats, simulations } = memoryStore()
    const simulationId = await newSimulation(store)
    await executeAction(store, ALICE, { simulationId, actionId: 'inspect_access_logs', commandId: 'cmd-00000001' }, T0 + 1000)
    simulations.set(simulationId, { ...simulations.get(simulationId)!, rulesVersion: null })
    const before = structuredClone(events.get(simulationId)!)
    stats.appendAttempts = 0
    expect(await syncSimulation(store, ALICE, { simulationId }, T0 + 900_000)).toMatchObject({ ok: false, code: 'rules_version_unsupported' })
    expect(events.get(simulationId)).toEqual(before)
    expect(stats.appendAttempts).toBe(0)
  })

  it('the refusal tells a stranger nothing: a foreign legacy simulation is still just forbidden', async () => {
    const { store, simulationId } = await legacySimulation(null)
    const foreign = await syncSimulation(store, BOB, { simulationId }, T0 + 600_000)
    const missing = await syncSimulation(store, BOB, { simulationId: 'sim-does-not-exist' }, T0 + 600_000)
    expect(foreign).toMatchObject({ ok: false, code: 'forbidden' })
    expect(foreign).toEqual(missing)
  })

  it('a current simulation next to a legacy one is unaffected', async () => {
    const { store, simulations } = memoryStore()
    const legacy = await newSimulation(store)
    simulations.set(legacy, { ...simulations.get(legacy)!, rulesVersion: null })
    const fresh = await createSoloSimulation(store, ALICE, { commandId: 'create-fresh-0001' }, T0)
    if (!fresh.ok) throw new Error('expected ok')
    expect(await syncSimulation(store, ALICE, { simulationId: fresh.data.simulationId }, T0 + 1000)).toMatchObject({
      ok: true,
      data: { rulesVersion: RULES_VERSION },
    })
    expect(await syncSimulation(store, ALICE, { simulationId: legacy }, T0 + 1000)).toMatchObject({ ok: false, code: 'rules_version_unsupported' })
  })

  it('retrying the create command of a legacy simulation returns it, marked with its (missing) version, and creates nothing', async () => {
    const { store, simulations } = memoryStore()
    const legacy = await newSimulation(store)
    simulations.set(legacy, { ...simulations.get(legacy)!, rulesVersion: null })
    const retry = await createSoloSimulation(store, ALICE, { commandId: `create-${ALICE}-0001` }, T0 + 5000)
    expect(retry).toMatchObject({ ok: true, data: { simulationId: legacy, rulesVersion: null, replayed: true } })
    expect(simulations.size).toBe(1)
  })
})
