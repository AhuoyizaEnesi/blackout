import { describe, expect, it } from 'vitest'
import { ROLES } from './engine'
import {
  INVITE_CODE_LENGTH,
  MAX_MEMBERS,
  applyLobbyEvent,
  encodeInviteCode,
  formatInviteCode,
  initialLobby,
  isReady,
  normalizeInviteCode,
  reduceLobby,
  validateAbandon,
  validateClaim,
  validateJoin,
  validateLeave,
  validateRelease,
  validateStart,
  type LobbyEvent,
  type LobbyState,
} from './lobby'

const T0 = 1_800_000_000_000
const HOST = 'user-host'
const B = 'user-b'
const C = 'user-c'
const D = 'user-d'

/** Build a lobby by applying events in order; seq and time are filled in. */
function lobby(...steps: Array<Omit<LobbyEvent, 'seq' | 'at'>>): LobbyState {
  return reduceLobby(HOST, T0, steps.map((step, i) => ({ ...step, seq: i + 1, at: T0 + (i + 1) * 1000 })))
}

const full = () =>
  lobby(
    { type: 'member_joined', userId: B },
    { type: 'member_joined', userId: C },
    { type: 'role_claimed', userId: HOST, role: 'security' },
    { type: 'role_claimed', userId: B, role: 'commander' },
    { type: 'role_claimed', userId: C, role: 'infrastructure' },
  )
const started = () => applyLobbyEvent(full(), { seq: 6, type: 'started', userId: HOST, at: T0 + 60_000 })

describe('membership', () => {
  it('starts with the host as the only member, holding no role', () => {
    expect(initialLobby(HOST, T0)).toMatchObject({ status: 'lobby', members: [{ userId: HOST, role: null }], lastSeq: 0 })
  })

  it('admits at most three distinct participants', () => {
    const state = lobby({ type: 'member_joined', userId: B }, { type: 'member_joined', userId: C })
    expect(state.members.map((m) => m.userId)).toEqual([HOST, B, C])
    expect(state.members).toHaveLength(MAX_MEMBERS)
    expect(validateJoin(state, D)).toEqual({ ok: false, code: 'room_full' })
  })

  it('treats a member joining again as already done, not as a second seat', () => {
    const state = lobby({ type: 'member_joined', userId: B })
    expect(validateJoin(state, B)).toEqual({ ok: true, noop: true })
    expect(validateJoin(state, HOST)).toEqual({ ok: true, noop: true })
    expect(() => applyLobbyEvent(state, { seq: 2, type: 'member_joined', userId: B, at: T0 + 5000 })).toThrow(/already true/)
  })

  it('lets a member leave and frees the seat and the role; the host cannot leave', () => {
    const state = lobby(
      { type: 'member_joined', userId: B },
      { type: 'role_claimed', userId: B, role: 'commander' },
      { type: 'member_left', userId: B },
    )
    expect(state.members.map((m) => m.userId)).toEqual([HOST])
    expect(validateClaim(state, HOST, 'commander')).toEqual({ ok: true, noop: false })
    expect(validateLeave(state, HOST)).toEqual({ ok: false, code: 'host_cannot_leave' })
    expect(validateLeave(state, D)).toEqual({ ok: false, code: 'not_a_member' })
  })
})

describe('roles', () => {
  it('gives each participant at most one role and each role at most one participant', () => {
    const state = lobby({ type: 'member_joined', userId: B }, { type: 'role_claimed', userId: HOST, role: 'commander' })
    expect(validateClaim(state, B, 'commander')).toEqual({ ok: false, code: 'role_taken' })
    expect(validateClaim(state, HOST, 'commander')).toEqual({ ok: true, noop: true })
    // Claiming another role swaps: the first one is free again.
    const swapped = applyLobbyEvent(state, { seq: 3, type: 'role_claimed', userId: HOST, role: 'security', at: T0 + 9000 })
    expect(swapped.members.find((m) => m.userId === HOST)?.role).toBe('security')
    expect(validateClaim(swapped, B, 'commander')).toEqual({ ok: true, noop: false })
  })

  it('refuses unknown roles and non-members', () => {
    const state = lobby({ type: 'member_joined', userId: B })
    for (const role of ['admin', 'host', '', null, undefined, 3, ['commander'], { role: 'commander' }]) {
      expect(validateClaim(state, B, role)).toEqual({ ok: false, code: 'unknown_role' })
    }
    expect(validateClaim(state, D, 'commander')).toEqual({ ok: false, code: 'not_a_member' })
    expect(validateRelease(state, D)).toEqual({ ok: false, code: 'not_a_member' })
  })

  it('releases a role', () => {
    const state = lobby({ type: 'role_claimed', userId: HOST, role: 'commander' }, { type: 'role_released', userId: HOST })
    expect(state.members[0].role).toBeNull()
    expect(validateRelease(state, HOST)).toEqual({ ok: true, noop: true })
  })

  it('throws on a log that would hold a role twice', () => {
    const state = lobby({ type: 'member_joined', userId: B }, { type: 'role_claimed', userId: HOST, role: 'commander' })
    expect(() => applyLobbyEvent(state, { seq: 3, type: 'role_claimed', userId: B, role: 'commander', at: T0 + 9000 })).toThrow(/role_taken/)
  })
})

describe('starting', () => {
  it('is ready only with three members holding the three roles', () => {
    expect(isReady(initialLobby(HOST, T0))).toBe(false)
    expect(isReady(lobby({ type: 'member_joined', userId: B }, { type: 'member_joined', userId: C }))).toBe(false)
    const twoRoles = lobby(
      { type: 'member_joined', userId: B },
      { type: 'member_joined', userId: C },
      { type: 'role_claimed', userId: HOST, role: 'security' },
      { type: 'role_claimed', userId: B, role: 'commander' },
    )
    expect(isReady(twoRoles)).toBe(false)
    expect(validateStart(twoRoles, HOST)).toEqual({ ok: false, code: 'room_not_ready' })
    expect(isReady(full())).toBe(true)
  })

  it('only the host can start, and only once', () => {
    expect(validateStart(full(), B)).toEqual({ ok: false, code: 'not_host' })
    expect(validateStart(full(), D)).toEqual({ ok: false, code: 'not_a_member' })
    expect(validateStart(full(), HOST)).toEqual({ ok: true, noop: false })
    const state = started()
    expect(state).toMatchObject({ status: 'active', startedAt: T0 + 60_000 })
    expect(validateStart(state, HOST)).toEqual({ ok: true, noop: true })
  })

  it('locks membership and roles once started — for everyone, the host included', () => {
    const state = started()
    for (const user of [HOST, B, C]) {
      for (const role of ROLES) {
        const held = state.members.find((m) => m.userId === user)?.role
        if (role !== held) expect(validateClaim(state, user, role)).toEqual({ ok: false, code: 'roles_locked' })
      }
      expect(validateRelease(state, user)).toEqual({ ok: false, code: 'roles_locked' })
      expect(validateLeave(state, user)).toEqual({ ok: false, code: 'roles_locked' })
    }
    expect(validateJoin(state, D)).toEqual({ ok: false, code: 'room_not_open' })
    expect(validateAbandon(state, HOST)).toEqual({ ok: false, code: 'roles_locked' })
    expect(() => applyLobbyEvent(state, { seq: 7, type: 'role_released', userId: B, at: T0 + 70_000 })).toThrow(/roles_locked/)
  })
})

describe('abandoning', () => {
  it('only the host can abandon, before the start; nothing is possible afterwards', () => {
    const open = lobby({ type: 'member_joined', userId: B })
    expect(validateAbandon(open, B)).toEqual({ ok: false, code: 'not_host' })
    const closed = applyLobbyEvent(open, { seq: 2, type: 'abandoned', userId: HOST, at: T0 + 5000 })
    expect(closed.status).toBe('abandoned')
    expect(validateAbandon(closed, HOST)).toEqual({ ok: true, noop: true })
    expect(validateJoin(closed, C)).toEqual({ ok: false, code: 'room_not_open' })
    expect(validateStart(closed, HOST)).toEqual({ ok: false, code: 'room_not_open' })
    expect(validateClaim(closed, B, 'commander')).toEqual({ ok: false, code: 'roles_locked' })
  })
})

describe('log integrity', () => {
  it('rejects gaps, duplicates and time running backwards', () => {
    const state = lobby({ type: 'member_joined', userId: B })
    expect(() => applyLobbyEvent(state, { seq: 3, type: 'member_joined', userId: C, at: T0 + 9000 })).toThrow(/out of sequence/)
    expect(() => applyLobbyEvent(state, { seq: 1, type: 'member_joined', userId: C, at: T0 + 9000 })).toThrow(/out of sequence/)
    expect(() => applyLobbyEvent(state, { seq: 2, type: 'member_joined', userId: C, at: T0 })).toThrow(/backwards/)
  })

  it('folds the same state whatever order the rows arrive in', () => {
    const events: LobbyEvent[] = [
      { seq: 1, type: 'member_joined', userId: B, at: T0 + 1 },
      { seq: 2, type: 'role_claimed', userId: B, role: 'commander', at: T0 + 2 },
      { seq: 3, type: 'member_joined', userId: C, at: T0 + 3 },
    ]
    expect(reduceLobby(HOST, T0, [...events].reverse())).toEqual(reduceLobby(HOST, T0, events))
  })
})

describe('invitation codes', () => {
  it('encodes twelve random bytes as twelve unambiguous symbols', () => {
    const code = encodeInviteCode(new Uint8Array([0, 1, 31, 32, 63, 255, 128, 17, 18, 20, 21, 30]))
    expect(code).toHaveLength(INVITE_CODE_LENGTH)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
    expect(() => encodeInviteCode(new Uint8Array(5))).toThrow()
  })

  it('uses every symbol equally often (no modulo bias)', () => {
    const counts = new Map<string, number>()
    for (let byte = 0; byte < 256; byte++) {
      const symbol = encodeInviteCode(new Uint8Array(12).fill(byte))[0]
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
    }
    expect(counts.size).toBe(32)
    expect([...counts.values()].every((n) => n === 8)).toBe(true)
  })

  it('accepts what a person would type and rejects everything else', () => {
    const code = encodeInviteCode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
    expect(normalizeInviteCode(code)).toBe(code)
    expect(normalizeInviteCode(` ${formatInviteCode(code).toLowerCase()} `)).toBe(code)
    expect(formatInviteCode(code)).toMatch(/^.{4}-.{4}-.{4}$/)
    expect(normalizeInviteCode('O0IL-1111-1111')).toBe('001111111111')
    for (const bad of ['', 'short', code + 'A', 'UUUUUUUUUUUU', '!!!!!!!!!!!!', null, undefined, 42, {}, 'A'.repeat(100)]) {
      expect(normalizeInviteCode(bad)).toBeNull()
    }
  })
})
