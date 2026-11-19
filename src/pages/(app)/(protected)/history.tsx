/**
 * History: every simulation and room this person has taken part in.
 *
 * The rows are the ones the realtime connection sends this user — their own
 * solo runs and the rooms that list them. Opening one shows its postmortem,
 * computed from its recorded events.
 */

import { useNavigate } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Page, PageHeader } from '@/components/PageHeader'
import { RoomList, SoloRunList } from '@/components/game/RunLists'
import { RULES_VERSION } from '@/game/engine'
import type { SimulationRow } from '@/schemas/simulation-schema'
import type { TeamRoomRow } from '@/schemas/team-schema'

export default function HistoryPage() {
  const navigate = useNavigate()
  const solo = useQuery<SimulationRow>('simulations', { orderBy: 'startedAt', orderDir: 'desc' })
  const rooms = useQuery<TeamRoomRow>('team_rooms', { orderBy: 'createdAt', orderDir: 'desc' })
  const older =
    solo.records.some((record) => record.data.rulesVersion !== RULES_VERSION) || rooms.records.some((record) => record.data.rulesVersion !== RULES_VERSION)

  return (
    <Page>
      <PageHeader eyebrow="Operation Nightfall" title="History" lead="Your solo runs and team rooms, newest first. Open one to read its after-action report and the full record of events." />
      {older && (
        <p className="mt-5 border-l-2 border-caution bg-caution-surface px-4 py-3 text-sm" data-testid="history-rules-notice">
          Some entries were recorded under an earlier version of the scenario rules (the current version is {RULES_VERSION}). Their logs only make sense under the rules that
          wrote them, so they are listed but cannot be opened or scored.
        </p>
      )}
      <div className="grid border-b border-border-strong lg:grid-cols-2">
        <section aria-labelledby="history-solo-heading" className="min-w-0 py-8 lg:border-r lg:border-border lg:pr-10" data-testid="history-solo">
          <h2 id="history-solo-heading" className="kicker mb-4">
            Solo runs
          </h2>
          <SoloRunList records={solo.records} status={solo.status} onOpen={(id) => navigate(`/simulation?id=${encodeURIComponent(id)}`)} />
        </section>
        <section aria-labelledby="history-team-heading" className="min-w-0 border-t border-border py-8 lg:border-t-0 lg:pl-10" data-testid="history-team">
          <h2 id="history-team-heading" className="kicker mb-4">
            Team rooms
          </h2>
          <RoomList records={rooms.records} status={rooms.status} onOpen={(id) => navigate(`/team?room=${encodeURIComponent(id)}`)} />
        </section>
      </div>
    </Page>
  )
}
