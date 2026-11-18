/**
 * Per-user limits on the commands that create rows or test invitation codes.
 *
 * These are ceilings against abuse, not game rules: a person playing normally
 * never meets them. They are counted on the server, per verified user id, in
 * the app's own record room — no external service.
 *
 * Mechanism: time is cut into fixed windows. Taking a slot means creating the
 * row (userId, kind, window, n) for the first free `n` in 1..limit. The store
 * refuses a second row with the same four values, so two requests racing for
 * the last slot cannot both get it: the loser re-reads and finds the window
 * full. It is the same uniqueness mechanism the event logs rely on.
 *
 * A fixed window allows up to twice the limit across a window boundary. That
 * is accepted: the numbers below are sized for it.
 */

export type LimitKind = 'create_room' | 'create_simulation' | 'join_attempt'

export interface Limit {
  limit: number
  windowMs: number
}

const HOUR = 60 * 60 * 1000

export const LIMITS: Record<LimitKind, Limit> = {
  /** Team rooms one person may create. */
  create_room: { limit: 120, windowMs: HOUR },
  /** Solo simulations one person may start. */
  create_simulation: { limit: 240, windowMs: HOUR },
  /**
   * Invitation codes one person may try, right or wrong. A code has 60 random
   * bits, so guessing is hopeless long before this; the limit bounds it anyway.
   */
  join_attempt: { limit: 120, windowMs: 10 * 60 * 1000 },
}

export interface RateStore {
  /** The slot numbers already taken in this window. */
  listSlots(userId: string, kind: LimitKind, window: number): Promise<number[]>
  /** `conflict` when (userId, kind, window, n) already exists. Must be atomic. */
  createSlot(userId: string, kind: LimitKind, window: number, n: number, at: number): Promise<'ok' | 'conflict'>
  /** Remove this user's slots of this kind from windows before `window`. Best effort. */
  deleteSlotsBefore(userId: string, kind: LimitKind, window: number): Promise<void>
}

export type SlotResult = { ok: true } | { ok: false; retryAfterMs: number }

export function windowOf(now: number, limit: Limit): number {
  return Math.floor(now / limit.windowMs)
}

function retryAfter(now: number, limit: Limit): number {
  return (windowOf(now, limit) + 1) * limit.windowMs - now
}

/** Is the window already full? Reads only. */
export async function isExhausted(
  store: RateStore,
  userId: string,
  kind: LimitKind,
  now: number,
  limit: Limit = LIMITS[kind],
): Promise<SlotResult> {
  const taken = await store.listSlots(userId, kind, windowOf(now, limit))
  return taken.length >= limit.limit ? { ok: false, retryAfterMs: retryAfter(now, limit) } : { ok: true }
}

/**
 * Take one slot in the current window, or report that it is full. Never
 * grants more than `limit.limit` slots per (user, kind, window), however many
 * requests arrive at once.
 */
export async function takeSlot(
  store: RateStore,
  userId: string,
  kind: LimitKind,
  now: number,
  limit: Limit = LIMITS[kind],
): Promise<SlotResult> {
  const window = windowOf(now, limit)
  // Each lost race means another request took a slot, so the loop ends within
  // `limit` rounds: by then the window is full.
  for (let attempt = 0; attempt <= limit.limit; attempt++) {
    const taken = await store.listSlots(userId, kind, window)
    if (taken.length >= limit.limit) return { ok: false, retryAfterMs: retryAfter(now, limit) }
    if (taken.length === 0) {
      // First use of a new window: drop what earlier windows left behind.
      try {
        await store.deleteSlotsBefore(userId, kind, window)
      } catch {
        // Housekeeping only. Old rows are never counted.
      }
    }
    const used = new Set(taken)
    let n = 1
    while (used.has(n)) n++
    if ((await store.createSlot(userId, kind, window, n, now)) === 'ok') return { ok: true }
  }
  return { ok: false, retryAfterMs: retryAfter(now, limit) }
}

/** "about 7 minutes", for the refusal message. */
export function describeWait(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000))
  return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`
}
