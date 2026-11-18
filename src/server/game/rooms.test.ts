import { describe, expect, it } from 'vitest'
import { reduce, type ActionId, type RoleId } from '../../game/engine'
import { reduceLobby } from '../../game/lobby'
import {
  createSoloSimulation,
  decideApproval,
  executeAction,
  requestApproval,
  shareFinding,
  syncSimulation,
} from './commands'
import {
  abandonRoom,
  claimRole,
  createRoom,
  joinRoom,
  leaveRoom,
  releaseRole,
  startRoom,
  syncRoom,
  type RoomSnapshot,
} from './rooms'
import { memoryStore } from './store.testkit'

type Store = ReturnType<typeof memoryStore>['store']

const T0 = 1_800_000_000_000
const HOST = 'user-host' // plays security: the host is deliberately NOT the commander
const CMDR = 'user-cmdr'
const INFRA = 'user-infra'
const OUTSIDER = 'user-outsider'
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)

let counter = 0
const cid = () => `cmd-${String(++counter).padStart(8, '0')}`
/** Deterministic stand-in for the platform's random source: distinct bytes on each call. */
function byteSource() {
  let n = 7
  return (length: number) => Uint8Array.from({ length }, () => (n = (n * 73 + 41) % 251))
}

function must<T>(result: { ok: true; data: T } | { ok: false; code: string }): T {
  if (!result.ok) throw new Error(`setup failed: ${result.code}`)
  return result.data
}

async function openRoom(store: Store, host = HOST, now = T0, random = byteSource()): Promise<RoomSnapshot> {
  return must(await createRoom(store, host, { commandId: cid() }, now, random))
}

/** A room with three members and all roles claimed, not yet started. */
async function readyRoom(store: Store, random = byteSource()) {
  const room = await openRoom(store, HOST, T0, random)
  must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 1000))
  must(await joinRoom(store, INFRA, { inviteCode: room.inviteCode }, T0 + 2000))
  must(await claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, T0 + 3000))
  must(await claimRole(store, CMDR, { roomId: room.roomId, role: 'commander' }, T0 + 4000))
  must(await claimRole(store, INFRA, { roomId: room.roomId, role: 'infrastructure' }, T0 + 5000))
  return room
}

const START = T0 + 60_000
/** A started team simulation; returns its id (the room id). */
async function startedRoom(store: Store, random = byteSource()) {
  const room = await readyRoom(store, random)
  must(await startRoom(store, HOST, { roomId: room.roomId }, START))
  return room.roomId
}

const at = (seconds: number) => START + seconds * 1000
const PLAYER: Record<RoleId, string> = { security: HOST, commander: CMDR, infrastructure: INFRA }

describe('createRoom', () => {
  it('creates a lobby with the host as sole member and a 12-symbol code', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    expect(room).toMatchObject({ hostId: HOST, status: 'lobby', startedAt: null, members: [{ userId: HOST, role: null }] })
    expect(room.inviteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  })

  it('is idempotent per command id, also under concurrent retries', async () => {
    for (const seed of SEEDS) {
      const { store, rooms } = memoryStore(seed)
      const commandId = cid()
      const random = byteSource()
      const results = await Promise.all([1, 2, 3, 4].map(() => createRoom(store, HOST, { commandId }, T0, random)))
      expect(new Set(results.map((r) => must(r).roomId)).size).toBe(1)
      expect(new Set(results.map((r) => must(r).inviteCode)).size).toBe(1)
      expect(rooms.size).toBe(1)
    }
  })

  it('gives different rooms different codes and takes no identity from the request', async () => {
    const { store } = memoryStore()
    const random = byteSource()
    const a = await openRoom(store, HOST, T0, random)
    const b = must(await createRoom(store, HOST, { commandId: cid(), hostId: OUTSIDER, userId: OUTSIDER } as never, T0, random))
    expect(a.inviteCode).not.toBe(b.inviteCode)
    expect(b.hostId).toBe(HOST)
    expect(await createRoom(store, HOST, { commandId: 'x' }, T0, random)).toMatchObject({ ok: false, code: 'invalid_request' })
  })
})

describe('joinRoom', () => {
  it('joins by code, however it is typed', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    const typed = ` ${room.inviteCode.slice(0, 4)}-${room.inviteCode.slice(4, 8)}-${room.inviteCode.slice(8)} `.toLowerCase()
    const joined = must(await joinRoom(store, CMDR, { inviteCode: typed }, T0 + 1000))
    expect(joined.roomId).toBe(room.roomId)
    expect(joined.members.map((m) => m.userId)).toEqual([HOST, CMDR])
  })

  it('refuses wrong, malformed and missing codes identically', async () => {
    const { store } = memoryStore()
    await openRoom(store)
    for (const inviteCode of ['000000000000', 'nope', '', null, undefined, 12, { $ne: '' }]) {
      expect(await joinRoom(store, CMDR, { inviteCode }, T0)).toMatchObject({ ok: false, code: 'invalid_invite' })
    }
  })

  it('does not accept a room id in place of the code', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    expect(await joinRoom(store, CMDR, { inviteCode: room.roomId, roomId: room.roomId } as never, T0)).toMatchObject({ ok: false, code: 'invalid_invite' })
  })

  it('refuses a fourth participant', async () => {
    const { store, lobbyEvents } = memoryStore()
    const room = await readyRoom(store)
    expect(await joinRoom(store, OUTSIDER, { inviteCode: room.inviteCode }, T0 + 9000)).toMatchObject({ ok: false, code: 'room_full' })
    expect(lobbyEvents.get(room.roomId)!.filter((e) => e.type === 'member_joined')).toHaveLength(2)
  })

  it('admits exactly two of many simultaneous joiners', async () => {
    for (const seed of SEEDS) {
      const { store, lobbyEvents, rooms } = memoryStore(seed)
      const room = await openRoom(store)
      const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']
      const results = await Promise.all(users.map((u) => joinRoom(store, u, { inviteCode: room.inviteCode }, T0 + 1000)))
      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'room_full')).toBe(true)
      const lobby = reduceLobby(HOST, T0, lobbyEvents.get(room.roomId)!)
      expect(lobby.members).toHaveLength(3)
      expect(new Set(lobby.members.map((m) => m.userId)).size).toBe(3)
      // The view members read converged on the log.
      expect(rooms.get(room.roomId)!.view?.memberIds).toEqual(lobby.members.map((m) => m.userId))
    }
  })

  it('gives one account one seat, however many tabs join at once', async () => {
    for (const seed of SEEDS) {
      const { store, lobbyEvents } = memoryStore(seed)
      const room = await openRoom(store)
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 1000)))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(lobbyEvents.get(room.roomId)).toHaveLength(1)
      // The host joining their own room by code changes nothing either.
      must(await joinRoom(store, HOST, { inviteCode: room.inviteCode }, T0 + 2000))
      expect(lobbyEvents.get(room.roomId)).toHaveLength(1)
    }
  })
})

describe('roles in the lobby', () => {
  it('lets exactly one of several simultaneous claimants take a role', async () => {
    for (const seed of SEEDS) {
      const { store, lobbyEvents } = memoryStore(seed)
      const room = await openRoom(store)
      must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 1000))
      must(await joinRoom(store, INFRA, { inviteCode: room.inviteCode }, T0 + 2000))
      const results = await Promise.all(
        [HOST, CMDR, INFRA].map((u) => claimRole(store, u, { roomId: room.roomId, role: 'commander' }, T0 + 3000)),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'role_taken')).toBe(true)
      const lobby = reduceLobby(HOST, T0, lobbyEvents.get(room.roomId)!)
      expect(lobby.members.filter((m) => m.role === 'commander')).toHaveLength(1)
    }
  })

  it('never leaves one participant with two roles when two tabs claim different roles', async () => {
    for (const seed of SEEDS) {
      const { store, lobbyEvents } = memoryStore(seed)
      const room = await openRoom(store)
      await Promise.all([
        claimRole(store, HOST, { roomId: room.roomId, role: 'commander' }, T0 + 1000),
        claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, T0 + 1000),
      ])
      const lobby = reduceLobby(HOST, T0, lobbyEvents.get(room.roomId)!) // would throw on a corrupt log
      expect(lobby.members).toHaveLength(1)
      expect(['commander', 'security']).toContain(lobby.members[0].role)
    }
  })

  it('swaps, releases, and refuses unknown roles', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    must(await claimRole(store, HOST, { roomId: room.roomId, role: 'commander' }, T0 + 1000))
    const swapped = must(await claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, T0 + 2000))
    expect(swapped.members[0].role).toBe('security')
    expect(must(await releaseRole(store, HOST, { roomId: room.roomId }, T0 + 3000)).members[0].role).toBeNull()
    for (const role of ['admin', 'host', '', null, ['commander']]) {
      expect(await claimRole(store, HOST, { roomId: room.roomId, role }, T0 + 4000)).toMatchObject({ ok: false, code: 'unknown_role' })
    }
  })

  it('lets a member leave, freeing the seat for someone else', async () => {
    const { store } = memoryStore()
    const room = await readyRoom(store)
    expect(await leaveRoom(store, HOST, { roomId: room.roomId }, T0 + 6000)).toMatchObject({ ok: false, code: 'host_cannot_leave' })
    must(await leaveRoom(store, INFRA, { roomId: room.roomId }, T0 + 7000))
    expect(await syncRoom(store, INFRA, { roomId: room.roomId }, T0 + 8000)).toMatchObject({ ok: false, code: 'forbidden' })
    const joined = must(await joinRoom(store, OUTSIDER, { inviteCode: room.inviteCode }, T0 + 9000))
    expect(joined.members.map((m) => m.userId)).toEqual([HOST, CMDR, OUTSIDER])
    expect(joined.members.find((m) => m.userId === OUTSIDER)?.role).toBeNull()
  })
})

describe('room access', () => {
  it('shows a room to its members only; missing and foreign rooms look the same', async () => {
    const { store } = memoryStore()
    const room = await readyRoom(store)
    const foreign = await syncRoom(store, OUTSIDER, { roomId: room.roomId }, T0 + 9000)
    const missing = await syncRoom(store, OUTSIDER, { roomId: 'room-999999' }, T0 + 9000)
    expect(foreign).toEqual(missing)
    expect(foreign).toMatchObject({ ok: false, code: 'forbidden' })
    for (const command of [claimRole, releaseRole, leaveRoom, startRoom, abandonRoom]) {
      expect(await command(store, OUTSIDER, { roomId: room.roomId, role: 'commander' }, T0 + 9000)).toMatchObject({ ok: false, code: 'forbidden' })
    }
    for (const roomId of [null, undefined, 7, '', { id: room.roomId }]) {
      expect(await syncRoom(store, HOST, { roomId }, T0 + 9000)).toMatchObject({ ok: false, code: 'forbidden' })
    }
  })

  it('keeps two rooms apart', async () => {
    const { store } = memoryStore()
    const random = byteSource()
    const a = await readyRoom(store, random)
    const b = must(await createRoom(store, OUTSIDER, { commandId: cid() }, T0, random))
    expect(await claimRole(store, OUTSIDER, { roomId: a.roomId, role: 'commander' }, T0 + 9000)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await claimRole(store, CMDR, { roomId: b.roomId, role: 'commander' }, T0 + 9000)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(must(await syncRoom(store, OUTSIDER, { roomId: b.roomId }, T0 + 9000)).members).toHaveLength(1)
  })
})

describe('startRoom', () => {
  it('needs the host and three filled roles', async () => {
    const { store } = memoryStore()
    const room = await openRoom(store)
    must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, T0 + 1000))
    must(await claimRole(store, HOST, { roomId: room.roomId, role: 'security' }, T0 + 2000))
    must(await claimRole(store, CMDR, { roomId: room.roomId, role: 'commander' }, T0 + 3000))
    expect(await startRoom(store, HOST, { roomId: room.roomId }, T0 + 4000)).toMatchObject({ ok: false, code: 'room_not_ready' })
    must(await joinRoom(store, INFRA, { inviteCode: room.inviteCode }, T0 + 5000))
    expect(await startRoom(store, HOST, { roomId: room.roomId }, T0 + 6000)).toMatchObject({ ok: false, code: 'room_not_ready' })
    must(await claimRole(store, INFRA, { roomId: room.roomId, role: 'infrastructure' }, T0 + 7000))
    expect(await startRoom(store, CMDR, { roomId: room.roomId }, T0 + 8000)).toMatchObject({ ok: false, code: 'not_host' })
    const started = must(await startRoom(store, HOST, { roomId: room.roomId }, START))
    expect(started).toMatchObject({ status: 'active', startedAt: START, deadlineAt: START + 480_000 })
  })

  it('starts once, even when pressed many times, and keeps the first start time', async () => {
    for (const seed of SEEDS.slice(0, 15)) {
      const { store, lobbyEvents } = memoryStore(seed)
      const room = await readyRoom(store)
      const results = await Promise.all([0, 1, 2, 3].map((i) => startRoom(store, HOST, { roomId: room.roomId }, START + i)))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(new Set(results.map((r) => must(r).startedAt)).size).toBe(1)
      expect(lobbyEvents.get(room.roomId)!.filter((e) => e.type === 'started')).toHaveLength(1)
      const later = must(await startRoom(store, HOST, { roomId: room.roomId }, START + 99_000))
      expect(later.startedAt).toBe(must(results[0]).startedAt)
    }
  })

  it('locks roles and membership after the start', async () => {
    const { store, lobbyEvents } = memoryStore()
    const room = await readyRoom(store)
    must(await startRoom(store, HOST, { roomId: room.roomId }, START))
    const before = lobbyEvents.get(room.roomId)!.length
    for (const user of [HOST, CMDR, INFRA]) {
      expect(await claimRole(store, user, { roomId: room.roomId, role: user === CMDR ? 'security' : 'commander' }, at(1))).toMatchObject({ ok: false, code: 'roles_locked' })
      expect(await releaseRole(store, user, { roomId: room.roomId }, at(1))).toMatchObject({ ok: false, code: 'roles_locked' })
      expect(await leaveRoom(store, user, { roomId: room.roomId }, at(1))).toMatchObject({ ok: false, code: 'roles_locked' })
    }
    expect(await abandonRoom(store, HOST, { roomId: room.roomId }, at(1))).toMatchObject({ ok: false, code: 'roles_locked' })
    expect(await joinRoom(store, OUTSIDER, { inviteCode: room.inviteCode }, at(1))).toMatchObject({ ok: false, code: 'room_not_open' })
    // A participant using the code again (second tab, reconnect) is still simply in.
    expect(must(await joinRoom(store, CMDR, { inviteCode: room.inviteCode }, at(2))).status).toBe('active')
    expect(lobbyEvents.get(room.roomId)).toHaveLength(before)
  })

  it('a race between the last role claim and the start never starts an unready room', async () => {
    for (const seed of SEEDS) {
      const { store, lobbyEvents } = memoryStore(seed)
      const room = await readyRoom(store)
      await Promise.all([
        startRoom(store, HOST, { roomId: room.roomId }, START),
        releaseRole(store, INFRA, { roomId: room.roomId }, START),
        leaveRoom(store, CMDR, { roomId: room.roomId }, START),
      ])
      const lobby = reduceLobby(HOST, T0, lobbyEvents.get(room.roomId)!)
      if (lobby.status === 'active') {
        expect(lobby.members.map((m) => m.role).sort()).toEqual(['commander', 'infrastructure', 'security'])
      }
    }
  })
})

describe('abandonRoom', () => {
  it('closes a lobby for good; only the host can', async () => {
    const { store } = memoryStore()
    const room = await readyRoom(store)
    expect(await abandonRoom(store, CMDR, { roomId: room.roomId }, T0 + 9000)).toMatchObject({ ok: false, code: 'not_host' })
    expect(must(await abandonRoom(store, HOST, { roomId: room.roomId }, T0 + 9000)).status).toBe('abandoned')
    expect(await startRoom(store, HOST, { roomId: room.roomId }, T0 + 9500)).toMatchObject({ ok: false, code: 'room_not_open' })
    expect(await joinRoom(store, OUTSIDER, { inviteCode: room.inviteCode }, T0 + 9500)).toMatchObject({ ok: false, code: 'room_not_open' })
    expect(await executeAction(store, HOST, { simulationId: room.roomId, actionId: 'inspect_access_logs', commandId: cid() }, T0 + 9500)).toMatchObject({ ok: false, code: 'forbidden' })
  })
})

// ---------------------------------------------------------------------------
// The simulation, played by a team
// ---------------------------------------------------------------------------

const run = (store: Store, user: string, simulationId: string, actionId: string, seconds: number, commandId = cid()) =>
  executeAction(store, user, { simulationId, actionId, commandId }, at(seconds))
const ask = (store: Store, user: string, simulationId: string, actionId: string, seconds: number, commandId = cid()) =>
  requestApproval(store, user, { simulationId, actionId, commandId }, at(seconds))
const decide = (
  store: Store,
  user: string,
  simulationId: string,
  actionId: string,
  requestSeq: unknown,
  decision: unknown,
  seconds: number,
  commandId = cid(),
) => decideApproval(store, user, { simulationId, actionId, requestSeq, decision, commandId }, at(seconds))

/** Play up to the point where security may ask to revoke admin sessions (35 s). */
async function untilRevokeRequest(store: Store, id: string) {
  must(await run(store, HOST, id, 'inspect_access_logs', 0))
  must(await run(store, HOST, id, 'correlate_session_events', 15))
  return must(await ask(store, HOST, id, 'revoke_admin_sessions', 35))
}

describe('team simulation: who may act', () => {
  it('does not exist as a simulation until the host starts it', async () => {
    const { store, events } = memoryStore()
    const room = await readyRoom(store)
    for (const user of [HOST, CMDR, INFRA]) {
      expect(await run(store, user, room.roomId, 'inspect_access_logs', 0)).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await syncSimulation(store, user, { simulationId: room.roomId }, T0 + 9000)).toMatchObject({ ok: false, code: 'forbidden' })
    }
    expect(events.get(room.roomId) ?? []).toHaveLength(0)
  })

  it('refuses every command from a non-participant, exactly as for a missing simulation', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const request = await untilRevokeRequest(store, id)
    const before = events.get(id)!.length
    const missing = await run(store, OUTSIDER, 'room-999999', 'inspect_access_logs', 36)
    expect(await run(store, OUTSIDER, id, 'review_deployment', 36)).toEqual(missing)
    expect(await ask(store, OUTSIDER, id, 'roll_back_release', 36)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await decide(store, OUTSIDER, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 36)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await shareFinding(store, OUTSIDER, { simulationId: id, eventSeq: 3 }, at(36))).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await syncSimulation(store, OUTSIDER, { simulationId: id }, at(36))).toMatchObject({ ok: false, code: 'forbidden' })
    expect(events.get(id)).toHaveLength(before)
  })

  it('lets each participant perform only the actions of the role they hold', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const first: Record<RoleId, ActionId> = { security: 'inspect_access_logs', infrastructure: 'review_deployment', commander: 'issue_customer_advisory' }
    for (const role of Object.keys(first) as RoleId[]) {
      for (const [holder, user] of Object.entries(PLAYER)) {
        if (holder === role) continue
        expect(await run(store, user, id, first[role], 0)).toMatchObject({ ok: false, code: 'wrong_role' })
      }
    }
    expect(events.get(id)!.filter((e) => e.type !== 'incident')).toHaveLength(0)
    for (const role of Object.keys(first) as RoleId[]) must(await run(store, PLAYER[role], id, first[role], 0))
    expect(events.get(id)!.filter((e) => e.type === 'action_started').map((e) => e.actorId).sort()).toEqual([CMDR, HOST, INFRA].sort())
  })

  it('ignores a role, user id or membership claimed in the request body', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const forged = { simulationId: id, actionId: 'issue_customer_advisory', commandId: cid(), role: 'commander', roles: ['commander'], userId: CMDR, actorId: CMDR, members: [{ userId: HOST, role: 'commander' }] }
    expect(await executeAction(store, HOST, forged, at(0))).toMatchObject({ ok: false, code: 'wrong_role' })
    expect(await executeAction(store, OUTSIDER, { ...forged, commandId: cid() }, at(0))).toMatchObject({ ok: false, code: 'forbidden' })
    expect(events.get(id)!.filter((e) => e.type !== 'incident')).toHaveLength(0)
  })

  it('ignores timestamps in the request: events carry the server time', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const forged = { simulationId: id, actionId: 'inspect_access_logs', commandId: cid(), at: START - 999_999, now: 1, startedAt: 0, serverNow: 5, completesAt: 1 }
    const result = must(await executeAction(store, HOST, forged, at(3)))
    expect(result.startedAt).toBe(at(3))
    expect(result.completesAt).toBe(at(18))
    expect(events.get(id)!.find((e) => e.type === 'action_started')?.at).toBe(at(3))
  })

  it('gives the host no gameplay privilege', async () => {
    const { store } = memoryStore()
    const id = await startedRoom(store)
    // HOST holds security. Hosting does not make them commander or infrastructure.
    expect(await run(store, HOST, id, 'issue_customer_advisory', 0)).toMatchObject({ ok: false, code: 'wrong_role' })
    expect(await run(store, HOST, id, 'review_deployment', 0)).toMatchObject({ ok: false, code: 'wrong_role' })
    const request = await untilRevokeRequest(store, id)
    expect(await decide(store, HOST, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 36)).toMatchObject({ ok: false, code: 'wrong_role' })
    expect(await run(store, HOST, id, 'revoke_admin_sessions', 50)).toMatchObject({ ok: false, code: 'approval_required' })
  })

  it('keeps two started rooms apart', async () => {
    const { store, events } = memoryStore()
    const random = byteSource()
    const a = await startedRoom(store, random)
    const other = must(await createRoom(store, OUTSIDER, { commandId: cid() }, T0, random))
    must(await joinRoom(store, 'u-x', { inviteCode: other.inviteCode }, T0 + 1))
    must(await joinRoom(store, 'u-y', { inviteCode: other.inviteCode }, T0 + 2))
    must(await claimRole(store, OUTSIDER, { roomId: other.roomId, role: 'commander' }, T0 + 3))
    must(await claimRole(store, 'u-x', { roomId: other.roomId, role: 'security' }, T0 + 4))
    must(await claimRole(store, 'u-y', { roomId: other.roomId, role: 'infrastructure' }, T0 + 5))
    must(await startRoom(store, OUTSIDER, { roomId: other.roomId }, START))
    // The commander of one room is nobody in the other.
    const request = await untilRevokeRequest(store, a)
    expect(await decide(store, OUTSIDER, a, 'revoke_admin_sessions', request.requestSeq, 'approve', 36)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await run(store, HOST, other.roomId, 'inspect_access_logs', 0)).toMatchObject({ ok: false, code: 'forbidden' })
    must(await run(store, 'u-x', other.roomId, 'inspect_access_logs', 0))
    expect(events.get(other.roomId)!.every((e) => e.actorId !== HOST)).toBe(true)
    expect(events.get(a)!.every((e) => !['u-x', 'u-y', OUTSIDER].includes(e.actorId ?? ''))).toBe(true)
  })
})

describe('team simulation: commander approvals', () => {
  it('records a request, and nothing runs until the commander approves that request', async () => {
    const { store } = memoryStore()
    const id = await startedRoom(store)
    const request = await untilRevokeRequest(store, id)
    expect(request).toMatchObject({ status: 'requested', effectiveAt: null, actionId: 'revoke_admin_sessions' })
    expect(request.requestSeq).toBe(request.seq)
    expect(await run(store, HOST, id, 'revoke_admin_sessions', 36)).toMatchObject({ ok: false, code: 'approval_required' })
    const granted = must(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 40))
    expect(granted).toMatchObject({ decision: 'approved', requestSeq: request.requestSeq, effectiveAt: at(45) })
    expect(await run(store, HOST, id, 'revoke_admin_sessions', 44)).toMatchObject({ ok: false, code: 'approval_pending' })
    must(await run(store, HOST, id, 'revoke_admin_sessions', 45))
  })

  it('only the requesting role can ask, and only the commander can decide', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    must(await run(store, HOST, id, 'correlate_session_events', 15))
    for (const user of [CMDR, INFRA]) {
      expect(await ask(store, user, id, 'revoke_admin_sessions', 35)).toMatchObject({ ok: false, code: 'wrong_role' })
    }
    const request = must(await ask(store, HOST, id, 'revoke_admin_sessions', 35))
    for (const user of [HOST, INFRA]) {
      for (const decision of ['approve', 'deny']) {
        expect(await decide(store, user, id, 'revoke_admin_sessions', request.requestSeq, decision, 36)).toMatchObject({ ok: false, code: 'wrong_role' })
      }
    }
    expect(events.get(id)!.filter((e) => e.type === 'approval_granted' || e.type === 'approval_denied')).toHaveLength(0)
  })

  it('refuses forged, mismatched and malformed decisions', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const request = await untilRevokeRequest(store, id)
    const seq = request.requestSeq!
    const before = events.get(id)!.length
    // A request id that is not the pending request.
    for (const forged of [seq + 1, seq - 1, 1, 9999]) {
      expect(await decide(store, CMDR, id, 'revoke_admin_sessions', forged, 'approve', 36)).toMatchObject({ ok: false, code: 'stale_request' })
    }
    // The right id quoted for a different operation, and operations nobody asked about.
    expect(await decide(store, CMDR, id, 'rotate_signing_keys', seq, 'approve', 36)).toMatchObject({ ok: false, code: 'no_pending_request' })
    expect(await decide(store, CMDR, id, 'roll_back_release', seq, 'approve', 36)).toMatchObject({ ok: false, code: 'no_pending_request' })
    expect(await decide(store, CMDR, id, 'inspect_access_logs', seq, 'approve', 36)).toMatchObject({ ok: false, code: 'approval_not_needed' })
    expect(await decide(store, CMDR, id, 'no_such_action', seq, 'approve', 36)).toMatchObject({ ok: false, code: 'unknown_action' })
    for (const bad of [String(seq), null, undefined, 1.5, -1, 0, {}, [seq]]) {
      expect(await decide(store, CMDR, id, 'revoke_admin_sessions', bad, 'approve', 36)).toMatchObject({ ok: false, code: 'invalid_request' })
    }
    for (const bad of ['approved', 'yes', true, null, undefined, '']) {
      expect(await decide(store, CMDR, id, 'revoke_admin_sessions', seq, bad, 36)).toMatchObject({ ok: false, code: 'invalid_request' })
    }
    expect(events.get(id)).toHaveLength(before)
    must(await decide(store, CMDR, id, 'revoke_admin_sessions', seq, 'approve', 37))
  })

  it('decides a request once: a retry replays, a second decision is refused', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const request = await untilRevokeRequest(store, id)
    const commandId = cid()
    const first = must(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 36, commandId))
    const retry = must(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 39, commandId))
    expect(retry).toMatchObject({ replayed: true, seq: first.seq, effectiveAt: first.effectiveAt })
    expect(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'deny', 39, commandId)).toMatchObject({ ok: false, code: 'command_id_reused' })
    expect(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'deny', 39)).toMatchObject({ ok: false, code: 'no_pending_request' })
    expect(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 39)).toMatchObject({ ok: false, code: 'no_pending_request' })
    expect(events.get(id)!.filter((e) => e.type === 'approval_granted')).toHaveLength(1)
    expect(events.get(id)!.filter((e) => e.type === 'approval_denied')).toHaveLength(0)
  })

  it('records exactly one decision when approve and deny arrive together', async () => {
    for (const seed of SEEDS) {
      const { store, events } = memoryStore(seed)
      const id = await startedRoom(store)
      const request = await untilRevokeRequest(store, id)
      const results = await Promise.all([
        decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 36),
        decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'deny', 36),
        decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 36),
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      const decisions = events.get(id)!.filter((e) => e.type === 'approval_granted' || e.type === 'approval_denied')
      expect(decisions).toHaveLength(1)
      reduce(START, events.get(id)!) // the log is valid
    }
  })

  it('a denied request is over: the old id cannot approve the new request', async () => {
    const { store } = memoryStore()
    const id = await startedRoom(store)
    const first = await untilRevokeRequest(store, id)
    must(await decide(store, CMDR, id, 'revoke_admin_sessions', first.requestSeq, 'deny', 36))
    expect(await run(store, HOST, id, 'revoke_admin_sessions', 60)).toMatchObject({ ok: false, code: 'approval_denied' })
    expect(await decide(store, CMDR, id, 'revoke_admin_sessions', first.requestSeq, 'approve', 60)).toMatchObject({ ok: false, code: 'no_pending_request' })
    const second = must(await ask(store, HOST, id, 'revoke_admin_sessions', 61))
    expect(second.requestSeq).not.toBe(first.requestSeq)
    expect(await decide(store, CMDR, id, 'revoke_admin_sessions', first.requestSeq, 'approve', 62)).toMatchObject({ ok: false, code: 'stale_request' })
    must(await decide(store, CMDR, id, 'revoke_admin_sessions', second.requestSeq, 'approve', 62))
    must(await run(store, HOST, id, 'revoke_admin_sessions', 67))
  })

  it('a request waits for the commander, however long they are away, and dies with the simulation', async () => {
    const { store } = memoryStore()
    const id = await startedRoom(store)
    const request = await untilRevokeRequest(store, id)
    // Nobody else can stand in while the commander is disconnected.
    expect(await decide(store, INFRA, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 200)).toMatchObject({ ok: false, code: 'wrong_role' })
    expect(await run(store, HOST, id, 'revoke_admin_sessions', 300)).toMatchObject({ ok: false, code: 'approval_required' })
    // Other roles keep working meanwhile.
    must(await run(store, INFRA, id, 'review_deployment', 300))
    // The commander comes back before the deadline: the same request is still decidable.
    must(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 400))
  })

  it('a request left undecided cannot be approved after the deadline', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    const request = await untilRevokeRequest(store, id)
    expect(await decide(store, CMDR, id, 'revoke_admin_sessions', request.requestSeq, 'approve', 481)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(events.get(id)!.some((e) => e.type === 'approval_granted')).toBe(false)
  })

  it('makes a room unjoinable rather than ambiguous if two rooms ever shared a code', async () => {
    const { store } = memoryStore()
    const a = await openRoom(store, HOST, T0, byteSource())
    const b = await openRoom(store, OUTSIDER, T0, byteSource())
    expect(a.inviteCode).toBe(b.inviteCode)
    expect(await joinRoom(store, CMDR, { inviteCode: a.inviteCode }, T0 + 1000)).toMatchObject({ ok: false, code: 'invalid_invite' })
  })

  it('is not available in a solo simulation', async () => {
    const { store } = memoryStore()
    const solo = must(await createSoloSimulation(store, HOST, { commandId: cid() }, T0))
    expect(await decideApproval(store, HOST, { simulationId: solo.simulationId, actionId: 'roll_back_release', requestSeq: 2, decision: 'approve', commandId: cid() }, T0 + 1000)).toMatchObject({ ok: false, code: 'not_a_team_simulation' })
    expect(await shareFinding(store, HOST, { simulationId: solo.simulationId, eventSeq: 1 }, T0 + 1000)).toMatchObject({ ok: false, code: 'not_a_team_simulation' })
    // Solo approvals are still granted on the spot.
    expect(must(await requestApproval(store, HOST, { simulationId: solo.simulationId, actionId: 'roll_back_release', commandId: cid() }, T0 + 1000))).toMatchObject({ status: 'approved', effectiveAt: T0 + 6000 })
  })
})

describe('team simulation: findings', () => {
  it('keeps revealed text off the shared events', async () => {
    const { store, events, findings } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    must(await syncSimulation(store, HOST, { simulationId: id }, at(20)))
    expect(events.get(id)!.length).toBeGreaterThan(2)
    expect(events.get(id)!.every((e) => e.finding === undefined)).toBe(true)
    expect(findings.get(id)!.length).toBeGreaterThan(0)
  })

  it('shows an investigation result to the participant who ran it, and incident reports to all', async () => {
    const { store } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    must(await run(store, INFRA, id, 'review_deployment', 0))
    const view = async (user: string) => must(await syncSimulation(store, user, { simulationId: id }, at(20)))
    const [sec, cmd, inf] = [await view(HOST), await view(CMDR), await view(INFRA)]
    const seqOf = (actionId: string) => sec.events.find((e) => e.type === 'action_completed' && e.actionId === actionId)!.seq
    const logs = seqOf('inspect_access_logs')
    const deploy = seqOf('review_deployment')
    expect(sec.findings.find((f) => f.eventSeq === logs)).toMatchObject({ scope: 'private', ownerId: HOST })
    expect(inf.findings.find((f) => f.eventSeq === deploy)).toMatchObject({ scope: 'private', ownerId: INFRA })
    expect(sec.findings.some((f) => f.eventSeq === deploy)).toBe(false)
    expect(inf.findings.some((f) => f.eventSeq === logs)).toBe(false)
    expect(cmd.findings.some((f) => f.eventSeq === logs || f.eventSeq === deploy)).toBe(false)
    // Everyone sees the same events and the same incident reports.
    expect(cmd.events).toEqual(sec.events)
    const incidents = sec.events.filter((e) => e.type === 'incident').map((e) => e.seq)
    for (const member of [sec, cmd, inf]) {
      expect(member.findings.filter((f) => f.scope === 'team').map((f) => f.eventSeq)).toEqual(incidents)
    }
    expect(sec.mode).toBe('team')
  })

  it('shares a finding only when its owner says so, with the server\'s text', async () => {
    const { store, findings } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    const mine = must(await syncSimulation(store, HOST, { simulationId: id }, at(20))).findings.find((f) => f.scope === 'private')!
    // Nobody else can share it, and it cannot be told apart from an event with no finding.
    const nothing = await shareFinding(store, CMDR, { simulationId: id, eventSeq: 9999 }, at(21))
    expect(await shareFinding(store, CMDR, { simulationId: id, eventSeq: mine.eventSeq }, at(21))).toEqual(nothing)
    expect(nothing).toMatchObject({ ok: false, code: 'finding_not_found' })
    expect(await shareFinding(store, INFRA, { simulationId: id, eventSeq: mine.eventSeq, text: 'made up', ownerId: INFRA } as never, at(21))).toMatchObject({ ok: false, code: 'finding_not_found' })
    for (const bad of [null, '3', 0, -1, 1.5]) {
      expect(await shareFinding(store, HOST, { simulationId: id, eventSeq: bad }, at(21))).toMatchObject({ ok: false, code: 'invalid_request' })
    }
    expect(must(await syncSimulation(store, CMDR, { simulationId: id }, at(21))).findings.some((f) => f.eventSeq === mine.eventSeq)).toBe(false)

    expect(must(await shareFinding(store, HOST, { simulationId: id, eventSeq: mine.eventSeq, text: 'forged text' } as never, at(22))).replayed).toBe(false)
    expect(must(await shareFinding(store, HOST, { simulationId: id, eventSeq: mine.eventSeq }, at(23))).replayed).toBe(true)
    for (const user of [CMDR, INFRA]) {
      const shared = must(await syncSimulation(store, user, { simulationId: id }, at(24))).findings.find((f) => f.eventSeq === mine.eventSeq)
      expect(shared).toMatchObject({ scope: 'team', text: mine.text, sharedBy: HOST })
    }
    expect(findings.get(id)!.filter((f) => f.eventSeq === mine.eventSeq)).toHaveLength(2)
  })

  it('shares once when two tabs share at the same moment', async () => {
    for (const seed of SEEDS.slice(0, 15)) {
      const { store, findings } = memoryStore(seed)
      const id = await startedRoom(store)
      must(await run(store, HOST, id, 'inspect_access_logs', 0))
      const mine = must(await syncSimulation(store, HOST, { simulationId: id }, at(20))).findings.find((f) => f.scope === 'private')!
      const results = await Promise.all([1, 2, 3].map(() => shareFinding(store, HOST, { simulationId: id, eventSeq: mine.eventSeq }, at(21))))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(findings.get(id)!.filter((f) => f.eventSeq === mine.eventSeq && f.scope === 'team')).toHaveLength(1)
    }
  })

  it('writes a finding later if its write was lost, to the same audience', async () => {
    const { store, findings, faults } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    faults.dropFindings = true
    must(await syncSimulation(store, CMDR, { simulationId: id }, at(20))) // completes the action; finding write lost
    expect((findings.get(id) ?? []).some((f) => f.scope === 'private')).toBe(false)
    faults.dropFindings = false
    const cmd = must(await syncSimulation(store, CMDR, { simulationId: id }, at(21)))
    expect(cmd.findings.some((f) => f.scope === 'private')).toBe(false)
    const sec = must(await syncSimulation(store, HOST, { simulationId: id }, at(21)))
    expect(sec.findings.filter((f) => f.scope === 'private')).toHaveLength(1)
    expect(sec.findings.find((f) => f.scope === 'private')).toMatchObject({ ownerId: HOST })
  })
})

describe('team simulation: a whole game', () => {
  /** The solo optimal line, played by three people with real commander decisions. */
  async function playOptimal(store: Store, id: string) {
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    must(await run(store, CMDR, id, 'issue_customer_advisory', 0))
    must(await run(store, HOST, id, 'correlate_session_events', 15))
    must(await run(store, HOST, id, 'investigate_signing_access', 35))
    const revoke = must(await ask(store, HOST, id, 'revoke_admin_sessions', 35))
    must(await decide(store, CMDR, id, 'revoke_admin_sessions', revoke.requestSeq, 'approve', 35))
    must(await run(store, HOST, id, 'revoke_admin_sessions', 55))
    const rotate = must(await ask(store, INFRA, id, 'rotate_signing_keys', 55))
    must(await decide(store, CMDR, id, 'rotate_signing_keys', rotate.requestSeq, 'approve', 55))
    must(await run(store, INFRA, id, 'rotate_signing_keys', 60))
    must(await run(store, INFRA, id, 'restore_auth', 95))
    must(await run(store, INFRA, id, 'validate_recovery', 135))
    return must(await run(store, CMDR, id, 'confirm_resolution', 155))
  }

  it('reaches the same ending and score as the solo optimal run', async () => {
    const { store, events, rooms } = memoryStore()
    const id = await startedRoom(store)
    const end = await playOptimal(store, id)
    expect(end.result).toMatchObject({ outcome: 'complete_recovery', score: 100, reason: 'confirmed' })
    const log = events.get(id)!
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1))
    expect(log.filter((e) => e.type === 'approval_auto_granted')).toHaveLength(0)
    expect(log.filter((e) => e.type === 'approval_granted').every((e) => e.actorId === CMDR)).toBe(true)
    // The room row says so once anyone syncs it.
    expect(must(await syncRoom(store, INFRA, { roomId: id }, at(156))).status).toBe('completed')
    expect(rooms.get(id)!.view?.status).toBe('completed')
    // Everyone sees the closing finding.
    const closing = log.find((e) => e.actionId === 'confirm_resolution' && e.type === 'action_completed')!.seq
    for (const user of [HOST, CMDR, INFRA]) {
      const view = must(await syncSimulation(store, user, { simulationId: id }, at(157)))
      expect(view.result).toMatchObject({ outcome: 'complete_recovery', score: 100 })
      expect(view.findings.find((f) => f.eventSeq === closing)).toMatchObject({ scope: 'team' })
    }
  })

  it('refuses every command after the end, and repeats change nothing', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    await playOptimal(store, id)
    const before = events.get(id)!.length
    expect(await run(store, HOST, id, 'validate_containment', 160)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await run(store, INFRA, id, 'review_deployment', 160)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await ask(store, INFRA, id, 'roll_back_release', 160)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(await decide(store, CMDR, id, 'roll_back_release', 3, 'approve', 160)).toMatchObject({ ok: false, code: 'simulation_ended' })
    expect(events.get(id)).toHaveLength(before)
  })

  it('ends on the deadline for everyone, and refuses commands after it', async () => {
    const { store, events } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    const results = await Promise.all([
      run(store, HOST, id, 'correlate_session_events', 481),
      run(store, INFRA, id, 'review_deployment', 481),
      run(store, CMDR, id, 'issue_customer_advisory', 481),
    ])
    expect(results.every((r) => !r.ok && r.code === 'simulation_ended')).toBe(true)
    const view = must(await syncSimulation(store, CMDR, { simulationId: id }, at(500)))
    expect(view.result).toMatchObject({ outcome: 'incident_escalation', reason: 'deadline', endedAt: START + 480_000 })
    expect(events.get(id)!.every((e) => e.at <= START + 480_000)).toBe(true)
    expect(must(await syncRoom(store, HOST, { roomId: id }, at(500))).status).toBe('completed')
  })

  it('keeps one consistent log when all three act and retry at the same instant', async () => {
    for (const seed of SEEDS) {
      const { store, events, stats } = memoryStore(seed)
      const id = await startedRoom(store)
      const ids = { a: cid(), b: cid(), c: cid() }
      const send = () => [
        run(store, HOST, id, 'inspect_access_logs', 1, ids.a),
        run(store, INFRA, id, 'review_deployment', 1, ids.b),
        run(store, CMDR, id, 'issue_customer_advisory', 1, ids.c),
        // The same role trying two things at once: one must lose.
        run(store, INFRA, id, 'roll_back_release', 1),
        run(store, HOST, id, 'inspect_access_logs', 1),
      ]
      const results = await Promise.all([...send(), ...send()])
      const log = events.get(id)!
      expect(log.map((e) => e.seq).sort((x, y) => x - y)).toEqual(log.map((_, i) => i + 1))
      reduce(START, log) // throws if two actions of one role overlap or an action started twice
      const starts = log.filter((e) => e.type === 'action_started')
      expect(starts.map((e) => e.actionId).sort()).toEqual(['inspect_access_logs', 'issue_customer_advisory', 'review_deployment'])
      expect(new Set(starts.map((e) => e.commandId)).size).toBe(3)
      expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(3)
      expect(stats.appendAttempts).toBeGreaterThan(log.length - 1)
    }
  })

  it('an action in progress completes on time whoever is connected', async () => {
    const { store } = memoryStore()
    const id = await startedRoom(store)
    must(await run(store, HOST, id, 'inspect_access_logs', 0))
    // Security "disconnects". Someone else syncing much later still records the completion at 15 s.
    const view = must(await syncSimulation(store, INFRA, { simulationId: id }, at(120)))
    const done = view.events.find((e) => e.type === 'action_completed' && e.actionId === 'inspect_access_logs')
    expect(done?.at).toBe(at(15))
    // Security comes back and carries on from there; the old command id replays instead of acting twice.
    must(await run(store, HOST, id, 'correlate_session_events', 121))
  })
})
