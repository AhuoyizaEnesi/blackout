/**
 * Browser-side calls to the game's server actions.
 *
 * The browser sends ids only. Identity comes from the bearer token the worker
 * verifies; time, state and scoring are the server's.
 */

import { clearAuthToken, getAuthToken } from 'deepspace'

export type ActionResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string }

export type GameActionName =
  | 'createSoloSimulation'
  | 'executeAction'
  | 'requestApproval'
  | 'syncSimulation'
  | 'decideApproval'
  | 'shareFinding'
  | 'createRoom'
  | 'joinRoom'
  | 'leaveRoom'
  | 'claimRole'
  | 'releaseRole'
  | 'startRoom'
  | 'abandonRoom'
  | 'syncRoom'

const SIGNED_OUT: ActionResponse<never> = {
  success: false,
  error: 'Your session has expired. Sign in again to continue.',
  code: 'unauthorized',
}
const UNREACHABLE: ActionResponse<never> = {
  success: false,
  error: 'Could not reach the server. Check your connection and try again.',
  code: 'network',
}
const SERVER_ERROR: ActionResponse<never> = {
  success: false,
  error: 'The server had a problem. Try again.',
  code: 'server_error',
}

async function post(name: string, params: Record<string, unknown>, token: string): Promise<Response> {
  return fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  })
}

/**
 * Call a server action. Never throws: every way it can go wrong comes back
 * as a failed response with a `code` the page can act on —
 *   `unauthorized`  the session is gone (after one attempt with a fresh token);
 *   `network`       no answer at all;
 *   `server_error`  an answer that was not the action's own;
 *   anything else   the server's refusal of this command.
 */
export async function callGameAction<T>(name: GameActionName, params: Record<string, unknown>): Promise<ActionResponse<T>> {
  try {
    let token = await getAuthToken()
    if (!token) return SIGNED_OUT
    let res = await post(name, params, token)
    if (res.status === 401) {
      // The cached token may simply have expired: fetch a new one and try once
      // more. Nothing was done by the refused request, so this cannot repeat a command.
      clearAuthToken()
      token = await getAuthToken()
      if (!token) return SIGNED_OUT
      res = await post(name, params, token)
      if (res.status === 401) return SIGNED_OUT
    }
    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      return SERVER_ERROR
    }
    if (body.success === true) return { success: true, data: body.data as T }
    if (typeof body.error !== 'string' || (res.status >= 500 && typeof body.code !== 'string')) return SERVER_ERROR
    return { success: false, error: body.error, code: typeof body.code === 'string' ? body.code : undefined }
  } catch {
    return UNREACHABLE
  }
}

/**
 * True when the command may not have reached the server, or reached it and
 * got no verdict. Its command id must then be kept, so that sending it again
 * cannot do the thing twice.
 */
export function isUnanswered(code: string | undefined): boolean {
  return code === 'network' || code === 'server_error' || code === 'unauthorized'
}

/** What is wrong with the link to the server, if anything, judging by an action's answer. */
export type LinkProblem = 'offline' | 'signed_out' | null

export function linkProblem(result: ActionResponse<unknown>): LinkProblem {
  if (result.success) return null
  if (result.code === 'unauthorized') return 'signed_out'
  if (result.code === 'network' || result.code === 'server_error') return 'offline'
  return null
}

/** A fresh idempotency key. Reuse the same one when retrying the same command. */
export function newCommandId(): string {
  return crypto.randomUUID()
}
