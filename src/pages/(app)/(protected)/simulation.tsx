/**
 * Solo simulation — functional page, not the designed one.
 *
 * Deliberately plain: the visual design is being developed separately. This
 * page proves the path end to end and nothing more.
 *
 * It never computes authoritative state. It reads the simulation row and its
 * event log over the realtime connection, folds them with the shared engine
 * reducer, and sends commands (ids only) to server actions. The countdown is
 * a display derived from server timestamps; the server decides when an action
 * is complete, when an incident fires and how the run ends.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button } from '@/components/ui'
import {
  ACTIONS,
  ACTION_IDS,
  GAME_EVENT_TYPES,
  OUTCOME_LABELS,
  ROLES,
  ROLE_LABELS,
  RULES_VERSION,
  finalResult,
  isActionId,
  isIncidentId,
  nextDue,
  reduce,
  validateApprovalRequest,
  validateExecute,
  type ActionId,
  type GameEvent,
  type GameEventType,
  type SimulationState,
} from '@/game/engine'
import { ConnectionNotice } from '@/components/ConnectionNotice'
import { callGameAction, isUnanswered, linkProblem, newCommandId, type LinkProblem } from '@/lib/game-api'
import type { SimulationEventRow, SimulationRow } from '@/schemas/simulation-schema'

interface ServerClock {
  serverNow: number
}

/** Why an available action cannot be run right now, in a few words. Display only: the server decides. */
const BLOCKED_TEXT: Record<string, string> = {
  prerequisite_missing: 'Not possible yet',
  approval_required: 'Needs commander approval',
  approval_denied: 'Approval denied',
  role_busy: 'Role busy',
  simulation_ended: 'Ended',
}

function eventText(event: GameEvent): string {
  const action = event.actionId ? ACTIONS[event.actionId].label : ''
  switch (event.type) {
    case 'action_started':
      return `${action} started`
    case 'action_completed':
      return `${action} completed`
    case 'approval_requested':
      return `Approval requested: ${action}`
    case 'approval_granted':
    case 'approval_auto_granted':
      return `Approval granted: ${action}`
    case 'approval_denied':
      return `Approval denied: ${action}`
    case 'incident':
      return event.finding ?? 'Incident update'
  }
}

/**
 * A run recorded under other rules (or before rules were versioned). Its log
 * only means something under the rules that wrote it, so it is never folded
 * or scored here; the server refuses it for the same reason.
 */
function isLegacy(row: SimulationRow): boolean {
  return row.rulesVersion !== RULES_VERSION
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export default function SimulationPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const simulationId = searchParams.get('id')

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 text-foreground">
      <h1 className="text-2xl font-semibold">Operation Nightfall</h1>
      {simulationId ? (
        <SimulationView simulationId={simulationId} onLeave={() => setSearchParams({})} />
      ) : (
        <Lobby onOpen={(id) => setSearchParams({ id })} />
      )}
    </div>
  )
}

function Lobby({ onOpen }: { onOpen: (id: string) => void }) {
  const { records, status } = useQuery<SimulationRow>('simulations', {
    orderBy: 'startedAt',
    orderDir: 'desc',
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One id per attempt, reused if the request is retried, so a retry cannot
  // create a second simulation.
  const commandId = useRef(newCommandId())

  const create = async () => {
    setPending(true)
    setError(null)
    const result = await callGameAction<{ simulationId: string }>('createSoloSimulation', {
      commandId: commandId.current,
    })
    setPending(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    commandId.current = newCommandId()
    onOpen(result.data.simulationId)
  }

  return (
    <section className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        Solo run. The clock starts on the server the moment you create it.
      </p>
      <Button onClick={create} loading={pending} data-testid="create-simulation">
        Start solo simulation
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="lobby-error">
          {error}
        </p>
      )}
      <div>
        <h2 className="text-sm font-medium">Your simulations</h2>
        {status === 'loading' && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
        {status === 'ready' && records.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">None yet.</p>
        )}
        <ul className="mt-2 space-y-1" data-testid="simulation-list">
          {records.map((record) => (
            <li key={record.recordId}>
              <button
                type="button"
                className="text-sm underline"
                onClick={() => onOpen(record.recordId)}
              >
                Started {new Date(record.data.startedAt).toLocaleString()}
              </button>
              {isLegacy(record.data) && (
                <span className="ml-2 text-xs text-muted-foreground" data-testid="simulation-legacy-tag">
                  earlier rules — cannot be opened
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function SimulationView({ simulationId, onLeave }: { simulationId: string; onLeave: () => void }) {
  const simulations = useQuery<SimulationRow>('simulations')
  const eventsQuery = useQuery<SimulationEventRow>('simulation_events', {
    where: { simulationId },
    orderBy: 'seq',
    orderDir: 'asc',
  })
  const simulation = simulations.records.find((record) => record.recordId === simulationId)
  const legacy = simulation ? isLegacy(simulation.data) : false

  // Server time = local time + offset, learned from every server response.
  const [clockOffset, setClockOffset] = useState<number | null>(null)
  const [localNow, setLocalNow] = useState(() => Date.now())
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One id per (command, action), reused if the request is retried.
  const commandIds = useRef<Record<string, string>>({})

  const learnClock = useCallback((clock: ServerClock) => {
    setClockOffset(clock.serverNow - Date.now())
  }, [])

  // The server's answer to the last sync is the log itself. The realtime
  // rows normally arrive first; when they are late or the socket is down,
  // this is what keeps the page from showing an older state as current.
  const [syncedEvents, setSyncedEvents] = useState<GameEvent[]>([])
  const [problem, setProblem] = useState<LinkProblem>(null)

  const sync = useCallback(async () => {
    const result = await callGameAction<ServerClock & { events?: GameEvent[] }>('syncSimulation', { simulationId })
    setProblem(linkProblem(result))
    if (result.success) {
      learnClock(result.data)
      if (Array.isArray(result.data.events)) setSyncedEvents(result.data.events)
    }
    return result
  }, [simulationId, learnClock])

  // While the server cannot be reached, keep trying; the first answer clears the warning.
  useEffect(() => {
    if (problem !== 'offline') return
    const timer = setInterval(() => void sync(), 3000)
    return () => clearInterval(timer)
  }, [problem, sync])

  // On open, refresh or reconnect: settle anything that happened while this
  // tab was away, and learn the server clock.
  useEffect(() => {
    void sync()
  }, [sync])

  useEffect(() => {
    const timer = setInterval(() => setLocalNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])

  const events = useMemo<GameEvent[]>(() => {
    const live: GameEvent[] = eventsQuery.records
        .map((record) => record.data)
        .filter((row) => GAME_EVENT_TYPES.includes(row.type as GameEventType))
        .map((row) => ({
          seq: row.seq,
          type: row.type as GameEventType,
          ...(isActionId(row.actionId) ? { actionId: row.actionId } : {}),
          ...(isIncidentId(row.incidentId) ? { incidentId: row.incidentId } : {}),
          at: row.at,
          actorId: row.actorId ?? '',
          commandId: row.commandId ?? '',
          finding: row.finding || undefined,
        }))
        .sort((a, b) => a.seq - b.seq)
    // The log only grows, so whichever copy reaches further is the newer one.
    return (syncedEvents.at(-1)?.seq ?? 0) > (live.at(-1)?.seq ?? 0) ? syncedEvents : live
  }, [eventsQuery.records, syncedEvents])

  const state = useMemo(() => {
    if (!simulation || legacy) return null
    try {
      return reduce(simulation.data.startedAt, events)
    } catch {
      // A partial snapshot mid-sync (a later event before an earlier one).
      // Keep the last good render; the next update will be complete.
      return null
    }
  }, [simulation, legacy, events])

  const lastGoodState = useRef(state)
  if (state) lastGoodState.current = state
  const view = state ?? lastGoodState.current

  const serverNow = clockOffset === null ? null : localNow + clockOffset

  // When an action's time is up or a scheduled incident is due, ask the
  // server to record it. The server decides; this is only a prompt, repeated
  // at most once a second.
  const lastSettleAttempt = useRef(0)
  useEffect(() => {
    if (!view || serverNow === null) return
    const waiting = nextDue(view, serverNow) !== null
    if (waiting && localNow - lastSettleAttempt.current >= 1000) {
      lastSettleAttempt.current = localNow
      void sync()
    }
  }, [view, serverNow, localNow, sync])

  const send = async (command: 'executeAction' | 'requestApproval', actionId: ActionId) => {
    const key = `${command}:${actionId}`
    setPendingAction(key)
    setError(null)
    commandIds.current[key] ??= newCommandId()
    const result = await callGameAction<ServerClock>(command, {
      simulationId,
      actionId,
      commandId: commandIds.current[key],
    })
    if (result.success) {
      learnClock(result.data)
      // Show what the command did before the button becomes available again.
      await sync()
    } else {
      // A refused command is over; the next attempt is a new command. A
      // request that never got an answer keeps its id, so a retry is safe.
      if (!isUnanswered(result.code)) delete commandIds.current[key]
      const link = linkProblem(result)
      if (link) setProblem(link)
      setError(result.error)
    }
    setPendingAction(null)
  }

  if (simulations.status === 'loading' || eventsQuery.status === 'loading') {
    return (
      <div className="mt-6 space-y-4">
        <ConnectionNotice problem={problem} onRetry={() => void sync()} />
        <p className="text-sm text-muted-foreground">Loading simulation…</p>
      </div>
    )
  }
  if (simulation && legacy) {
    return (
      <div className="mt-6 space-y-4">
        <p className="text-sm text-muted-foreground" data-testid="simulation-legacy">
          This run was recorded under an earlier version of the scenario rules. It cannot be replayed or scored
          under the current rules, so it is not shown.
        </p>
        <Button variant="secondary" onClick={onLeave}>
          Back
        </Button>
      </div>
    )
  }
  if (!simulation || !view) {
    return (
      <div className="mt-6 space-y-4">
        <p className="text-sm text-muted-foreground" data-testid="simulation-missing">
          This simulation does not exist, or you are not a participant in it.
        </p>
        <Button variant="secondary" onClick={onLeave}>
          Back
        </Button>
      </div>
    )
  }

  const result = finalResult(view)
  const ended = result !== null || (serverNow !== null && serverNow >= view.deadlineAt)
  const remaining = serverNow === null ? null : view.deadlineAt - (result ? result.endedAt : serverNow)
  const clock = serverNow ?? view.lastEventAt

  return (
    <section className="mt-6 space-y-8" data-testid="simulation-view" data-last-seq={view.lastSeq}>
      <ConnectionNotice problem={problem} onRetry={() => void sync()} />
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-muted-foreground">
          {ended ? 'Simulation ended' : 'Time remaining'}
        </p>
        <p className="font-mono text-xl tabular-nums" data-testid="time-remaining">
          {remaining === null ? '--:--' : formatClock(remaining)}
        </p>
      </div>

      {result && (
        <div className="rounded-md border border-border p-4" data-testid="result">
          <p className="text-xs text-muted-foreground">Outcome</p>
          <p className="text-lg font-semibold" data-testid="outcome">
            {OUTCOME_LABELS[result.outcome]}
          </p>
          <p className="mt-1 text-sm">
            Score{' '}
            <span className="font-mono tabular-nums" data-testid="score">
              {result.score}
            </span>{' '}
            / 100
          </p>
        </div>
      )}

      <dl className="grid grid-cols-4 gap-4">
        {(['health', 'containment', 'trust', 'evidence'] as const).map((metric) => (
          <div key={metric} className="rounded-md border border-border p-3">
            <dt className="text-xs capitalize text-muted-foreground">{metric}</dt>
            <dd className="font-mono text-lg tabular-nums" data-testid={`metric-${metric}`}>
              {view.metrics[metric]}
            </dd>
          </div>
        ))}
      </dl>

      <div>
        <h2 className="text-sm font-medium">Actions</h2>
        {ROLES.map((role) => (
          <div key={role} className="mt-4">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{ROLE_LABELS[role]}</h3>
            <ul className="mt-2 space-y-3">
              {ACTION_IDS.filter((actionId) => ACTIONS[actionId].role === role).map((actionId) => (
                <ActionRow
                  key={actionId}
                  actionId={actionId}
                  view={view}
                  clock={clock}
                  ended={ended || problem === 'signed_out'}
                  pendingAction={pendingAction}
                  onRun={() => send('executeAction', actionId)}
                  onRequestApproval={() => send('requestApproval', actionId)}
                />
              ))}
            </ul>
          </div>
        ))}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive" data-testid="action-error">
            {error}
          </p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium">Timeline</h2>
        {events.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No events yet.</p>}
        <ol className="mt-2 space-y-2" data-testid="timeline">
          {events.map((event) => (
            <li key={event.seq} className="text-sm" data-testid={`event-${event.type}`}>
              <span className="font-mono text-xs text-muted-foreground">
                {formatClock(event.at - view.startedAt)}
              </span>{' '}
              {eventText(event)}
              {event.finding && event.type !== 'incident' && (
                <span className="block text-muted-foreground">{event.finding}</span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <Button variant="secondary" onClick={onLeave}>
        Back to list
      </Button>
    </section>
  )
}

function ActionRow({
  actionId,
  view,
  clock,
  ended,
  pendingAction,
  onRun,
  onRequestApproval,
}: {
  actionId: ActionId
  view: SimulationState
  clock: number
  ended: boolean
  pendingAction: string | null
  onRun: () => void
  onRequestApproval: () => void
}) {
  const definition = ACTIONS[actionId]
  const action = view.actions[actionId]
  // The same checks the server will make, used here only to label and enable
  // buttons. The server's answer is the one that counts.
  const verdict = validateExecute(view, actionId, clock)
  const canRequestApproval = definition.needsApproval && validateApprovalRequest(view, actionId, clock).ok
  const approval = view.approvals[actionId]

  let status: string
  if (action.status === 'completed') {
    status = 'Completed'
  } else if (action.status === 'in_progress') {
    const left = (action.completesAt ?? clock) - clock
    status = left > 0 ? `In progress — ${formatClock(left)}` : 'Finishing…'
  } else if (verdict.ok) {
    status = definition.durationMs === 0 ? 'Ready' : `${definition.durationMs / 1000}s`
  } else if (
    verdict.code === 'approval_pending' &&
    approval &&
    (approval.status === 'approved' || approval.status === 'denied')
  ) {
    status = `Approval processing — ${formatClock(approval.effectiveAt - clock)}`
  } else {
    status = BLOCKED_TEXT[verdict.code] ?? 'Unavailable'
  }

  return (
    <li className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm">{definition.label}</p>
        <p className="text-xs text-muted-foreground" data-testid={`action-status-${actionId}`}>
          {status}
        </p>
      </div>
      <div className="flex gap-2">
        {canRequestApproval && !ended && (
          <Button
            variant="secondary"
            onClick={onRequestApproval}
            loading={pendingAction === `requestApproval:${actionId}`}
            data-testid={`approve-${actionId}`}
          >
            Request approval
          </Button>
        )}
        <Button
          onClick={onRun}
          disabled={!verdict.ok || ended}
          loading={pendingAction === `executeAction:${actionId}`}
          data-testid={`action-${actionId}`}
        >
          Run
        </Button>
      </div>
    </li>
  )
}
