/**
 * Prompt 009 — timers, room lifecycle, abuse limits and the security audit,
 * against the real local worker and its Durable Objects.
 *
 * Everything goes through the doors a browser has: server actions (bearer
 * token), the realtime sockets, and the other HTTP routes the worker exposes.
 * Exact time boundaries are proven with an injected clock in
 * src/server/game/hardening.test.ts; this file proves the real room, job
 * queue and routes behave as those tests assume.
 *
 * Needs five test accounts. The fifth ("Blk echo") is used only by the limit
 * tests, which deliberately exhaust its allowance; no other test signs in as
 * it, so they cannot be starved by that.
 *
 * Two groups are opt-in:
 *   BLACKOUT_SLOW=1        the real-time eight-minute unattended deadline;
 *   BLACKOUT_RESTART=a|b   the two halves of the server-restart check, run as
 *                          two separate Playwright invocations (each one
 *                          starts and stops its own server).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const accounts = loadAllTestAccounts()
test.skip(accounts.length < 5, `Needs 5 usable test accounts, found ${accounts.length}.`)
const ECHO = 'Blk echo'

const APP_ID = /DEEPSPACE_APP_ID\s*=\s*"(app_[A-Z0-9]+)"/.exec(
  readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8'),
)?.[1]
const SCOPE_ID = `app:${APP_ID}`
const RESTART_STATE = fileURLToPath(new URL('../.deepspace/restart-state.json', import.meta.url))

const DURATION = 480_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Mirrors of src/server/game/limits.ts — asserted, not imported, so a change there must be made here knowingly.
const JOIN_LIMIT = { limit: 120, windowMs: 600_000 }
const ROOM_LIMIT = { limit: 120, windowMs: HOUR }

type Role = 'commander' | 'security' | 'infrastructure'
interface Body<T> {
  success: boolean
  data?: T
  error?: string
  code?: string
}
interface Room {
  roomId: string
  hostId: string
  inviteCode: string
  status: 'lobby' | 'active' | 'completed' | 'abandoned'
  closedReason: 'host' | 'expired' | null
  members: { userId: string; role: Role | null }[]
  startedAt: number | null
  deadlineAt: number | null
  serverNow: number
  replayed?: boolean
}
interface EventView {
  seq: number
  type: string
  actionId?: string
  incidentId?: string
  at: number
}
interface Sync {
  startedAt: number
  deadlineAt: number
  serverNow: number
  events: EventView[]
  findings: { eventSeq: number; scope: string; text: string }[]
  result: { outcome: string; score: number; reason: string } | null
}
interface Created {
  simulationId: string
  startedAt: number
  deadlineAt: number
  serverNow: number
}
type Row = { recordId: string; data: Record<string, unknown> }

const cid = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Call = <T>(name: string, data: Record<string, unknown>) => Promise<Body<T>>
interface Player {
  page: Page
  token: string
  userId: string
  call: Call
}

async function player(page: Page): Promise<Player> {
  await page.goto('/home')
  const token = await page.evaluate(async () => {
    const res = await fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
    return res.ok ? ((await res.json()) as { token?: string }).token ?? null : null
  })
  if (!token) throw new Error('Could not obtain an auth token for the test account')
  const userId = (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { sub: string }).sub
  const call: Call = async (name, data) => {
    const res = await page.request.post(`/api/actions/${name}`, { headers: { Authorization: `Bearer ${token}` }, data })
    expect(res.status()).toBe(200)
    return (await res.json()) as Body<never>
  }
  return { page, token, userId, call }
}

function ok<T>(body: Body<T>): T {
  expect(body, JSON.stringify(body)).toMatchObject({ success: true })
  return body.data as T
}

/**
 * One query over the record socket: the rows this player may read. A pure
 * read — unlike a sync action, it cannot cause the server to write anything,
 * so it shows what the server did on its own.
 */
async function readable(p: Player, collection: string, where?: Record<string, unknown>): Promise<Row[]> {
  return p.page.evaluate(
    async ({ token, scope, collection, where }) =>
      await new Promise<Row[]>((resolve, reject) => {
        const url = new URL('/ws/' + encodeURIComponent(scope), location.origin.replace(/^http/, 'ws'))
        url.searchParams.set('token', token)
        const socket = new WebSocket(url)
        const subscriptionId = crypto.randomUUID()
        const timer = setTimeout(() => {
          socket.close()
          reject(new Error(`no query result for ${collection}`))
        }, 8000)
        socket.onmessage = (m) => {
          if (typeof m.data !== 'string') return
          const message = JSON.parse(m.data) as { type: string; payload?: { subscriptionId?: string; records?: [] } }
          if (message.type === 'core.query_result' && message.payload?.subscriptionId === subscriptionId) {
            clearTimeout(timer)
            socket.close()
            resolve(message.payload.records ?? [])
          }
        }
        socket.onopen = () => socket.send(JSON.stringify({ type: 'core.subscribe', payload: { subscriptionId, query: { collection, ...(where ? { where } : {}) } } }))
      }),
    { token: p.token, scope: SCOPE_ID, collection, where },
  )
}
async function storedEvents(p: Player, simulationId: string): Promise<EventView[]> {
  const rows = await readable(p, 'simulation_events', { simulationId })
  return rows.map((row) => row.data as unknown as EventView).sort((a, b) => a.seq - b.seq)
}

/** Try to open a WebSocket at `path`; report whether it opened and what arrived in `ms`. Optionally send frames once open. */
async function trySocket(page: Page, path: string, token: string | null, ms = 2500, send: unknown[] = []): Promise<{ opened: boolean; frames: string[] }> {
  return page.evaluate(
    async ({ path, token, ms, send }) =>
      await new Promise<{ opened: boolean; frames: string[] }>((resolve) => {
        const url = new URL(path, location.origin.replace(/^http/, 'ws'))
        if (token) url.searchParams.set('token', token)
        const socket = new WebSocket(url)
        const frames: string[] = []
        let opened = false
        socket.onopen = () => {
          opened = true
          for (const message of send) socket.send(JSON.stringify(message))
        }
        socket.onmessage = (m) => frames.push(typeof m.data === 'string' ? m.data : '[binary]')
        setTimeout(() => {
          socket.close()
          resolve({ opened, frames })
        }, ms)
      }),
    { path, token, ms, send },
  )
}

type Users = (selector: number | string[]) => Promise<Array<{ page: Page }>>

interface Team {
  room: Room
  roomId: string
  security: Player // the host
  commander: Player
  infrastructure: Player
  outsider: Player
}
async function readyTeam(users: Users): Promise<Team> {
  const contexts = await users(4)
  const [security, commander, infrastructure, outsider] = await Promise.all(contexts.map((c) => player(c.page)))
  const room = ok(await security.call<Room>('createRoom', { commandId: cid() }))
  ok(await commander.call<Room>('joinRoom', { inviteCode: room.inviteCode }))
  ok(await infrastructure.call<Room>('joinRoom', { inviteCode: room.inviteCode }))
  ok(await security.call<Room>('claimRole', { roomId: room.roomId, role: 'security' }))
  ok(await commander.call<Room>('claimRole', { roomId: room.roomId, role: 'commander' }))
  ok(await infrastructure.call<Room>('claimRole', { roomId: room.roomId, role: 'infrastructure' }))
  return { room, roomId: room.roomId, security, commander, infrastructure, outsider }
}
async function startedTeam(users: Users): Promise<Team & { startedAt: number }> {
  const team = await readyTeam(users)
  const started = ok(await team.security.call<Room>('startRoom', { roomId: team.roomId }))
  expect(started.status).toBe('active')
  return { ...team, startedAt: started.startedAt! }
}

const SCHEDULE: [string, number][] = [
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
/** The incidents that must be in the log once `elapsed` ms have passed, with their exact timestamps. */
const owed = (startedAt: number, elapsed: number) =>
  SCHEDULE.filter(([, atMs]) => atMs <= elapsed).map(([incidentId, atMs]) => ({ incidentId, at: startedAt + atMs }))
const incidents = (events: EventView[]) => events.filter((e) => e.type === 'incident').map((e) => ({ incidentId: e.incidentId, at: e.at }))
const contiguous = (events: EventView[]) => expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))

// ---------------------------------------------------------------------------
// Stage 1 — authoritative time, with nobody connected
// ---------------------------------------------------------------------------

test.describe('the server keeps time by itself', () => {
  test('a solo simulation nobody is watching still gets its scheduled incidents, each once, at the scheduled instant', async ({ users }) => {
    test.setTimeout(120_000)
    const [context] = await users(1)
    const alice = await player(context.page)
    const sim = ok(await alice.call<Created>('createSoloSimulation', { commandId: cid() }))
    expect(sim.deadlineAt - sim.startedAt).toBe(DURATION)

    // From here on this test sends NO action: nothing a browser does can be what writes the events.
    await expect.poll(async () => incidents(await storedEvents(alice, sim.simulationId)), { timeout: 10_000 }).toEqual(owed(sim.startedAt, 0))

    await sleep(Math.max(0, sim.startedAt + 60_000 - Date.now()))
    await expect
      .poll(async () => incidents(await storedEvents(alice, sim.simulationId)), { timeout: 15_000, intervals: [500] })
      .toEqual(owed(sim.startedAt, 60_000))

    // A sync afterwards adds nothing and finds one event per position.
    const view = ok(await alice.call<Sync>('syncSimulation', { simulationId: sim.simulationId }))
    contiguous(view.events)
    expect(incidents(view.events)).toEqual(owed(sim.startedAt, 60_000))
    expect(view.result).toBeNull()
  })

  test('a team simulation nobody is watching does too, and its reports reach the team only', async ({ users }) => {
    test.setTimeout(120_000)
    const team = await startedTeam(users)
    await sleep(Math.max(0, team.startedAt + 60_000 - Date.now()))
    await expect
      .poll(async () => incidents(await storedEvents(team.commander, team.roomId)), { timeout: 15_000, intervals: [500] })
      .toEqual(owed(team.startedAt, 60_000))
    // The incident reports were written with the events, readable by members and nobody else.
    const reports = await readable(team.infrastructure, 'simulation_findings', { simulationId: team.roomId })
    expect(reports.filter((r) => r.data.scope === 'team').map((r) => r.data.eventSeq).sort()).toEqual([1, 2])
    expect(await readable(team.outsider, 'simulation_findings', { simulationId: team.roomId })).toEqual([])
    expect(await storedEvents(team.outsider, team.roomId)).toEqual([])
    // Three people syncing at once afterwards changes nothing.
    const views = await Promise.all([team.security, team.commander, team.infrastructure].map((p) => p.call<Sync>('syncSimulation', { simulationId: team.roomId })))
    for (const view of views) {
      contiguous(ok(view).events)
      expect(incidents(ok(view).events)).toEqual(owed(team.startedAt, 60_000))
    }
  })

  test('a browser cannot move the clock: times in a request are ignored and stored times cannot be rewritten', async ({ users }) => {
    const [context] = await users(1)
    const alice = await player(context.page)
    const before = Date.now()
    const forged = { commandId: cid(), startedAt: 1, deadlineAt: 9_999_999_999_999, now: 1, serverNow: 1, durationMs: 9e9, rulesVersion: 1 }
    const sim = ok(await alice.call<Created>('createSoloSimulation', forged))
    expect(sim.startedAt).toBeGreaterThanOrEqual(before - 5000)
    expect(sim.startedAt).toBeLessThanOrEqual(Date.now() + 5000)
    expect(sim.deadlineAt).toBe(sim.startedAt + DURATION)

    // An action cannot be told when it started or finished.
    const run = ok(
      await alice.call<{ startedAt: number; completesAt: number; seq: number }>('executeAction', {
        simulationId: sim.simulationId,
        actionId: 'inspect_access_logs',
        commandId: cid(),
        at: 1,
        startedAt: 1,
        completesAt: 2,
        completed: true,
        type: 'action_completed',
      }),
    )
    expect(run.completesAt).toBe(run.startedAt + 15_000)
    expect(run.startedAt).toBeGreaterThanOrEqual(sim.startedAt)
    const view = ok(await alice.call<Sync>('syncSimulation', { simulationId: sim.simulationId, now: sim.deadlineAt + 1, serverNow: sim.deadlineAt + 1 }))
    expect(view.result).toBeNull()
    expect(view.events.filter((e) => e.type === 'action_completed')).toEqual([])
    expect(view.deadlineAt).toBe(sim.startedAt + DURATION)

    // Direct writes over the socket: a later deadline, and a forged completion.
    const [row] = await readable(alice, 'simulations', { recordId: sim.simulationId })
    expect(row?.data.deadlineAt).toBe(sim.deadlineAt)
    const frames = await trySocket(alice.page, `/ws/${encodeURIComponent(SCOPE_ID)}`, alice.token, 2500, [
      { type: 'core.put', payload: { collection: 'simulations', recordId: sim.simulationId, data: { deadlineAt: sim.deadlineAt + HOUR } } },
      {
        type: 'core.put',
        payload: {
          collection: 'simulation_events',
          recordId: crypto.randomUUID(),
          data: { simulationId: sim.simulationId, seq: 3, ownerId: alice.userId, type: 'action_completed', actionId: 'inspect_access_logs', at: Date.now(), actorId: alice.userId, commandId: cid() },
        },
      },
    ])
    expect(frames.opened).toBe(true)
    expect(frames.frames.join('\n')).toMatch(/DENIED|immutable/i)
    const after = ok(await alice.call<Sync>('syncSimulation', { simulationId: sim.simulationId }))
    expect(after.deadlineAt).toBe(sim.deadlineAt)
    expect(after.events.filter((e) => e.type === 'action_completed')).toEqual([])
    contiguous(after.events)
  })
})

test.describe('unattended deadline (slow)', () => {
  test.skip(!process.env.BLACKOUT_SLOW, 'Set BLACKOUT_SLOW=1 to run the real-time unattended deadline test (about nine minutes).')

  test('with every browser idle for eight minutes, solo and team simulations are finalized by the server at the deadline', async ({ users }) => {
    test.setTimeout(600_000)
    const team = await startedTeam(users)
    const sim = ok(await team.outsider.call<Created>('createSoloSimulation', { commandId: cid() }))
    // No action is sent until both deadlines have passed.
    await sleep(Math.max(team.startedAt, sim.startedAt) + DURATION + 4000 - Date.now())

    await expect.poll(async () => incidents(await storedEvents(team.outsider, sim.simulationId)), { timeout: 20_000, intervals: [1000] }).toEqual(owed(sim.startedAt, DURATION))
    await expect.poll(async () => incidents(await storedEvents(team.commander, team.roomId)), { timeout: 20_000, intervals: [1000] }).toEqual(owed(team.startedAt, DURATION))
    // The room row says completed although nobody asked.
    await expect
      .poll(async () => (await readable(team.infrastructure, 'team_rooms', { recordId: team.roomId }))[0]?.data.status, { timeout: 20_000, intervals: [1000] })
      .toBe('completed')

    const solo = ok(await team.outsider.call<Sync>('syncSimulation', { simulationId: sim.simulationId }))
    const shared = ok(await team.security.call<Sync>('syncSimulation', { simulationId: team.roomId }))
    for (const view of [solo, shared]) {
      contiguous(view.events)
      expect(view.events).toHaveLength(SCHEDULE.length)
      expect(view.result).toMatchObject({ reason: 'deadline' })
    }
    expect(await team.security.call('executeAction', { simulationId: team.roomId, actionId: 'inspect_access_logs', commandId: cid() })).toMatchObject({ success: false, code: 'simulation_ended' })
  })
})

test.describe('server restart', () => {
  const phase = process.env.BLACKOUT_RESTART
  test.skip(phase !== 'a' && phase !== 'b', 'Set BLACKOUT_RESTART=a, then =b in a second run, to check recovery across a server restart.')

  test('phase a: start a simulation and leave it running when the server stops', async ({ users }) => {
    test.skip(phase !== 'a', 'phase b run')
    const team = await startedTeam(users)
    const sim = ok(await team.outsider.call<Created>('createSoloSimulation', { commandId: cid() }))
    ok(await team.outsider.call('executeAction', { simulationId: sim.simulationId, actionId: 'inspect_access_logs', commandId: cid() }))
    await expect.poll(async () => incidents(await storedEvents(team.outsider, sim.simulationId)), { timeout: 10_000 }).toEqual(owed(sim.startedAt, 0))
    mkdirSync(fileURLToPath(new URL('../.deepspace/', import.meta.url)), { recursive: true })
    writeFileSync(RESTART_STATE, JSON.stringify({ simulationId: sim.simulationId, soloStartedAt: sim.startedAt, roomId: team.roomId, teamStartedAt: team.startedAt }))
  })

  test('phase b: after the restart the timers resume and the logs are intact, with no browser prompting', async ({ users }) => {
    test.skip(phase !== 'b', 'phase a run')
    test.setTimeout(240_000)
    expect(existsSync(RESTART_STATE), 'run phase a first').toBe(true)
    const state = JSON.parse(readFileSync(RESTART_STATE, 'utf8')) as { simulationId: string; soloStartedAt: number; roomId: string; teamStartedAt: number }
    const contexts = await users(4)
    const [security, , , outsider] = await Promise.all(contexts.map((c) => player(c.page)))

    const now = Date.now()
    expect(now - state.soloStartedAt, 'phase b must run while the simulation is still in progress').toBeLessThan(DURATION - 90_000)
    // The next scheduled instant that lies wholly after the restart.
    const next = SCHEDULE.map(([, atMs]) => atMs).find((atMs) => state.soloStartedAt + atMs > now + 3000 && state.teamStartedAt + atMs > now + 3000)!
    await sleep(Math.max(state.soloStartedAt, state.teamStartedAt) + next + 1500 - Date.now())

    // Pure reads: what is in the logs was put there by the server's recovered timers.
    await expect.poll(async () => incidents(await storedEvents(outsider, state.simulationId)), { timeout: 20_000, intervals: [1000] }).toEqual(owed(state.soloStartedAt, next))
    await expect.poll(async () => incidents(await storedEvents(security, state.roomId)), { timeout: 20_000, intervals: [1000] }).toEqual(owed(state.teamStartedAt, next))
    const solo = await storedEvents(outsider, state.simulationId)
    contiguous(solo)
    // The action begun before the restart completed at its own time.
    const started = solo.find((e) => e.type === 'action_started')!
    expect(solo.find((e) => e.type === 'action_completed')).toMatchObject({ actionId: 'inspect_access_logs', at: started.at + 15_000 })

    // And the games go on: commands still work, and a sync adds nothing.
    const view = ok(await outsider.call<Sync>('syncSimulation', { simulationId: state.simulationId }))
    expect(view.events.map((e) => e.seq)).toEqual(solo.map((e) => e.seq))
    ok(await security.call('executeAction', { simulationId: state.roomId, actionId: 'inspect_access_logs', commandId: cid() }))
    contiguous(ok(await security.call<Sync>('syncSimulation', { simulationId: state.roomId })).events)
  })
})

// ---------------------------------------------------------------------------
// Stage 2 — room lifecycle and abuse protection
// ---------------------------------------------------------------------------

test.describe('room lifecycle', () => {
  test('an unused lobby expires after a day, is deleted a week later, and takes nothing else with it', async ({ users }) => {
    const contexts = await users(4)
    const [host, member, stranger] = await Promise.all(contexts.map((c) => player(c.page)))
    const sweep = async (roomId: string, advanceMs: number) => host.call<{ outcome: string }>('debugSweepRoom', { roomId, advanceMs })

    const room = ok(await host.call<Room>('createRoom', { commandId: cid() }))
    const joined = ok(await member.call<Room>('joinRoom', { inviteCode: room.inviteCode }))
    const keeper = ok(await host.call<Room>('createRoom', { commandId: cid() })) // a second lobby that is NOT swept

    // The test-only clock shift is for the room's host alone.
    expect(await member.call('debugSweepRoom', { roomId: room.roomId, advanceMs: 2 * DAY })).toMatchObject({ success: false, code: 'forbidden' })
    expect(await stranger.call('debugSweepRoom', { roomId: room.roomId, advanceMs: 2 * DAY })).toMatchObject({ success: false, code: 'forbidden' })

    // 23 hours idle: still open.
    expect(ok(await sweep(room.roomId, 23 * HOUR)).outcome).toBe('kept')
    expect(ok(await member.call<Room>('syncRoom', { roomId: room.roomId }))).toMatchObject({ status: 'lobby', closedReason: null })

    // A day after its last event: expired — for members, and for anyone holding the code.
    expect(ok(await sweep(room.roomId, DAY + 60_000)).outcome).toBe('expired')
    expect(ok(await member.call<Room>('syncRoom', { roomId: room.roomId }))).toMatchObject({ status: 'abandoned', closedReason: 'expired' })
    const [row] = await readable(host, 'team_rooms', { recordId: room.roomId })
    expect(row.data).toMatchObject({ status: 'abandoned', closedReason: 'expired' })
    expect(await stranger.call('joinRoom', { inviteCode: room.inviteCode })).toMatchObject({ success: false, code: 'room_not_open' })
    expect(await host.call('startRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'room_not_open' })
    expect(await member.call('claimRole', { roomId: room.roomId, role: 'commander' })).toMatchObject({ success: false, code: 'roles_locked' })
    // Recording it again changes nothing.
    expect(ok(await sweep(room.roomId, DAY + 120_000)).outcome).toBe('kept')

    // Six days after closing it is still kept; past seven it is deleted, with its lobby log.
    expect(ok(await sweep(room.roomId, 7 * DAY)).outcome).toBe('kept')
    expect(ok(await sweep(room.roomId, 8 * DAY + HOUR)).outcome).toBe('deleted')
    expect(await host.call('syncRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'forbidden' })
    expect(await member.call('syncRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'forbidden' })
    expect(await readable(host, 'team_rooms', { recordId: room.roomId })).toEqual([])
    expect(await readable(member, 'team_rooms', { recordId: room.roomId })).toEqual([])
    // Its code now means nothing at all, exactly like a code that never existed.
    expect(await stranger.call('joinRoom', { inviteCode: room.inviteCode })).toMatchObject({ success: false, code: 'invalid_invite' })
    expect(joined.roomId).toBe(room.roomId)

    // The lobby that was not swept is untouched.
    expect(ok(await host.call<Room>('syncRoom', { roomId: keeper.roomId }))).toMatchObject({ status: 'lobby', closedReason: null })
  })

  test('a room that started is never deleted: years later its history and result are still there', async ({ users }) => {
    const team = await startedTeam(users)
    ok(await team.security.call('executeAction', { simulationId: team.roomId, actionId: 'inspect_access_logs', commandId: cid() }))
    const sweep = async (advanceMs: number) => ok(await team.security.call<{ outcome: string }>('debugSweepRoom', { roomId: team.roomId, advanceMs })).outcome

    // Mid-game the sweep leaves it alone.
    expect(await sweep(60_000)).toBe('kept')
    expect(ok(await team.commander.call<Room>('syncRoom', { roomId: team.roomId })).status).toBe('active')
    // Past its deadline the sweep finishes it — the safety net for a lost timer.
    expect(await sweep(DAY)).toBe('completed')
    // Ten years on, swept twice more: still there.
    expect(await sweep(3650 * DAY)).toBe('kept')
    expect(await sweep(3650 * DAY)).toBe('kept')

    for (const p of [team.security, team.commander, team.infrastructure]) {
      const room = ok(await p.call<Room>('syncRoom', { roomId: team.roomId }))
      expect(room).toMatchObject({ status: 'completed', closedReason: null })
      expect(room.members).toHaveLength(3)
      const view = ok(await p.call<Sync>('syncSimulation', { simulationId: team.roomId }))
      contiguous(view.events)
      expect(view.result).toMatchObject({ reason: 'deadline' })
      expect(view.events.at(-1)).toMatchObject({ incidentId: 'finalization', at: team.startedAt + DURATION })
      expect(view.events.some((e) => e.type === 'action_completed' && e.actionId === 'inspect_access_logs')).toBe(true)
      expect(view.findings.filter((f) => f.scope === 'team').length).toBeGreaterThanOrEqual(8)
    }
    // Still private to the three of them.
    expect(await team.outsider.call('syncSimulation', { simulationId: team.roomId })).toMatchObject({ success: false, code: 'forbidden' })
    expect(await readable(team.outsider, 'team_rooms', { recordId: team.roomId })).toEqual([])
  })

  test('holding a code reveals nothing beyond what the code is for', async ({ users }) => {
    const team = await startedTeam(users)
    // A started room's code: refused, and not a single row of the room arrives.
    expect(await team.outsider.call('joinRoom', { inviteCode: team.room.inviteCode })).toMatchObject({ success: false, code: 'room_not_open' })
    for (const collection of ['team_rooms', 'team_room_events', 'simulation_events', 'simulation_findings']) {
      const rows = await readable(team.outsider, collection)
      expect(JSON.stringify(rows)).not.toContain(team.roomId)
    }
    // The refusal body carries a code and a sentence — no ids, members or state.
    const res = await team.outsider.page.request.post('/api/actions/joinRoom', { headers: { Authorization: `Bearer ${team.outsider.token}` }, data: { inviteCode: team.room.inviteCode } })
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'success'])
    expect(JSON.stringify(body)).not.toContain(team.roomId)
    expect(JSON.stringify(body)).not.toContain(team.security.userId)
  })
})

test.describe('abuse limits', () => {
  test('invitation-code attempts are bounded per account, and one account cannot spend another’s', async ({ users }) => {
    test.setTimeout(120_000)
    const [echoContext] = await users([ECHO])
    const contexts = await users(2)
    const echo = await player(echoContext.page)
    const [host, friend] = await Promise.all(contexts.map((c) => player(c.page)))
    const room = ok(await host.call<Room>('createRoom', { commandId: cid() }))

    const window0 = Math.floor(Date.now() / JOIN_LIMIT.windowMs)
    let wrong = 0
    let limited: Body<Room> | null = null
    // Bursts of simultaneous guesses, until the server says stop.
    for (let round = 0; round < 20 && !limited; round++) {
      const answers = await Promise.all(Array.from({ length: 16 }, () => echo.call<Room>('joinRoom', { inviteCode: '0000000000' + String(Math.floor(Math.random() * 100)).padStart(2, '0') })))
      for (const answer of answers) {
        expect(answer.success).toBe(false)
        if (answer.code === 'rate_limited') limited = answer
        else {
          expect(answer.code).toBe('invalid_invite')
          wrong++
        }
      }
    }
    const windows = Math.floor(Date.now() / JOIN_LIMIT.windowMs) - window0 + 1
    console.log(`[limits] join attempts answered before the limit: ${wrong} (limit ${JOIN_LIMIT.limit}, windows spanned ${windows})`)
    expect(limited, 'the limit was never reached').not.toBeNull()
    expect(wrong).toBeLessThanOrEqual(JOIN_LIMIT.limit * windows)
    expect(limited!.error).toMatch(/Too many attempts\. Try again in about (a minute|\d+ minutes)\./)

    // Once spent, the real code is refused as well: guessing has stopped paying.
    if (Math.floor(Date.now() / JOIN_LIMIT.windowMs) === window0 + windows - 1) {
      expect(await echo.call('joinRoom', { inviteCode: room.inviteCode })).toMatchObject({ success: false, code: 'rate_limited' })
      expect(ok(await host.call<Room>('syncRoom', { roomId: room.roomId })).members.map((m) => m.userId)).toEqual([host.userId])
    }
    // Someone else's allowance is their own.
    expect(ok(await friend.call<Room>('joinRoom', { inviteCode: room.inviteCode })).members.map((m) => m.userId)).toEqual([host.userId, friend.userId])
  })

  test('room creation is bounded per account; repeating a command stays free', async ({ users }) => {
    test.setTimeout(180_000)
    const [echoContext] = await users([ECHO])
    const [otherContext] = await users(1)
    const echo = await player(echoContext.page)
    const other = await player(otherContext.page)

    const window0 = Math.floor(Date.now() / ROOM_LIMIT.windowMs)
    const made: { commandId: string; room: Room }[] = []
    let limited: Body<Room> | null = null
    for (let round = 0; round < 30 && !limited; round++) {
      const ids = Array.from({ length: 8 }, cid)
      const answers = await Promise.all(ids.map((commandId) => echo.call<Room>('createRoom', { commandId })))
      answers.forEach((answer, i) => {
        if (answer.success) made.push({ commandId: ids[i], room: answer.data! })
        else {
          expect(answer.code).toBe('rate_limited')
          limited = answer
        }
      })
    }
    const windows = Math.floor(Date.now() / ROOM_LIMIT.windowMs) - window0 + 1
    console.log(`[limits] rooms created before the limit: ${made.length} (limit ${ROOM_LIMIT.limit}, windows spanned ${windows})`)
    expect(limited, 'the limit was never reached').not.toBeNull()
    expect(made.length).toBeLessThanOrEqual(ROOM_LIMIT.limit * windows)
    expect(new Set(made.map((m) => m.room.roomId)).size).toBe(made.length)
    expect(new Set(made.map((m) => m.room.inviteCode)).size).toBe(made.length)

    // A retry of a command that already made a room is answered, not counted.
    if (made.length > 0) {
      const again = ok(await echo.call<Room>('createRoom', { commandId: made[0].commandId }))
      expect(again).toMatchObject({ roomId: made[0].room.roomId, replayed: true })
    }
    expect(await echo.call('createRoom', { commandId: cid() })).toMatchObject({ success: false, code: 'rate_limited' })
    // Another account is unaffected.
    const room = ok(await other.call<Room>('createRoom', { commandId: cid() }))
    // Tidy up what this test made where that is cheap: the rest expire by themselves.
    ok(await other.call('abandonRoom', { roomId: room.roomId }))
  })

  test('requests are bounded and validated before any action runs', async ({ users }) => {
    const [context] = await users(1)
    const alice = await player(context.page)
    const post = (name: string, body: string) =>
      alice.page.request.post(`/api/actions/${name}`, { headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' }, data: Buffer.from(body) })

    const tooBig = await post('syncRoom', JSON.stringify({ roomId: 'x'.repeat(5000) }))
    expect(tooBig.status()).toBe(413)
    for (const body of ['not json', '[1,2,3]', 'null', '"text"', '42', '']) {
      const res = await post('joinRoom', body)
      expect(res.status(), body).toBe(400)
      expect(await res.json()).toMatchObject({ success: false, code: 'invalid_request' })
    }
    // Well-formed but hostile values are refused by the action, with nothing thrown.
    const hostile: Record<string, unknown>[] = [
      { roomId: { $ne: '' } },
      { roomId: ['a'] },
      { roomId: '../../etc/passwd' },
      { roomId: 'x'.repeat(200) },
      { roomId: null },
      {},
    ]
    for (const data of hostile) {
      for (const name of ['syncRoom', 'claimRole', 'startRoom', 'abandonRoom', 'leaveRoom', 'releaseRole']) {
        expect(await alice.call(name, { ...data, role: 'commander' }), `${name} ${JSON.stringify(data)}`).toMatchObject({ success: false, code: 'forbidden' })
      }
      for (const name of ['syncSimulation', 'shareFinding']) {
        const answer = await alice.call(name, { simulationId: data.roomId, eventSeq: 1 })
        expect(answer.success).toBe(false)
        expect(['forbidden', 'invalid_request']).toContain(answer.code)
      }
    }
    // Names that are not actions, including inherited object properties.
    for (const name of ['constructor', '__proto__', 'toString', 'nope']) {
      const res = await post(name, '{}')
      expect(res.status(), name).toBe(404)
    }
  })
})

// ---------------------------------------------------------------------------
// Stage 2/4 — presence, scheduler, job queue and assistant routes
// ---------------------------------------------------------------------------

test.describe('other doors', () => {
  test('presence is for the room’s members: nobody else can connect, and it lists no one to them', async ({ users }) => {
    const team = await readyTeam(users)
    const scope = `/ws/presence/${encodeURIComponent(`team:${team.roomId}`)}`

    // Plain HTTP, no upgrade: the route answers before any room is reached.
    const get = (path: string, token?: string) => team.outsider.page.request.get(path + (token ? `?token=${token}` : ''))
    expect((await get(scope)).status()).toBe(401)
    expect((await get(scope, 'not-a-token')).status()).toBe(401)
    expect((await get(scope, team.outsider.token)).status()).toBe(403)
    expect((await get(`/ws/presence/${encodeURIComponent('team:no-such-room-id')}`, team.outsider.token)).status()).toBe(403)
    for (const other of ['lobby', 'app', SCOPE_ID, `room:${team.roomId}`, 'team:x', `team:${team.roomId}:extra`]) {
      expect((await get(`/ws/presence/${encodeURIComponent(other)}`, team.security.token)).status(), other).toBe(404)
    }

    // A member connects and is told who else is there; a second member sees the first.
    const first = trySocket(team.security.page, scope, team.security.token, 4000)
    await sleep(1000)
    const second = await trySocket(team.commander.page, scope, team.commander.token, 2000)
    expect(second.opened).toBe(true)
    expect(second.frames.join('\n')).toContain(team.security.userId)
    expect((await first).opened).toBe(true)

    // The outsider and the anonymous visitor never get a socket, so never a name.
    const outsider = await trySocket(team.outsider.page, scope, team.outsider.token, 2000)
    const anonymous = await trySocket(team.outsider.page, scope, null, 2000)
    for (const attempt of [outsider, anonymous]) {
      expect(attempt.opened).toBe(false)
      expect(attempt.frames).toEqual([])
    }

    // The user directory gives a player their own row and nobody else's.
    const directory = await readable(team.outsider, 'users')
    expect(directory.length).toBeLessThanOrEqual(1)
    for (const other of [team.security, team.commander, team.infrastructure]) expect(JSON.stringify(directory)).not.toContain(other.userId)

    // Someone who leaves the room loses presence with it.
    ok(await team.infrastructure.call('leaveRoom', { roomId: team.roomId }))
    expect((await get(scope, team.infrastructure.token)).status()).toBe(403)
    // And being connected to presence never made anyone a member.
    expect(await team.outsider.call('syncRoom', { roomId: team.roomId })).toMatchObject({ success: false, code: 'forbidden' })
  })

  test('the scheduler and the job queue are closed to players', async ({ users }) => {
    const [context] = await users(1)
    const alice = await player(context.page)
    const scope = encodeURIComponent(SCOPE_ID)
    for (const kind of ['jobs', 'cron']) {
      const path = `/ws/${kind}/${scope}`
      expect((await alice.page.request.get(path)).status(), `${kind} anonymous`).toBe(401)
      expect((await alice.page.request.get(`${path}?token=${alice.token}`)).status(), `${kind} member`).toBe(403)
      expect((await alice.page.request.get(`/ws/${kind}/some-other-room?token=${alice.token}`)).status(), `${kind} other room`).toBe(404)
      const socket = await trySocket(alice.page, path, alice.token, 2000, [
        { type: 'job.enqueue', payload: { requestId: cid(), type: 'settle-simulation', payload: { simulationId: 'whatever-id' } } },
        { type: 'cron.pause', taskName: 'room-sweep', requestId: cid() },
      ])
      expect(socket.opened, kind).toBe(false)
      expect(socket.frames, kind).toEqual([])
    }
    // The queue's internal enqueue endpoint is not routed from outside.
    const enqueue = await alice.page.request.post(`/ws/jobs/${scope}/enqueue?token=${alice.token}`, { data: { type: 'settle-simulation', payload: {} } })
    expect([403, 404, 405]).toContain(enqueue.status())
  })

  test('the assistant tool routes obey the same permissions as the socket', async ({ users }) => {
    const team = await startedTeam(users)
    ok(await team.security.call('executeAction', { simulationId: team.roomId, actionId: 'inspect_access_logs', commandId: cid() }))
    const before = ok(await team.security.call<Sync>('syncSimulation', { simulationId: team.roomId })).events.length

    const tool = async (p: Player, base: string, name: string, input: Record<string, unknown>) => {
      const res = await p.page.request.post(`${base}/tools/${name}`, { headers: { Authorization: `Bearer ${p.token}` }, data: { input } })
      return { status: res.status(), text: await res.text() }
    }
    // Positive control: the browser route does work for what a member may read, so the
    // "nothing came back" checks below are not passing merely because the route is dead.
    const own = await tool(team.security, '/_deepspace/agent/browser', 'records_query', { collection: 'team_rooms' })
    console.log(`[tools] member query of team_rooms via the browser route: HTTP ${own.status}, mentions the room: ${own.text.includes(team.roomId)}`)
    expect(own.status).toBe(200)
    expect(own.text).toContain(team.roomId)

    for (const base of ['/_deepspace/agent', '/_deepspace/agent/browser']) {
      // No credentials: nothing.
      const anonymous = await team.outsider.page.request.post(`${base}/tools/records_query`, { data: { input: { collection: 'simulation_events' } } })
      expect(anonymous.status(), base).toBe(401)

      for (const collection of ['team_rooms', 'team_room_events', 'simulation_events', 'simulation_findings', 'rate_slots']) {
        // A non-member reads nothing of the room, by any route.
        const outside = await tool(team.outsider, base, 'records_query', { collection })
        expect(outside.text, `${base} outsider ${collection}`).not.toContain(team.roomId)
        // The lobby log and the limit counters are closed even to members.
        if (collection === 'team_room_events' || collection === 'rate_slots') {
          const inside = await tool(team.security, base, 'records_query', { collection })
          expect(inside.text, `${base} member ${collection}`).not.toContain(team.roomId)
          expect(inside.text, `${base} member ${collection}`).not.toContain('"window"')
        }
      }
      // Nobody can write game state through it — not even a participant.
      for (const p of [team.outsider, team.security]) {
        const forgedEvent = await tool(p, base, 'records_create', {
          collection: 'simulation_events',
          data: { simulationId: team.roomId, seq: before + 1, ownerId: p.userId, type: 'action_completed', actionId: 'confirm_resolution', at: Date.now(), actorId: p.userId, commandId: cid(), readers: [p.userId] },
        })
        expect(forgedEvent.text).not.toMatch(/"success"\s*:\s*true/)
        const forgedMember = await tool(p, base, 'records_create', {
          collection: 'team_room_events',
          data: { roomId: team.roomId, seq: 99, type: 'member_joined', userId: team.outsider.userId, at: Date.now() },
        })
        expect(forgedMember.text).not.toMatch(/"success"\s*:\s*true/)
        const slot = await tool(p, base, 'records_delete', { collection: 'rate_slots', recordId: 'anything' })
        expect(slot.text).not.toMatch(/"success"\s*:\s*true/)
      }
    }
    // The log is exactly as it was, and the outsider is still outside.
    const after = ok(await team.security.call<Sync>('syncSimulation', { simulationId: team.roomId }))
    expect(after.events.filter((e) => e.actionId === 'confirm_resolution')).toEqual([])
    contiguous(after.events)
    expect(await team.outsider.call('syncRoom', { roomId: team.roomId })).toMatchObject({ success: false, code: 'forbidden' })
  })
})

// ---------------------------------------------------------------------------
// Stage 3 — the page under a bad connection or an ended session
// ---------------------------------------------------------------------------

test.describe('the page when the link to the server fails', () => {
  const WAIT = { timeout: 20_000 }

  async function openSolo(page: Page) {
    await page.goto('/simulation')
    await page.getByTestId('create-simulation').click()
    await expect(page.getByTestId('simulation-view')).toBeVisible(WAIT)
    await expect(page.getByTestId('action-inspect_access_logs')).toBeEnabled(WAIT)
    const token = await page.evaluate(async () => {
      const res = await fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
      return ((await res.json()) as { token: string }).token
    })
    const simulationId = new URL(page.url()).searchParams.get('id')!
    const sync = async () => {
      const res = await page.request.post('/api/actions/syncSimulation', { headers: { Authorization: `Bearer ${token}` }, data: { simulationId } })
      return ((await res.json()) as Body<Sync>).data!
    }
    return { simulationId, sync }
  }

  test('a command whose answer is lost is retried safely: the action happens once', async ({ users }) => {
    test.setTimeout(90_000)
    const [{ page }] = await users(1)
    const { sync } = await openSolo(page)

    // The server receives and performs the command; the browser never hears back.
    let swallowed = 0
    await page.route('**/api/actions/executeAction', async (route) => {
      swallowed++
      await route.fetch()
      await route.abort('connectionreset')
    })
    await page.getByTestId('action-inspect_access_logs').click()
    await expect(page.getByTestId('action-error')).toContainText('Could not reach the server', WAIT)
    await expect(page.getByTestId('connection-warning')).toBeVisible()
    expect(swallowed).toBe(1)
    expect((await sync()).events.filter((e) => e.type === 'action_started')).toHaveLength(1)

    // The page recovers by itself (its next sync is answered) and shows what really happened.
    await expect(page.getByTestId('connection-warning')).toHaveCount(0, WAIT)
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText(/In progress|Finishing|Completed/, WAIT)

    // Pressing a different button while the link is restored works normally…
    await page.unroute('**/api/actions/executeAction')
    await page.getByTestId('action-review_deployment').click()
    await expect(page.getByTestId('action-status-review_deployment')).toContainText(/In progress|Finishing|Completed/, WAIT)
    // …and the log has each action started exactly once.
    const started = (await sync()).events.filter((e) => e.type === 'action_started').map((e) => e.actionId)
    expect(started.sort()).toEqual(['inspect_access_logs', 'review_deployment'])
  })

  test('offline: the page says so, never shows an unconfirmed completion, and catches up when the link returns', async ({ users }) => {
    test.setTimeout(120_000)
    const [{ page, context }] = (await users(1)) as unknown as [{ page: Page; context: import('@playwright/test').BrowserContext }]
    const { sync } = await openSolo(page)
    await page.getByTestId('action-inspect_access_logs').click()
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText('In progress', WAIT)

    await context.setOffline(true)
    // The action's fifteen seconds pass while offline. The page cannot know the server recorded the completion…
    await expect(page.getByTestId('connection-warning')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText('Finishing', { timeout: 30_000 })
    await expect(page.getByTestId('action-status-inspect_access_logs')).not.toContainText('Completed')
    // …and a command attempted meanwhile fails visibly instead of pretending.
    await page.getByTestId('action-review_deployment').click()
    await expect(page.getByTestId('action-error')).toContainText('Could not reach the server', WAIT)
    await expect(page.getByTestId('action-status-review_deployment')).not.toContainText(/In progress|Completed/)

    await context.setOffline(false)
    await expect(page.getByTestId('connection-warning')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText('Completed', { timeout: 30_000 })
    const view = await sync()
    contiguous(view.events)
    const begun = view.events.find((e) => e.type === 'action_started' && e.actionId === 'inspect_access_logs')!
    expect(view.events.find((e) => e.type === 'action_completed')).toMatchObject({ actionId: 'inspect_access_logs', at: begun.at + 15_000 })
    // The command that failed offline was not performed behind the player's back.
    expect(view.events.filter((e) => e.actionId === 'review_deployment')).toEqual([])
  })

  test('an ended session is stated plainly and is recoverable without losing the game', async ({ users }) => {
    test.setTimeout(90_000)
    const [{ page }] = await users(1)
    const { sync } = await openSolo(page)

    await page.route('**/api/actions/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) }))
    await page.getByTestId('action-inspect_access_logs').click()
    await expect(page.getByTestId('session-expired')).toBeVisible(WAIT)
    await expect(page.getByTestId('action-error')).toContainText('session has expired', WAIT)
    await expect(page.getByTestId('action-inspect_access_logs')).toBeDisabled()
    expect((await sync()).events.filter((e) => e.type === 'action_started')).toEqual([])

    // Signed in again (here: the route works again): one press and the game carries on.
    await page.unroute('**/api/actions/**')
    await page.getByTestId('session-retry').click()
    await expect(page.getByTestId('session-expired')).toHaveCount(0, WAIT)
    await page.getByTestId('action-inspect_access_logs').click()
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText(/In progress|Finishing|Completed/, WAIT)
    expect((await sync()).events.filter((e) => e.type === 'action_started')).toHaveLength(1)
  })

  test('when live updates lag behind, the page shows the server’s answer, not the stale picture', async ({ users }) => {
    test.setTimeout(120_000)
    const [{ page }] = await users(1)
    // Hold back everything the record socket sends to this page, on demand.
    let hold = false
    const held: Array<() => void> = []
    await page.routeWebSocket(/\/ws\/app/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => {
        if (hold) held.push(() => ws.send(message))
        else ws.send(message)
      })
    })
    const { sync } = await openSolo(page)
    const view = page.getByTestId('simulation-view')
    const seqBefore = Number(await view.getAttribute('data-last-seq'))

    hold = true
    await page.getByTestId('action-inspect_access_logs').click()
    // The live row announcing the start is stuck; the page still shows the action running.
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText('In progress', WAIT)
    expect(Number(await view.getAttribute('data-last-seq'))).toBeGreaterThan(seqBefore)
    await expect(page.getByTestId('connection-warning')).toHaveCount(0)
    // Fifteen seconds later it shows the completion the server recorded — still without the live rows.
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText('Completed', { timeout: 30_000 })
    expect(held.length).toBeGreaterThan(0)
    const seqHeld = Number(await view.getAttribute('data-last-seq'))

    // The delayed rows finally arrive, old news by now: nothing goes backwards.
    hold = false
    for (const release of held.splice(0)) release()
    await sleep(1500)
    await expect(page.getByTestId('action-status-inspect_access_logs')).toContainText('Completed')
    expect(Number(await view.getAttribute('data-last-seq'))).toBeGreaterThanOrEqual(seqHeld)
    contiguous((await sync()).events)
  })
})
