/**
 * The postmortem: how a finished simulation is assessed.
 *
 * Every figure and sentence here is derived from the recorded log through
 * the shared engine (`finalResult`, `facts`) — the same computation the
 * server makes. Nothing is generated, estimated or advised: it reports what
 * the rules say about what was recorded.
 */

import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ACTION_IDS,
  COMPLETE_RECOVERY_MIN_TRUST,
  METRIC_NAMES,
  OUTCOME_LABELS,
  facts,
  type FinalResult,
  type SimulationState,
} from '@/game/engine'
import {
  OUTCOME_SUMMARY,
  OUTCOME_TONE,
  SCORE_PARTS,
  TONE_BAR,
  TONE_TEXT,
  eventHeadline,
  formatClock,
  formatDelta,
  type AnnotatedEvent,
} from './model'

export function Postmortem({
  view,
  result,
  annotated,
  exits,
}: {
  view: SimulationState
  result: FinalResult
  annotated: AnnotatedEvent[]
  exits: ReactNode
}) {
  const f = facts(view)
  const tone = OUTCOME_TONE[result.outcome]
  const elapsed = result.endedAt - view.startedAt
  const completed = ACTION_IDS.filter((actionId) => view.actions[actionId].status === 'completed').length
  const denied = annotated.filter((entry) => entry.event.type === 'approval_denied').length

  const criteria: { label: string; met: boolean; detail: string }[] = [
    { label: 'Administrator sessions revoked', met: f.adminRevoked, detail: 'Containment intervention 1 of 2' },
    { label: 'Signing keys rotated', met: f.keysRotated, detail: 'Containment intervention 2 of 2' },
    { label: 'Authentication service restored', met: f.serviceRestored, detail: 'Requires both interventions first' },
    { label: 'Recovery validated', met: f.recoveryValidated, detail: 'Needed for Complete Recovery' },
    {
      label: `Customer trust at ${COMPLETE_RECOVERY_MIN_TRUST} or above`,
      met: view.metrics.trust >= COMPLETE_RECOVERY_MIN_TRUST,
      detail: `Ended at ${view.metrics.trust}`,
    },
  ]
  // Every recorded moment that cost something, in order.
  const costs = annotated.filter((entry) => METRIC_NAMES.some((name) => (entry.delta[name] ?? 0) < 0) || entry.event.type === 'approval_denied')

  const outcomeColor = TONE_TEXT[tone] === 'text-muted-foreground' ? 'text-foreground' : TONE_TEXT[tone]

  return (
    <section aria-labelledby="postmortem-heading" className="rise-in" data-testid="result" data-outcome={result.outcome}>
      {/* Title block: the finding first, the number beside it. */}
      <div className="grid gap-x-10 gap-y-8 border-b border-border-strong pb-8 pt-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:pt-14">
        <div className="min-w-0">
          <p className="eyebrow flex flex-wrap gap-x-4" id="postmortem-heading">
            <span className="text-foreground">After-action report</span>
            <span>Operation Nightfall</span>
            <span className="tabular">Closed at T+{formatClock(elapsed)}</span>
          </p>
          <p className={cn('mt-5 font-display text-[clamp(2.75rem,1.4rem+6vw,7rem)] font-extrabold leading-[0.92] tracking-[-0.035em]', outcomeColor)} data-testid="outcome">
            {OUTCOME_LABELS[result.outcome]}
          </p>
          <div className={cn('mt-6 h-1 w-24', TONE_BAR[tone])} aria-hidden />
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-foreground" data-testid="outcome-summary">
            {OUTCOME_SUMMARY[result.outcome]}
          </p>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground" data-testid="end-reason">
            {result.reason === 'confirmed'
              ? `The Incident Commander confirmed resolution at ${formatClock(elapsed)}.`
              : 'The eight minutes ran out and the incident was assessed as it stood.'}{' '}
            {completed} of {ACTION_IDS.length} actions were completed{denied > 0 ? `, and ${denied} approval ${denied === 1 ? 'request was' : 'requests were'} denied` : ''}.
          </p>
        </div>
        <div className="lg:border-l lg:border-border-strong lg:pl-10 lg:text-right">
          <p className="eyebrow">Final score</p>
          <p className="numeral mt-4 text-foreground">
            <span className="text-[clamp(6rem,3rem+12vw,13rem)]" data-testid="score">
              {result.score}
            </span>
          </p>
          <p className="mt-3 text-sm text-subtle tabular">out of 100</p>
        </div>
      </div>

      <div className="grid border-b border-border-strong lg:grid-cols-2">
        <section aria-labelledby="score-heading" className="min-w-0 py-7 lg:pr-10">
          <p className="eyebrow">Section 1</p>
          <h2 id="score-heading" className="mt-1.5 text-xl font-bold">
            How the score adds up
          </h2>
          <table className="mt-4 w-full border-t border-border-strong text-sm" data-testid="score-breakdown">
            <thead className="sr-only">
              <tr>
                <th scope="col">Component</th>
                <th scope="col">Share</th>
                <th scope="col">Points</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {SCORE_PARTS.map((part) => (
                <tr key={part.key}>
                  <th scope="row" className="py-3 pr-3 text-left font-normal">
                    <span className="block font-medium text-foreground">{part.label}</span>
                    <span className="block text-xs text-subtle">{part.detail}</span>
                  </th>
                  <td className="hidden w-28 py-3 align-middle sm:table-cell" aria-hidden>
                    <span className="block h-0.5 bg-secondary">
                      <span className="block h-full bg-foreground" style={{ width: `${(result.breakdown[part.key] / part.max) * 100}%` }} />
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-3 pl-4 text-right tabular">
                    <span className="font-display text-lg font-bold" data-testid={`score-part-${part.key}`}>
                      {result.breakdown[part.key]}
                    </span>
                    <span className="text-subtle"> / {part.max}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border-strong">
                <th scope="row" className="py-3 text-left">
                  <span className="kicker">Total</span>
                </th>
                <td className="hidden sm:table-cell" aria-hidden />
                <td className="py-3 pl-4 text-right tabular">
                  <span className="font-display text-lg font-bold" data-testid="score-total">
                    {result.breakdown.total}
                  </span>
                  <span className="text-subtle"> / 100</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        <section aria-labelledby="criteria-heading" className="min-w-0 border-t border-border py-7 lg:border-l lg:border-t-0 lg:pl-10">
          <p className="eyebrow">Section 2</p>
          <h2 id="criteria-heading" className="mt-1.5 text-xl font-bold">
            What decided the outcome
          </h2>
          <ul className="mt-4 divide-y divide-border border-t border-border-strong" data-testid="outcome-criteria">
            {criteria.map((criterion) => (
              <li key={criterion.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-3 text-sm" data-met={criterion.met ? 'true' : 'false'}>
                <span className="min-w-0">
                  <span className="block font-medium">
                    {criterion.label} <span className="sr-only">— {criterion.met ? 'yes' : 'no'}</span>
                  </span>
                  <span className="block text-xs text-subtle">{criterion.detail}</span>
                </span>
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em]', criterion.met ? 'text-ok' : 'text-critical')} aria-hidden>
                  {criterion.met ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  {criterion.met ? 'Met' : 'Not met'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="costs-heading" className="grid gap-x-10 gap-y-4 border-b border-border-strong py-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <p className="eyebrow">Section 3</p>
          <h2 id="costs-heading" className="mt-1.5 text-xl font-bold">
            Consequential moments
          </h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">Every recorded event that cost the response something, in the order it happened.</p>
        </div>
        {costs.length === 0 ? (
          <p className="border-t border-border-strong pt-3 text-sm" data-testid="no-costs">
            None. No recorded event reduced a metric and no request was denied.
          </p>
        ) : (
          <ol className="divide-y divide-border border-t border-border-strong" data-testid="consequences">
            {costs.map(({ event, delta }) => {
              const changed = METRIC_NAMES.filter((name) => (delta[name] ?? 0) !== 0)
              return (
                <li key={event.seq} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 text-sm sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
                  <time className="font-mono text-xs leading-5 text-muted-foreground tabular">{formatClock(event.at - view.startedAt)}</time>
                  <span className="min-w-0 font-medium">{eventHeadline(event)}</span>
                  <span className="col-start-2 flex flex-wrap gap-x-3 text-xs font-semibold tabular sm:col-start-3">
                    {changed.length === 0 && <span className="text-critical">Request refused</span>}
                    {changed.map((name) => (
                      <span key={name} className={(delta[name] ?? 0) < 0 ? 'text-critical' : 'text-subtle'}>
                        {formatDelta(name, delta[name] ?? 0)}
                      </span>
                    ))}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <div className="py-6" data-print="hide">
        {exits}
      </div>
    </section>
  )
}
