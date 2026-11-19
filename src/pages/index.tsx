/**
 * Landing page — a STATIC page.
 *
 * It lives at the top level of src/pages/ (not under (app)/), so it renders
 * with no DeepSpace providers: no auth session fetch, no records WebSocket.
 * It is also prerendered to static HTML at build (prerender.ts), so it must
 * render without a browser: no window/document during render, prose in HTML
 * text, motion in CSS only. `<Seo>` comes first and reads src/seo.ts.
 *
 * The page is built on one figure: the 8 of the eight-minute response window.
 * Everything else shown is the real scenario — the starting values, the report
 * schedule, the roles and the endings come from the engine the game is played
 * with. Nothing here is a statistic about players or a result that has not
 * happened.
 */

import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Seo } from '../components/Seo'
import { Brand } from '../components/Brand'
import { ACTION_IDS, ACTIONS, INCIDENTS, INITIAL_METRICS, METRIC_NAMES, OUTCOME_LABELS, ROLES, ROLE_LABELS, SIMULATION_DURATION_MS, type OutcomeId } from '../game/engine'
import { INCIDENT_TITLES, METRIC_LABELS, OUTCOME_TONE, ROLE_BRIEF, TONE_BAR, formatClock, metricTone } from '../components/game/model'
import { cn } from '../lib/utils'
import { seo } from '../seo'

const SHELL = 'mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-12'

/** Score bands of the four endings, as the rules define them. */
const ENDINGS: { id: OutcomeId; band: string; meaning: string }[] = [
  { id: 'complete_recovery', band: '96–100', meaning: 'Threat contained, service restored, recovery validated, customers still with you.' },
  { id: 'costly_recovery', band: '79–95', meaning: 'Contained and restored — but unverified, or at a price in customer trust.' },
  { id: 'partial_containment', band: '32–57', meaning: 'One door closed. The service never came back.' },
  { id: 'incident_escalation', band: '12–26', meaning: 'Neither intervention landed before the bridge call.' },
]

export default function Landing() {
  // The report schedule: one mark per moment, with what arrives then.
  const marks = [...new Set(INCIDENTS.map((incident) => incident.atMs))].map((atMs) => ({
    atMs,
    titles: [...new Set(INCIDENTS.filter((incident) => incident.atMs === atMs).map((incident) => INCIDENT_TITLES[incident.id]))],
  }))
  const halfMinutes = Array.from({ length: SIMULATION_DURATION_MS / 30_000 + 1 }, (_, index) => index * 30_000)

  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="min-h-screen overflow-x-clip">
        <header className={cn(SHELL, 'flex h-[4.5rem] items-center justify-between gap-6 border-b border-border-strong')}>
          <Link to="/" aria-label="BLACKOUT" className="shrink-0">
            <Brand />
          </Link>
          <p className="eyebrow hidden md:block">An incident-response simulation · Solo or team of three</p>
          <Link to="/home" className="text-sm font-semibold text-foreground underline decoration-border-strong underline-offset-[6px] hover:decoration-foreground" data-testid="landing-sign-in">
            Sign in
          </Link>
        </header>

        <main>
          {/* The figure: an 8 the height of the page, with the brief set against it. */}
          <section className={cn(SHELL, 'relative')}>
            <div className="grid lg:min-h-[calc(100svh-4.5rem-11rem)] lg:grid-cols-12">
              <div className="relative order-2 flex flex-col justify-between gap-12 py-10 lg:order-1 lg:col-span-5 lg:border-r lg:border-border lg:py-12 lg:pr-12">
                <div className="rise-in">
                  <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="bg-critical px-2 py-1 text-[11px] font-bold leading-none tracking-[0.14em] text-background">SEV-1</span>
                    <span className="eyebrow text-foreground">Operation Nightfall</span>
                  </p>
                  <h1 className="mt-7 text-[clamp(2.5rem,1.6rem+3.1vw,4.5rem)] font-extrabold leading-[0.98] tracking-[-0.035em]">
                    Eight minutes
                    <br />
                    to contain
                    <br />a breach.
                  </h1>
                  <p className="mt-7 max-w-md text-[17px] leading-relaxed text-muted-foreground">
                    Customers of Meridian Cloud cannot sign in, and nobody knows why. Investigate, cut off the intruder and restore the service before the executive bridge call.
                    Every decision goes on the record.
                  </p>
                </div>

                <nav aria-label="Start" className="rise-in">
                  <p className="eyebrow border-b border-border-strong pb-3">Enter the incident</p>
                  <Link to="/simulation" className="group flex items-center justify-between gap-6 border-b border-border-strong bg-foreground px-5 py-5 text-background transition-colors duration-150 hover:bg-white" data-testid="landing-start">
                    <span>
                      <span className="block font-display text-2xl font-extrabold tracking-tight">Start simulation</span>
                      <span className="mt-0.5 block text-sm text-background/70">Solo — you hold all three roles</span>
                    </span>
                    <ArrowRight className="size-6 shrink-0 transition-transform duration-150 group-hover:translate-x-1" aria-hidden />
                  </Link>
                  <Link to="/team" className="group flex items-center justify-between gap-6 border-b border-border-strong px-5 py-5 transition-colors duration-150 hover:bg-secondary" data-testid="landing-join">
                    <span>
                      <span className="block font-display text-2xl font-extrabold tracking-tight">Join a team</span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">Three people, one role each, by room code</span>
                    </span>
                    <ArrowRight className="size-6 shrink-0 transition-transform duration-150 group-hover:translate-x-1" aria-hidden />
                  </Link>
                  <p className="pt-3 text-xs text-subtle">Sign-in is asked for when you start, so your runs and reports are kept.</p>
                </nav>
              </div>

              <div className="relative order-1 flex min-h-[19rem] items-center justify-center overflow-hidden border-b border-border sm:min-h-[26rem] lg:order-2 lg:col-span-7 lg:min-h-0 lg:border-b-0" aria-hidden>
                <span className="numeral select-none text-[clamp(22rem,104vw,34rem)] leading-[0.7] text-foreground lg:text-[min(64vw,calc((100svh-15.5rem)*1.36),72rem)]">8</span>
                <p className="eyebrow absolute left-12 top-12 hidden lg:block">
                  Response window
                  <span className="mt-1 block font-mono text-sm normal-case tracking-normal text-foreground">08:00</span>
                </p>
                <p className="eyebrow absolute bottom-12 right-0 hidden text-right lg:block">
                  Minutes
                  <span className="mt-1 block max-w-[13rem] text-xs font-normal normal-case leading-snug tracking-normal text-muted-foreground">on a server clock that does not pause</span>
                </p>
              </div>
            </div>
          </section>

          {/* The eight minutes, to scale: when each report arrives. */}
          <section aria-labelledby="clock-heading" className="border-y border-border-strong">
            <div className={cn(SHELL, 'py-6 lg:py-0')}>
              <div className="grid gap-x-12 gap-y-5 lg:grid-cols-12 lg:items-center xl:h-[11rem] lg:py-8 xl:py-0">
                <div className="lg:col-span-3">
                  <h2 id="clock-heading" className="kicker">
                    The eight minutes, to scale
                  </h2>
                  <p className="mt-2 text-sm leading-snug text-muted-foreground">Reports arrive on schedule, ready or not. Each is decided by the state of the incident at that instant.</p>
                </div>
                <div className="lg:col-span-9">
                  <div className="relative hidden h-4 xl:mt-9 xl:block" aria-hidden>
                    <span className="absolute inset-x-0 bottom-0 h-px bg-border-strong" />
                    {halfMinutes.map((atMs) => (
                      <span key={atMs} className={cn('absolute bottom-0 w-px bg-border-strong', atMs % 60_000 === 0 ? 'h-2.5' : 'h-1.5')} style={{ left: `${(atMs / SIMULATION_DURATION_MS) * 100}%` }} />
                    ))}
                    {marks.map((mark, index) => (
                      <span
                        key={mark.atMs}
                        className={cn('absolute bottom-0 h-4 w-0.5 -translate-x-px', index === 0 || index === marks.length - 1 ? 'bg-critical' : 'bg-foreground')}
                        style={{ left: `${(mark.atMs / SIMULATION_DURATION_MS) * 100}%` }}
                      />
                    ))}
                  </div>
                  <ol className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 xl:relative xl:mt-3 xl:block xl:h-12" data-testid="landing-schedule">
                    {marks.map((mark, index) => {
                      const last = index === marks.length - 1
                      return (
                        <li
                          key={mark.atMs}
                          className={cn(
                            'border-t border-border-strong pt-2 xl:absolute xl:w-24 xl:border-t-0 xl:pt-0',
                            // The final mark is labelled above the rule, so it cannot run into the one-minute warning beside it.
                            last ? 'xl:bottom-[calc(100%+2.25rem)] xl:-translate-x-full xl:text-right' : 'xl:top-0',
                          )}
                          style={{ left: `${(mark.atMs / SIMULATION_DURATION_MS) * 100}%` }}
                        >
                          <span className={cn('block font-mono text-sm font-semibold tabular', index === 0 || last ? 'text-critical' : 'text-foreground')}>{formatClock(mark.atMs)}</span>
                          <span className="mt-0.5 block text-[11px] leading-tight text-muted-foreground">{mark.titles.join(' · ')}</span>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              </div>
            </div>
          </section>

          {/* Where every run begins. */}
          <section aria-labelledby="opening-heading" className="border-b border-border-strong" data-testid="landing-preview">
            <div className={cn(SHELL, 'grid lg:grid-cols-12')}>
              <div className="py-8 lg:col-span-3 lg:border-r lg:border-border lg:py-10 lg:pr-10">
                <h2 id="opening-heading" className="kicker">
                  Opening state
                </h2>
                <p className="mt-3 font-display text-xl font-bold leading-snug">Sign-in failures across Meridian Cloud</p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  A release shipped at 07:53; the failures began at 08:00. Whether the two are connected is the first thing to find out.
                </p>
                <p className="mt-4 flex items-center gap-3 text-xs text-subtle">
                  <span className="bg-critical px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-[0.14em] text-background">SEV-1</span>
                  <span className="font-mono tabular">{formatClock(SIMULATION_DURATION_MS)} on the clock</span>
                </p>
              </div>
              <dl className="grid grid-cols-2 lg:col-span-9 lg:grid-cols-4">
                {METRIC_NAMES.map((metric, index) => {
                  const value = INITIAL_METRICS[metric]
                  const tone = metricTone(value)
                  return (
                    <div key={metric} className={cn('relative flex flex-col justify-between gap-8 border-t border-border px-0 py-6 lg:border-t-0 lg:px-8 lg:py-10', index % 2 === 1 && 'pl-5 lg:pl-8', index > 0 && 'lg:border-l lg:border-border', index === 0 && 'lg:pl-10')}>
                      <dt className="eyebrow">{METRIC_LABELS[metric]}</dt>
                      <dd className={cn('numeral text-[clamp(3.5rem,2rem+5vw,6rem)]', tone === 'critical' ? 'text-critical' : 'text-foreground')}>{value}</dd>
                      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-secondary lg:inset-x-8" aria-hidden>
                        <div className={cn('h-full', TONE_BAR[tone])} style={{ width: `${value}%` }} />
                      </div>
                    </div>
                  )
                })}
              </dl>
            </div>
          </section>

          {/* The three roles. */}
          <section aria-labelledby="roles-heading" className="border-b border-border-strong">
            <div className={cn(SHELL, 'grid lg:grid-cols-12')}>
              <div className="py-10 lg:col-span-3 lg:border-r lg:border-border lg:py-14 lg:pr-10">
                <p className="eyebrow">The response team</p>
                <h2 id="roles-heading" className="mt-3 text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.025em]">
                  Three roles. None of them sees everything.
                </h2>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                  In a team, what you discover stays private until you share it, and major interventions wait for the commander. Alone, you hold all three — and each still does
                  one thing at a time.
                </p>
              </div>
              <ol className="grid lg:col-span-9 lg:grid-cols-3">
                {ROLES.map((role, index) => {
                  const actions = ACTION_IDS.filter((actionId) => ACTIONS[actionId].role === role)
                  const gated = actions.filter((actionId) => ACTIONS[actionId].needsApproval).length
                  return (
                    <li key={role} className={cn('flex flex-col border-t border-border py-8 lg:border-t-0 lg:px-8 lg:py-14', index > 0 && 'lg:border-l lg:border-border', index === 0 && 'lg:pl-10')}>
                      <p className="numeral text-[4.5rem] text-secondary [-webkit-text-stroke:1px_var(--color-border-strong)]" aria-hidden>
                        0{index + 1}
                      </p>
                      <h3 className="mt-8 text-2xl font-extrabold tracking-tight">{ROLE_LABELS[role]}</h3>
                      <p className="mt-2 flex-1 text-[15px] leading-relaxed text-muted-foreground">{ROLE_BRIEF[role]}</p>
                      <dl className="mt-6 divide-y divide-border border-y border-border text-sm">
                        <div className="flex justify-between gap-4 py-2">
                          <dt className="text-subtle">Actions</dt>
                          <dd className="font-semibold tabular">{actions.length}</dd>
                        </div>
                        <div className="flex justify-between gap-4 py-2">
                          <dt className="text-subtle">{role === 'commander' ? 'Decides approvals' : 'Need commander approval'}</dt>
                          <dd className={cn('font-semibold tabular', role !== 'commander' && gated > 0 && 'text-caution')}>{role === 'commander' ? 'All' : gated}</dd>
                        </div>
                      </dl>
                    </li>
                  )
                })}
              </ol>
            </div>
          </section>

          {/* The four endings. */}
          <section aria-labelledby="endings-heading" className="border-b border-border-strong">
            <div className={cn(SHELL, 'grid lg:grid-cols-12')}>
              <div className="py-10 lg:col-span-3 lg:border-r lg:border-border lg:py-14 lg:pr-10">
                <p className="eyebrow">The after-action report</p>
                <h2 id="endings-heading" className="mt-3 text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.025em]">
                  Four endings, scored out of 100.
                </h2>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">The ending and the score are computed from the recorded events — the same log you can read back, line by line, afterwards.</p>
              </div>
              <div className="pb-10 lg:col-span-9 lg:py-14 lg:pl-10">
                <ul className="border-t border-border-strong">
                  {ENDINGS.map((ending) => (
                    <li key={ending.id} className="grid gap-x-8 gap-y-1 border-b border-border py-5 sm:grid-cols-[6rem_minmax(0,5fr)_minmax(0,6fr)] sm:items-baseline">
                      <p className="font-mono text-sm text-subtle tabular">{ending.band}</p>
                      <p className="flex items-baseline gap-3 font-display text-[clamp(1.5rem,1.1rem+1.2vw,2.125rem)] font-extrabold leading-tight tracking-tight">
                        <span className={cn('size-2 shrink-0 -translate-y-1', TONE_BAR[OUTCOME_TONE[ending.id]])} aria-hidden />
                        {OUTCOME_LABELS[ending.id]}
                      </p>
                      <p className="text-[15px] leading-relaxed text-muted-foreground">{ending.meaning}</p>
                    </li>
                  ))}
                </ul>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <Link to="/simulation" className="inline-flex h-12 items-center justify-center gap-2 bg-foreground px-6 text-[15px] font-bold text-background transition-colors duration-150 hover:bg-white">
                    Start simulation <ArrowRight className="size-4" aria-hidden />
                  </Link>
                  <Link to="/team" className="inline-flex h-12 items-center justify-center gap-2 border border-border-strong px-6 text-[15px] font-bold transition-colors duration-150 hover:bg-secondary">
                    Join a team
                  </Link>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className={cn(SHELL, 'flex flex-col gap-2 py-8 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between')}>
          <p>BLACKOUT is a training simulation. Meridian Cloud, its systems and this incident are fictional.</p>
          <p>It is not a security tool and connects to no real systems.</p>
        </footer>
      </div>
    </>
  )
}
