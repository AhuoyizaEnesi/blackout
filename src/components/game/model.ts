/**
 * Presentation helpers for the game screens.
 *
 * Everything here is display: wording, formatting and derived views of state
 * the page already holds. Nothing here decides anything — the server does —
 * and nothing here is scenario truth. Findings and incident reports are
 * written by the server and reach a player only inside the events and
 * findings that player is allowed to read; the copy below is the public
 * briefing every participant gets before the clock starts.
 */

import {
  ACTIONS,
  METRIC_NAMES,
  applyEvent,
  initialState,
  type ActionId,
  type GameEvent,
  type IncidentId,
  type MetricName,
  type Metrics,
  type OutcomeId,
  type RoleId,
  type ScoreBreakdown,
  type SimulationState,
} from '@/game/engine'

export type Tone = 'critical' | 'caution' | 'ok' | 'neutral'

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function formatDuration(ms: number): string {
  return ms === 0 ? 'Immediate' : `${ms / 1000}s`
}

export const METRIC_LABELS: Record<MetricName, string> = {
  health: 'Infrastructure health',
  containment: 'Threat containment',
  trust: 'Customer trust',
  evidence: 'Evidence collected',
}

export const METRIC_SHORT: Record<MetricName, string> = {
  health: 'Health',
  containment: 'Containment',
  trust: 'Trust',
  evidence: 'Evidence',
}

/** How worrying a metric's current value is. Display only. */
export function metricTone(value: number): Tone {
  if (value < 40) return 'critical'
  if (value < 60) return 'caution'
  return 'neutral'
}

export const ROLE_BRIEF: Record<RoleId, string> = {
  commander: 'Coordinates the response, approves major interventions and speaks to customers.',
  security: 'Investigates the intrusion and cuts off unauthorized access.',
  infrastructure: 'Reviews changes, restores the service and proves it is healthy.',
}

/** One line on what each action is. Describes the work, never what it will find. */
export const ACTION_BRIEF: Record<ActionId, string> = {
  inspect_access_logs: 'Review recent sign-ins to the administrator console.',
  correlate_session_events: 'Match console sessions against configuration changes.',
  investigate_signing_access: 'Check whether token-signing material was read.',
  revoke_admin_sessions: 'End every administrator session and disable suspect credentials.',
  validate_containment: 'Verify what access remains after the revocation.',
  review_deployment: 'Examine what the 07:53 release changed.',
  roll_back_release: 'Revert the 07:53 release.',
  rotate_signing_keys: 'Issue new signing keys and reject the old ones.',
  restore_auth: 'Return the authentication service to a known-good configuration.',
  validate_recovery: 'Run sign-in checks in every region.',
  issue_customer_advisory: 'Tell customers what is known and when to expect more.',
  confirm_resolution: 'Declare the incident resolved. This ends the simulation.',
}

/** A heading for each scheduled report. The report itself is the server's text. */
export const INCIDENT_TITLES: Record<IncidentId, string> = {
  initial_alert: 'Initial alert',
  service_degradation: 'Service status',
  attacker_activity: 'Access monitoring',
  outage_spreads: 'Service status',
  attacker_escalation: 'Access monitoring',
  token_replay: 'Token monitoring',
  communication_gap: 'Customer communications',
  deadline_warning: 'One minute remaining',
  finalization: 'Final assessment',
}

export const OUTCOME_TONE: Record<OutcomeId, Tone> = {
  complete_recovery: 'ok',
  costly_recovery: 'caution',
  partial_containment: 'caution',
  incident_escalation: 'critical',
}

/** What each ending means, in the terms the rules define it. */
export const OUTCOME_SUMMARY: Record<OutcomeId, string> = {
  complete_recovery:
    'Both containment interventions were completed, the authentication service was restored, recovery was validated and customer trust held at 40 or above.',
  costly_recovery:
    'The threat was contained and the authentication service restored, but recovery was not validated or customer trust fell below 40.',
  partial_containment:
    'At least one containment intervention was completed, but the authentication service was not restored.',
  incident_escalation: 'Neither containment intervention was completed before the assessment.',
}

export const SCORE_PARTS: { key: keyof Omit<ScoreBreakdown, 'total'>; label: string; max: number; detail: string }[] = [
  { key: 'containment', label: 'Containment', max: 30, detail: '15 for each intervention completed' },
  { key: 'restoration', label: 'Service restoration', max: 25, detail: 'Authentication service restored' },
  { key: 'validation', label: 'Recovery validation', max: 15, detail: 'Recovery validated' },
  { key: 'evidence', label: 'Critical evidence', max: 10, detail: '5 for each critical finding' },
  { key: 'trust', label: 'Customer trust retained', max: 10, detail: '1 lost for every 6 points of trust' },
  { key: 'health', label: 'Infrastructure health', max: 10, detail: 'One point per 10 health' },
]

export function eventHeadline(event: GameEvent): string {
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
      return event.incidentId ? INCIDENT_TITLES[event.incidentId] : 'Incident update'
  }
}

export type MetricDelta = Partial<Record<MetricName, number>>

export interface AnnotatedEvent {
  event: GameEvent
  /** What this event changed, measured by replaying the log up to it. */
  delta: MetricDelta
  tone: Tone
}

function diff(before: Metrics, after: Metrics): MetricDelta {
  const delta: MetricDelta = {}
  for (const name of METRIC_NAMES) {
    if (after[name] !== before[name]) delta[name] = after[name] - before[name]
  }
  return delta
}

function toneOf(event: GameEvent, delta: MetricDelta): Tone {
  if (event.type === 'approval_denied') return 'critical'
  if (event.type === 'approval_requested') return 'caution'
  if (event.type === 'action_completed' || event.type === 'approval_granted' || event.type === 'approval_auto_granted') return 'ok'
  if (event.type === 'incident') {
    if (event.incidentId === 'initial_alert') return 'critical'
    if (event.incidentId === 'deadline_warning') return 'caution'
    return Object.values(delta).some((change) => (change ?? 0) < 0) ? 'critical' : 'neutral'
  }
  return 'neutral'
}

/**
 * The log with each event's recorded effect on the four metrics. The effect
 * is not looked up from the rules: it is the difference between the state
 * before and after replaying that event, so it is exactly what happened in
 * this run. Returns what could be replayed if the log is momentarily partial.
 */
export function annotate(startedAt: number, events: readonly GameEvent[]): AnnotatedEvent[] {
  const out: AnnotatedEvent[] = []
  let state: SimulationState = initialState(startedAt)
  for (const event of events) {
    let next: SimulationState
    try {
      next = applyEvent(state, event)
    } catch {
      break
    }
    const delta = diff(state.metrics, next.metrics)
    out.push({ event, delta, tone: toneOf(event, delta) })
    state = next
  }
  return out
}

export function formatDelta(name: MetricName, change: number): string {
  return `${METRIC_SHORT[name]} ${change > 0 ? '+' : '−'}${Math.abs(change)}`
}

/** Tailwind classes per tone, kept in one place so colour always means the same thing. */
export const TONE_TEXT: Record<Tone, string> = {
  critical: 'text-critical',
  caution: 'text-caution',
  ok: 'text-ok',
  neutral: 'text-muted-foreground',
}
export const TONE_BAR: Record<Tone, string> = {
  critical: 'bg-critical',
  caution: 'bg-caution',
  ok: 'bg-ok',
  neutral: 'bg-foreground',
}
export const TONE_CHIP: Record<Tone, string> = {
  critical: 'border-critical/40 bg-critical-surface text-critical',
  caution: 'border-caution/40 bg-caution-surface text-caution',
  ok: 'border-ok/40 bg-ok-surface text-ok',
  neutral: 'border-border bg-secondary text-muted-foreground',
}
