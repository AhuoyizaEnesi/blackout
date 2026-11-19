/**
 * Realtime rows to engine events, and small hooks the game screens share.
 */

import { useEffect, useState } from 'react'
import { GAME_EVENT_TYPES, isActionId, isIncidentId, type GameEvent, type GameEventType } from '@/game/engine'
import type { SimulationEventRow } from '@/schemas/simulation-schema'

/** The event rows this person may read, as engine events in log order. */
export function toGameEvents(records: readonly { data: SimulationEventRow }[], withFindings: boolean): GameEvent[] {
  return records
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
      ...(withFindings ? { finding: row.finding || undefined } : {}),
    }))
    .sort((a, b) => a.seq - b.seq)
}

/** The local time, refreshed every `intervalMs`. For display; the server keeps the real clock. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
