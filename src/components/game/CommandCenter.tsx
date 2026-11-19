/**
 * The command center: the one screen a simulation is played on, solo or team.
 *
 * Presentation only. The page that renders it holds the realtime rows, folds
 * the log with the shared engine and sends commands; this component shows
 * that state and reports which control was pressed. The checks it runs
 * (`validateExecute`, `validateApprovalRequest`) are the same ones the server
 * runs, used here only to label and enable controls — the server's answer is
 * the one that counts.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, ChevronDown, Lock, LockKeyhole } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  ACTIONS,
  ACTION_IDS,
  METRIC_NAMES,
  ROLES,
  ROLE_LABELS,
  validateApprovalRequest,
  validateExecute,
  type ActionId,
  type FinalResult,
  type GameEvent,
  type RoleId,
  type SimulationState,
} from '@/game/engine'
import {
  ACTION_BRIEF,
  METRIC_LABELS,
  TONE_BAR,
  TONE_TEXT,
  annotate,
  eventHeadline,
  formatClock,
  formatDelta,
  formatDuration,
  metricTone,
  type AnnotatedEvent,
  type Tone,
} from './model'
import { Postmortem } from './Postmortem'

export interface EventFindings {
  /** Text everyone in the simulation can read. */
  shared?: { text: string; sharedBy?: string }
  /** Text only this person can read, not yet shared. */
  own?: { text: string }
}

export type PendingKind = 'run' | 'ask' | 'approve' | 'deny' | 'share'

export interface CommandCenterProps {
  mode: 'solo' | 'team'
  rootTestId: string
  rootAttrs?: Record<string, string | number>
  view: SimulationState
  events: GameEvent[]
  /** Server time as best known; the last event's time before the first answer. */
  clock: number
  remaining: number | null
  ended: boolean
  /** Controls are off although the simulation is running (signed out). */
  locked?: boolean
  result: FinalResult | null
  /** The role this person plays. Null in a solo run, where one person plays all three. */
  role: RoleId | null
  nameOf: (userId: string) => string
  findingsOf: (event: GameEvent) => EventFindings
  isPending: (kind: PendingKind, key: string) => boolean
  onRun: (actionId: ActionId) => void
  onRequestApproval: (actionId: ActionId) => void
  onDecide?: (actionId: ActionId, requestSeq: number, decision: 'approve' | 'deny') => void
  onShare?: (eventSeq: number) => void
  error: string | null
  notice?: ReactNode
  teamPanel?: ReactNode
  /** Where to go from here: back, new run. */
  exits: ReactNode
}

/** Why an available action cannot be run right now. Display only: the server decides. */
const BLOCKED_TEXT: Record<string, string> = {
  prerequisite_missing: 'Not possible yet',
  approval_required: 'Needs commander approval',
  approval_denied: 'Approval denied',
  role_busy: 'Role busy',
  simulation_ended: 'Ended',
  wrong_role: 'Another role',
}

interface ActionStatus {
  text: string
  tone: Tone
  kind: 'completed' | 'running' | 'waiting' | 'ready' | 'processing' | 'blocked'
  runnable: boolean
  canRequest: boolean
  progress: number | null
}

function actionStatus(view: SimulationState, actionId: ActionId, clock: number, team: boolean): ActionStatus {
  const definition = ACTIONS[actionId]
  const action = view.actions[actionId]
  // In a team the label says why the ACTION is blocked, so it is judged as its own role.
  const roles = team ? [definition.role] : undefined
  const verdict = validateExecute(view, actionId, clock, roles)
  const canRequest = definition.needsApproval && validateApprovalRequest(view, actionId, clock, roles).ok
  const approval = view.approvals[actionId]
  const base = { runnable: verdict.ok, canRequest, progress: null }

  if (action.status === 'completed') return { ...base, text: 'Completed', tone: 'ok', kind: 'completed' }
  if (action.status === 'in_progress') {
    const left = (action.completesAt ?? clock) - clock
    const total = Math.max(1, (action.completesAt ?? clock) - (action.startedAt ?? clock))
    return {
      ...base,
      text: left > 0 ? `In progress — ${formatClock(left)}` : 'Finishing…',
      tone: 'caution',
      kind: 'running',
      progress: Math.min(1, Math.max(0, 1 - left / total)),
    }
  }
  if (team && approval?.status === 'requested') return { ...base, text: 'Waiting for the commander', tone: 'caution', kind: 'waiting' }
  if (verdict.ok) {
    return { ...base, text: definition.durationMs === 0 ? 'Ready' : `${definition.durationMs / 1000}s`, tone: 'neutral', kind: 'ready' }
  }
  if (verdict.code === 'approval_pending' && approval && (approval.status === 'approved' || approval.status === 'denied')) {
    return { ...base, text: `Approval processing — ${formatClock(approval.effectiveAt - clock)}`, tone: 'caution', kind: 'processing' }
  }
  const tone: Tone = verdict.code === 'approval_denied' ? 'critical' : verdict.code === 'approval_required' ? 'caution' : 'neutral'
  return { ...base, text: BLOCKED_TEXT[verdict.code] ?? 'Unavailable', tone, kind: 'blocked' }
}

export function CommandCenter(props: CommandCenterProps) {
  const { mode, view, events, clock, remaining, ended, result, role, error } = props
  const annotated = useMemo(() => annotate(view.startedAt, events), [view.startedAt, events])
  const [evidence, setEvidence] = useState<number | null>(null)
  const openEvent = evidence === null ? undefined : annotated.find((entry) => entry.event.seq === evidence)

  // The large countdown scrolls away with the header; while it is out of view the pinned bar carries the time.
  const timer = useRef<HTMLParagraphElement>(null)
  const [clockHidden, setClockHidden] = useState(false)
  useEffect(() => {
    const element = timer.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setClockHidden(!entry.isIntersecting), { threshold: 0.2 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const pendingApprovals = ACTION_IDS.filter((actionId) => view.approvals[actionId]?.status === 'requested').map((actionId) => ({
    actionId,
    request: [...events].reverse().find((event) => event.type === 'approval_requested' && event.actionId === actionId),
  }))

  // What a screen reader is told as things happen: the newest event, once.
  const latest = annotated.at(-1)
  const announcement = latest ? `${eventHeadline(latest.event)}. ${props.findingsOf(latest.event).shared?.text ?? ''}` : ''

  const columns = (
      <div
        className={cn(
          'grid', !result && 'border-b border-border-strong',
          props.teamPanel ? 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_15.5rem]' : 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
        )}
      >
        <section aria-labelledby="actions-heading" className={cn('min-w-0 py-5 lg:col-start-2 lg:row-start-1 lg:border-l lg:border-border lg:pl-6', props.teamPanel && 'xl:pr-6')}>
          <ColumnHead id="actions-heading" title={result ? 'Actions taken' : 'Response actions'}>
            {!result && <span>{mode === 'team' ? 'One at a time per role' : 'One at a time per role · three roles'}</span>}
          </ColumnHead>
          {error && (
            <p role="alert" className="mt-3 border-l-2 border-critical bg-critical-surface px-3 py-2 text-sm text-foreground" data-testid="action-error">
              {error}
            </p>
          )}
          <div className="mt-1">
            {orderedRoles(role).map((group) => {
              const engaged = ACTION_IDS.some((actionId) => ACTIONS[actionId].role === group && view.actions[actionId].status === 'in_progress')
              return (
                <div key={group} className="mt-5 first:mt-4">
                  <h3 className="flex items-center justify-between gap-3 border-b border-border-strong pb-2">
                    <span className="flex items-center gap-2.5 font-display text-[15px] font-bold tracking-tight">
                      {ROLE_LABELS[group]}
                      {group === role && <span className="bg-foreground px-1.5 py-px font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-background">You</span>}
                      {role !== null && group !== role && (
                        <span className="border border-border-strong px-1.5 py-px font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">View only</span>
                      )}
                    </span>
                    {!ended && (
                      <span className={cn('font-sans text-[11px] font-semibold uppercase tracking-[0.12em]', engaged ? 'text-caution' : 'text-subtle')}>{engaged ? 'Engaged' : 'Free'}</span>
                    )}
                  </h3>
                  <ul>
                    {ACTION_IDS.filter((actionId) => ACTIONS[actionId].role === group).map((actionId) => (
                      <ActionRow
                        key={actionId}
                        actionId={actionId}
                        view={view}
                        clock={clock}
                        team={mode === 'team'}
                        mine={role === null || group === role}
                        disabled={ended || !!props.locked}
                        isPending={props.isPending}
                        onRun={() => props.onRun(actionId)}
                        onRequestApproval={() => props.onRequestApproval(actionId)}
                      />
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </section>

        <Timeline
          annotated={annotated}
          view={view}
          live={!ended}
          mode={mode}
          nameOf={props.nameOf}
          findingsOf={props.findingsOf}
          isPending={props.isPending}
          onShare={props.onShare}
          onOpen={setEvidence}
          bounded={!result}
        />

        {props.teamPanel && <div className="min-w-0 border-t border-border py-5 lg:col-span-2 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:border-l xl:border-t-0 xl:pl-6">{props.teamPanel}</div>}
      </div>
  )

  return (
    <section className="w-full px-4 pb-10 sm:px-6 lg:px-10" data-testid={props.rootTestId} {...props.rootAttrs}>
      <p className="sr-only" role="status" aria-live="polite" data-testid="live-announcement">
        {announcement}
      </p>
      {props.notice && <div className="pt-4 empty:hidden">{props.notice}</div>}

      <Header mode={mode} remaining={remaining} ended={ended} result={result} role={role} timer={timer} />
      <StatusStrip view={view} />
      {!result && !ended && !props.locked && (
        <NowBar view={view} clock={clock} remaining={remaining} team={mode === 'team'} role={role} decisions={role === 'commander' ? pendingApprovals.length : 0} clockHidden={clockHidden} />
      )}

      {result && <Postmortem view={view} result={result} annotated={annotated} exits={props.exits} />}

      {mode === 'team' && (pendingApprovals.length > 0 || role === 'commander') && !result && (
        <ApprovalQueue
          pendingApprovals={pendingApprovals}
          view={view}
          role={role}
          ended={ended || !!props.locked}
          nameOf={props.nameOf}
          isPending={props.isPending}
          onDecide={props.onDecide}
        />
      )}
      {mode === 'team' && pendingApprovals.length === 0 && role !== 'commander' && !result && (
        <p className="sr-only" data-testid="no-pending-approvals">
          No approvals are pending.
        </p>
      )}

      {result ? (
        // The report above is the reading copy; the whole log stays one step away.
        <details className="group border-b border-border-strong" data-testid="full-record">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="eyebrow block">Annex</span>
              <span className="mt-1.5 block font-display text-xl font-bold">Complete event record</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                All {events.length} recorded events in order, and the state each of the {ACTION_IDS.length} actions ended in.
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-2 border border-border-strong px-3 py-2 text-sm font-semibold">
              <span className="group-open:hidden">Show record</span>
              <span className="hidden group-open:inline">Hide record</span>
              <ChevronDown className="size-4 group-open:rotate-180" aria-hidden />
            </span>
          </summary>
          {columns}
        </details>
      ) : (
        columns
      )}

      {!result && <Briefing mode={mode} />}
      {!result && (
        <div className="pt-6" data-print="hide">
          {props.exits}
        </div>
      )}

      <EvidenceDialog
        entry={openEvent}
        view={view}
        mode={mode}
        nameOf={props.nameOf}
        findingsOf={props.findingsOf}
        isPending={props.isPending}
        onShare={props.onShare}
        onClose={() => setEvidence(null)}
      />
    </section>
  )
}

/** A person sees their own role's actions first. */
function orderedRoles(role: RoleId | null): RoleId[] {
  const order: RoleId[] = ['security', 'infrastructure', 'commander']
  return role ? [role, ...order.filter((other) => other !== role)] : order.filter((r) => ROLES.includes(r))
}

/** The title bar of one column of the incident room. */
export function ColumnHead({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h2 id={id} className="kicker">
        {title}
      </h2>
      {children && <div className="flex items-center gap-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  )
}

function Header({
  mode,
  remaining,
  ended,
  result,
  role,
  timer,
}: {
  mode: 'solo' | 'team'
  remaining: number | null
  ended: boolean
  result: FinalResult | null
  role: RoleId | null
  timer: RefObject<HTMLParagraphElement | null>
}) {
  const urgent = !ended && remaining !== null && remaining <= 60_000
  return (
    <header className="grid gap-x-10 gap-y-5 border-b border-border-strong py-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end lg:py-7">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="inline-flex items-center gap-2 bg-critical px-2 py-1 text-[11px] font-bold leading-none tracking-[0.14em] text-background" data-testid="severity">
            <span className={cn('size-1.5 rounded-full bg-background', !ended && 'soft-pulse')} aria-hidden />
            SEV-1
          </span>
          <span className="eyebrow text-foreground">Operation Nightfall</span>
          <span className="eyebrow">{mode === 'team' ? 'Team · 3 players' : 'Solo · all three roles'}</span>
        </div>
        <h1 className="mt-4 text-[clamp(1.75rem,1.1rem+2.5vw,3.25rem)] font-extrabold leading-[1.02] tracking-[-0.025em]">Sign-in failures across Meridian Cloud</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
          {result
            ? 'The simulation is over. The report below is computed from the recorded events.'
            : 'Customers cannot sign in and the cause is unknown. Investigate, contain the threat and restore the service before the executive bridge call.'}
          {role && (
            <>
              {' '}
              You are the{' '}
              <strong className="font-semibold text-foreground" data-testid="my-role">
                {ROLE_LABELS[role]}
              </strong>
              .
            </>
          )}
        </p>
      </div>
      <div className="shrink-0 md:border-l md:border-border-strong md:pl-10 md:text-right">
        <p className="eyebrow" data-testid="clock-label">
          {ended ? 'Simulation ended' : 'Remaining · server time'}
        </p>
        <p
          ref={timer}
          className={cn('numeral mt-3 text-[clamp(4rem,2.6rem+5.6vw,7.25rem)]', urgent ? 'text-critical' : 'text-foreground')}
          role="timer"
          aria-label={ended ? 'Simulation ended' : 'Time remaining'}
          data-testid="time-remaining"
        >
          {remaining === null ? '--:--' : formatClock(remaining)}
        </p>
      </div>
    </header>
  )
}

/** The four measures of the incident, as one ruled line under the header. */
function StatusStrip({ view }: { view: SimulationState }) {
  return (
    <dl className="grid grid-cols-2 gap-px border-b border-border-strong bg-border lg:grid-cols-4">
      {METRIC_NAMES.map((metric) => {
        const value = view.metrics[metric]
        const tone = metricTone(value)
        return (
          <div key={metric} className="relative flex flex-col gap-2 bg-background px-1 pb-4 pt-3 sm:flex-row sm:items-end sm:justify-between sm:gap-3 sm:px-4 lg:first:pl-0 lg:last:pr-0">
            <dt className="eyebrow pb-0.5">{METRIC_LABELS[metric]}</dt>
            <dd className="flex items-baseline gap-1">
              <span className={cn('numeral text-[2rem] sm:text-[2.5rem]', tone === 'critical' ? 'text-critical' : 'text-foreground')} data-testid={`metric-${metric}`}>
                {value}
              </span>
              <span className="text-xs text-subtle" aria-hidden>
                /100
              </span>
            </dd>
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-secondary" aria-hidden>
              <div className={cn('h-full transition-[width] duration-300 ease-out', TONE_BAR[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
            </div>
          </div>
        )
      })}
    </dl>
  )
}

/** Scroll a part of the room into view and put the keyboard on its first live control. */
function jumpTo(id: string) {
  const element = document.getElementById(id)
  if (!element) return
  element.scrollIntoView({ block: 'center' })
  element.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true })
}

/**
 * The line that stays in view: time left once the big clock has scrolled away,
 * and what this person can act on this second. It starts nothing itself — each
 * entry leads to the control in the list below.
 */
function NowBar({
  view,
  clock,
  remaining,
  team,
  role,
  decisions,
  clockHidden,
}: {
  view: SimulationState
  clock: number
  remaining: number | null
  team: boolean
  role: RoleId | null
  decisions: number
  clockHidden: boolean
}) {
  const mine = ACTION_IDS.filter((actionId) => role === null || ACTIONS[actionId].role === role).map((actionId) => ({ actionId, status: actionStatus(view, actionId, clock, team) }))
  const open = [
    ...mine.filter((entry) => entry.status.kind === 'ready').map((entry) => ({ ...entry, verb: ACTIONS[entry.actionId].terminal ? 'Confirm' : 'Execute' })),
    ...mine.filter((entry) => entry.status.kind !== 'ready' && entry.status.canRequest).map((entry) => ({ ...entry, verb: 'Request approval' })),
  ]
  const running = mine.filter((entry) => entry.status.kind === 'running')
  const waiting = mine.filter((entry) => entry.status.kind === 'waiting' || entry.status.kind === 'processing')
  const urgent = remaining !== null && remaining <= 60_000
  const shown = open.slice(0, 3)

  return (
    <div
      role="group"
      aria-label="What you can act on now"
      className="sticky top-0 z-20 -mx-4 flex min-h-[3.25rem] items-center gap-x-4 border-b border-border-strong bg-background px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"
      data-testid="now-bar"
    >
      {clockHidden && (
        // The timer above is the one assistive technology reads; this is the same value kept in sight.
        <span className={cn('numeral shrink-0 border-r border-border-strong pr-4 text-[1.75rem]', urgent ? 'text-critical' : 'text-foreground')} aria-hidden data-testid="now-clock">
          {remaining === null ? '--:--' : formatClock(remaining)}
        </span>
      )}
      <p className="eyebrow hidden shrink-0 text-foreground sm:block">{decisions > 0 ? 'Decide now' : open.length > 0 ? 'Open to you' : 'Status'}</p>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
        {decisions > 0 && (
          <button type="button" className="inline-flex min-h-8 items-center gap-2 bg-caution px-2.5 text-xs font-bold text-background" onClick={() => jumpTo('approvals')} data-testid="now-decisions">
            {decisions} {decisions === 1 ? 'approval needs' : 'approvals need'} your decision
          </button>
        )}
        {shown.map(({ actionId, verb }) => (
          <button
            key={actionId}
            type="button"
            className="inline-flex min-h-8 max-w-full items-center gap-2 border border-border-strong px-2.5 text-left text-xs font-semibold hover:bg-secondary"
            onClick={() => jumpTo(`action-row-${actionId}`)}
            data-testid={`now-${actionId}`}
          >
            <span className="truncate">{ACTIONS[actionId].label}</span>
            <span className={cn('shrink-0 font-medium', verb === 'Request approval' ? 'text-caution' : 'text-muted-foreground')}>
              <span className="sr-only">— go to </span>
              {verb}
            </span>
          </button>
        ))}
        {open.length > shown.length && <span className="text-xs text-muted-foreground">+{open.length - shown.length} more</span>}
        {open.length === 0 && decisions === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="now-idle">
            {running.length > 0
              ? `${running.map((entry) => ACTIONS[entry.actionId].label).join(', ')} in progress. Nothing else can start until it finishes.`
              : waiting.length > 0
                ? 'Waiting on a commander decision. Nothing else can start yet.'
                : 'Nothing can be started right now.'}
          </p>
        )}
      </div>
    </div>
  )
}

function ApprovalQueue({
  pendingApprovals,
  view,
  role,
  ended,
  nameOf,
  isPending,
  onDecide,
}: {
  pendingApprovals: { actionId: ActionId; request: GameEvent | undefined }[]
  view: SimulationState
  role: RoleId | null
  ended: boolean
  nameOf: (userId: string) => string
  isPending: (kind: PendingKind, key: string) => boolean
  onDecide?: (actionId: ActionId, requestSeq: number, decision: 'approve' | 'deny') => void
}) {
  const commander = role === 'commander'
  const empty = pendingApprovals.length === 0
  return (
    <section
      id="approvals"
      aria-labelledby="approvals-heading"
      className={cn(
        'grid gap-x-8 gap-y-3 border-b py-5 md:grid-cols-[13rem_minmax(0,1fr)]',
        empty ? 'border-border' : 'border-l-4 border-caution/70 border-l-caution bg-caution-surface px-4 sm:px-5',
      )}
    >
      <div>
        <p className={cn('eyebrow', !empty && 'text-caution')}>
          {empty ? 'Command' : commander ? 'Decision required' : 'Awaiting command'}
          {!empty && <span className="tabular"> · {pendingApprovals.length}</span>}
        </p>
        <h2 id="approvals-heading" className="mt-1.5 font-display text-lg font-bold leading-tight">
          {commander ? 'Approvals waiting for your decision' : 'Waiting for the Incident Commander'}
        </h2>
      </div>
      <div className="min-w-0">
        {empty && (
          <p className="text-sm text-muted-foreground md:pt-6" data-testid="no-pending-approvals">
            Nothing is waiting. Requests for major interventions appear here.
          </p>
        )}
        <ul className="divide-y divide-caution/30" data-testid="pending-approvals">
          {pendingApprovals.map(({ actionId, request }) => {
            const definition = ACTIONS[actionId]
            return (
              <li key={actionId} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between" data-testid={`pending-${actionId}`}>
                <div className="min-w-0">
                  <p className="font-display text-base font-bold">{definition.label}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{ACTION_BRIEF[actionId]}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Requested by <span className="text-foreground">{request ? nameOf(request.actorId) : 'a teammate'}</span> ({ROLE_LABELS[definition.role]})
                    {request && <> at {formatClock(request.at - view.startedAt)}</>} · {definition.durationMs === 0 ? 'takes effect at once' : `takes ${formatDuration(definition.durationMs)}`} once approved
                  </p>
                </div>
                {commander && request && !ended && onDecide ? (
                  <div className="flex shrink-0 gap-2">
                    <Button onClick={() => onDecide(actionId, request.seq, 'approve')} loading={isPending('approve', `${actionId}:${request.seq}`)} data-testid={`decide-approve-${actionId}`}>
                      Approve
                    </Button>
                    <Button variant="outline" onClick={() => onDecide(actionId, request.seq, 'deny')} loading={isPending('deny', `${actionId}:${request.seq}`)} data-testid={`decide-deny-${actionId}`}>
                      Deny
                    </Button>
                  </div>
                ) : (
                  <p className="shrink-0 text-xs font-medium text-caution">{commander ? 'Decision unavailable' : 'Only the commander can decide'}</p>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function ActionRow({
  actionId,
  view,
  clock,
  team,
  mine,
  disabled,
  isPending,
  onRun,
  onRequestApproval,
}: {
  actionId: ActionId
  view: SimulationState
  clock: number
  team: boolean
  mine: boolean
  disabled: boolean
  isPending: (kind: PendingKind, key: string) => boolean
  onRun: () => void
  onRequestApproval: () => void
}) {
  const definition = ACTIONS[actionId]
  const status = actionStatus(view, actionId, clock, team)
  const missing = definition.requires.filter((required) => view.actions[required].status !== 'completed')
  const done = status.kind === 'completed'
  const over = view.endedAt !== undefined
  const approved = view.approvals[actionId]?.status === 'approved'
  const open = status.kind === 'ready' && mine && !disabled
  const dim = !done && !open && status.kind !== 'running' && status.kind !== 'waiting' && status.kind !== 'processing'

  return (
    <li id={`action-row-${actionId}`} className="relative scroll-mt-20 border-b border-border py-3.5 pl-4" data-action-state={status.kind}>
      {/* The edge of the row says what state the decision is in. */}
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-0.5',
          open ? 'bg-foreground' : status.kind === 'running' || status.kind === 'waiting' || status.kind === 'processing' ? 'bg-caution' : done ? 'bg-ok/70' : 'bg-transparent',
        )}
        aria-hidden
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3.5">
          <span className="w-5 shrink-0 pt-0.5 text-xs font-semibold text-subtle tabular" aria-hidden>
            {String(ACTION_IDS.indexOf(actionId) + 1).padStart(2, '0')}
          </span>
          <div className="min-w-0">
            <p className={cn('font-display text-base font-bold leading-snug tracking-tight', (done || dim) && 'text-muted-foreground')}>{definition.label}</p>
            <p className={cn('mt-0.5 text-sm', dim || done ? 'text-subtle' : 'text-muted-foreground')}>{ACTION_BRIEF[actionId]}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <span className={cn('inline-flex items-center gap-1.5 font-semibold tabular', TONE_TEXT[status.tone], status.tone === 'neutral' && open && 'text-foreground')}>
                {done ? <Check className="size-3" aria-hidden /> : status.kind === 'blocked' ? <Lock className="size-3" aria-hidden /> : <span className={cn('size-1.5', TONE_BAR[status.tone], open && 'bg-foreground')} aria-hidden />}
                {status.kind === 'ready' && definition.durationMs > 0 && <span>Ready · takes</span>}
                <span data-testid={`action-status-${actionId}`}>{status.text}</span>
              </span>
              {status.kind !== 'ready' && !done && !over && status.kind !== 'running' && <span className="text-muted-foreground">{definition.durationMs === 0 ? 'Takes effect at once' : `Takes ${formatDuration(definition.durationMs)}`}</span>}
              {definition.needsApproval && !done && !over && !approved && (
                <span className="inline-flex items-center gap-1 font-medium text-caution">
                  <LockKeyhole className="size-3" aria-hidden />
                  Commander approval
                </span>
              )}
              {definition.needsApproval && !done && !over && approved && (
                <span className="inline-flex items-center gap-1 font-medium text-ok">
                  <Check className="size-3" aria-hidden />
                  Commander approved
                </span>
              )}
            </div>
            {missing.length > 0 && !done && (
              <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground" data-testid={`action-requires-${actionId}`}>
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">Requires first</span>
                {missing.map((required, index) => (
                  <span key={required} className="text-foreground/85">
                    {ACTIONS[required].label}
                    {index < missing.length - 1 && <span className="text-subtle">,</span>}
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
        {mine && !done && (
          <div className="flex shrink-0 flex-wrap gap-2 pl-[2.125rem] sm:pl-0">
            {status.canRequest && !disabled && (
              <Button size="sm" variant="outline" className="border-caution/70 bg-transparent text-caution hover:bg-caution-surface hover:text-caution" onClick={onRequestApproval} loading={isPending('ask', actionId)} data-testid={`approve-${actionId}`}>
                Request approval
              </Button>
            )}
            <Button
              size="sm"
              variant={status.runnable && !disabled ? 'default' : 'outline'}
              className={cn('min-w-[5.5rem] font-semibold', !(status.runnable && !disabled) && 'border-border bg-transparent text-subtle disabled:opacity-100')}
              onClick={onRun}
              disabled={!status.runnable || disabled}
              loading={isPending('run', actionId)}
              data-testid={`action-${actionId}`}
            >
              {!(status.runnable && !disabled) && status.kind === 'blocked' && !over && <Lock aria-hidden />}
              {status.runnable && !disabled ? (definition.terminal ? 'Confirm' : 'Execute') : status.kind === 'running' ? 'Running' : status.kind === 'waiting' || status.kind === 'processing' ? 'Pending' : over ? 'Not run' : 'Locked'}
              <span className="sr-only">: {definition.label}</span>
            </Button>
          </div>
        )}
        {mine && done && (
          // The control stays in the page, disabled, so its state is unambiguous to assistive tech and tests alike.
          <Button size="sm" variant="ghost" disabled className="min-w-[5.5rem] shrink-0 self-start text-subtle disabled:opacity-100" data-testid={`action-${actionId}`}>
            <Check aria-hidden /> Done
            <span className="sr-only">: {definition.label}</span>
          </Button>
        )}
      </div>
      {status.progress !== null && (
        <div className="absolute inset-x-0 -bottom-px h-0.5 bg-secondary" role="progressbar" aria-label={`${definition.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.progress * 100)}>
          <div className="h-full bg-caution transition-[width] duration-300 ease-linear" style={{ width: `${status.progress * 100}%` }} />
        </div>
      )}
    </li>
  )
}

function eventActor(event: GameEvent, mode: 'solo' | 'team', nameOf: (userId: string) => string): string {
  if (event.type === 'incident') return 'System'
  if (event.type === 'approval_auto_granted') return 'Incident Commander · automatic in solo play'
  const roleLabel =
    event.type === 'approval_granted' || event.type === 'approval_denied' ? ROLE_LABELS.commander : event.actionId ? ROLE_LABELS[ACTIONS[event.actionId].role] : ''
  return mode === 'team' && event.actorId ? `${nameOf(event.actorId)} · ${roleLabel}` : roleLabel
}

function Timeline({
  annotated,
  view,
  live,
  mode,
  nameOf,
  findingsOf,
  isPending,
  onShare,
  onOpen,
  bounded,
}: {
  annotated: AnnotatedEvent[]
  view: SimulationState
  live: boolean
  mode: 'solo' | 'team'
  nameOf: (userId: string) => string
  findingsOf: (event: GameEvent) => EventFindings
  isPending: (kind: PendingKind, key: string) => boolean
  onShare?: (eventSeq: number) => void
  onOpen: (seq: number) => void
  bounded: boolean
}) {
  // Keep the newest entry in view while the reader is following along; leave
  // the scroll position alone once they have scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const count = annotated.length
  useEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [count])

  return (
    <section aria-labelledby="timeline-heading" className="flex min-w-0 flex-col border-t border-border py-5 lg:col-start-1 lg:row-start-1 lg:border-t-0 lg:pr-6">
      <ColumnHead id="timeline-heading" title="Incident timeline">
        <span className="inline-flex items-center gap-1.5" data-testid="timeline-mode">
          <span className={cn('size-1.5 rounded-full', live ? 'bg-ok soft-pulse' : 'bg-subtle')} aria-hidden />
          {live ? 'Live' : 'Final record'}
        </span>
      </ColumnHead>
      {annotated.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No events yet.</p>}
      <div
        ref={scroller}
        tabIndex={bounded ? 0 : undefined}
        role={bounded ? 'region' : undefined}
        aria-label={bounded ? 'Incident timeline, scrollable' : undefined}
        onScroll={(event) => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}
        className={cn('mt-4 min-h-0 border-t border-border-strong', bounded && 'max-h-[38rem] overflow-y-auto pr-2')}
      >
        <ol data-testid="timeline">
          {annotated.map(({ event, delta, tone }) => {
            const findings = findingsOf(event)
            const deltas = METRIC_NAMES.filter((name) => delta[name] !== undefined)
            const hasEvidence = !!(findings.shared || findings.own)
            const quiet = event.type === 'action_started'
            return (
              <li key={event.seq} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 border-b border-border py-3" data-testid={`event-${event.type}`} data-seq={event.seq}>
                <div className="pt-px">
                  <time className={cn('block font-mono text-xs tabular', tone === 'critical' ? 'text-critical' : 'text-muted-foreground')}>{formatClock(event.at - view.startedAt)}</time>
                  <span className={cn('mt-1.5 block h-0.5 w-4', tone === 'neutral' ? 'bg-border-strong' : TONE_BAR[tone])} aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className={cn('text-sm leading-snug', quiet ? 'font-medium text-muted-foreground' : 'font-semibold')}>{eventHeadline(event)}</p>
                  <p className={cn('mt-0.5 text-xs', tone === 'critical' ? 'text-critical' : 'text-subtle')}>{eventActor(event, mode, nameOf)}</p>
                  {event.type === 'incident' && findings.shared && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{findings.shared.text}</p>}
                  {event.type !== 'incident' && findings.shared && (
                    <p className="mt-2 border-l-2 border-foreground/50 bg-card px-3 py-2 font-mono text-xs leading-relaxed text-foreground" data-testid={mode === 'team' ? 'finding-team' : 'finding'}>
                      {findings.shared.text}
                      {findings.shared.sharedBy ? <span className="mt-1 block font-sans text-subtle">(shared by {nameOf(findings.shared.sharedBy)})</span> : null}
                    </p>
                  )}
                  {findings.own && !findings.shared && (
                    <div className="mt-2 border-l-2 border-dashed border-caution/80 bg-card px-3 py-2" data-testid="finding-private">
                      <p className="font-mono text-xs leading-relaxed text-foreground">{findings.own.text}</p>
                      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <LockKeyhole className="size-3" aria-hidden />
                          (only you can see this)
                        </span>
                        {onShare && (
                          <button
                            type="button"
                            className="font-semibold text-foreground underline disabled:opacity-50"
                            disabled={isPending('share', String(event.seq))}
                            onClick={() => onShare(event.seq)}
                            data-testid={`share-${event.seq}`}
                          >
                            Share with team
                          </button>
                        )}
                      </p>
                    </div>
                  )}
                  {(deltas.length > 0 || hasEvidence) && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {deltas.map((name) => (
                        <span key={name} className={cn('text-[11px] font-semibold tabular', (delta[name] ?? 0) < 0 ? 'text-critical' : 'text-ok')}>
                          {formatDelta(name, delta[name] ?? 0)}
                        </span>
                      ))}
                      {hasEvidence && (
                        <button type="button" className="text-[11px] font-medium text-muted-foreground underline hover:text-foreground" onClick={() => onOpen(event.seq)} data-testid={`open-evidence-${event.seq}`}>
                          Open record
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

/** One event as a record sheet: what was done, by whom, what it showed and what it changed. */
function EvidenceDialog({
  entry,
  view,
  mode,
  nameOf,
  findingsOf,
  isPending,
  onShare,
  onClose,
}: {
  entry: AnnotatedEvent | undefined
  view: SimulationState
  mode: 'solo' | 'team'
  nameOf: (userId: string) => string
  findingsOf: (event: GameEvent) => EventFindings
  isPending: (kind: PendingKind, key: string) => boolean
  onShare?: (eventSeq: number) => void
  onClose: () => void
}) {
  // Keep the last entry while the dialog animates out, so its content does not vanish first.
  const last = useRef(entry)
  if (entry) last.current = entry
  const shown = entry ?? last.current
  const findings = shown ? findingsOf(shown.event) : {}
  const text = findings.shared?.text ?? findings.own?.text
  const isPrivate = !findings.shared && !!findings.own
  const deltas = shown ? METRIC_NAMES.filter((name) => shown.delta[name] !== undefined) : []
  // One statement per line, as a log extract reads. The text itself is untouched.
  const lines = text ? (text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [text]).map((line) => line.trim()).filter(Boolean) : []

  // While the record is open the page behind it takes no focus at all: the dialog is rendered outside the app
  // root, so the root can be made inert. Without this, Tab from a record with a single control could land on a
  // link behind the dialog.
  const isOpen = !!entry
  useEffect(() => {
    if (!isOpen) return
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => {
      root?.removeAttribute('inert')
    }
  }, [isOpen])
  const close = () => {
    // Before the dialog hands focus back to the control that opened it, that control must be focusable again.
    document.getElementById('root')?.removeAttribute('inert')
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl sm:p-0" data-testid="evidence-dialog">
        {shown && (
          <>
            <DialogHeader className="space-y-0 border-b border-border-strong px-5 pb-5 pt-5 text-left sm:px-7 sm:pt-6">
              <p className="eyebrow flex flex-wrap gap-x-3 pr-10">
                <span className="text-foreground">{shown.event.type === 'incident' ? 'Scheduled report' : 'Investigation record'}</span>
                <span>Operation Nightfall</span>
                <span className="tabular">Log entry {String(shown.event.seq).padStart(3, '0')}</span>
              </p>
              <DialogTitle className="pt-3 font-display text-2xl font-extrabold leading-tight tracking-tight">{eventHeadline(shown.event)}</DialogTitle>
              <DialogDescription className="pt-1.5">
                Recorded at {formatClock(shown.event.at - view.startedAt)} · {eventActor(shown.event, mode, nameOf)}
              </DialogDescription>
              <p className="pt-3.5">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 border px-2 py-1 text-[11px] font-bold uppercase leading-none tracking-[0.12em]',
                    isPrivate && mode === 'team' ? 'border-caution bg-caution text-background' : 'border-border-strong text-foreground',
                  )}
                >
                  {isPrivate && mode === 'team' && <LockKeyhole className="size-3" aria-hidden />}
                  {mode === 'solo' ? 'Your record' : isPrivate ? 'Private · only you' : 'Shared · whole team'}
                </span>
              </p>
            </DialogHeader>

            {text && (
              <div className="px-5 py-5 sm:px-7">
                <p className="eyebrow">{shown.event.type === 'incident' ? 'Report text' : 'Finding'}</p>
                <div className="mt-2.5 border border-border bg-background py-3 [counter-reset:line]" data-testid="evidence-text">
                  {lines.map((line, index) => (
                    <p
                      key={index}
                      className="grid grid-cols-[2.75rem_minmax(0,1fr)] font-mono text-[13px] leading-relaxed [counter-increment:line] before:pr-3 before:text-right before:text-subtle before:content-[counter(line,decimal-leading-zero)]"
                    >
                      <span className="border-l border-border pl-3 pr-4">{line} </span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
              <RecordField label="Time">
                <span className="font-mono tabular">T+{formatClock(shown.event.at - view.startedAt)}</span>
              </RecordField>
              <RecordField label="Source">{shown.event.type === 'incident' ? 'Monitoring' : shown.event.actionId ? ROLE_LABELS[ACTIONS[shown.event.actionId].role] : 'Command'}</RecordField>
              <RecordField label="Effect">{deltas.length === 0 ? 'No change to the four metrics' : deltas.map((name) => formatDelta(name, shown.delta[name] ?? 0)).join(' · ')}</RecordField>
              <RecordField label="Log position">
                <span className="tabular">Event {shown.event.seq}</span>
              </RecordField>
            </dl>

            <div className={cn('flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7', isPrivate && mode === 'team' && 'bg-caution-surface')}>
              <p className="text-sm leading-relaxed">
                <span className="eyebrow mr-3">Visibility</span>
                <span data-testid="evidence-visibility">
                  {mode === 'solo'
                    ? 'Yours — this is a solo run'
                    : isPrivate
                      ? 'Private — only you can see this until you share it'
                      : findings.shared?.sharedBy
                        ? `Shared with the team by ${nameOf(findings.shared.sharedBy)}`
                        : 'Visible to the whole team'}
                </span>
                {isPrivate && mode === 'team' && <span className="block text-xs text-muted-foreground">Sharing adds this finding to every teammate's timeline.</span>}
              </p>
              {isPrivate && mode === 'team' && onShare && (
                <Button className="shrink-0" onClick={() => onShare(shown.event.seq)} loading={isPending('share', String(shown.event.seq))} data-testid="evidence-share">
                  Share with team
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RecordField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-card px-5 py-3 sm:px-4 sm:first:pl-7">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  )
}

function Briefing({ mode }: { mode: 'solo' | 'team' }) {
  return (
    <section aria-label="Briefing" className="grid gap-x-10 gap-y-6 border-b border-border py-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_auto]">
      <div>
        <h2 className="kicker">Incident overview</h2>
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
          At 08:00 customers of Meridian Cloud, a fictional hosting provider, began failing to sign in. A release shipped seven minutes earlier. Nobody yet knows whether
          the two are connected.
        </p>
      </div>
      <div>
        <h2 className="kicker">Rules of engagement</h2>
        <ol className="mt-2.5 grid gap-x-8 gap-y-1.5 text-sm text-muted-foreground sm:grid-cols-2">
          <li>You have eight minutes. The clock runs on the server and does not pause.</li>
          <li>Each role does one thing at a time; every action takes the time shown.</li>
          <li>{mode === 'team' ? 'Major interventions need the Incident Commander to approve them.' : 'Major interventions need approval, recorded automatically in solo play.'}</li>
          <li>{mode === 'team' ? 'What you find is private until you share it with the team.' : 'Reports arrive on schedule whether or not you are ready.'}</li>
        </ol>
      </div>
      <p className="hidden self-end text-right font-display text-xs font-bold uppercase leading-relaxed tracking-[0.34em] text-subtle md:block" aria-hidden>
        Meridian
        <br />
        Cloud
      </p>
    </section>
  )
}
