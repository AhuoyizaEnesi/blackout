/**
 * Team simulation — functional page, not the designed one.
 *
 * Deliberately plain, like the solo page: it proves the multiplayer path end
 * to end and nothing more.
 *
 * It never decides anything. The room row, the shared event log and the
 * findings this person may read arrive over the realtime connection (the
 * room only sends rows that list this user); the page folds the log with the
 * shared engine reducer for display and sends commands — ids only — to server
 * actions. Which role this person holds, what that role may do, and whether
 * an approval is valid are all checked on the server.
 *
 * "Connected" is presence: a hint about who has the page open. It grants
 * nothing and nothing depends on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth, usePresenceRoom, useQuery, useUsers } from 'deepspace'
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
  type RoleId,
  type SimulationState,
} from '@/game/engine'
import { MAX_MEMBERS, formatInviteCode, isRole } from '@/game/lobby'
import { ConnectionNotice } from '@/components/ConnectionNotice'
import { callGameAction, isUnanswered, linkProblem, newCommandId, type ActionResponse, type LinkProblem } from '@/lib/game-api'
import type { SimulationEventRow } from '@/schemas/simulation-schema'
import type { SimulationFindingRow, TeamRoomRow } from '@/schemas/team-schema'

interface ServerClock {
  serverNow: number
}
interface RoomAnswer extends ServerClock {
  roomId: string
}
/** A lobby command's or sync's answer: the room as the server has it now. */
interface RoomSnapshot extends RoomAnswer {
  hostId: string
  inviteCode: string
  rulesVersion: number
  status: string
  members: { userId: string; role: string | null; joinedAt: number }[]
  startedAt: number | null
  closedReason: string | null
  lobbySeq: number
}
interface SimulationSnapshot extends ServerClock {
  events?: GameEvent[]
  findings?: SimulationFindingRow[]
}

/**
 * The room to show: the realtime row, unless the server's last direct answer
 * is ahead of it. The lobby log only grows, so the higher position is newer;
 * and a room that either source calls completed is completed.
 */
function currentRoom(row: TeamRoomRow | undefined, snapshot: RoomSnapshot | null): TeamRoomRow | null {
  if (!row && !snapshot) return null
  const fromSnapshot: TeamRoomRow | null = snapshot
    ? {
        hostId: snapshot.hostId,
        createCommandId: '',
        inviteCode: snapshot.inviteCode,
        scenarioId: '',
        rulesVersion: snapshot.rulesVersion,
        createdAt: 0,
        status: snapshot.status,
        members: snapshot.members,
        lobbySeq: snapshot.lobbySeq,
        startedAt: snapshot.startedAt,
        closedReason: snapshot.closedReason,
      }
    : null
  if (!row) return fromSnapshot
  if (!fromSnapshot) return row
  const newer = (fromSnapshot.lobbySeq ?? 0) > (row.lobbySeq ?? 0) ? fromSnapshot : row
  const completed = row.status === 'completed' || fromSnapshot.status === 'completed'
  return completed && newer.status === 'active' ? { ...newer, status: 'completed' } : newer
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

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
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
      return 'Incident update'
  }
}

interface MemberView {
  userId: string
  role: RoleId | null
}

function membersOf(row: TeamRoomRow): MemberView[] {
  return (row.members ?? []).map((member) => ({ userId: member.userId, role: isRole(member.role) ? member.role : null }))
}

export default function TeamPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const roomId = searchParams.get('room')

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 text-foreground">
      <h1 className="text-2xl font-semibold">Operation Nightfall — team</h1>
      {roomId ? (
        <RoomView key={roomId} roomId={roomId} onLeave={() => setSearchParams({})} />
      ) : (
        <Entrance onOpen={(room) => setSearchParams({ room })} />
      )}
    </div>
  )
}

/** Create a room, join one by code, or reopen one you are in. */
function Entrance({ onOpen }: { onOpen: (roomId: string) => void }) {
  const { records, status } = useQuery<TeamRoomRow>('team_rooms', { orderBy: 'createdAt', orderDir: 'desc' })
  const [code, setCode] = useState('')
  const [pending, setPending] = useState<'create' | 'join' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One id per attempt, reused on retry, so a retry cannot create a second room.
  const createId = useRef(newCommandId())

  const create = async () => {
    setPending('create')
    setError(null)
    const result = await callGameAction<RoomAnswer>('createRoom', { commandId: createId.current })
    setPending(null)
    if (!result.success) return setError(result.error)
    createId.current = newCommandId()
    onOpen(result.data.roomId)
  }
  const join = async () => {
    setPending('join')
    setError(null)
    const result = await callGameAction<RoomAnswer>('joinRoom', { inviteCode: code })
    setPending(null)
    if (!result.success) return setError(result.error)
    onOpen(result.data.roomId)
  }

  return (
    <section className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        Three people, three roles. Create a room and share its code, or join with a code you were given.
      </p>
      <Button onClick={create} loading={pending === 'create'} data-testid="create-room">
        Create team room
      </Button>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void join()
        }}
      >
        <label className="text-sm">
          <span className="block text-xs text-muted-foreground">Invitation code</span>
          <input
            className="mt-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm uppercase"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            data-testid="invite-input"
          />
        </label>
        <Button type="submit" variant="secondary" loading={pending === 'join'} disabled={code.trim() === ''} data-testid="join-room">
          Join
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="entrance-error">
          {error}
        </p>
      )}
      <div>
        <h2 className="text-sm font-medium">Your rooms</h2>
        {status === 'loading' && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
        {status === 'ready' && records.length === 0 && <p className="mt-2 text-sm text-muted-foreground">None yet.</p>}
        <ul className="mt-2 space-y-1" data-testid="room-list">
          {records.map((record) => (
            <li key={record.recordId}>
              <button type="button" className="text-sm underline" onClick={() => onOpen(record.recordId)}>
                {formatInviteCode(record.data.inviteCode)} — {record.data.status}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function RoomView({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const { userId } = useAuth()
  const rooms = useQuery<TeamRoomRow>('team_rooms')
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [problem, setProblem] = useState<LinkProblem>(null)
  const roomData = currentRoom(rooms.records.find((record) => record.recordId === roomId)?.data, snapshot)
  const room = roomData ? { data: roomData } : null
  const { users } = useUsers()
  // Who has this room open right now. A hint for people, not a permission.
  const presence = usePresenceRoom(`team:${roomId}`)

  const [clockOffset, setClockOffset] = useState<number | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [synced, setSynced] = useState(false)

  const learnClock = useCallback((clock: ServerClock) => setClockOffset(clock.serverNow - Date.now()), [])

  // On open, refresh or reconnect: ask the server for the room. This also
  // repairs the row if a server write was lost, and tells a non-member no.
  // Every answer from the server says something about the link to it, and a
  // successful one carries the room itself.
  const note = useCallback(
    (result: ActionResponse<ServerClock>) => {
      const link = linkProblem(result)
      if (result.success) {
        setProblem(null)
        learnClock(result.data)
        if ('members' in result.data) setSnapshot(result.data as RoomSnapshot)
      } else {
        if (link) setProblem(link)
        // Not a member (any more): forget what we were told about the room.
        if (result.code === 'forbidden') setSnapshot(null)
      }
    },
    [learnClock],
  )
  const syncRoom = useCallback(async () => {
    const result = await callGameAction<RoomSnapshot>('syncRoom', { roomId })
    note(result)
    // An unanswered sync says nothing about the room; keep waiting for one that is answered.
    if (!isUnanswered(result.success ? undefined : result.code)) setSynced(true)
    return result
  }, [roomId, note])
  useEffect(() => {
    void syncRoom()
  }, [syncRoom])
  // While the server cannot be reached, keep trying; the first answer clears the warning.
  useEffect(() => {
    if (problem !== 'offline') return
    const timer = setInterval(() => void syncRoom(), 3000)
    return () => clearInterval(timer)
  }, [problem, syncRoom])

  const lobbyCommand = async (
    name: 'claimRole' | 'releaseRole' | 'leaveRoom' | 'startRoom' | 'abandonRoom',
    params: Record<string, unknown> = {},
  ) => {
    const key = `${name}:${String(params.role ?? '')}`
    setPending(key)
    setError(null)
    const result = await callGameAction<ServerClock>(name, { roomId, ...params })
    setPending(null)
    note(result)
    if (!result.success) return setError(result.error)
    if (name === 'leaveRoom') onLeave()
  }

  if (!room && (rooms.status === 'loading' || !synced)) {
    return (
      <div className="mt-6 space-y-4">
        <ConnectionNotice problem={problem} onRetry={() => void syncRoom()} />
        <p className="text-sm text-muted-foreground">Loading room…</p>
      </div>
    )
  }
  if (!room || !userId) {
    return (
      <div className="mt-6 space-y-4">
        <p className="text-sm text-muted-foreground" data-testid="room-missing">
          This room does not exist, or you are not a participant in it.
        </p>
        <Button variant="secondary" onClick={onLeave}>
          Back
        </Button>
      </div>
    )
  }
  if (room.data.rulesVersion !== RULES_VERSION) {
    return (
      <div className="mt-6 space-y-4">
        <p className="text-sm text-muted-foreground" data-testid="room-legacy">
          This room was played under an earlier version of the scenario rules and cannot be shown.
        </p>
        <Button variant="secondary" onClick={onLeave}>
          Back
        </Button>
      </div>
    )
  }

  const members = membersOf(room.data)
  const me = members.find((member) => member.userId === userId)
  const isHost = room.data.hostId === userId
  const status = room.data.status
  const nameOf = (id: string) => users.find((user) => user.id === id)?.name ?? 'Participant'
  const isOnline = (id: string) => (id === userId ? presence.connected : presence.peers.some((peer) => peer.userId === id))
  const ready = members.length === MAX_MEMBERS && ROLES.every((role) => members.some((member) => member.role === role))

  return (
    <section className="mt-6 space-y-8" data-testid="room-view" data-status={status}>
      <ConnectionNotice problem={problem} onRetry={() => void syncRoom()} />
      <div>
        <h2 className="text-sm font-medium">Participants</h2>
        <ul className="mt-2 space-y-1" data-testid="participants">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex items-center justify-between text-sm"
              data-testid="member"
              data-user-id={member.userId}
              data-role={member.role ?? ''}
              data-online={isOnline(member.userId) ? 'true' : 'false'}
            >
              <span>
                {nameOf(member.userId)}
                {member.userId === userId && <span className="text-muted-foreground"> (you)</span>}
                {member.userId === room.data.hostId && <span className="text-muted-foreground"> · host</span>}
              </span>
              <span className="text-muted-foreground">
                {member.role ? ROLE_LABELS[member.role] : 'No role yet'} · {isOnline(member.userId) ? 'connected' : 'disconnected'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {status === 'lobby' && (
        <div className="space-y-6" data-testid="lobby">
          <div className="rounded-md border border-border p-4">
            <p className="text-xs text-muted-foreground">Invitation code — share it with your two teammates</p>
            <p className="font-mono text-xl tracking-widest" data-testid="invite-code">
              {formatInviteCode(room.data.inviteCode)}
            </p>
          </div>
          <div>
            <h2 className="text-sm font-medium">Roles</h2>
            <ul className="mt-2 space-y-2">
              {ROLES.map((role) => {
                const holder = members.find((member) => member.role === role)
                const mine = holder?.userId === userId
                return (
                  <li key={role} className="flex items-center justify-between gap-4 text-sm">
                    <span>
                      {ROLE_LABELS[role]}
                      <span className="text-muted-foreground" data-testid={`role-holder-${role}`}>
                        {' '}
                        — {holder ? (mine ? 'you' : nameOf(holder.userId)) : 'open'}
                      </span>
                    </span>
                    {mine ? (
                      <Button variant="secondary" onClick={() => lobbyCommand('releaseRole')} loading={pending === 'releaseRole:'} data-testid="release-role">
                        Release
                      </Button>
                    ) : (
                      <Button
                        onClick={() => lobbyCommand('claimRole', { role })}
                        disabled={!!holder || !me}
                        loading={pending === `claimRole:${role}`}
                        data-testid={`claim-${role}`}
                      >
                        Take role
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="flex gap-2">
            {isHost ? (
              <>
                <Button onClick={() => lobbyCommand('startRoom')} disabled={!ready} loading={pending === 'startRoom:'} data-testid="start-room">
                  Start simulation
                </Button>
                <Button variant="secondary" onClick={() => lobbyCommand('abandonRoom')} loading={pending === 'abandonRoom:'} data-testid="abandon-room">
                  Close room
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => lobbyCommand('leaveRoom')} loading={pending === 'leaveRoom:'} data-testid="leave-room">
                Leave room
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="lobby-hint">
            {ready
              ? isHost
                ? 'Everyone is ready. The clock starts on the server when you start.'
                : 'Everyone is ready. Waiting for the host to start.'
              : 'The simulation can start once three people hold the three roles.'}
          </p>
        </div>
      )}

      {status === 'abandoned' && (
        <p className="text-sm text-muted-foreground" data-testid="room-abandoned" data-reason={room.data.closedReason ?? 'host'}>
          {room.data.closedReason === 'expired'
            ? 'This room was not used for a day and has closed. Create a new room to play.'
            : 'The host closed this room before the simulation started.'}
        </p>
      )}

      {(status === 'active' || status === 'completed') && me?.role && typeof room.data.startedAt === 'number' && (
        <TeamSimulation
          roomId={roomId}
          startedAt={room.data.startedAt}
          userId={userId}
          role={me.role}
          members={members}
          nameOf={nameOf}
          clockOffset={clockOffset}
          learnClock={learnClock}
          onEnded={syncRoom}
          problem={problem}
          note={note}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="room-error">
          {error}
        </p>
      )}
      <Button variant="secondary" onClick={onLeave}>
        Back to rooms
      </Button>
    </section>
  )
}

function TeamSimulation({
  roomId,
  startedAt,
  userId,
  role,
  members,
  nameOf,
  clockOffset,
  learnClock,
  onEnded,
  problem,
  note,
}: {
  roomId: string
  startedAt: number
  userId: string
  role: RoleId
  members: MemberView[]
  nameOf: (id: string) => string
  clockOffset: number | null
  learnClock: (clock: ServerClock) => void
  onEnded: () => Promise<unknown>
  problem: LinkProblem
  note: (result: ActionResponse<ServerClock>) => void
}) {
  const eventsQuery = useQuery<SimulationEventRow>('simulation_events', {
    where: { simulationId: roomId },
    orderBy: 'seq',
    orderDir: 'asc',
  })
  // Only the rows this person may read arrive: the team's, and their own private ones.
  const findingsQuery = useQuery<SimulationFindingRow>('simulation_findings', { where: { simulationId: roomId } })

  const [localNow, setLocalNow] = useState(() => Date.now())
  const [pendingCommand, setPendingCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One id per (command, target), reused if the request is retried.
  const commandIds = useRef<Record<string, string>>({})

  // The server's answer to the last sync: the log, and the findings this
  // person may read. Realtime rows normally arrive first; when they are late
  // or the socket is down, this keeps the page from showing an older state.
  const [synced, setSynced] = useState<{ events: GameEvent[]; findings: SimulationFindingRow[] }>({ events: [], findings: [] })

  const sync = useCallback(async () => {
    const result = await callGameAction<SimulationSnapshot>('syncSimulation', { simulationId: roomId })
    note(result)
    if (result.success) {
      setSynced({
        events: Array.isArray(result.data.events) ? result.data.events : [],
        findings: Array.isArray(result.data.findings) ? result.data.findings.map((f) => ({ ...f, simulationId: roomId })) : [],
      })
    }
    return result
  }, [roomId, note])

  // While the server cannot be reached, keep trying; the first answer clears the warning.
  useEffect(() => {
    if (problem !== 'offline') return
    const timer = setInterval(() => void sync(), 3000)
    return () => clearInterval(timer)
  }, [problem, sync])

  // On open, refresh or reconnect: settle whatever came due while away.
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
        }))
        .sort((a, b) => a.seq - b.seq)
    // The log only grows, so whichever copy reaches further is the newer one.
    return (synced.events.at(-1)?.seq ?? 0) > (live.at(-1)?.seq ?? 0) ? synced.events : live
  }, [eventsQuery.records, synced.events])

  const state = useMemo(() => {
    try {
      return reduce(startedAt, events)
    } catch {
      // A partial snapshot mid-sync. Keep the last good render.
      return null
    }
  }, [startedAt, events])
  const lastGoodState = useRef(state)
  if (state) lastGoodState.current = state
  const view = state ?? lastGoodState.current

  const serverNow = clockOffset === null ? null : localNow + clockOffset

  // Prompt the server to record what has come due. Any participant's page does
  // this, so nothing waits for a particular person to be connected.
  const lastSettleAttempt = useRef(0)
  useEffect(() => {
    if (!view || serverNow === null) return
    if (nextDue(view, serverNow) !== null && localNow - lastSettleAttempt.current >= 1000) {
      lastSettleAttempt.current = localNow
      void sync()
    }
  }, [view, serverNow, localNow, sync])

  const result = view ? finalResult(view) : null
  // Once it is over, have the room row say so.
  const reportedEnd = useRef(false)
  useEffect(() => {
    if (result && !reportedEnd.current) {
      reportedEnd.current = true
      void onEnded()
    }
  }, [result, onEnded])

  const send = async (
    command: 'executeAction' | 'requestApproval' | 'decideApproval' | 'shareFinding',
    key: string,
    params: Record<string, unknown>,
  ) => {
    setPendingCommand(key)
    setError(null)
    commandIds.current[key] ??= newCommandId()
    const answer = await callGameAction<ServerClock>(command, {
      simulationId: roomId,
      commandId: commandIds.current[key],
      ...params,
    })
    if (answer.success) {
      learnClock(answer.data)
      // Show what the command did before the button becomes available again.
      await sync()
    } else {
      // A refused command is over. One that got no answer keeps its id, so retrying is safe.
      if (!isUnanswered(answer.code)) delete commandIds.current[key]
      note(answer)
      setError(answer.error)
    }
    setPendingCommand(null)
  }

  if (eventsQuery.status === 'loading' || !view) {
    return <p className="text-sm text-muted-foreground">Loading simulation…</p>
  }

  const ended = result !== null || (serverNow !== null && serverNow >= view.deadlineAt)
  const remaining = serverNow === null ? null : view.deadlineAt - (result ? result.endedAt : serverNow)
  const clock = serverNow ?? view.lastEventAt
  // Findings are only ever added: show the union of what both sources have delivered.
  const findings = [...findingsQuery.records.map((record) => record.data)]
  for (const finding of synced.findings) {
    if (!findings.some((have) => have.eventSeq === finding.eventSeq && have.scope === finding.scope)) findings.push(finding)
  }

  // Requests waiting for the commander: the action, and the event that asked.
  const pendingApprovals = ACTION_IDS.filter((actionId) => view.approvals[actionId]?.status === 'requested').map((actionId) => {
    const request = [...events].reverse().find((event) => event.type === 'approval_requested' && event.actionId === actionId)
    return { actionId, request }
  })
  const commander = members.find((member) => member.role === 'commander')

  return (
    <div className="space-y-8" data-testid="team-simulation" data-my-role={role} data-last-seq={view.lastSeq}>
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-muted-foreground">
          {ended ? 'Simulation ended' : 'Time remaining'} · you are the <span data-testid="my-role">{ROLE_LABELS[role]}</span>
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
        <h2 className="text-sm font-medium">Pending approvals</h2>
        {pendingApprovals.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="no-pending-approvals">
            None.
          </p>
        )}
        <ul className="mt-2 space-y-3" data-testid="pending-approvals">
          {pendingApprovals.map(({ actionId, request }) => (
            <li key={actionId} className="flex items-center justify-between gap-4" data-testid={`pending-${actionId}`}>
              <div>
                <p className="text-sm">{ACTIONS[actionId].label}</p>
                <p className="text-xs text-muted-foreground">
                  Requested by {request ? nameOf(request.actorId) : 'a teammate'} · waiting for{' '}
                  {commander ? nameOf(commander.userId) : 'the commander'}
                </p>
              </div>
              {role === 'commander' && request && !ended && (
                <div className="flex gap-2">
                  <Button
                    onClick={() => send('decideApproval', `approve:${actionId}:${request.seq}`, { actionId, requestSeq: request.seq, decision: 'approve' })}
                    loading={pendingCommand === `approve:${actionId}:${request.seq}`}
                    data-testid={`decide-approve-${actionId}`}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => send('decideApproval', `deny:${actionId}:${request.seq}`, { actionId, requestSeq: request.seq, decision: 'deny' })}
                    loading={pendingCommand === `deny:${actionId}:${request.seq}`}
                    data-testid={`decide-deny-${actionId}`}
                  >
                    Deny
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2 className="text-sm font-medium">Actions</h2>
        {ROLES.map((group) => (
          <div key={group} className="mt-4">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              {ROLE_LABELS[group]}
              {group === role ? ' — you' : ''}
            </h3>
            <ul className="mt-2 space-y-3">
              {ACTION_IDS.filter((actionId) => ACTIONS[actionId].role === group).map((actionId) => (
                <ActionRow
                  key={actionId}
                  actionId={actionId}
                  view={view}
                  clock={clock}
                  ended={ended}
                  mine={group === role}
                  pendingCommand={pendingCommand}
                  onRun={() => send('executeAction', `run:${actionId}`, { actionId })}
                  onRequestApproval={() => send('requestApproval', `ask:${actionId}`, { actionId })}
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
        <ol className="mt-2 space-y-2" data-testid="timeline">
          {events.map((event) => {
            const shared = findings.find((finding) => finding.eventSeq === event.seq && finding.scope === 'team')
            const own = findings.find((finding) => finding.eventSeq === event.seq && finding.scope === 'private' && finding.ownerId === userId)
            return (
              <li key={event.seq} className="text-sm" data-testid={`event-${event.type}`} data-seq={event.seq}>
                <span className="font-mono text-xs text-muted-foreground">{formatClock(event.at - view.startedAt)}</span>{' '}
                {event.type === 'incident' ? (shared?.text ?? eventText(event)) : eventText(event)}
                {event.type !== 'incident' && event.actorId && (
                  <span className="text-muted-foreground"> — {nameOf(event.actorId)}</span>
                )}
                {event.type !== 'incident' && shared && (
                  <span className="block text-muted-foreground" data-testid="finding-team">
                    {shared.text}
                    {shared.sharedBy ? ` (shared by ${nameOf(shared.sharedBy)})` : ''}
                  </span>
                )}
                {own && !shared && (
                  <span className="block text-muted-foreground" data-testid="finding-private">
                    {own.text} <span className="text-xs">(only you can see this)</span>{' '}
                    <button
                      type="button"
                      className="text-xs underline"
                      disabled={pendingCommand === `share:${event.seq}`}
                      onClick={() => send('shareFinding', `share:${event.seq}`, { eventSeq: event.seq })}
                      data-testid={`share-${event.seq}`}
                    >
                      Share with team
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

function ActionRow({
  actionId,
  view,
  clock,
  ended,
  mine,
  pendingCommand,
  onRun,
  onRequestApproval,
}: {
  actionId: ActionId
  view: SimulationState
  clock: number
  ended: boolean
  mine: boolean
  pendingCommand: string | null
  onRun: () => void
  onRequestApproval: () => void
}) {
  const definition = ACTIONS[actionId]
  const action = view.actions[actionId]
  // The same checks the server makes, used only to label and enable buttons.
  // The role here is always the action's own, so the label says why the
  // ACTION is blocked; whether THIS person may act is `mine`.
  const verdict = validateExecute(view, actionId, clock, [definition.role])
  const canRequestApproval = definition.needsApproval && validateApprovalRequest(view, actionId, clock, [definition.role]).ok
  const approval = view.approvals[actionId]

  let status: string
  if (action.status === 'completed') {
    status = 'Completed'
  } else if (action.status === 'in_progress') {
    const left = (action.completesAt ?? clock) - clock
    status = left > 0 ? `In progress — ${formatClock(left)}` : 'Finishing…'
  } else if (approval?.status === 'requested') {
    status = 'Waiting for the commander'
  } else if (verdict.ok) {
    status = definition.durationMs === 0 ? 'Ready' : `${definition.durationMs / 1000}s`
  } else if (verdict.code === 'approval_pending' && approval && (approval.status === 'approved' || approval.status === 'denied')) {
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
      {mine && (
        <div className="flex gap-2">
          {canRequestApproval && !ended && (
            <Button
              variant="secondary"
              onClick={onRequestApproval}
              loading={pendingCommand === `ask:${actionId}`}
              data-testid={`approve-${actionId}`}
            >
              Request approval
            </Button>
          )}
          <Button onClick={onRun} disabled={!verdict.ok || ended} loading={pendingCommand === `run:${actionId}`} data-testid={`action-${actionId}`}>
            Run
          </Button>
        </div>
      )}
    </li>
  )
}
