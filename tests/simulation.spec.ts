/**
 * Solo simulation against the real local worker and Durable Object.
 *
 * These run on real time — an action takes its real seconds — so exact
 * millisecond boundaries and the full rule set are proven in the unit tests
 * with an injected clock (src/game/engine.test.ts,
 * src/server/game/commands.test.ts). Here boundaries are checked as
 * invariants on server responses, and one complete run is played for real.
 *
 * The eight-minute deadline tests only run with BLACKOUT_SLOW=1.
 *
 * Needs two test accounts:
 *   npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)

/** The app's record room, `app:<DEEPSPACE_APP_ID>`, read from wrangler.toml. */
const APP_ID = /DEEPSPACE_APP_ID\s*=\s*"(app_[A-Z0-9]+)"/.exec(
  readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8'),
)?.[1]
const SCOPE_ID = `app:${APP_ID}`

const ACTION = 'inspect_access_logs'
const DURATION_MS = 15_000

interface ActionBody<T> {
  success: boolean
  data?: T
  error?: string
  code?: string
}
interface EventView {
  seq: number
  type: string
  actionId?: string
  incidentId?: string
  at: number
  actorId: string
  commandId: string
  finding?: string
}
interface SyncData {
  serverNow: number
  startedAt: number
  deadlineAt: number
  rulesVersion: number
  events: EventView[]
  result: { outcome: string; score: number; reason: string; endedAt: number } | null
}
interface ExecuteData {
  startedAt: number
  completesAt: number
  seq: number
  serverNow: number
  replayed: boolean
}

const commandId = () => crypto.randomUUID()

/** What the player did: the log without the scheduled incidents. */
const playerEvents = (events: EventView[]) => events.filter((e) => e.type !== 'incident')
/** The log is always contiguous from 1 and opens with the initial alert. */
function expectWellFormed(events: EventView[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  expect(events[0]).toMatchObject({ type: 'incident', incidentId: 'initial_alert' })
}

/** The signed-in page's bearer token, the same way the SDK client obtains it. */
async function tokenFor(page: Page): Promise<string> {
  await page.goto('/home')
  const token = await page.evaluate(async () => {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    return res.ok ? ((await res.json()) as { token?: string }).token ?? null : null
  })
  if (!token) throw new Error('Could not obtain an auth token for the test account')
  return token
}

function api(page: Page, token: string) {
  return async <T>(name: string, data: Record<string, unknown>): Promise<ActionBody<T>> => {
    const res = await page.request.post(`/api/actions/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
      data,
    })
    expect(res.status()).toBe(200)
    return (await res.json()) as ActionBody<T>
  }
}

async function createSimulation(call: ReturnType<typeof api>): Promise<string> {
  const created = await call<{ simulationId: string }>('createSoloSimulation', { commandId: commandId() })
  expect(created.success).toBe(true)
  return created.data!.simulationId
}

test.describe('unauthenticated callers', () => {
  for (const name of ['createSoloSimulation', 'executeAction', 'syncSimulation']) {
    test(`${name} without a token is 401`, async ({ request }) => {
      const res = await request.post(`/api/actions/${name}`, {
        data: { simulationId: 'whatever-id', actionId: ACTION, commandId: commandId() },
      })
      expect(res.status()).toBe(401)
    })

    test(`${name} with a forged token is 401`, async ({ request }) => {
      const res = await request.post(`/api/actions/${name}`, {
        headers: { Authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.' },
        data: { simulationId: 'whatever-id', actionId: ACTION, commandId: commandId() },
      })
      expect(res.status()).toBe(401)
    })
  }
})

test('golden path: create, run the action, server completes it after 15s, refresh restores it', async ({ users }) => {
  test.setTimeout(90_000)
  const [alice] = await users(1)
  const { page } = alice

  await page.goto('/simulation')
  await page.getByTestId('create-simulation').click()
  await expect(page.getByTestId('simulation-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('metric-evidence')).toHaveText('10')
  await expect(page.getByTestId('metric-health')).toHaveText('82')
  await expect(page.getByTestId('time-remaining')).toHaveText(/^0[67]:\d\d$/)

  await page.getByTestId(`action-${ACTION}`).click()
  // The started event arrives over the realtime connection; no reload.
  await expect(page.getByTestId('event-action_started')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText(/In progress/)
  await expect(page.getByTestId(`action-${ACTION}`)).toBeDisabled()
  // Starting awards nothing.
  await expect(page.getByTestId('metric-evidence')).toHaveText('10')
  await expect(page.getByTestId('event-action_completed')).toHaveCount(0)

  // Completion is decided and recorded by the server, then pushed.
  await expect(page.getByTestId('metric-evidence')).toHaveText('25', { timeout: 30_000 })
  await expect(page.getByTestId('event-action_completed')).toHaveCount(1)
  await expect(page.getByTestId('event-action_completed')).toContainText('07:42')
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText('Completed')

  // The server's own record: one start, one completion, exactly 15s apart.
  const simulationId = new URL(page.url()).searchParams.get('id')!
  const call = api(page, await tokenFor(page))
  const synced = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(synced.data!.events)
  const acted = playerEvents(synced.data!.events)
  expect(acted.map((e) => e.type)).toEqual(['action_started', 'action_completed'])
  expect(acted[1].at - acted[0].at).toBe(DURATION_MS)

  // Refresh: state comes back from storage, not from the page.
  await page.goto(`/simulation?id=${simulationId}`)
  await expect(page.getByTestId('metric-evidence')).toHaveText('25', { timeout: 15_000 })
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText('Completed')
  await expect(page.getByTestId('event-action_started')).toHaveCount(1)
  await expect(page.getByTestId('event-action_completed')).toHaveCount(1)
  await expect(page.getByTestId('event-incident').first()).toContainText('Sign-in failures')
  await expect(page.getByTestId(`action-${ACTION}`)).toBeDisabled()
})

test('refresh mid-action restores the in-progress state and it still completes once', async ({ users }) => {
  test.setTimeout(90_000)
  const [alice] = await users(1)
  const { page } = alice
  const call = api(page, await tokenFor(page))
  const simulationId = await createSimulation(call)

  await page.goto(`/simulation?id=${simulationId}`)
  await page.getByTestId(`action-${ACTION}`).click()
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText(/In progress/, { timeout: 10_000 })

  await page.reload()
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText(/In progress|Finishing/, { timeout: 15_000 })
  await expect(page.getByTestId('metric-evidence')).toHaveText('10')

  await expect(page.getByTestId('metric-evidence')).toHaveText('25', { timeout: 30_000 })
  const synced = await call<SyncData>('syncSimulation', { simulationId })
  expect(synced.data!.events.filter((e) => e.type === 'action_completed')).toHaveLength(1)
})

test('a non-member cannot command, sync, or read another player\'s simulation', async ({ users }) => {
  test.setTimeout(60_000)
  const [alice, bob] = await users(2)
  const asAlice = api(alice.page, await tokenFor(alice.page))
  const asBob = api(bob.page, await tokenFor(bob.page))
  const simulationId = await createSimulation(asAlice)

  const execute = await asBob<ExecuteData>('executeAction', { simulationId, actionId: ACTION, commandId: commandId() })
  expect(execute).toMatchObject({ success: false, code: 'forbidden' })
  const sync = await asBob<SyncData>('syncSimulation', { simulationId })
  expect(sync).toMatchObject({ success: false, code: 'forbidden' })

  // A missing simulation is indistinguishable from someone else's.
  const missing = await asBob<ExecuteData>('executeAction', {
    simulationId: 'does-not-exist-000',
    actionId: ACTION,
    commandId: commandId(),
  })
  expect(missing.code).toBe(execute.code)
  expect(missing.error).toBe(execute.error)

  const approval = await asBob<unknown>('requestApproval', { simulationId, actionId: 'roll_back_release', commandId: commandId() })
  expect(approval).toMatchObject({ success: false, code: 'forbidden' })

  // Nothing was written by Bob's attempts.
  const view = await asAlice<SyncData>('syncSimulation', { simulationId })
  expect(playerEvents(view.data!.events)).toEqual([])

  // Alice starts the action; Bob's realtime connection must not receive it.
  await asAlice<ExecuteData>('executeAction', { simulationId, actionId: ACTION, commandId: commandId() })
  await bob.page.goto(`/simulation?id=${simulationId}`)
  await expect(bob.page.getByTestId('simulation-missing')).toBeVisible({ timeout: 15_000 })
  await expect(bob.page.getByTestId('simulation-view')).toHaveCount(0)
  await bob.page.goto('/simulation')
  await expect(bob.page.getByTestId('create-simulation')).toBeVisible({ timeout: 15_000 })
  await expect(bob.page.getByTestId('simulation-list').locator('li')).toHaveCount(0)

  // And Alice does see it.
  await alice.page.goto(`/simulation?id=${simulationId}`)
  await expect(alice.page.getByTestId('event-action_started')).toBeVisible({ timeout: 15_000 })
})

test('client-supplied time, role, metrics and state are ignored', async ({ users }) => {
  const [alice] = await users(1)
  const call = api(alice.page, await tokenFor(alice.page))

  const created = await call<{ simulationId: string; startedAt: number; deadlineAt: number; serverNow: number }>(
    'createSoloSimulation',
    { commandId: commandId(), startedAt: 1, deadlineAt: 9e15, ownerId: 'someone-else', evidence: 100 },
  )
  expect(created.success).toBe(true)
  expect(created.data!.startedAt).toBe(created.data!.serverNow)
  expect(Math.abs(created.data!.startedAt - Date.now())).toBeLessThan(60_000)
  expect(created.data!.deadlineAt - created.data!.startedAt).toBe(480_000)

  const simulationId = created.data!.simulationId
  const executed = await call<ExecuteData>('executeAction', {
    simulationId,
    actionId: ACTION,
    commandId: commandId(),
    at: 1,
    startedAt: 1,
    completesAt: 2,
    role: 'commander',
    type: 'action_completed',
    evidence: 100,
  })
  expect(executed.success).toBe(true)
  expect(executed.data!.startedAt).toBeGreaterThanOrEqual(created.data!.startedAt)
  expect(executed.data!.completesAt - executed.data!.startedAt).toBe(DURATION_MS)

  const view = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(view.data!.events)
  expect(playerEvents(view.data!.events)).toHaveLength(1)
  expect(playerEvents(view.data!.events)[0]).toMatchObject({ type: 'action_started', at: executed.data!.startedAt })
  expect(JSON.stringify(view.data)).not.toContain('07:42')
})

test('clients cannot write game records directly over the realtime connection', async ({ users }) => {
  const [alice] = await users(1)
  const { page } = alice
  const token = await tokenFor(page)
  const call = api(page, token)
  const simulationId = await createSimulation(call)

  // Speak the record protocol by hand as a signed-in member (same message the
  // SDK client sends for a confirmed write) and try to forge a completion.
  const replies = await page.evaluate(
    async ({ token, scope, simulationId }) =>
      await new Promise<string[]>((resolve) => {
        const messages: string[] = []
        const url = new URL('/ws/' + encodeURIComponent(scope), location.origin.replace(/^http/, 'ws'))
        url.searchParams.set('token', token)
        const socket = new WebSocket(url)
        const finish = () => {
          socket.close()
          resolve(messages)
        }
        socket.onmessage = (m) => messages.push(typeof m.data === 'string' ? m.data : '[binary]')
        socket.onerror = finish
        socket.onopen = () => {
          for (const collection of ['simulation_events', 'simulations']) {
            socket.send(
              JSON.stringify({
                type: 'core.put',
                payload: {
                  collection,
                  recordId: crypto.randomUUID(),
                  requestId: crypto.randomUUID(),
                  data: {
                    simulationId,
                    seq: 1,
                    ownerId: 'forged',
                    type: 'action_completed',
                    actionId: 'inspect_access_logs',
                    at: 1,
                    createCommandId: 'forged-command-1',
                    mode: 'solo',
                    scenarioId: 'operation-nightfall',
                    startedAt: 1,
                    deadlineAt: 9e15,
                  },
                },
              }),
            )
          }
          setTimeout(finish, 3000)
        }
      }),
    { token, scope: SCOPE_ID, simulationId },
  )

  // The room must refuse both writes explicitly…
  const denials = replies.filter((m) => m.includes('CREATE DENIED'))
  expect(denials.map((m) => (m.includes('simulation_events') ? 'simulation_events' : 'simulations')).sort()).toEqual([
    'simulation_events',
    'simulations',
  ])
  // …and the authoritative log must be untouched.
  const view = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(view.data!.events)
  expect(playerEvents(view.data!.events)).toEqual([])
})

test('duplicate command: applied once, every submission gets the original result', async ({ users }) => {
  const [alice] = await users(1)
  const call = api(alice.page, await tokenFor(alice.page))
  const simulationId = await createSimulation(call)
  const params = { simulationId, actionId: ACTION, commandId: commandId() }

  const first = await call<ExecuteData>('executeAction', params)
  // Sequence 1 is the initial alert; the action is the second event.
  expect(first).toMatchObject({ success: true, data: { seq: 2, replayed: false } })

  const second = await call<ExecuteData>('executeAction', params)
  expect(second).toMatchObject({ success: true, data: { seq: 2, replayed: true, startedAt: first.data!.startedAt } })

  const burst = await Promise.all(Array.from({ length: 6 }, () => call<ExecuteData>('executeAction', params)))
  for (const r of burst) {
    expect(r).toMatchObject({ success: true, data: { seq: 2, startedAt: first.data!.startedAt } })
  }

  const view = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(view.data!.events)
  expect(playerEvents(view.data!.events)).toHaveLength(1)

  // The same command id for a different simulation's create is also single-use.
  const createId = commandId()
  const creates = await Promise.all(
    Array.from({ length: 5 }, () => call<{ simulationId: string }>('createSoloSimulation', { commandId: createId })),
  )
  expect(new Set(creates.map((c) => c.data?.simulationId)).size).toBe(1)
})

test('concurrent submissions: exactly one starts the action, nothing is lost or doubled', async ({ users }) => {
  test.setTimeout(90_000)
  const [alice] = await users(1)
  const call = api(alice.page, await tokenFor(alice.page))
  const simulationId = await createSimulation(call)

  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      call<ExecuteData>('executeAction', { simulationId, actionId: ACTION, commandId: commandId() }),
    ),
  )
  const winners = results.filter((r) => r.success)
  expect(winners).toHaveLength(1)
  for (const loser of results.filter((r) => !r.success)) expect(loser.code).toBe('action_already_used')

  const afterStart = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(afterStart.data!.events)
  expect(afterStart.data!.events.map((e) => [e.seq, e.type])).toEqual([
    [1, 'incident'],
    [2, 'action_started'],
  ])
  const startedAt = afterStart.data!.events[1].at
  const completesAt = startedAt + DURATION_MS
  expect(winners[0].data!.startedAt).toBe(startedAt)

  // Boundary invariant on every response until completion: the completion
  // event is present if and only if the server's clock had reached start+15s.
  let completedSeen = false
  for (let i = 0; i < 80 && !completedSeen; i++) {
    const view = await call<SyncData>('syncSimulation', { simulationId })
    const completed = view.data!.events.some((e) => e.type === 'action_completed')
    expect(completed).toBe(view.data!.serverNow >= completesAt)
    completedSeen = completed
    if (!completedSeen) await new Promise((r) => setTimeout(r, 250))
  }
  expect(completedSeen).toBe(true)

  // A burst of syncs after completion must not add a second completion.
  const burst = await Promise.all(Array.from({ length: 12 }, () => call<SyncData>('syncSimulation', { simulationId })))
  for (const view of burst) {
    expect(view.data!.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'incident'],
      [2, 'action_started'],
      [3, 'action_completed'],
    ])
    expect(view.data!.events[2].at).toBe(completesAt)
  }
})

test('concurrent syncs racing at the completion instant complete the action exactly once', async ({ users }) => {
  test.setTimeout(90_000)
  const [alice] = await users(1)
  const call = api(alice.page, await tokenFor(alice.page))
  const simulationId = await createSimulation(call)
  const started = await call<ExecuteData>('executeAction', { simulationId, actionId: ACTION, commandId: commandId() })
  expect(started.success).toBe(true)

  // Nobody has synced yet, so no completion exists. Wait past the boundary,
  // then let many callers discover it at the same moment.
  await new Promise((r) => setTimeout(r, DURATION_MS + 500))
  const racers = await Promise.all(Array.from({ length: 16 }, () => call<SyncData>('syncSimulation', { simulationId })))
  for (const view of racers) {
    expect(view.success).toBe(true)
    expect(view.data!.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'incident'],
      [2, 'action_started'],
      [3, 'action_completed'],
    ])
    expect(view.data!.events[2].at).toBe(started.data!.completesAt)
  }
})

test('reconnect: a tab that was offline while the action ran catches up without a reload', async ({ users }) => {
  test.setTimeout(120_000)
  const [alice] = await users(1)
  const { page } = alice
  const token = await tokenFor(page)
  const call = api(page, token)
  const simulationId = await createSimulation(call)

  await page.goto(`/simulation?id=${simulationId}`)
  await expect(page.getByTestId('simulation-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('metric-evidence')).toHaveText('10')

  // Cut the tab off, then start the action from outside it (same account,
  // server-side request that the offline emulation does not affect).
  await page.context().setOffline(true)
  const started = await call<ExecuteData>('executeAction', { simulationId, actionId: ACTION, commandId: commandId() })
  expect(started.success).toBe(true)

  // The tab really is disconnected: the started event must not reach it.
  await page.waitForTimeout(4000)
  await expect(page.getByTestId('event-action_started')).toHaveCount(0)
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText('15s')

  // Stay offline past the completion instant, so the tab misses both events.
  await page.waitForTimeout(DURATION_MS)
  await expect(page.getByTestId('metric-evidence')).toHaveText('10')

  // Back online, no reload: the tab must converge on the server's state.
  await page.context().setOffline(false)
  await expect(page.getByTestId('metric-evidence')).toHaveText('25', { timeout: 45_000 })
  await expect(page.getByTestId('event-action_started')).toHaveCount(1)
  await expect(page.getByTestId('event-action_completed')).toHaveCount(1)
  await expect(page.getByTestId(`action-status-${ACTION}`)).toHaveText('Completed')

  const view = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(view.data!.events)
  const acted = playerEvents(view.data!.events)
  expect(acted.map((e) => e.type)).toEqual(['action_started', 'action_completed'])
  expect(acted[1].at).toBe(started.data!.completesAt)
})

// ---------------------------------------------------------------------------
// Full scenario
// ---------------------------------------------------------------------------

test('rules are enforced by the server: prerequisites, approval and its five-second processing', async ({ users }) => {
  test.setTimeout(60_000)
  const [alice] = await users(1)
  const call = api(alice.page, await tokenFor(alice.page))
  const simulationId = await createSimulation(call)
  const attempt = (actionId: string) =>
    call<ExecuteData>('executeAction', { simulationId, actionId, commandId: commandId() })

  expect(await attempt('correlate_session_events')).toMatchObject({ success: false, code: 'prerequisite_missing' })
  expect(await attempt('restore_auth')).toMatchObject({ success: false, code: 'prerequisite_missing' })
  expect(await attempt('confirm_resolution')).toMatchObject({ success: false, code: 'prerequisite_missing' })
  expect(await attempt('roll_back_release')).toMatchObject({ success: false, code: 'approval_required' })
  expect(
    await call<unknown>('requestApproval', { simulationId, actionId: 'rotate_signing_keys', commandId: commandId() }),
  ).toMatchObject({ success: false, code: 'prerequisite_missing' })
  expect(
    await call<unknown>('requestApproval', { simulationId, actionId: ACTION, commandId: commandId() }),
  ).toMatchObject({ success: false, code: 'approval_not_needed' })

  const approvalId = commandId()
  const approval = await call<{ effectiveAt: number; serverNow: number; replayed: boolean }>('requestApproval', {
    simulationId,
    actionId: 'roll_back_release',
    commandId: approvalId,
  })
  expect(approval.success).toBe(true)
  expect(approval.data!.effectiveAt - approval.data!.serverNow).toBe(5000)
  // The same request again is the same approval, not a second one.
  const replay = await call<{ effectiveAt: number; replayed: boolean }>('requestApproval', {
    simulationId,
    actionId: 'roll_back_release',
    commandId: approvalId,
  })
  expect(replay).toMatchObject({ success: true, data: { replayed: true, effectiveAt: approval.data!.effectiveAt } })

  // Until the approval takes effect the server refuses; from that instant it accepts.
  let started: ActionBody<ExecuteData> | null = null
  for (let i = 0; i < 40 && !started?.success; i++) {
    started = await attempt('roll_back_release')
    if (!started.success) {
      expect(started.code).toBe('approval_pending')
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  expect(started?.success).toBe(true)
  expect(started!.data!.startedAt).toBeGreaterThanOrEqual(approval.data!.effectiveAt)
  // Same role, already busy.
  expect(await attempt('review_deployment')).toMatchObject({ success: false, code: 'role_busy' })

  const view = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(view.data!.events)
  expect(playerEvents(view.data!.events).map((e) => [e.type, e.actionId])).toEqual([
    ['approval_auto_granted', 'roll_back_release'],
    ['action_started', 'roll_back_release'],
  ])
})

test('complete solo run through the page: investigate, contain, restore, validate, confirm', async ({ users }) => {
  test.setTimeout(300_000)
  const [alice] = await users(1)
  const { page } = alice

  await page.goto('/simulation')
  await page.getByTestId('create-simulation').click()
  await expect(page.getByTestId('simulation-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('event-incident').first()).toContainText('Sign-in failures', { timeout: 15_000 })

  const run = async (actionId: string) => {
    await expect(page.getByTestId(`action-${actionId}`)).toBeEnabled({ timeout: 60_000 })
    await page.getByTestId(`action-${actionId}`).click()
  }
  const done = (actionId: string) =>
    expect(page.getByTestId(`action-status-${actionId}`)).toHaveText('Completed', { timeout: 60_000 })
  const approve = async (actionId: string) => {
    await page.getByTestId(`approve-${actionId}`).click()
    await expect(page.getByTestId(`action-status-${actionId}`)).toHaveText(/Approval processing|s$/, { timeout: 10_000 })
  }

  // Nothing downstream is offered before its prerequisites.
  await expect(page.getByTestId('action-restore_auth')).toBeDisabled()
  await expect(page.getByTestId('action-confirm_resolution')).toBeDisabled()
  await expect(page.getByTestId('approve-revoke_admin_sessions')).toHaveCount(0)

  await run('inspect_access_logs')
  await run('issue_customer_advisory')
  await done('inspect_access_logs')
  await run('correlate_session_events')
  await done('correlate_session_events')
  await approve('revoke_admin_sessions')
  await run('investigate_signing_access')
  await done('investigate_signing_access')
  await approve('rotate_signing_keys')
  await run('revoke_admin_sessions')
  await run('rotate_signing_keys')
  await done('revoke_admin_sessions')
  await expect(page.getByTestId('metric-containment')).toHaveText('60')
  await done('rotate_signing_keys')
  await expect(page.getByTestId('metric-containment')).toHaveText('95')
  await run('restore_auth')
  await done('restore_auth')
  await run('validate_recovery')
  await done('validate_recovery')
  await expect(page.getByTestId('result')).toHaveCount(0) // not over until confirmed
  await run('confirm_resolution')

  await expect(page.getByTestId('outcome')).toHaveText('Complete Recovery', { timeout: 15_000 })
  const shownScore = Number(await page.getByTestId('score').textContent())
  // Complete Recovery scores 96 to 100; which exactly depends on real-time pace.
  expect(shownScore).toBeGreaterThanOrEqual(96)
  expect(shownScore).toBeLessThanOrEqual(100)
  await expect(page.getByTestId('action-validate_containment')).toBeDisabled() // ended: nothing more can run

  // The server's own verdict matches what the page worked out from the log.
  const simulationId = new URL(page.url()).searchParams.get('id')!
  const call = api(page, await tokenFor(page))
  const view = await call<SyncData>('syncSimulation', { simulationId })
  expectWellFormed(view.data!.events)
  expect(view.data!.result).toMatchObject({ outcome: 'complete_recovery', reason: 'confirmed', score: shownScore })
  const completed = view.data!.events.filter((e) => e.type === 'action_completed').map((e) => e.actionId)
  expect(completed).toHaveLength(9) // eight timed actions and the confirmation
  expect(completed[completed.length - 1]).toBe('confirm_resolution')
  // Every timed action took exactly its duration on the server's clock.
  const durations: Record<string, number> = {
    inspect_access_logs: 15,
    issue_customer_advisory: 15,
    correlate_session_events: 20,
    investigate_signing_access: 20,
    revoke_admin_sessions: 25,
    rotate_signing_keys: 35,
    restore_auth: 40,
    validate_recovery: 20,
  }
  for (const [actionId, seconds] of Object.entries(durations)) {
    const start = view.data!.events.find((e) => e.type === 'action_started' && e.actionId === actionId)!
    const end = view.data!.events.find((e) => e.type === 'action_completed' && e.actionId === actionId)!
    expect(end.at - start.at, actionId).toBe(seconds * 1000)
  }
  // The run is over: later commands are refused and no further incident is ever added.
  const late = await call<ExecuteData>('executeAction', { simulationId, actionId: 'review_deployment', commandId: commandId() })
  expect(late).toMatchObject({ success: false, code: 'simulation_ended' })

  // Refresh: the finished run, its result and its timeline come back from storage.
  await page.goto(`/simulation?id=${simulationId}`)
  await expect(page.getByTestId('outcome')).toHaveText('Complete Recovery', { timeout: 15_000 })
  await expect(page.getByTestId('score')).toHaveText(String(shownScore))
  await expect(page.getByTestId('event-action_completed')).toHaveCount(9)
})

test.describe('eight-minute deadline (slow)', () => {
  test.skip(!process.env.BLACKOUT_SLOW, 'Set BLACKOUT_SLOW=1 to run the real-time deadline tests (about nine minutes).')

  test('an idle run is finalised by the server at the deadline; a run nobody watched is settled by one late sync', async ({ users }) => {
    test.setTimeout(660_000)
    const [alice] = await users(1)
    const { page } = alice
    const call = api(page, await tokenFor(page))
    const watched = await createSimulation(call)
    const unwatched = await createSimulation(call)
    const expectedSchedule = [
      ['initial_alert', 0],
      ['service_degradation', 60_000],
      ['attacker_activity', 120_000],
      ['outage_spreads', 180_000],
      ['attacker_escalation', 240_000],
      ['token_replay', 330_000],
      ['communication_gap', 330_000],
      ['deadline_warning', 420_000],
      ['finalization', 480_000],
    ]

    // The watched run: the page is open the whole time and nobody acts.
    await page.goto(`/simulation?id=${watched}`)
    await expect(page.getByTestId('simulation-view')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('event-incident')).toHaveCount(1, { timeout: 15_000 })
    // Incidents arrive on their own, with their penalties, and no reload.
    await expect(page.getByTestId('event-incident')).toHaveCount(2, { timeout: 75_000 })
    await expect(page.getByTestId('metric-health')).toHaveText('74')
    await expect(page.getByTestId('metric-trust')).toHaveText('59')
    await expect(page.getByTestId('outcome')).toHaveText('Incident Escalation', { timeout: 500_000 })
    await expect(page.getByTestId('score')).toHaveText('12')
    await expect(page.getByTestId('event-incident')).toHaveCount(9)
    await expect(page.getByTestId('metric-health')).toHaveText('64')
    await expect(page.getByTestId('metric-containment')).toHaveText('5')
    await expect(page.getByTestId('metric-trust')).toHaveText('41')
    await expect(page.getByTestId(`action-${ACTION}`)).toBeDisabled()

    const watchedView = await call<SyncData>('syncSimulation', { simulationId: watched })
    expect(watchedView.data!.events.map((e) => [e.incidentId, e.at - watchedView.data!.startedAt])).toEqual(expectedSchedule)
    expect(watchedView.data!.result).toMatchObject({ outcome: 'incident_escalation', score: 12, reason: 'deadline' })

    // The unwatched run: nothing has called the server about it since it was
    // created. One sync, after the deadline, must produce the identical log.
    const before = await call<ExecuteData>('executeAction', { simulationId: unwatched, actionId: ACTION, commandId: commandId() })
    expect(before).toMatchObject({ success: false, code: 'simulation_ended' })
    const racers = await Promise.all(Array.from({ length: 8 }, () => call<SyncData>('syncSimulation', { simulationId: unwatched })))
    for (const view of racers) {
      expect(view.data!.events.map((e) => [e.incidentId, e.at - view.data!.startedAt])).toEqual(expectedSchedule)
      expect(view.data!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(view.data!.result).toMatchObject({ outcome: 'incident_escalation', score: 12, reason: 'deadline' })
    }
  })
})

// ---------------------------------------------------------------------------
// Rules version
// ---------------------------------------------------------------------------

/** Must match RULES_VERSION in src/game/engine.ts; a rule change is meant to break this. */
const CURRENT_RULES_VERSION = 2

test('a new simulation is stamped with the current rules version, whatever the client sends', async ({ users }) => {
  const [alice] = await users(1)
  const call = api(alice.page, await tokenFor(alice.page))
  const created = await call<{ simulationId: string; rulesVersion: number }>('createSoloSimulation', {
    commandId: commandId(),
    rulesVersion: 1,
  })
  expect(created).toMatchObject({ success: true, data: { rulesVersion: CURRENT_RULES_VERSION } })
  const view = await call<SyncData>('syncSimulation', { simulationId: created.data!.simulationId })
  expect(view).toMatchObject({ success: true, data: { rulesVersion: CURRENT_RULES_VERSION } })
  expectWellFormed(view.data!.events)
})

test('a simulation recorded before rules were versioned is shown as such and refused by the server', async ({ users }) => {
  const [alice] = await users(1)
  const { page } = alice
  const call = api(page, await tokenFor(page))
  // Make sure the list has at least one current run next to any old ones.
  const current = await createSimulation(call)

  await page.goto('/simulation')
  await expect(page.getByTestId('simulation-list').locator('li').first()).toBeVisible({ timeout: 15_000 })
  const legacyRows = page.getByTestId('simulation-list').locator('li', { has: page.getByTestId('simulation-legacy-tag') })
  // Old rows only exist in a local database that was used before versioning.
  // The server-side refusal itself is covered for every case in commands.test.ts.
  test.skip((await legacyRows.count()) === 0, 'No pre-versioning simulation exists in this local database.')

  await legacyRows.first().locator('button').click()
  await expect(page.getByTestId('simulation-legacy')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('simulation-view')).toHaveCount(0)
  await expect(page.getByTestId('outcome')).toHaveCount(0)

  const legacyId = new URL(page.url()).searchParams.get('id')!
  expect(legacyId).not.toBe(current)
  const refusal = { success: false, code: 'rules_version_unsupported' }
  const synced = await call<SyncData>('syncSimulation', { simulationId: legacyId })
  expect(synced).toMatchObject(refusal)
  expect(synced.data).toBeUndefined() // no events, no result
  expect(await call<ExecuteData>('executeAction', { simulationId: legacyId, actionId: ACTION, commandId: commandId() })).toMatchObject(refusal)
  expect(await call<unknown>('requestApproval', { simulationId: legacyId, actionId: 'roll_back_release', commandId: commandId() })).toMatchObject(refusal)

  // The current run in the same list still opens normally.
  await page.goto(`/simulation?id=${current}`)
  await expect(page.getByTestId('simulation-view')).toBeVisible({ timeout: 15_000 })
})
