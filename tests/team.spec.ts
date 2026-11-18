/**
 * Team simulations against the real local worker and Durable Object, with
 * four separately signed-in accounts.
 *
 * Everything here goes through the same doors a browser has: the server
 * actions (bearer token) and the realtime record socket. Rules with exact
 * time boundaries are proven with an injected clock in
 * src/server/game/rooms.test.ts; this file proves that the real room gives
 * the guarantees those tests assume — one event per log position under truly
 * concurrent requests, and rows reaching only the people listed on them.
 *
 * Needs four test accounts:
 *   npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const usable = loadAllTestAccounts().length
test.skip(usable < 4, `Needs 4 usable test accounts, found ${usable}.`)

const APP_ID = /DEEPSPACE_APP_ID\s*=\s*"(app_[A-Z0-9]+)"/.exec(
  readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8'),
)?.[1]
const SCOPE_ID = `app:${APP_ID}`

type Role = 'commander' | 'security' | 'infrastructure'
const ROLES: Role[] = ['commander', 'security', 'infrastructure']

interface Body<T> {
  success: boolean
  data?: T
  error?: string
  code?: string
}
interface Member {
  userId: string
  role: Role | null
  joinedAt: number
}
interface Room {
  roomId: string
  hostId: string
  inviteCode: string
  status: 'lobby' | 'active' | 'completed' | 'abandoned'
  members: Member[]
  startedAt: number | null
  deadlineAt: number | null
  lobbySeq: number
  serverNow: number
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
interface FindingView {
  eventSeq: number
  scope: 'private' | 'team'
  ownerId: string
  text: string
  sharedBy?: string
}
interface Sync {
  mode: string
  serverNow: number
  startedAt: number
  deadlineAt: number
  events: EventView[]
  findings: FindingView[]
  result: { outcome: string; score: number; reason: string } | null
}
interface Executed {
  startedAt: number
  completesAt: number
  seq: number
  replayed: boolean
  result: Sync['result']
}
interface Requested {
  status: string
  requestSeq: number
  seq: number
  replayed: boolean
}
interface Decided {
  decision: string
  requestSeq: number
  effectiveAt: number
  seq: number
  serverNow: number
  replayed: boolean
}

const cid = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Call = <T>(name: string, data: Record<string, unknown>) => Promise<Body<T>>
interface Player {
  page: Page
  token: string
  userId: string
  call: Call
}

/** Sign-in state → bearer token, the same way the SDK client obtains it. */
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
 * A raw realtime connection for this player, speaking the record protocol by
 * hand. It subscribes to every game collection with no filter — the most a
 * client can ask for — and keeps every frame the room sends, so a test can
 * check what did and did not reach this person.
 */
const GAME_COLLECTIONS = ['team_rooms', 'team_room_events', 'simulation_events', 'simulation_findings', 'simulations']
async function openSpy(p: Player, name: string): Promise<void> {
  await p.page.evaluate(
    async ({ token, scope, collections, name }) => {
      const url = new URL('/ws/' + encodeURIComponent(scope), location.origin.replace(/^http/, 'ws'))
      url.searchParams.set('token', token)
      const socket = new WebSocket(url)
      const frames: string[] = []
      socket.onmessage = (m) => frames.push(typeof m.data === 'string' ? m.data : '[binary]')
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error('spy socket failed'))
      })
      for (const collection of collections) {
        socket.send(JSON.stringify({ type: 'core.subscribe', payload: { subscriptionId: `spy-${collection}`, query: { collection } } }))
      }
      ;(window as unknown as Record<string, unknown>)[`__spy_${name}`] = { socket, frames }
    },
    { token: p.token, scope: SCOPE_ID, collections: GAME_COLLECTIONS, name },
  )
}
/** Every frame the spy has received so far. */
async function spyFrames(p: Player, name: string): Promise<string[]> {
  return p.page.evaluate((name) => [...(window as unknown as Record<string, { frames: string[] }>)[`__spy_${name}`].frames], name)
}
/**
 * The frames about one room. Finding texts are the same in every room, and an
 * account can be in several rooms at once, so a check on what reached a
 * person has to look at this room's rows only (each carries the room id).
 */
async function roomFrames(p: Player, name: string, roomId: string): Promise<string> {
  return (await spyFrames(p, name)).filter((frame) => frame.includes(roomId)).join('\n')
}
/** Send raw frames on the spy socket and return the frames that came back in the next 2.5 s. */
async function spySend(p: Player, name: string, messages: unknown[]): Promise<string[]> {
  return p.page.evaluate(
    async ({ name, messages }) => {
      const spy = (window as unknown as Record<string, { socket: WebSocket; frames: string[] }>)[`__spy_${name}`]
      const from = spy.frames.length
      for (const message of messages) spy.socket.send(JSON.stringify(message))
      await new Promise((resolve) => setTimeout(resolve, 2500))
      return spy.frames.slice(from)
    },
    { name, messages },
  )
}
/** One fresh query over the socket: the records this player may read in a collection. */
async function readable(p: Player, collection: string, where?: Record<string, unknown>): Promise<Array<{ recordId: string; data: Record<string, unknown> }>> {
  return p.page.evaluate(
    async ({ token, scope, collection, where }) =>
      await new Promise<Array<{ recordId: string; data: Record<string, unknown> }>>((resolve, reject) => {
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

interface Team {
  room: Room
  roomId: string
  security: Player // also the host: the host is deliberately NOT the commander
  commander: Player
  infrastructure: Player
  outsider: Player
}

/** A room with three members and all roles claimed, not yet started. */
async function readyTeam(users: (n: number) => Promise<Array<{ page: Page }>>): Promise<Team> {
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
async function startedTeam(users: (n: number) => Promise<Array<{ page: Page }>>): Promise<Team & { startedAt: number }> {
  const team = await readyTeam(users)
  const started = ok(await team.security.call<Room>('startRoom', { roomId: team.roomId }))
  expect(started.status).toBe('active')
  return { ...team, startedAt: started.startedAt! }
}

function expectWellFormed(events: EventView[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  expect(events[0]).toMatchObject({ type: 'incident', incidentId: 'initial_alert' })
}
const moves = (events: EventView[]) => events.filter((e) => e.type !== 'incident')

test.describe('unauthenticated callers', () => {
  for (const name of ['createRoom', 'joinRoom', 'claimRole', 'startRoom', 'syncRoom', 'decideApproval', 'shareFinding']) {
    test(`${name} without a token is 401`, async ({ request }) => {
      const res = await request.post(`/api/actions/${name}`, { data: { roomId: 'whatever-id', inviteCode: '000000000000', commandId: cid() } })
      expect(res.status()).toBe(401)
    })
  }
})

test('lobby under real concurrency: seats, duplicate joins, role claims and the start', async ({ users }) => {
  test.setTimeout(90_000)
  const contexts = await users(4)
  const [host, ...others] = await Promise.all(contexts.map((c) => player(c.page)))

  // Creating twice with one command id (a retry racing itself) makes one room.
  const createId = cid()
  const created = await Promise.all([1, 2, 3].map(() => host.call<Room>('createRoom', { commandId: createId })))
  const room = ok(created[0])
  expect(new Set(created.map((c) => ok(c).roomId)).size).toBe(1)
  expect(room.inviteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  expect(room).toMatchObject({ hostId: host.userId, status: 'lobby', members: [{ userId: host.userId, role: null }] })
  // A second room gets a different code.
  const second = ok(await host.call<Room>('createRoom', { commandId: cid() }))
  expect(second.roomId).not.toBe(room.roomId)
  expect(second.inviteCode).not.toBe(room.inviteCode)

  // A wrong code tells nothing; the room id is not a code.
  for (const inviteCode of ['000000000000', room.roomId, '', 'ZZZZ']) {
    expect(await others[0].call<Room>('joinRoom', { inviteCode })).toMatchObject({ success: false, code: 'invalid_invite' })
  }

  // Three people race for the two free seats, each from "two tabs" at once.
  const joins = await Promise.all(
    [...others, ...others].map((p) => p.call<Room>('joinRoom', { inviteCode: room.inviteCode }).then((body) => ({ p, body }))),
  )
  const winners = others.filter((p) => joins.some((j) => j.p === p && j.body.success))
  const losers = others.filter((p) => !winners.includes(p))
  expect(winners).toHaveLength(2)
  expect(losers).toHaveLength(1)
  // Both tabs of a winner were told yes; both tabs of the loser were told the room is full.
  for (const { p, body } of joins) {
    if (winners.includes(p)) expect(body.success).toBe(true)
    else expect(body).toMatchObject({ success: false, code: 'room_full' })
  }
  const [loser] = losers
  const lobby = ok(await host.call<Room>('syncRoom', { roomId: room.roomId }))
  expect(lobby.members.map((m) => m.userId).sort()).toEqual([host, ...winners].map((p) => p.userId).sort())
  expect(new Set(lobby.members.map((m) => m.userId)).size).toBe(3)
  // Exactly two join events were written: host is implicit, duplicates wrote nothing.
  expect(lobby.lobbySeq).toBe(2)

  // The person who did not get in can do nothing with the room id.
  for (const name of ['syncRoom', 'claimRole', 'releaseRole', 'leaveRoom', 'startRoom', 'abandonRoom']) {
    expect(await loser.call<Room>(name, { roomId: room.roomId, role: 'commander' })).toMatchObject({ success: false, code: 'forbidden' })
  }
  expect(await loser.call<Room>('joinRoom', { inviteCode: room.inviteCode })).toMatchObject({ success: false, code: 'room_full' })

  // All three members grab "commander" at once, twice each.
  const members = [host, ...winners]
  const claims = await Promise.all(
    [...members, ...members].map((p) => p.call<Room>('claimRole', { roomId: room.roomId, role: 'commander' }).then((body) => ({ p, body }))),
  )
  const commanders = members.filter((p) => claims.some((c) => c.p === p && c.body.success))
  expect(commanders).toHaveLength(1)
  for (const { p, body } of claims) {
    if (p !== commanders[0]) expect(body).toMatchObject({ success: false, code: 'role_taken' })
  }
  const afterClaims = ok(await host.call<Room>('syncRoom', { roomId: room.roomId }))
  expect(afterClaims.members.filter((m) => m.role === 'commander').map((m) => m.userId)).toEqual([commanders[0].userId])
  expect(afterClaims.lobbySeq).toBe(3)

  // Starting is refused until every role is filled, and for anyone but the host.
  expect(await host.call<Room>('startRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'room_not_ready' })
  const rest = members.filter((p) => p !== commanders[0])
  // The two others race for "security"; the one who loses takes what is left.
  const race = await Promise.all(rest.map((p) => p.call<Room>('claimRole', { roomId: room.roomId, role: 'security' })))
  expect(race.filter((r) => r.success)).toHaveLength(1)
  const last = rest[race.findIndex((r) => !r.success)]
  expect(await last.call<Room>('claimRole', { roomId: room.roomId, role: 'director' })).toMatchObject({ success: false, code: 'unknown_role' })
  ok(await last.call<Room>('claimRole', { roomId: room.roomId, role: 'infrastructure' }))
  for (const p of winners) {
    expect(await p.call<Room>('startRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'not_host' })
  }

  // The host presses start several times at once: one start, one clock.
  const starts = await Promise.all([1, 2, 3, 4].map(() => host.call<Room>('startRoom', { roomId: room.roomId })))
  const startedAt = new Set(starts.map((s) => ok(s).startedAt))
  expect(startedAt.size).toBe(1)
  const active = ok(starts[0])
  expect(active.status).toBe('active')
  expect(active.deadlineAt! - active.startedAt!).toBe(480_000)
  expect(active.members.map((m) => m.role).sort()).toEqual([...ROLES].sort())
  expect(active.lobbySeq).toBe(6)

  // After the start nothing about membership or roles can change — not even by the host.
  for (const p of members) {
    const held = active.members.find((m) => m.userId === p.userId)!.role
    const other = ROLES.find((r) => r !== held)!
    expect(await p.call<Room>('claimRole', { roomId: room.roomId, role: other })).toMatchObject({ success: false, code: 'roles_locked' })
    expect(await p.call<Room>('releaseRole', { roomId: room.roomId })).toMatchObject({ success: false, code: 'roles_locked' })
    expect(await p.call<Room>('leaveRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'roles_locked' })
  }
  expect(await host.call<Room>('abandonRoom', { roomId: room.roomId })).toMatchObject({ success: false, code: 'roles_locked' })
  expect(await loser.call<Room>('joinRoom', { inviteCode: room.inviteCode })).toMatchObject({ success: false, code: 'room_not_open' })
  // A participant using the code again is simply still in.
  expect(ok(await winners[0].call<Room>('joinRoom', { inviteCode: room.inviteCode })).status).toBe('active')
  const final = ok(await host.call<Room>('syncRoom', { roomId: room.roomId }))
  expect(final.lobbySeq).toBe(6)
  expect(final.startedAt).toBe(active.startedAt)

  // The untouched second room: its host can close it, and then nobody can join.
  expect(ok(await host.call<Room>('abandonRoom', { roomId: second.roomId })).status).toBe('abandoned')
  expect(await loser.call<Room>('joinRoom', { inviteCode: second.inviteCode })).toMatchObject({ success: false, code: 'room_not_open' })
})

test('room data reaches participants only, and no client can write it', async ({ users }) => {
  test.setTimeout(120_000)
  const contexts = await users(4)
  const [host, guest, third, outsider] = await Promise.all(contexts.map((c) => player(c.page)))
  // Everyone listens to everything they can, from before the room exists.
  await Promise.all([openSpy(host, 'a'), openSpy(guest, 'a'), openSpy(third, 'a'), openSpy(outsider, 'a')])

  const room = ok(await host.call<Room>('createRoom', { commandId: cid() }))
  // Before joining, the guest cannot see the room at all.
  expect((await readable(guest, 'team_rooms')).some((r) => r.recordId === room.roomId)).toBe(false)
  ok(await guest.call<Room>('joinRoom', { inviteCode: room.inviteCode }))
  // After joining, the room row is theirs to read — and it arrived live.
  const guestRows = await readable(guest, 'team_rooms')
  expect(guestRows.find((r) => r.recordId === room.roomId)?.data).toMatchObject({ status: 'lobby', inviteCode: room.inviteCode })
  await expect.poll(async () => (await spyFrames(guest, 'a')).some((f) => f.includes(room.roomId)), { timeout: 10_000 }).toBe(true)

  ok(await third.call<Room>('joinRoom', { inviteCode: room.inviteCode }))
  ok(await host.call<Room>('claimRole', { roomId: room.roomId, role: 'security' }))
  ok(await guest.call<Room>('claimRole', { roomId: room.roomId, role: 'commander' }))
  ok(await third.call<Room>('claimRole', { roomId: room.roomId, role: 'infrastructure' }))

  // A member tries to rewrite the room, the lobby log and the game by hand.
  const forgedRoom = { status: 'active', memberIds: [guest.userId], members: [{ userId: guest.userId, role: 'commander', joinedAt: 1 }], hostId: guest.userId, lobbySeq: 99, startedAt: 1, deadlineAt: 9e15 }
  const put = (collection: string, recordId: string, data: Record<string, unknown>) => ({ type: 'core.put', payload: { collection, recordId, requestId: crypto.randomUUID(), data } })
  const replies = await spySend(guest, 'a', [
    put('team_rooms', room.roomId, forgedRoom),
    put('team_rooms', crypto.randomUUID(), { ...forgedRoom, createCommandId: 'forged-command-1', inviteCode: 'AAAAAAAAAAAA', scenarioId: 'operation-nightfall', rulesVersion: 2, createdAt: 1 }),
    put('team_room_events', crypto.randomUUID(), { roomId: room.roomId, seq: 6, type: 'role_claimed', userId: guest.userId, role: 'security', at: Date.now() }),
    put('simulation_events', crypto.randomUUID(), { simulationId: room.roomId, seq: 1, ownerId: guest.userId, type: 'action_completed', actionId: 'restore_auth', at: 1, readers: [guest.userId] }),
    put('simulation_findings', crypto.randomUUID(), { simulationId: room.roomId, eventSeq: 1, scope: 'team', ownerId: guest.userId, readers: [outsider.userId], text: 'forged', at: 1 }),
    { type: 'core.delete', payload: { collection: 'team_rooms', recordId: room.roomId, requestId: crypto.randomUUID() } },
  ])
  const denied = replies.filter((f) => /DENIED|denied|not allowed|permission/i.test(f))
  expect(denied.length, replies.join('\n')).toBeGreaterThanOrEqual(5)
  const unchanged = ok(await host.call<Room>('syncRoom', { roomId: room.roomId }))
  expect(unchanged).toMatchObject({ status: 'lobby', hostId: host.userId, lobbySeq: 5 })
  expect(unchanged.members.map((m) => [m.userId, m.role])).toEqual([
    [host.userId, 'security'],
    [guest.userId, 'commander'],
    [third.userId, 'infrastructure'],
  ])

  // Start, and let security run one investigation to its end.
  ok(await host.call<Room>('startRoom', { roomId: room.roomId }))
  const run = ok(await host.call<Executed>('executeAction', { simulationId: room.roomId, actionId: 'inspect_access_logs', commandId: cid() }))
  await sleep(Math.max(0, run.completesAt - Date.now()) + 1500)
  const securityView = ok(await host.call<Sync>('syncSimulation', { simulationId: room.roomId }))
  const privateFinding = securityView.findings.find((f) => f.scope === 'private')!
  expect(privateFinding).toMatchObject({ ownerId: host.userId })
  expect(privateFinding.text.length).toBeGreaterThan(20)
  const teamFinding = securityView.findings.find((f) => f.scope === 'team')!

  // What each person can read back over the realtime connection.
  const eventsOf = async (p: Player) => (await readable(p, 'simulation_events', { simulationId: room.roomId })).length
  const findingsOf = async (p: Player) => (await readable(p, 'simulation_findings', { simulationId: room.roomId })).map((r) => r.data)
  expect(await eventsOf(host)).toBe(securityView.events.length)
  expect(await eventsOf(guest)).toBe(securityView.events.length)
  expect(await eventsOf(third)).toBe(securityView.events.length)
  expect(await eventsOf(outsider)).toBe(0)
  expect((await findingsOf(host)).map((f) => f.scope).sort()).toEqual(securityView.findings.map((f) => f.scope).sort())
  for (const p of [guest, third]) {
    const rows = await findingsOf(p)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((f) => f.scope === 'team')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(privateFinding.text)
  }
  expect(await findingsOf(outsider)).toEqual([])
  // (The outsider may hold rooms of their own from other tests; never this one.)
  expect((await readable(outsider, 'team_rooms')).map((r) => r.recordId)).not.toContain(room.roomId)
  // The lobby log is readable by nobody, members included; shared events carry no finding text.
  for (const p of [host, guest, third, outsider]) expect(await readable(p, 'team_room_events')).toEqual([])
  const eventRows = await readable(guest, 'simulation_events', { simulationId: room.roomId })
  expect(eventRows.every((r) => !r.data.finding)).toBe(true)

  // The outsider's and the other members' server actions agree.
  expect(await outsider.call<Sync>('syncSimulation', { simulationId: room.roomId })).toMatchObject({ success: false, code: 'forbidden' })
  const commanderView = ok(await guest.call<Sync>('syncSimulation', { simulationId: room.roomId }))
  expect(commanderView.events).toEqual(securityView.events)
  expect(commanderView.findings.every((f) => f.scope === 'team')).toBe(true)

  // Nobody but the owner can share it; then the owner does, and it reaches the team.
  for (const p of [guest, third, outsider]) {
    const attempt = await p.call<unknown>('shareFinding', { simulationId: room.roomId, eventSeq: privateFinding.eventSeq })
    expect(attempt).toMatchObject({ success: false, code: p === outsider ? 'forbidden' : 'finding_not_found' })
  }
  const before = await roomFrames(guest, 'a', room.roomId)
  expect(before).not.toContain(privateFinding.text)
  expect(before).toContain(teamFinding.text)
  const shares = await Promise.all([1, 2, 3].map(() => host.call<{ replayed: boolean }>('shareFinding', { simulationId: room.roomId, eventSeq: privateFinding.eventSeq, text: 'forged text' })))
  expect(shares.every((s) => s.success)).toBe(true)
  for (const p of [guest, third]) {
    const shared = ok(await p.call<Sync>('syncSimulation', { simulationId: room.roomId })).findings.find((f) => f.eventSeq === privateFinding.eventSeq)
    expect(shared).toMatchObject({ scope: 'team', text: privateFinding.text, sharedBy: host.userId })
    await expect.poll(async () => (await roomFrames(p, 'a', room.roomId)).includes(privateFinding.text), { timeout: 10_000 }).toBe(true)
  }
  expect((await findingsOf(host)).filter((f) => f.eventSeq === privateFinding.eventSeq)).toHaveLength(2)

  // Through all of it, nothing about this room ever reached the outsider's socket.
  const leaked = (await spyFrames(outsider, 'a')).join('\n')
  // Every row of this room carries its id (or its code), so no frame may mention either.
  for (const secret of [room.roomId, room.inviteCode]) expect(leaked).not.toContain(secret)
  expect(await findingsOf(outsider)).toEqual([])
})

test('roles and commander approvals are enforced by the server', async ({ users }) => {
  test.setTimeout(120_000)
  const { roomId, security, commander, infrastructure, outsider, startedAt } = await startedTeam(users)
  const act = (p: Player, actionId: string, extra: Record<string, unknown> = {}) =>
    p.call<Executed>('executeAction', { simulationId: roomId, actionId, commandId: cid(), ...extra })
  const decide = (p: Player, actionId: string, requestSeq: unknown, decision: unknown, commandId = cid()) =>
    p.call<Decided>('decideApproval', { simulationId: roomId, actionId, requestSeq, decision, commandId })

  // Each participant is refused the other roles' actions; the host (security) included.
  const first: Record<Role, string> = { security: 'inspect_access_logs', infrastructure: 'review_deployment', commander: 'issue_customer_advisory' }
  const holder: Record<Role, Player> = { security, commander, infrastructure }
  for (const role of ROLES) {
    for (const other of ROLES) {
      if (other !== role) expect(await act(holder[other], first[role])).toMatchObject({ success: false, code: 'wrong_role' })
    }
    expect(await act(outsider, first[role])).toMatchObject({ success: false, code: 'forbidden' })
  }
  // Claiming a role, an identity or a time in the request body changes nothing.
  const forged = { role: 'commander', roles: ROLES, userId: commander.userId, actorId: commander.userId, at: 1, now: 1, startedAt: 1 }
  expect(await act(security, 'issue_customer_advisory', forged)).toMatchObject({ success: false, code: 'wrong_role' })
  expect(await act(outsider, 'issue_customer_advisory', forged)).toMatchObject({ success: false, code: 'forbidden' })
  expect(moves(ok(await commander.call<Sync>('syncSimulation', { simulationId: roomId })).events)).toEqual([])

  // Infrastructure asks to roll back. Only infrastructure may ask.
  const ask = (p: Player, commandId = cid()) => p.call<Requested>('requestApproval', { simulationId: roomId, actionId: 'roll_back_release', commandId })
  expect(await ask(security)).toMatchObject({ success: false, code: 'wrong_role' })
  expect(await ask(commander)).toMatchObject({ success: false, code: 'wrong_role' })
  expect(await ask(outsider)).toMatchObject({ success: false, code: 'forbidden' })
  const askId = cid()
  const asked = await Promise.all([ask(infrastructure, askId), ask(infrastructure, askId), ask(infrastructure)])
  // Same command twice → one request, replayed; a different command for the same thing → refused.
  const requests = asked.filter((a) => a.success)
  const request = ok(requests[0])
  expect(new Set(requests.map((r) => r.data!.requestSeq)).size).toBe(1)
  expect(request.status).toBe('requested')
  expect(asked.filter((a) => !a.success).every((a) => a.code === 'approval_already_requested')).toBe(true)
  // Not approved yet: the action cannot run.
  expect(await act(infrastructure, 'roll_back_release')).toMatchObject({ success: false, code: 'approval_required' })

  // Decisions by anyone but the commander — including the host and the requester.
  for (const p of [security, infrastructure]) {
    for (const decision of ['approve', 'deny']) {
      expect(await decide(p, 'roll_back_release', request.requestSeq, decision)).toMatchObject({ success: false, code: 'wrong_role' })
    }
  }
  expect(await decide(outsider, 'roll_back_release', request.requestSeq, 'approve')).toMatchObject({ success: false, code: 'forbidden' })
  // Forged or mismatched references from the real commander.
  for (const seq of [request.requestSeq + 1, request.requestSeq - 1, 1, 424242]) {
    expect(await decide(commander, 'roll_back_release', seq, 'approve')).toMatchObject({ success: false, code: 'stale_request' })
  }
  for (const seq of [String(request.requestSeq), null, 1.5, -3, { $gt: 0 }]) {
    expect(await decide(commander, 'roll_back_release', seq, 'approve')).toMatchObject({ success: false, code: 'invalid_request' })
  }
  expect(await decide(commander, 'rotate_signing_keys', request.requestSeq, 'approve')).toMatchObject({ success: false, code: 'no_pending_request' })
  expect(await decide(commander, 'revoke_admin_sessions', request.requestSeq, 'approve')).toMatchObject({ success: false, code: 'no_pending_request' })
  expect(await decide(commander, 'review_deployment', request.requestSeq, 'approve')).toMatchObject({ success: false, code: 'approval_not_needed' })
  expect(await decide(commander, 'roll_back_release', request.requestSeq, 'maybe')).toMatchObject({ success: false, code: 'invalid_request' })
  let view = ok(await commander.call<Sync>('syncSimulation', { simulationId: roomId }))
  expect(moves(view.events).map((e) => e.type)).toEqual(['approval_requested'])

  // The commander denies and approves at the same instant from two tabs: one decision is recorded.
  const denyId = cid()
  const approveId = cid()
  const decisions = await Promise.all([
    decide(commander, 'roll_back_release', request.requestSeq, 'deny', denyId),
    decide(commander, 'roll_back_release', request.requestSeq, 'approve', approveId),
    decide(commander, 'roll_back_release', request.requestSeq, 'deny', denyId),
  ])
  const accepted = decisions.filter((d) => d.success)
  expect(new Set(accepted.map((d) => d.data!.seq)).size).toBe(1)
  expect(decisions.filter((d) => !d.success).every((d) => d.code === 'no_pending_request')).toBe(true)
  view = ok(await security.call<Sync>('syncSimulation', { simulationId: roomId }))
  expectWellFormed(view.events)
  const recorded = view.events.filter((e) => e.type === 'approval_granted' || e.type === 'approval_denied')
  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({ actorId: commander.userId, actionId: 'roll_back_release' })
  const winner = ok(accepted[0])
  // The decision's time is the server's, inside this simulation, and takes five seconds to come into effect.
  expect(recorded[0].at).toBeGreaterThanOrEqual(startedAt)
  expect(winner.effectiveAt - recorded[0].at).toBe(5000)
  // The decided request cannot be decided again.
  expect(await decide(commander, 'roll_back_release', request.requestSeq, 'approve')).toMatchObject({ success: false, code: 'no_pending_request' })

  if (winner.decision === 'denied') {
    // A denial ends that request. After it takes effect infrastructure may ask again; the old id is dead.
    expect(await act(infrastructure, 'roll_back_release')).toMatchObject({ success: false })
    await sleep(Math.max(0, winner.effectiveAt - Date.now()) + 1000)
    expect(await act(infrastructure, 'roll_back_release')).toMatchObject({ success: false, code: 'approval_denied' })
    const again = ok(await ask(infrastructure))
    expect(again.requestSeq).toBeGreaterThan(request.requestSeq)
    expect(await decide(commander, 'roll_back_release', request.requestSeq, 'approve')).toMatchObject({ success: false, code: 'stale_request' })
    const granted = ok(await decide(commander, 'roll_back_release', again.requestSeq, 'approve'))
    await sleep(Math.max(0, granted.effectiveAt - Date.now()) + 1000)
  } else {
    expect(await act(infrastructure, 'roll_back_release')).toMatchObject({ success: false, code: 'approval_pending' })
    await sleep(Math.max(0, winner.effectiveAt - Date.now()) + 1000)
  }
  // Approved and in effect: only infrastructure can run it.
  expect(await act(security, 'roll_back_release')).toMatchObject({ success: false, code: 'wrong_role' })
  expect(await act(commander, 'roll_back_release')).toMatchObject({ success: false, code: 'wrong_role' })
  const rolled = ok(await act(infrastructure, 'roll_back_release'))
  expect(rolled.completesAt - rolled.startedAt).toBe(30_000)
  view = ok(await commander.call<Sync>('syncSimulation', { simulationId: roomId }))
  expectWellFormed(view.events)
  expect(view.events.find((e) => e.type === 'action_started')).toMatchObject({ actionId: 'roll_back_release', actorId: infrastructure.userId })
  expect(view.events.some((e) => e.type === 'approval_auto_granted')).toBe(false)
})

test('simultaneous, conflicting and repeated commands leave one consistent shared log', async ({ users }) => {
  test.setTimeout(120_000)
  const { roomId, security, commander, infrastructure } = await startedTeam(users)
  const ids = { s: cid(), i: cid(), c: cid() }
  const send = (p: Player, actionId: string, commandId = cid()) =>
    p.call<Executed>('executeAction', { simulationId: roomId, actionId, commandId }).then((body) => ({ actionId, commandId, body }))

  // All three act at once; every command is also sent twice; and infrastructure
  // tries a second action in the same instant, which only one of can win.
  const burst = () => [
    send(security, 'inspect_access_logs', ids.s),
    send(infrastructure, 'review_deployment', ids.i),
    send(commander, 'issue_customer_advisory', ids.c),
    send(security, 'inspect_access_logs'),
    send(commander, 'issue_customer_advisory'),
  ]
  const results = await Promise.all([...burst(), ...burst(), ...burst()])
  const view = ok(await security.call<Sync>('syncSimulation', { simulationId: roomId }))
  expectWellFormed(view.events)
  const started = view.events.filter((e) => e.type === 'action_started')
  // One start per action, whatever arrived: three roles, three actions.
  expect(started.map((e) => e.actionId).sort()).toEqual(['inspect_access_logs', 'issue_customer_advisory', 'review_deployment'])
  expect(started.map((e) => e.actorId).sort()).toEqual([security.userId, commander.userId, infrastructure.userId].sort())
  // Every accepted response for one action names the same event.
  for (const actionId of ['inspect_access_logs', 'review_deployment', 'issue_customer_advisory']) {
    const event = started.find((e) => e.actionId === actionId)!
    const accepted = results.filter((r) => r.actionId === actionId && r.body.success)
    expect(accepted.length).toBeGreaterThanOrEqual(1)
    for (const r of accepted) expect(r.body.data).toMatchObject({ seq: event.seq, startedAt: event.at })
    // Whoever won, all repeats of that command id were told the same thing.
    const sameCommand = results.filter((r) => r.commandId === event.commandId)
    expect(sameCommand.every((r) => r.body.success)).toBe(true)
    // And everything refused was refused for a rule, not by accident.
    for (const r of results.filter((x) => x.actionId === actionId && !x.body.success)) {
      expect(['action_already_used', 'role_busy']).toContain(r.body.code)
    }
  }
  // While each role is busy, a second action for that role is refused.
  expect((await send(security, 'correlate_session_events')).body).toMatchObject({ success: false })
  expect((await send(infrastructure, 'roll_back_release')).body).toMatchObject({ success: false, code: 'approval_required' })

  // Security "disconnects" mid-action: nobody calls for them. The action still completes, on time.
  const inspect = started.find((e) => e.actionId === 'inspect_access_logs')!
  await sleep(Math.max(0, inspect.at + 15_000 - Date.now()) + 1500)
  const later = ok(await commander.call<Sync>('syncSimulation', { simulationId: roomId }))
  expectWellFormed(later.events)
  const done = later.events.find((e) => e.type === 'action_completed' && e.actionId === 'inspect_access_logs')
  expect(done?.at).toBe(inspect.at + 15_000)
  // Three people syncing at once all see the same log, and nothing is added twice.
  const views = await Promise.all([security, commander, infrastructure, security, commander].map((p) => p.call<Sync>('syncSimulation', { simulationId: roomId })))
  const logs = views.map((v) => ok(v).events)
  for (const log of logs) expectWellFormed(log)
  const longest = logs.reduce((a, b) => (b.length > a.length ? b : a))
  for (const log of logs) expect(log).toEqual(longest.slice(0, log.length))
  expect(longest.filter((e) => e.type === 'action_completed' && e.actionId === 'inspect_access_logs')).toHaveLength(1)
  // Security reconnects: the old command replays the original result rather than acting again.
  const replay = await send(security, 'inspect_access_logs', ids.s)
  expect(replay.body).toMatchObject({ success: true, data: { replayed: true, seq: inspect.seq } })
  expect(ok((await send(security, 'correlate_session_events')).body).replayed).toBe(false)
})

test('two rooms never see or affect each other', async ({ users }) => {
  test.setTimeout(120_000)
  const a = await startedTeam(users)
  // Room B: the outsider hosts, with two of room A's people in different roles.
  const { outsider, security, commander, infrastructure } = a
  const roomB = ok(await outsider.call<Room>('createRoom', { commandId: cid() }))
  ok(await commander.call<Room>('joinRoom', { inviteCode: roomB.inviteCode }))
  ok(await security.call<Room>('joinRoom', { inviteCode: roomB.inviteCode }))
  ok(await outsider.call<Room>('claimRole', { roomId: roomB.roomId, role: 'commander' }))
  ok(await commander.call<Room>('claimRole', { roomId: roomB.roomId, role: 'security' }))
  ok(await security.call<Room>('claimRole', { roomId: roomB.roomId, role: 'infrastructure' }))
  const b = ok(await outsider.call<Room>('startRoom', { roomId: roomB.roomId }))
  expect(b.startedAt).not.toBe(a.startedAt)

  const act = (p: Player, simulationId: string, actionId: string) => p.call<Executed>('executeAction', { simulationId, actionId, commandId: cid() })
  // A's infrastructure engineer is nobody in B; B's host is nobody in A.
  expect(await act(infrastructure, roomB.roomId, 'review_deployment')).toMatchObject({ success: false, code: 'forbidden' })
  expect(await infrastructure.call<Room>('syncRoom', { roomId: roomB.roomId })).toMatchObject({ success: false, code: 'forbidden' })
  expect(await act(outsider, a.roomId, 'issue_customer_advisory')).toMatchObject({ success: false, code: 'forbidden' })
  // A role held in one room is not held in the other.
  expect(await act(commander, roomB.roomId, 'issue_customer_advisory')).toMatchObject({ success: false, code: 'wrong_role' })
  expect(await act(security, roomB.roomId, 'inspect_access_logs')).toMatchObject({ success: false, code: 'wrong_role' })
  ok(await act(commander, roomB.roomId, 'inspect_access_logs')) // security in B
  ok(await act(commander, a.roomId, 'issue_customer_advisory')) // commander in A
  ok(await act(security, a.roomId, 'inspect_access_logs')) // security in A

  // An approval request in B cannot be decided by A's commander (who is B's security), nor quoted in A.
  const request = ok(await security.call<Requested>('requestApproval', { simulationId: roomB.roomId, actionId: 'roll_back_release', commandId: cid() }))
  const decideIn = (p: Player, simulationId: string) => p.call<Decided>('decideApproval', { simulationId, actionId: 'roll_back_release', requestSeq: request.requestSeq, decision: 'approve', commandId: cid() })
  expect(await decideIn(commander, roomB.roomId)).toMatchObject({ success: false, code: 'wrong_role' })
  expect(await decideIn(commander, a.roomId)).toMatchObject({ success: false, code: 'no_pending_request' })
  ok(await decideIn(outsider, roomB.roomId))

  const logA = ok(await infrastructure.call<Sync>('syncSimulation', { simulationId: a.roomId }))
  const logB = ok(await outsider.call<Sync>('syncSimulation', { simulationId: roomB.roomId }))
  expectWellFormed(logA.events)
  expectWellFormed(logB.events)
  expect(logA.startedAt).toBe(a.startedAt)
  expect(logB.startedAt).toBe(b.startedAt)
  expect(moves(logA.events).map((e) => `${e.type}:${e.actionId}`).sort()).toEqual(['action_started:inspect_access_logs', 'action_started:issue_customer_advisory'].sort())
  expect(moves(logB.events).filter((e) => e.type !== 'action_completed').map((e) => `${e.type}:${e.actionId}`)).toEqual([
    'action_started:inspect_access_logs',
    'approval_requested:roll_back_release',
    'approval_granted:roll_back_release',
  ])
  // Realtime: each room's rows go to that room's three people only.
  const rows = async (p: Player, simulationId: string) => (await readable(p, 'simulation_events', { simulationId })).length
  expect(await rows(infrastructure, roomB.roomId)).toBe(0)
  expect(await rows(outsider, a.roomId)).toBe(0)
  expect(await rows(infrastructure, a.roomId)).toBeGreaterThan(0)
  expect(await rows(outsider, roomB.roomId)).toBeGreaterThan(0)
  expect((await readable(infrastructure, 'team_rooms')).map((r) => r.recordId)).not.toContain(roomB.roomId)
  expect((await readable(outsider, 'team_rooms')).map((r) => r.recordId)).not.toContain(a.roomId)
  expect((await readable(security, 'team_rooms')).map((r) => r.recordId)).toEqual(expect.arrayContaining([a.roomId, roomB.roomId]))
})

test('a team plays Operation Nightfall to a complete recovery; nothing is accepted afterwards', async ({ users }) => {
  test.setTimeout(300_000)
  const { roomId, security, commander, infrastructure, outsider, startedAt } = await startedTeam(users)
  const until = async (seconds: number) => sleep(Math.max(0, startedAt + seconds * 1000 - Date.now()) + 400)
  const act = async (p: Player, actionId: string) => ok(await p.call<Executed>('executeAction', { simulationId: roomId, actionId, commandId: cid() }))
  /** Ask, have the commander approve that very request, and wait for it to take effect. */
  const approved = async (p: Player, actionId: string) => {
    const request = ok(await p.call<Requested>('requestApproval', { simulationId: roomId, actionId, commandId: cid() }))
    const decision = ok(await commander.call<Decided>('decideApproval', { simulationId: roomId, actionId, requestSeq: request.requestSeq, decision: 'approve', commandId: cid() }))
    await sleep(Math.max(0, decision.effectiveAt - Date.now()) + 300)
  }
  /** Run an action and wait for it to finish. */
  const finish = async (p: Player, actionId: string) => {
    const run = await act(p, actionId)
    await sleep(Math.max(0, run.completesAt - Date.now()) + 400)
  }

  // Three people working in parallel: security investigates and contains,
  // infrastructure rotates, restores and validates, the commander approves,
  // informs customers and closes.
  await act(commander, 'issue_customer_advisory')
  await finish(security, 'inspect_access_logs')
  await finish(security, 'correlate_session_events')
  const investigate = await act(security, 'investigate_signing_access')
  await approved(security, 'revoke_admin_sessions')
  await sleep(Math.max(0, investigate.completesAt - Date.now()) + 400)
  const revoke = await act(security, 'revoke_admin_sessions')
  await approved(infrastructure, 'rotate_signing_keys')
  const rotate = await act(infrastructure, 'rotate_signing_keys')
  await sleep(Math.max(0, Math.max(revoke.completesAt, rotate.completesAt) - Date.now()) + 400)
  await finish(infrastructure, 'restore_auth')
  await finish(infrastructure, 'validate_recovery')
  // Only the commander can close the incident.
  for (const p of [security, infrastructure]) {
    expect(await p.call<Executed>('executeAction', { simulationId: roomId, actionId: 'confirm_resolution', commandId: cid() })).toMatchObject({ success: false, code: 'wrong_role' })
  }
  const confirmId = cid()
  const closed = ok(await commander.call<Executed>('executeAction', { simulationId: roomId, actionId: 'confirm_resolution', commandId: confirmId }))
  expect(closed.result).toMatchObject({ outcome: 'complete_recovery', reason: 'confirmed' })
  expect(closed.result!.score).toBeGreaterThanOrEqual(96)

  // Everyone sees the same finished game; the room says completed.
  const views = await Promise.all([security, commander, infrastructure].map((p) => p.call<Sync>('syncSimulation', { simulationId: roomId })))
  for (const v of views) {
    const view = ok(v)
    expectWellFormed(view.events)
    expect(view.events).toEqual(ok(views[0]).events)
    expect(view.result).toEqual(closed.result)
    expect(view.events.every((e) => !e.finding)).toBe(true)
  }
  const log = ok(views[0]).events
  expect(log.filter((e) => e.type === 'approval_granted').map((e) => e.actorId)).toEqual([commander.userId, commander.userId])
  expect(log.some((e) => e.type === 'approval_auto_granted')).toBe(false)
  for (const e of log.filter((x) => x.type === 'action_started')) {
    const role = ['issue_customer_advisory', 'confirm_resolution'].includes(e.actionId!) ? commander : ['rotate_signing_keys', 'restore_auth', 'validate_recovery'].includes(e.actionId!) ? infrastructure : security
    expect(e.actorId).toBe(role.userId)
  }
  expect(ok(await infrastructure.call<Room>('syncRoom', { roomId })).status).toBe('completed')
  await expect.poll(async () => (await readable(security, 'team_rooms')).find((r) => r.recordId === roomId)?.data.status, { timeout: 10_000 }).toBe('completed')

  // After completion: every command from everyone is refused, repeats included, and the log does not grow.
  await until(0)
  const refusals = await Promise.all([
    security.call<Executed>('executeAction', { simulationId: roomId, actionId: 'validate_containment', commandId: cid() }),
    infrastructure.call<Executed>('executeAction', { simulationId: roomId, actionId: 'review_deployment', commandId: cid() }),
    infrastructure.call<Requested>('requestApproval', { simulationId: roomId, actionId: 'roll_back_release', commandId: cid() }),
    commander.call<Decided>('decideApproval', { simulationId: roomId, actionId: 'roll_back_release', requestSeq: 2, decision: 'approve', commandId: cid() }),
    security.call<Executed>('executeAction', { simulationId: roomId, actionId: 'validate_containment', commandId: cid() }),
  ])
  for (const r of refusals) expect(r).toMatchObject({ success: false, code: 'simulation_ended' })
  expect(await outsider.call<Sync>('syncSimulation', { simulationId: roomId })).toMatchObject({ success: false, code: 'forbidden' })
  // The closing command itself replays its original result.
  const replay = ok(await commander.call<Executed>('executeAction', { simulationId: roomId, actionId: 'confirm_resolution', commandId: confirmId }))
  expect(replay).toMatchObject({ replayed: true, seq: closed.seq, result: closed.result })
  for (const name of ['claimRole', 'leaveRoom', 'abandonRoom', 'startRoom']) {
    const body = await security.call<Room>(name, { roomId, role: 'commander' })
    if (name === 'startRoom') expect(ok(body).startedAt).toBe(startedAt)
    else expect(body).toMatchObject({ success: false, code: 'roles_locked' })
  }
  expect(ok(await security.call<Sync>('syncSimulation', { simulationId: roomId })).events).toEqual(log)
})
