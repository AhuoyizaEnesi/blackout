/**
 * A person's own simulations and rooms, as lists.
 *
 * The rows come from the realtime connection, which sends a user only the
 * rows that list them. The outcome shown beside a finished run is computed
 * here from that run's event log with the shared engine — the same figures
 * its postmortem shows — and only for the most recent few, so a long history
 * does not open a subscription per row.
 */

import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useQuery } from 'deepspace'
import { cn } from '@/lib/utils'
import { OUTCOME_LABELS, RULES_VERSION, finalResult, reduce } from '@/game/engine'
import { formatInviteCode } from '@/game/lobby'
import type { SimulationEventRow, SimulationRow } from '@/schemas/simulation-schema'
import type { TeamRoomRow } from '@/schemas/team-schema'
import { OUTCOME_TONE, TONE_TEXT } from './model'
import { toGameEvents, useNow } from './rows'

/** How many rows at the top of a list show a computed result. */
const LIVE_RESULTS = 6

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function isLegacyRun(row: { rulesVersion?: number | null }): boolean {
  return row.rulesVersion !== RULES_VERSION
}

/** Outcome and score of one run, from its log. Says so when it is still running. */
function RunResult({ simulationId, startedAt, deadlineAt }: { simulationId: string; startedAt: number; deadlineAt: number }) {
  const { records, status } = useQuery<SimulationEventRow>('simulation_events', { where: { simulationId }, orderBy: 'seq', orderDir: 'asc' })
  const now = useNow(5000)
  const result = useMemo(() => {
    try {
      return finalResult(reduce(startedAt, toGameEvents(records, false)))
    } catch {
      return null
    }
  }, [records, startedAt])

  if (status === 'loading') return <span className="text-xs text-subtle">…</span>
  if (result) {
    return (
      <span className="text-right text-xs" data-testid="run-result">
        <span className={cn('block font-display text-sm font-bold', TONE_TEXT[OUTCOME_TONE[result.outcome]])}>{OUTCOME_LABELS[result.outcome]}</span>
        <span className="block text-muted-foreground tabular">{result.score} / 100</span>
      </span>
    )
  }
  return <span className="text-xs text-caution">{now < deadlineAt ? 'In progress' : 'Awaiting assessment'}</span>
}

const ROW = 'group flex w-full items-center justify-between gap-4 border-b border-border px-1 py-3.5 text-left transition-colors duration-150 hover:bg-secondary/70'

export function SoloRunList({
  records,
  status,
  onOpen,
}: {
  records: readonly { recordId: string; data: SimulationRow }[]
  status: string
  onOpen: (simulationId: string) => void
}) {
  const now = useNow(5000)
  return (
    <div>
      {status === 'loading' && <p className="text-sm text-muted-foreground">Loading your runs…</p>}
      {status === 'error' && <p className="text-sm text-critical">Your runs could not be loaded. Check your connection and reload.</p>}
      {status === 'ready' && records.length === 0 && (
        <p className="border-y border-border py-6 text-sm text-muted-foreground" data-testid="simulation-list-empty">
          No runs yet. Your finished simulations and their postmortems will be kept here.
        </p>
      )}
      <ul className="border-t border-border-strong empty:border-t-0" data-testid="simulation-list">
        {records.map((record, index) => {
          const legacy = isLegacyRun(record.data)
          return (
            <li key={record.recordId} data-run-id={record.recordId}>
              <button type="button" className={ROW} onClick={() => onOpen(record.recordId)}>
                <span className="min-w-0">
                  <span className="block font-display text-base font-bold">Solo run</span>
                  <span className="block text-xs text-muted-foreground">Started {WHEN.format(record.data.startedAt)}</span>
                  {legacy && (
                    <span className="mt-1 block text-xs text-caution" data-testid="simulation-legacy-tag">
                      earlier rules — cannot be opened
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {legacy ? null : index < LIVE_RESULTS ? (
                    <RunResult simulationId={record.recordId} startedAt={record.data.startedAt} deadlineAt={record.data.deadlineAt} />
                  ) : (
                    <span className="text-xs text-muted-foreground">{now < record.data.deadlineAt ? 'In progress' : 'Finished'}</span>
                  )}
                  <ChevronRight className="size-4 text-subtle transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const ROOM_STATUS: Record<string, { label: string; className: string }> = {
  lobby: { label: 'In the lobby', className: 'text-caution' },
  active: { label: 'In progress', className: 'text-caution' },
  completed: { label: 'Finished', className: 'text-muted-foreground' },
  abandoned: { label: 'Closed before starting', className: 'text-subtle' },
}

export function RoomList({
  records,
  status,
  onOpen,
}: {
  records: readonly { recordId: string; data: TeamRoomRow }[]
  status: string
  onOpen: (roomId: string) => void
}) {
  return (
    <div>
      {status === 'loading' && <p className="text-sm text-muted-foreground">Loading your rooms…</p>}
      {status === 'error' && <p className="text-sm text-critical">Your rooms could not be loaded. Check your connection and reload.</p>}
      {status === 'ready' && records.length === 0 && (
        <p className="border-y border-border py-6 text-sm text-muted-foreground" data-testid="room-list-empty">
          No rooms yet. Rooms you create or join are listed here.
        </p>
      )}
      <ul className="border-t border-border-strong empty:border-t-0" data-testid="room-list">
        {records.map((record, index) => {
          const room = record.data
          const state = ROOM_STATUS[room.status] ?? { label: room.status, className: 'text-muted-foreground' }
          const legacy = isLegacyRun(room)
          const showResult = !legacy && room.status === 'completed' && index < LIVE_RESULTS && typeof room.startedAt === 'number' && typeof room.deadlineAt === 'number'
          return (
            <li key={record.recordId}>
              <button type="button" className={ROW} onClick={() => onOpen(record.recordId)}>
                <span className="min-w-0">
                  <span className="block font-mono text-base font-semibold tracking-[0.08em]">{formatInviteCode(room.inviteCode)}</span>
                  <span className="block text-xs text-muted-foreground">
                    Team room · {(room.members ?? []).length} of 3 people · created {WHEN.format(room.createdAt)}
                  </span>
                  {legacy && <span className="mt-1 block text-xs text-caution">earlier rules — cannot be opened</span>}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {showResult ? (
                    <RunResult simulationId={record.recordId} startedAt={room.startedAt as number} deadlineAt={room.deadlineAt as number} />
                  ) : (
                    <span className={cn('text-xs', state.className)}>{state.label}</span>
                  )}
                  <ChevronRight className="size-4 text-subtle transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
