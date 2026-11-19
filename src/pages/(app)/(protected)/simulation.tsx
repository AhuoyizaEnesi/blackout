/**
 * Solo simulation: start a run, or play one.
 *
 * This page never computes authoritative state. It reads the simulation row
 * and its event log over the realtime connection, folds them with the shared
 * engine reducer, and sends commands (ids only) to server actions. The
 * countdown is a display derived from server timestamps; the server decides
 * when an action is complete, when an incident fires and how the run ends.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useQuery } from 'deepspace'
import { Button } from '@/components/ui'
import { RULES_VERSION, finalResult, nextDue, reduce, type ActionId, type GameEvent } from '@/game/engine'
import { CommandCenter, type PendingKind } from '@/components/game/CommandCenter'
import { SoloRunList, isLegacyRun } from '@/components/game/RunLists'
import { toGameEvents } from '@/components/game/rows'
import { ConnectionNotice } from '@/components/ConnectionNotice'
import { Page, PageHeader, StateMessage } from '@/components/PageHeader'
import { callGameAction, isUnanswered, linkProblem, newCommandId, type LinkProblem } from '@/lib/game-api'
import type { SimulationEventRow, SimulationRow } from '@/schemas/simulation-schema'

interface ServerClock {
  serverNow: number
}

export default function SimulationPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const simulationId = searchParams.get('id')

  return simulationId ? (
    <SimulationView key={simulationId} simulationId={simulationId} onLeave={() => setSearchParams({})} />
  ) : (
    <Setup onOpen={(id) => setSearchParams({ id })} />
  )
}

function Setup({ onOpen }: { onOpen: (id: string) => void }) {
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
    <Page>
      <PageHeader
        eyebrow="Operation Nightfall · Solo"
        title="Run the incident alone"
        lead="You play all three roles — Incident Commander, Security Engineer and Infrastructure Engineer — against the same eight-minute clock a team gets."
      />
      <div className="grid border-b border-border-strong lg:grid-cols-12">
        <section aria-labelledby="start-heading" className="py-8 lg:col-span-5 lg:border-r lg:border-border lg:pr-10">
          <h2 id="start-heading" className="kicker">
            Before you start
          </h2>
          <ol className="mt-4 border-t border-border-strong">
            {[
              'The clock starts on the server the moment you press start, and it does not pause.',
              'Each role can do one thing at a time, so you can run three actions in parallel.',
              'Commander approvals are recorded automatically; they still take five seconds.',
            ].map((rule, index) => (
              <li key={rule} className="grid grid-cols-[2.75rem_minmax(0,1fr)] border-b border-border py-4">
                <span className={cn('numeral pt-0.5 text-xl', index === 0 ? 'text-critical' : 'text-subtle')} aria-hidden>
                  0{index + 1}
                </span>
                <span className="text-[15px] leading-relaxed text-foreground">{rule}</span>
              </li>
            ))}
          </ol>
          <Button className="mt-6 h-14 w-full justify-between px-5 text-base font-bold" size="lg" onClick={create} loading={pending} data-testid="create-simulation">
            Start solo simulation <ArrowRight aria-hidden />
          </Button>
          {error && (
            <p role="alert" className="mt-3 border-l-2 border-critical bg-critical-surface px-3 py-2 text-sm" data-testid="lobby-error">
              {error}
            </p>
          )}
          <p className="mt-5 text-sm text-muted-foreground">
            Playing with two other people?{' '}
            <Link to="/team" className="font-semibold text-foreground underline">
              Create or join a team room
            </Link>
            .
          </p>
        </section>

        <section aria-labelledby="runs-heading" className="min-w-0 border-t border-border py-8 lg:col-span-7 lg:border-t-0 lg:pl-10">
          <h2 id="runs-heading" className="kicker mb-4">
            Your solo runs
          </h2>
          <SoloRunList records={records} status={status} onOpen={onOpen} />
        </section>
      </div>
    </Page>
  )
}

function Unavailable({ children, testId, onLeave }: { children: string; testId: string; onLeave: () => void }) {
  return (
    <Page narrow>
      <PageHeader eyebrow="Operation Nightfall · Solo" title="This run cannot be shown" />
      <div className="space-y-4 pt-6">
        <StateMessage testId={testId}>{children}</StateMessage>
        <Button variant="ghost" className="px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={onLeave}>
          <ArrowLeft aria-hidden /> Back to your runs
        </Button>
      </div>
    </Page>
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
  const legacy = simulation ? isLegacyRun(simulation.data) : false

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
    const live = toGameEvents(eventsQuery.records, true)
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
      <Page>
        <div className="space-y-4">
          <ConnectionNotice problem={problem} onRetry={() => void sync()} />
          <StateMessage>Loading simulation…</StateMessage>
        </div>
      </Page>
    )
  }
  if (simulation && legacy) {
    return (
      <Unavailable testId="simulation-legacy" onLeave={onLeave}>
        {`This run was recorded under an earlier version of the scenario rules (the current version is ${RULES_VERSION}). It cannot be replayed or scored under the current rules, so it is not shown.`}
      </Unavailable>
    )
  }
  if (!simulation || !view) {
    return (
      <Unavailable testId="simulation-missing" onLeave={onLeave}>
        This simulation does not exist, or you are not a participant in it.
      </Unavailable>
    )
  }

  const result = finalResult(view)
  const ended = result !== null || (serverNow !== null && serverNow >= view.deadlineAt)
  const remaining = serverNow === null ? null : view.deadlineAt - (result ? result.endedAt : serverNow)
  const clock = serverNow ?? view.lastEventAt
  const isPending = (kind: PendingKind, key: string) =>
    (kind === 'run' && pendingAction === `executeAction:${key}`) || (kind === 'ask' && pendingAction === `requestApproval:${key}`)

  return (
    <CommandCenter
      mode="solo"
      rootTestId="simulation-view"
      rootAttrs={{ 'data-last-seq': view.lastSeq }}
      view={view}
      events={events}
      clock={clock}
      remaining={remaining}
      ended={ended}
      locked={problem === 'signed_out'}
      result={result}
      role={null}
      nameOf={() => 'You'}
      findingsOf={(event) => (event.finding ? { shared: { text: event.finding } } : {})}
      isPending={isPending}
      onRun={(actionId) => void send('executeAction', actionId)}
      onRequestApproval={(actionId) => void send('requestApproval', actionId)}
      error={error}
      notice={<ConnectionNotice problem={problem} onRetry={() => void sync()} />}
      exits={
        <div className="flex flex-wrap gap-2">
          {result && (
            <Button onClick={onLeave} data-testid="run-again">
              <RotateCcw aria-hidden /> New simulation
            </Button>
          )}
          <Button variant="outline" className="bg-transparent" onClick={onLeave} data-testid="back-to-runs">
            <ArrowLeft aria-hidden /> Back to your runs
          </Button>
        </div>
      }
    />
  )
}
