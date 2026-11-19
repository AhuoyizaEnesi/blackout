/**
 * Team simulation: create or join a room, assemble in the lobby, play.
 *
 * This page never decides anything. The room row, the shared event log and
 * the findings this person may read arrive over the realtime connection (the
 * room only sends rows that list this user); the page folds the log with the
 * shared engine reducer for display and sends commands — ids only — to server
 * actions. Which role this person holds, what that role may do, and whether
 * an approval is valid are all checked on the server.
 *
 * "Online" is presence: a hint about who has the page open. It grants
 * nothing and nothing depends on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, Copy, DoorOpen, Play, X } from 'lucide-react'
import { useAuth, usePresenceRoom, useQuery, useUsers } from 'deepspace'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ROLES, ROLE_LABELS, RULES_VERSION, finalResult, nextDue, reduce, type GameEvent, type RoleId } from '@/game/engine'
import { MAX_MEMBERS, formatInviteCode, isRole } from '@/game/lobby'
import { CommandCenter, type PendingKind } from '@/components/game/CommandCenter'
import { RoomList } from '@/components/game/RunLists'
import { ROLE_BRIEF } from '@/components/game/model'
import { toGameEvents } from '@/components/game/rows'
import { ConnectionNotice } from '@/components/ConnectionNotice'
import { Page, PageHeader, StateMessage } from '@/components/PageHeader'
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

  return roomId ? (
    <RoomView key={roomId} roomId={roomId} onLeave={() => setSearchParams({})} />
  ) : (
    <Entrance onOpen={(room) => setSearchParams({ room })} />
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
    <Page>
      <PageHeader
        eyebrow="Operation Nightfall · Team"
        title="Respond as a team of three"
        lead="One Incident Commander, one Security Engineer, one Infrastructure Engineer. Create a room and share its code, or join with a code you were given."
      />
      {error && (
        <p role="alert" className="mt-5 border-l-2 border-critical bg-critical-surface px-4 py-3 text-sm" data-testid="entrance-error">
          {error}
        </p>
      )}
      <div className="grid border-b border-border-strong lg:grid-cols-12">
        <div className="lg:col-span-5 lg:border-r lg:border-border lg:pr-10">
          <section aria-labelledby="create-heading" className="grid grid-cols-[2.75rem_minmax(0,1fr)] border-b border-border py-8">
            <p className="numeral pt-1 text-2xl text-subtle" aria-hidden>
              A
            </p>
            <div>
              <h2 id="create-heading" className="text-2xl font-extrabold tracking-tight">
                Create a room
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">You become the host: you start the simulation once all three roles are taken, and only you can close the lobby.</p>
              <Button size="lg" className="mt-5 h-12 w-full justify-between px-4 text-[15px] font-bold" onClick={create} loading={pending === 'create'} data-testid="create-room">
                Create team room <ArrowRight aria-hidden />
              </Button>
            </div>
          </section>
          <section aria-labelledby="join-heading" className="grid grid-cols-[2.75rem_minmax(0,1fr)] py-8">
            <p className="numeral pt-1 text-2xl text-subtle" aria-hidden>
              B
            </p>
            <div>
              <h2 id="join-heading" className="text-2xl font-extrabold tracking-tight">
                Join with a code
              </h2>
              <form
                className="mt-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void join()
                }}
              >
                <label className="block">
                  <span className="eyebrow">Invitation code</span>
                  <input
                    className="mt-2 h-14 w-full border-0 border-b-2 border-border-strong bg-transparent px-0 font-mono text-xl font-semibold uppercase tracking-[0.1em] outline-none placeholder:font-normal placeholder:text-subtle/60 focus:border-foreground"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    data-testid="invite-input"
                  />
                </label>
                <Button type="submit" size="lg" variant="outline" className="mt-4 h-12 w-full justify-between bg-transparent px-4 text-[15px] font-bold" loading={pending === 'join'} disabled={code.trim() === ''} data-testid="join-room">
                  Join room <ArrowRight aria-hidden />
                </Button>
              </form>
              <p className="mt-3 text-xs text-subtle">Twelve characters; dashes and capitals do not matter. A room holds three people.</p>
            </div>
          </section>
        </div>
        <section aria-labelledby="rooms-heading" className="min-w-0 border-t border-border py-8 lg:col-span-7 lg:border-t-0 lg:pl-10">
          <h2 id="rooms-heading" className="kicker mb-4">
            Your rooms
          </h2>
          <RoomList records={records} status={status} onOpen={onOpen} />
        </section>
      </div>
      <p className="pt-5 text-sm text-muted-foreground">
        On your own?{' '}
        <Link to="/simulation" className="font-semibold text-foreground underline">
          Start a solo run
        </Link>
        .
      </p>
    </Page>
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
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

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
      <Page>
        <div className="space-y-4">
          <ConnectionNotice problem={problem} onRetry={() => void syncRoom()} />
          <StateMessage>Loading room…</StateMessage>
        </div>
      </Page>
    )
  }
  if (!room || !userId) {
    return (
      <Unavailable testId="room-missing" onLeave={onLeave}>
        This room does not exist, or you are not a participant in it.
      </Unavailable>
    )
  }
  if (room.data.rulesVersion !== RULES_VERSION) {
    return (
      <Unavailable testId="room-legacy" onLeave={onLeave}>
        This room was played under an earlier version of the scenario rules and cannot be shown.
      </Unavailable>
    )
  }

  const members = membersOf(room.data)
  const me = members.find((member) => member.userId === userId)
  const isHost = room.data.hostId === userId
  const status = room.data.status
  const nameOf = (id: string) => users.find((user) => user.id === id)?.name ?? 'Participant'
  const isOnline = (id: string) => (id === userId ? presence.connected : presence.peers.some((peer) => peer.userId === id))
  const rolesTaken = ROLES.filter((role) => members.some((member) => member.role === role)).length
  const ready = members.length === MAX_MEMBERS && rolesTaken === ROLES.length
  const code = formatInviteCode(room.data.inviteCode)

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied('yes')
    } catch {
      setCopied('failed')
    }
  }

  const roster = (
    <section aria-labelledby="team-heading" className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h2 id="team-heading" className="kicker">
          Your team
        </h2>
        <span className="text-xs text-muted-foreground tabular">
          {members.length} / {MAX_MEMBERS}
        </span>
      </div>
      <ul className="mt-4 border-t border-border-strong" data-testid="participants">
        {members.map((member) => {
          const online = isOnline(member.userId)
          return (
            <li
              key={member.userId}
              className="border-b border-border py-3"
              data-testid="member"
              data-user-id={member.userId}
              data-role={member.role ?? ''}
              data-online={online ? 'true' : 'false'}
            >
              <p className="eyebrow">{member.role ? ROLE_LABELS[member.role] : 'No role yet'}</p>
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2 font-display text-base font-bold leading-snug">
                <span className="truncate">{nameOf(member.userId)}</span>
                {member.userId === userId && <span className="font-sans text-xs font-normal text-muted-foreground">(you)</span>}
                {member.userId === room.data.hostId && <span className="border border-border-strong px-1 py-px font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Host</span>}
              </p>
              <p className={cn('mt-1 inline-flex items-center gap-1.5 text-xs', online ? 'text-ok' : 'text-subtle')}>
                <span className={cn('size-1.5 rounded-full', online ? 'bg-ok' : 'border border-subtle')} aria-hidden />
                {online ? 'Online' : 'Offline'}
              </p>
            </li>
          )
        })}
      </ul>
      {status === 'lobby' && members.length < MAX_MEMBERS && (
        <p className="pt-3 text-xs text-muted-foreground">
          Waiting for {MAX_MEMBERS - members.length} more {MAX_MEMBERS - members.length === 1 ? 'person' : 'people'}.
        </p>
      )}
    </section>
  )

  const playing = (status === 'active' || status === 'completed') && !!me?.role && typeof room.data.startedAt === 'number'

  return (
    <section data-testid="room-view" data-status={status}>
      {playing ? (
        <TeamSimulation
          roomId={roomId}
          startedAt={room.data.startedAt as number}
          userId={userId}
          role={me.role as RoleId}
          nameOf={nameOf}
          clockOffset={clockOffset}
          learnClock={learnClock}
          onEnded={syncRoom}
          problem={problem}
          note={note}
          teamPanel={roster}
          onRetry={() => void syncRoom()}
          onLeave={onLeave}
        />
      ) : (
        <Page>
          <PageHeader
            eyebrow="Operation Nightfall · Team lobby"
            title={status === 'lobby' ? 'Assemble the response team' : 'Team room'}
            lead={status === 'lobby' ? 'Three people, three roles. The clock starts on the server when the host starts the simulation.' : undefined}
          />
          <div className="space-y-5">
            <div className="space-y-4 pt-5 empty:hidden">
              <ConnectionNotice problem={problem} onRetry={() => void syncRoom()} />
              {error && (
                <p role="alert" className="border-l-2 border-critical bg-critical-surface px-4 py-3 text-sm" data-testid="room-error">
                  {error}
                </p>
              )}
            </div>

            {status === 'lobby' && (
              <div className="grid border-b border-border-strong lg:grid-cols-[minmax(0,1fr)_21rem]" data-testid="lobby">
                <div className="min-w-0 pb-8 lg:border-r lg:border-border lg:pr-10">
                  <section aria-labelledby="roles-heading">
                    <div className="flex items-baseline justify-between gap-4">
                      <h2 id="roles-heading" className="kicker">
                        Role assignment
                      </h2>
                      <p className="text-xs text-muted-foreground tabular">
                        {rolesTaken} of {ROLES.length} taken
                      </p>
                    </div>
                    <ul className="mt-4 grid border-t border-border-strong md:grid-cols-3">
                      {ROLES.map((role, index) => {
                        const holder = members.find((member) => member.role === role)
                        const mine = holder?.userId === userId
                        return (
                          <li
                            key={role}
                            className={cn(
                              'relative flex flex-col border-b border-border px-0 pb-6 pt-6 md:min-h-[23rem] md:border-b-0 md:px-6',
                              index > 0 && 'md:border-l md:border-border',
                              index === 0 && 'md:pl-0',
                              mine && 'md:bg-secondary/60 md:pl-6',
                            )}
                            data-role-slot={role}
                            data-held={holder ? (mine ? 'self' : 'other') : 'open'}
                          >
                            {/* The bar across the top is the slot's state: solid when held, broken while open. */}
                            <span
                              className={cn('absolute inset-x-0 top-0 h-1', mine ? 'bg-foreground' : holder ? 'bg-muted-foreground/60' : 'bg-[repeating-linear-gradient(90deg,var(--color-caution)_0_8px,transparent_8px_14px)]')}
                              aria-hidden
                            />
                            <p className="numeral text-[3.25rem] text-subtle" aria-hidden>
                              0{index + 1}
                            </p>
                            <h3 className="mt-6 text-[1.625rem] font-extrabold leading-[1.05] tracking-[-0.02em]">{ROLE_LABELS[role]}</h3>
                            <p className="mt-2.5 flex-1 text-sm leading-relaxed text-muted-foreground">{ROLE_BRIEF[role]}</p>
                            <div className="mt-6 border-t border-border pt-3">
                              <p className="eyebrow">Status</p>
                              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                <p className={cn('font-display text-lg font-bold leading-snug', holder ? 'text-foreground' : 'text-caution')} data-testid={`role-holder-${role}`}>
                                  {holder ? (mine ? 'Held by you' : `Held by ${nameOf(holder.userId)}`) : 'Open'}
                                </p>
                                {holder && holder.userId === room.data.hostId && (
                                  <span className="border border-border-strong px-1 py-px text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Host</span>
                                )}
                              </div>
                            </div>
                            <div className="mt-4">
                              {mine ? (
                                <Button variant="outline" className="w-full bg-transparent" onClick={() => lobbyCommand('releaseRole')} loading={pending === 'releaseRole:'} data-testid="release-role">
                                  Release role
                                </Button>
                              ) : (
                                <Button
                                  className={cn('w-full', (!!holder || !me) && 'border border-border bg-transparent text-subtle disabled:opacity-100')}
                                  onClick={() => lobbyCommand('claimRole', { role })}
                                  disabled={!!holder || !me}
                                  loading={pending === `claimRole:${role}`}
                                  data-testid={`claim-${role}`}
                                >
                                  {holder ? 'Taken' : 'Take role'}
                                </Button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </section>

                  <section aria-labelledby="code-heading" className="mt-10 grid gap-x-10 gap-y-4 border-t border-border-strong pt-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                    <div className="min-w-0">
                      <h2 id="code-heading" className="kicker">
                        Invitation code
                      </h2>
                      <p className="mt-4 break-all font-mono text-[clamp(1.5rem,0.8rem+3vw,3.25rem)] font-semibold leading-none tracking-[0.08em]" data-testid="invite-code">
                        {code}
                      </p>
                      <p className="mt-4 max-w-md text-xs leading-relaxed text-muted-foreground">Give it to your two teammates. Anyone signed in who has it can take a free seat.</p>
                    </div>
                    <div>
                      <Button variant="outline" className="bg-transparent" onClick={() => void copyCode()} data-testid="copy-code">
                        {copied === 'yes' ? <Check aria-hidden /> : <Copy aria-hidden />}
                        {copied === 'yes' ? 'Copied' : 'Copy code'}
                      </Button>
                      <p className="sr-only" role="status" data-testid="copy-status">
                        {copied === 'yes' ? 'Invitation code copied.' : copied === 'failed' ? 'Could not copy. Select the code and copy it by hand.' : ''}
                      </p>
                      {copied === 'failed' && <p className="mt-1.5 text-xs text-caution">Could not copy — select the code instead.</p>}
                    </div>
                  </section>
                </div>

                <div className="min-w-0 space-y-8 border-t border-border py-6 lg:border-t-0 lg:pb-8 lg:pl-8 lg:pt-0">
                  {roster}

                  <section aria-labelledby="ready-heading" data-testid="readiness" data-ready={ready ? 'true' : 'false'}>
                    <h2 id="ready-heading" className="kicker">
                      Start readiness
                    </h2>
                    <p className={cn('mt-3 font-display text-[1.75rem] font-extrabold leading-[1.05] tracking-[-0.02em]', ready ? 'text-foreground' : 'text-caution')} data-testid="readiness-headline">
                      {ready
                        ? 'Ready to start'
                        : members.length < MAX_MEMBERS
                          ? `Waiting for ${MAX_MEMBERS - members.length} more ${MAX_MEMBERS - members.length === 1 ? 'person' : 'people'}`
                          : `${ROLES.length - rolesTaken} ${ROLES.length - rolesTaken === 1 ? 'role' : 'roles'} still open`}
                    </p>
                    <ul className="mt-4 border-t border-border-strong text-sm">
                      <ReadyLine met={members.length === MAX_MEMBERS}>
                        {members.length} of {MAX_MEMBERS} people joined
                      </ReadyLine>
                      <ReadyLine met={rolesTaken === ROLES.length}>
                        {rolesTaken} of {ROLES.length} roles taken
                      </ReadyLine>
                    </ul>
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="lobby-hint">
                      {ready
                        ? isHost
                          ? 'Everyone is ready. The clock starts on the server when you start.'
                          : 'Everyone is ready. Waiting for the host to start.'
                        : 'The simulation can start once three people hold the three roles.'}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="host-line">
                      Host: <span className="font-semibold text-foreground">{nameOf(room.data.hostId)}</span>
                      {isHost ? ' (you)' : ''}. Only the host can start or close the room.
                    </p>
                    <div className="mt-4 flex flex-col gap-2">
                      {isHost ? (
                        <>
                          <Button
                            size="lg"
                            className={cn('h-12 w-full justify-between px-4 text-[15px] font-bold', !ready && 'border border-border bg-transparent text-subtle disabled:opacity-100')}
                            onClick={() => lobbyCommand('startRoom')}
                            disabled={!ready}
                            loading={pending === 'startRoom:'}
                            data-testid="start-room"
                          >
                            Start simulation <Play aria-hidden />
                          </Button>
                          {confirmClose ? (
                            <div className="border-l-2 border-critical bg-critical-surface p-3" role="group" aria-label="Confirm closing the room">
                              <p className="text-sm">Close this room for everyone? It cannot be reopened.</p>
                              <div className="mt-2.5 flex gap-2">
                                <Button size="sm" variant="destructive" onClick={() => lobbyCommand('abandonRoom')} loading={pending === 'abandonRoom:'} data-testid="abandon-confirm">
                                  Close room
                                </Button>
                                <Button size="sm" variant="outline" className="bg-transparent" onClick={() => setConfirmClose(false)} data-testid="abandon-cancel">
                                  Keep it open
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button variant="ghost" className="w-full justify-between px-4 text-muted-foreground" onClick={() => setConfirmClose(true)} data-testid="abandon-room">
                              Close room <X aria-hidden />
                            </Button>
                          )}
                        </>
                      ) : (
                        <Button variant="outline" className="w-full justify-between bg-transparent px-4" onClick={() => lobbyCommand('leaveRoom')} loading={pending === 'leaveRoom:'} data-testid="leave-room">
                          Leave room <DoorOpen aria-hidden />
                        </Button>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            )}

            {status === 'abandoned' && (
              <StateMessage testId="room-abandoned" attrs={{ 'data-reason': room.data.closedReason ?? 'host' }}>
                {room.data.closedReason === 'expired'
                  ? 'This room was not used for a day and has closed. Create a new room to play.'
                  : 'The host closed this room before the simulation started.'}
              </StateMessage>
            )}
            {status !== 'lobby' && <div className="max-w-md pt-4">{roster}</div>}

            <Button variant="ghost" className="px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={onLeave}>
              <ArrowLeft aria-hidden /> Back to rooms
            </Button>
          </div>
        </Page>
      )}
    </section>
  )
}

function ReadyLine({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border py-2.5" data-met={met ? 'true' : 'false'}>
      <span className={met ? 'text-foreground' : 'text-muted-foreground'}>{children}</span>
      <span className={cn('inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.12em]', met ? 'text-ok' : 'text-caution')}>
        {met && <Check className="size-3" aria-hidden />}
        {met ? 'Met' : 'Waiting'}
      </span>
    </li>
  )
}

function Unavailable({ children, testId, onLeave }: { children: string; testId: string; onLeave: () => void }) {
  return (
    <Page narrow>
      <PageHeader eyebrow="Operation Nightfall · Team" title="This room cannot be shown" />
      <div className="space-y-4 pt-6">
        <StateMessage testId={testId}>{children}</StateMessage>
        <Button variant="ghost" className="px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={onLeave}>
          <ArrowLeft aria-hidden /> Back to rooms
        </Button>
      </div>
    </Page>
  )
}

function TeamSimulation({
  roomId,
  startedAt,
  userId,
  role,
  nameOf,
  clockOffset,
  learnClock,
  onEnded,
  problem,
  note,
  teamPanel,
  onRetry,
  onLeave,
}: {
  roomId: string
  startedAt: number
  userId: string
  role: RoleId
  nameOf: (id: string) => string
  clockOffset: number | null
  learnClock: (clock: ServerClock) => void
  onEnded: () => Promise<unknown>
  problem: LinkProblem
  note: (result: ActionResponse<ServerClock>) => void
  teamPanel: ReactNode
  onRetry: () => void
  onLeave: () => void
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
    const live = toGameEvents(eventsQuery.records, false)
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
    return (
      <Page>
        <StateMessage>Loading simulation…</StateMessage>
      </Page>
    )
  }

  const ended = result !== null || (serverNow !== null && serverNow >= view.deadlineAt)
  const remaining = serverNow === null ? null : view.deadlineAt - (result ? result.endedAt : serverNow)
  const clock = serverNow ?? view.lastEventAt
  // Findings are only ever added: show the union of what both sources have delivered.
  const findings = [...findingsQuery.records.map((record) => record.data)]
  for (const finding of synced.findings) {
    if (!findings.some((have) => have.eventSeq === finding.eventSeq && have.scope === finding.scope)) findings.push(finding)
  }

  return (
    <CommandCenter
      mode="team"
      rootTestId="team-simulation"
      rootAttrs={{ 'data-my-role': role, 'data-last-seq': view.lastSeq }}
      view={view}
      events={events}
      clock={clock}
      remaining={remaining}
      ended={ended}
      locked={problem === 'signed_out'}
      result={result}
      role={role}
      nameOf={nameOf}
      findingsOf={(event) => {
        const shared = findings.find((finding) => finding.eventSeq === event.seq && finding.scope === 'team')
        const own = findings.find((finding) => finding.eventSeq === event.seq && finding.scope === 'private' && finding.ownerId === userId)
        return {
          ...(shared ? { shared: { text: shared.text, sharedBy: shared.sharedBy || undefined } } : {}),
          ...(own ? { own: { text: own.text } } : {}),
        }
      }}
      isPending={(kind: PendingKind, key: string) => pendingCommand === `${kind}:${key}`}
      onRun={(actionId) => void send('executeAction', `run:${actionId}`, { actionId })}
      onRequestApproval={(actionId) => void send('requestApproval', `ask:${actionId}`, { actionId })}
      onDecide={(actionId, requestSeq, decision) => void send('decideApproval', `${decision}:${actionId}:${requestSeq}`, { actionId, requestSeq, decision })}
      onShare={(eventSeq) => void send('shareFinding', `share:${eventSeq}`, { eventSeq })}
      error={error}
      notice={<ConnectionNotice problem={problem} onRetry={onRetry} />}
      teamPanel={teamPanel}
      exits={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="bg-transparent" onClick={onLeave} data-testid="back-to-rooms">
            <ArrowLeft aria-hidden /> Back to rooms
          </Button>
        </div>
      }
    />
  )
}
