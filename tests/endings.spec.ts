/**
 * All four endings, played against the real local worker in real time.
 *
 * Four solo simulations run side by side for one account: one is played to a
 * confirmed resolution, three are left for the server to assess at the
 * eight-minute deadline after different amounts of work. The test then reads
 * each result three ways — the server's answer, the postmortem page and the
 * history list — and they must agree.
 *
 * Opt-in (BLACKOUT_ENDINGS=1): it takes about nine minutes of wall-clock time.
 * The unit tests cover the same rules exhaustively without a clock; this
 * checks that the deployed-shape server, its timer and the pages reach them.
 */
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(!process.env.BLACKOUT_ENDINGS, 'Set BLACKOUT_ENDINGS=1 to play all four endings in real time (about nine minutes).')
test.skip(loadAllTestAccounts().length < 1, 'Needs a test account.')

interface Body<T> {
  success: boolean
  data?: T
  code?: string
  error?: string
}
interface Sync {
  startedAt: number
  deadlineAt: number
  events: { seq: number; type: string; actionId?: string; at: number }[]
  result: { outcome: string; score: number; reason: string; endedAt: number } | null
}
type Step = ['ask' | 'run', string]

const cid = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function tokenFor(page: Page): Promise<string> {
  await page.goto('/home')
  const token = await page.evaluate(async () => {
    const res = await fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
    return res.ok ? (((await res.json()) as { token?: string }).token ?? null) : null
  })
  if (!token) throw new Error('Could not obtain an auth token for the test account')
  return token
}

const CONTAIN_ONE: Step[] = [
  ['run', 'inspect_access_logs'],
  ['run', 'correlate_session_events'],
  ['ask', 'revoke_admin_sessions'],
  ['run', 'revoke_admin_sessions'],
]
const RESTORE: Step[] = [
  ...CONTAIN_ONE,
  ['run', 'investigate_signing_access'],
  ['ask', 'rotate_signing_keys'],
  ['run', 'rotate_signing_keys'],
  ['run', 'restore_auth'],
]
const PLAYS: { name: string; steps: Step[]; outcome: string; label: string; reason: string; band: [number, number] }[] = [
  { name: 'nothing done', steps: [], outcome: 'incident_escalation', label: 'Incident Escalation', reason: 'deadline', band: [12, 26] },
  { name: 'one intervention', steps: CONTAIN_ONE, outcome: 'partial_containment', label: 'Partial Containment', reason: 'deadline', band: [32, 57] },
  { name: 'restored, never validated', steps: RESTORE, outcome: 'costly_recovery', label: 'Costly Recovery', reason: 'deadline', band: [79, 95] },
  {
    name: 'validated and confirmed',
    steps: [...RESTORE, ['run', 'issue_customer_advisory'], ['run', 'validate_recovery'], ['run', 'confirm_resolution']],
    outcome: 'complete_recovery',
    label: 'Complete Recovery',
    reason: 'confirmed',
    band: [96, 100],
  },
]

test('the four endings are each reached on the server, and the postmortem and history agree with it', async ({ users }) => {
  test.setTimeout(660_000)
  const [{ page }] = await users(1)
  const token = await tokenFor(page)
  const call = async <T>(name: string, data: Record<string, unknown>): Promise<Body<T>> => {
    const res = await page.request.post(`/api/actions/${name}`, { headers: { Authorization: `Bearer ${token}` }, data })
    expect(res.status()).toBe(200)
    return (await res.json()) as Body<T>
  }

  const ids: string[] = []
  for (const play of PLAYS) {
    const created = await call<{ simulationId: string }>('createSoloSimulation', { commandId: cid() })
    expect(created.success, `create for "${play.name}"`).toBe(true)
    ids.push(created.data!.simulationId)
  }

  // Each step is retried until the rules allow it: the server, not this test, decides when that is.
  const drive = async (simulationId: string, steps: Step[]) => {
    for (const [kind, actionId] of steps) {
      const commandId = cid()
      const giveUp = Date.now() + 150_000
      for (;;) {
        const body = await call<unknown>(kind === 'ask' ? 'requestApproval' : 'executeAction', { simulationId, actionId, commandId })
        if (body.success) break
        expect(body.code, `${kind} ${actionId} refused for good: ${body.code}`).not.toBe('simulation_ended')
        expect(Date.now(), `${kind} ${actionId} never became possible (last refusal: ${body.code})`).toBeLessThan(giveUp)
        await sleep(1000)
      }
    }
  }
  await Promise.all(PLAYS.map((play, index) => drive(ids[index], play.steps)))

  // The confirmed run is over already; the other three are still running and are left alone until the deadline.
  const confirmed = (await call<Sync>('syncSimulation', { simulationId: ids[3] })).data!
  expect(confirmed.result).toMatchObject({ outcome: 'complete_recovery', reason: 'confirmed' })
  const middle = (await call<Sync>('syncSimulation', { simulationId: ids[1] })).data!
  expect(middle.result).toBeNull()
  await sleep(Math.max(0, middle.deadlineAt - Date.now()) + 8_000)

  const results: NonNullable<Sync['result']>[] = []
  for (const [index, play] of PLAYS.entries()) {
    const view = (await call<Sync>('syncSimulation', { simulationId: ids[index] })).data!
    expect(view.events.map((event) => event.seq), `${play.name}: log is contiguous`).toEqual(view.events.map((_, i) => i + 1))
    expect(view.result, `${play.name}: has a result`).not.toBeNull()
    const result = view.result!
    expect(result, play.name).toMatchObject({ outcome: play.outcome, reason: play.reason })
    expect(result.score, `${play.name}: score in its band`).toBeGreaterThanOrEqual(play.band[0])
    expect(result.score, `${play.name}: score in its band`).toBeLessThanOrEqual(play.band[1])
    if (play.reason === 'deadline') expect(result.endedAt).toBe(view.deadlineAt)
    // Nothing is accepted after the end.
    expect(await call<unknown>('executeAction', { simulationId: ids[index], actionId: 'review_deployment', commandId: cid() })).toMatchObject({ success: false, code: 'simulation_ended' })
    results.push(result)
  }
  // Better endings never score below worse ones.
  expect(results[0].score).toBeLessThan(results[1].score)
  expect(results[1].score).toBeLessThan(results[2].score)
  expect(results[2].score).toBeLessThan(results[3].score)

  // The postmortem page shows what the server answered, and its parts add up.
  for (const [index, play] of PLAYS.entries()) {
    await page.goto(`/simulation?id=${ids[index]}`)
    await expect(page.getByTestId('outcome')).toHaveText(play.label, { timeout: 20_000 })
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', play.outcome)
    await expect(page.getByTestId('score')).toHaveText(String(results[index].score))
    let sum = 0
    for (const part of ['containment', 'restoration', 'validation', 'evidence', 'trust', 'health']) sum += Number(await page.getByTestId(`score-part-${part}`).innerText())
    expect(sum, `${play.name}: parts sum to the score`).toBe(results[index].score)
    await expect(page.getByTestId('end-reason')).toContainText(play.reason === 'confirmed' ? 'confirmed resolution' : 'eight minutes ran out')
  }
  // History lists each run, found by its id, with the same ending and score.
  await page.goto('/history')
  for (const [index, play] of PLAYS.entries()) {
    const row = page.getByTestId('history-solo').locator(`li[data-run-id="${ids[index]}"]`)
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    await expect(row.getByTestId('run-result')).toContainText(play.label, { timeout: 20_000 })
    await expect(row.getByTestId('run-result')).toContainText(`${results[index].score} / 100`)
  }
})
