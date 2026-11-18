/**
 * WebSocket routing for app-owned Durable Objects.
 *
 * Caller identity in query parameters and headers is never trusted. Routes
 * scrub it and forward verified JWT identity in internal-only headers; the
 * documents-aware Yjs route additionally resolves an application role from
 * the documents collection.
 */

import type { Context, Hono } from 'hono'
import { authenticatedRoomRequest, resolveAppRole, verifyJwt } from 'deepspace/worker'
import type { JwtVerifierConfig, VerifyResult } from 'deepspace/worker'
import type { AppContext, Env } from '../../worker.js'
import { createRecordStore, createSystemTools } from './game/record-store.js'
import { isRoomMember } from './game/rooms.js'

/** Presence scopes this app uses: one per team room. */
const TEAM_PRESENCE = /^team:([A-Za-z0-9_-]{8,64})$/

function jwtConfig(env: Env): JwtVerifierConfig {
  return { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
}

function wsRoute(
  doNamespace: (env: Env) => DurableObjectNamespace,
  extraIdentity?: (auth: VerifyResult, env: Env) => { role?: string } | Promise<{ role?: string }>,
) {
  return async (c: Context<AppContext>) => {
    const id = c.req.param('roomId') ?? c.req.param('docId') ?? c.req.param('scopeId')
    if (!id) return new Response('Not found', { status: 404 })
    const url = new URL(c.req.url)
    const token = url.searchParams.get('token')

    let auth: VerifyResult | null = null
    if (token) {
      auth = (await verifyJwt(jwtConfig(c.env), token)).result
      if (!auth) return new Response('Unauthorized', { status: 401 })
    }
    const roomRequest = authenticatedRoomRequest(
      c.req.raw,
      auth,
      auth ? await extraIdentity?.(auth, c.env) : undefined,
    )

    const namespace = doNamespace(c.env)
    const stub = namespace.get(namespace.idFromName(id))
    return stub.fetch(roomRequest)
  }
}

type DocsYjsRole = 'admin' | 'member' | 'viewer'

interface DocumentRecordForAccess {
  ownerId?: string
  collaborators?: string
  editors?: string
}

type DocumentAccessLookup =
  | { kind: 'found'; doc: DocumentRecordForAccess }
  | { kind: 'not-docs-room' }
  | { kind: 'error' }

function parseAccessList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

async function getDocumentForAccess(env: Env, docId: string): Promise<DocumentAccessLookup> {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
  try {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': env.OWNER_USER_ID,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({
          tool: 'records.get',
          params: { collection: 'documents', recordId: docId },
        }),
      }),
    )
    const json = (await res.json()) as {
      success?: boolean
      error?: string
      data?: { record?: { data?: DocumentRecordForAccess } }
    }
    if (json.success && json.data?.record?.data) {
      return { kind: 'found', doc: json.data.record.data }
    }
    if (json.error?.startsWith('Schema not registered for collection: documents')) {
      return { kind: 'not-docs-room' }
    }
    return { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

async function resolveDocsYjsRole(
  env: Env,
  docId: string,
  userId: string,
): Promise<DocsYjsRole | null> {
  const lookup = await getDocumentForAccess(env, docId)
  if (lookup.kind === 'not-docs-room') return 'member'
  if (lookup.kind === 'error') return null
  const { doc } = lookup
  if (doc.ownerId === userId || userId === env.OWNER_USER_ID) return 'admin'

  const editors = parseAccessList(doc.editors)
  if (editors.includes(userId)) return 'member'

  const collaborators = parseAccessList(doc.collaborators)
  if (collaborators.includes(userId)) return 'viewer'

  return null
}

export function registerRealtimeRoutes(app: Hono<AppContext>): void {
  app.get(
    '/ws/:roomId',
    wsRoute((env) => env.RECORD_ROOMS),
  )

  app.get('/ws/yjs/:docId', async (c) => {
    const docId = c.req.param('docId')
    const url = new URL(c.req.url)
    const token = url.searchParams.get('token')
    const auth = token ? (await verifyJwt(jwtConfig(c.env), token)).result : null
    if (!auth) return new Response('Unauthorized', { status: 401 })

    const role = await resolveDocsYjsRole(c.env, docId, auth.userId)
    if (!role) return new Response('Forbidden', { status: 403 })

    const roomRequest = authenticatedRoomRequest(c.req.raw, auth, { role })

    const stub = c.env.YJS_ROOMS.get(c.env.YJS_ROOMS.idFromName(docId))
    return stub.fetch(roomRequest)
  })

  app.get(
    '/ws/canvas/:docId',
    wsRoute(
      (env) => env.CANVAS_ROOMS,
      async (auth, env) => ({ role: await resolveAppRole(env, auth.userId) }),
    ),
  )

  // Presence shows who has a team room open, by name. It is therefore
  // available to that room's members only: a signed-in caller, a `team:<id>`
  // scope, and membership according to the room's lobby log — checked here,
  // on the server, before the socket reaches the presence room. Any other
  // scope does not exist. Presence itself grants nothing anywhere.
  app.get('/ws/presence/:scopeId', async (c) => {
    const match = TEAM_PRESENCE.exec(c.req.param('scopeId'))
    if (!match) return new Response('Not found', { status: 404 })
    const token = new URL(c.req.url).searchParams.get('token')
    const auth = token ? (await verifyJwt(jwtConfig(c.env), token)).result : null
    if (!auth) return new Response('Unauthorized', { status: 401 })
    const member = await isRoomMember(createRecordStore(createSystemTools(c.env)), auth.userId, match[1])
    if (!member) return new Response('Forbidden', { status: 403 })
    const stub = c.env.PRESENCE_ROOMS.get(c.env.PRESENCE_ROOMS.idFromName(match[0]))
    return stub.fetch(authenticatedRoomRequest(c.req.raw, auth))
  })

  // The scheduler and the job queue run the server's own housekeeping (the
  // room sweep and the simulation timers). Only an app admin may watch or
  // control the scheduler; the CronRoom would otherwise let any member pause
  // a task. The job queue additionally refuses every client inside the room
  // (worker.ts).
  const adminOnly = (doNamespace: (env: Env) => DurableObjectNamespace) => async (c: Context<AppContext>) => {
    const id = c.req.param('roomId')
    if (id !== `app:${c.env.DEEPSPACE_APP_ID}`) return new Response('Not found', { status: 404 })
    const token = new URL(c.req.url).searchParams.get('token')
    const auth = token ? (await verifyJwt(jwtConfig(c.env), token)).result : null
    if (!auth) return new Response('Unauthorized', { status: 401 })
    const role = await resolveAppRole(c.env, auth.userId)
    if (role !== 'admin') return new Response('Forbidden', { status: 403 })
    const namespace = doNamespace(c.env)
    return namespace.get(namespace.idFromName(id)).fetch(authenticatedRoomRequest(c.req.raw, auth, { role }))
  }
  app.get(
    '/ws/cron/:roomId',
    adminOnly((env) => env.CRON_ROOMS),
  )
  app.get(
    '/ws/jobs/:roomId',
    adminOnly((env) => env.JOB_ROOMS),
  )
}
