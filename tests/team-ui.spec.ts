/**
 * The team page, driven by four separately signed-in browser contexts against
 * the real local worker: join by code, live lobby, roles, a commander who
 * goes away with an approval pending, a refresh in the middle of an action,
 * a second tab, and sharing a finding.
 *
 * Server rules are proven in tests/team.spec.ts and the unit tests; this file
 * proves that people actually see each other's state and recover it.
 */
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const usable = loadAllTestAccounts().length
test.skip(usable < 4, `Needs 4 usable test accounts, found ${usable}.`)

interface EventView {
  seq: number
  type: string
  actionId?: string
  actorId: string
}

async function bearer(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const res = await fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
    return res.ok ? ((await res.json()) as { token?: string }).token ?? null : null
  })
  if (!token) throw new Error('no token')
  return token
}

test('three people play as a team through the page; a fourth is kept out', async ({ users }) => {
  test.setTimeout(240_000)
  const [host, second, third, fourth] = await users(4)
  const WAIT = { timeout: 20_000 }

  // The host creates a room and reads out the code.
  await host.page.goto('/team')
  await host.page.getByTestId('create-room').click()
  await expect(host.page.getByTestId('lobby')).toBeVisible(WAIT)
  const code = (await host.page.getByTestId('invite-code').innerText()).trim()
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  const roomId = new URL(host.page.url()).searchParams.get('room')!
  expect(roomId).toBeTruthy()
  await expect(host.page.getByTestId('member')).toHaveCount(1)
  await expect(host.page.getByTestId('start-room')).toBeDisabled()

  // Knowing the room's address is not enough: without the code there is no room.
  await second.page.goto(`/team?room=${roomId}`)
  await expect(second.page.getByTestId('room-missing')).toBeVisible(WAIT)
  await expect(second.page.getByTestId('room-view')).toHaveCount(0)

  // A wrong code is refused; the right one, typed in lower case, gets in.
  await second.page.goto('/team')
  await second.page.getByTestId('invite-input').fill('0000-0000-0000')
  await second.page.getByTestId('join-room').click()
  await expect(second.page.getByTestId('entrance-error')).toBeVisible(WAIT)
  await second.page.getByTestId('invite-input').fill(code.toLowerCase())
  await second.page.getByTestId('join-room').click()
  await expect(second.page.getByTestId('lobby')).toBeVisible(WAIT)
  // The host sees them arrive without doing anything.
  await expect(host.page.getByTestId('member')).toHaveCount(2, WAIT)

  await third.page.goto('/team')
  await third.page.getByTestId('invite-input').fill(code)
  await third.page.getByTestId('join-room').click()
  await expect(third.page.getByTestId('lobby')).toBeVisible(WAIT)
  for (const p of [host, second, third]) await expect(p.page.getByTestId('member')).toHaveCount(3, WAIT)
  // Everyone shows as connected to everyone.
  for (const p of [host, second, third]) await expect(p.page.locator('[data-testid="member"][data-online="true"]')).toHaveCount(3, WAIT)

  // The room is full: the fourth person is told so and sees nothing of it.
  await fourth.page.goto('/team')
  await fourth.page.getByTestId('invite-input').fill(code)
  await fourth.page.getByTestId('join-room').click()
  await expect(fourth.page.getByTestId('entrance-error')).toContainText('three participants', WAIT)
  await fourth.page.goto(`/team?room=${roomId}`)
  await expect(fourth.page.getByTestId('room-missing')).toBeVisible(WAIT)
  await expect(host.page.getByTestId('member')).toHaveCount(3)

  // The same person opening the room in a second tab is still one participant.
  const secondTab = await second.page.context().newPage()
  await secondTab.goto('/team')
  await secondTab.getByTestId('invite-input').fill(code)
  await secondTab.getByTestId('join-room').click()
  await expect(secondTab.getByTestId('lobby')).toBeVisible(WAIT)
  await expect(secondTab.getByTestId('member')).toHaveCount(3, WAIT)
  await expect(host.page.getByTestId('member')).toHaveCount(3)

  // Roles: the host takes security — the host is deliberately not the commander.
  await host.page.getByTestId('claim-security').click()
  await expect(host.page.getByTestId('role-holder-security')).toContainText('you', WAIT)
  // Others see it taken, live, and cannot take it.
  await expect(second.page.getByTestId('claim-security')).toBeDisabled(WAIT)
  await expect(third.page.getByTestId('claim-security')).toBeDisabled(WAIT)
  // Two tabs of one person claim different roles: that person ends with exactly one.
  // Wait for the server's answer to both, so the lobby is settled before going on.
  const answered = (page: Page) => page.waitForResponse((r) => r.url().endsWith('/api/actions/claimRole'))
  await Promise.all([
    answered(second.page),
    answered(secondTab),
    second.page.getByTestId('claim-commander').click(),
    secondTab.getByTestId('claim-infrastructure').click(),
  ])
  await expect
    .poll(async () => host.page.locator(`[data-testid="member"]:not([data-role=""])`).count(), WAIT)
    .toBe(2)
  // Settle on commander for the second person (a swap if the other tab won).
  await expect(second.page.locator('[data-testid="release-role"]')).toHaveCount(1, WAIT)
  if ((await second.page.getByTestId('claim-commander').count()) > 0) await second.page.getByTestId('claim-commander').click()
  await expect(second.page.getByTestId('role-holder-commander')).toContainText('you', WAIT)
  await expect(secondTab.getByTestId('role-holder-commander')).toContainText('you', WAIT)
  await expect(host.page.getByTestId('start-room')).toBeDisabled()
  await expect(third.page.getByTestId('start-room')).toHaveCount(0) // only the host has a start button
  await third.page.getByTestId('claim-infrastructure').click()
  await expect(host.page.getByTestId('start-room')).toBeEnabled(WAIT)

  // The host starts; every page moves to the simulation with its own role.
  await host.page.getByTestId('start-room').click()
  const roleOf: Array<[Page, string]> = [
    [host.page, 'security'],
    [second.page, 'commander'],
    [secondTab, 'commander'],
    [third.page, 'infrastructure'],
  ]
  for (const [page, role] of roleOf) {
    await expect(page.getByTestId('team-simulation')).toHaveAttribute('data-my-role', role, WAIT)
  }
  // Each person has buttons for their own role's actions only.
  await expect(host.page.getByTestId('action-inspect_access_logs')).toBeVisible()
  await expect(host.page.getByTestId('action-issue_customer_advisory')).toHaveCount(0)
  await expect(host.page.getByTestId('action-roll_back_release')).toHaveCount(0)
  await expect(second.page.getByTestId('action-inspect_access_logs')).toHaveCount(0)
  await expect(third.page.getByTestId('action-issue_customer_advisory')).toHaveCount(0)
  // The fourth person still has nothing.
  await fourth.page.reload()
  await expect(fourth.page.getByTestId('room-missing')).toBeVisible(WAIT)

  // Infrastructure asks for approval to roll back. Everyone sees it pending; only the commander can decide.
  await third.page.getByTestId('approve-roll_back_release').click()
  for (const [page] of roleOf) await expect(page.getByTestId('pending-roll_back_release')).toBeVisible(WAIT)
  await expect(second.page.getByTestId('decide-approve-roll_back_release')).toBeVisible()
  await expect(host.page.getByTestId('decide-approve-roll_back_release')).toHaveCount(0)
  await expect(third.page.getByTestId('decide-approve-roll_back_release')).toHaveCount(0)
  await expect(third.page.getByTestId('action-roll_back_release')).toBeDisabled()

  // The commander disconnects (both tabs) with the request still pending.
  await second.page.close()
  await secondTab.close()
  await expect(host.page.locator('[data-testid="member"][data-role="commander"]')).toHaveAttribute('data-online', 'false', { timeout: 45_000 })
  await expect(host.page.getByTestId('pending-roll_back_release')).toBeVisible()
  await expect(third.page.getByTestId('action-status-roll_back_release')).toHaveText('Waiting for the commander')

  // Work goes on. Security starts an investigation, then refreshes the page in the middle of it.
  await host.page.getByTestId('action-inspect_access_logs').click()
  await expect(host.page.getByTestId('action-status-inspect_access_logs')).toContainText('In progress', WAIT)
  // Infrastructure sees security's action live.
  await expect(third.page.getByTestId('action-status-inspect_access_logs')).toContainText('In progress', WAIT)
  await host.page.reload()
  await expect(host.page.getByTestId('team-simulation')).toHaveAttribute('data-my-role', 'security', WAIT)
  await expect(host.page.getByTestId('action-status-inspect_access_logs')).toHaveText(/In progress|Finishing|Completed/, WAIT)
  // It completes — the server finishes it, whoever is looking — and it ran once.
  await expect(host.page.getByTestId('action-status-inspect_access_logs')).toHaveText('Completed', { timeout: 40_000 })
  await expect(third.page.getByTestId('action-status-inspect_access_logs')).toHaveText('Completed', WAIT)
  await expect(host.page.getByTestId('event-action_started')).toHaveCount(1)
  await expect(host.page.getByTestId('event-action_completed')).toHaveCount(1)
  // The request is still waiting after all that.
  await expect(host.page.getByTestId('pending-roll_back_release')).toBeVisible()

  // What the investigation found is on security's page only.
  const privateFinding = host.page.getByTestId('finding-private')
  await expect(privateFinding).toHaveCount(1, WAIT)
  const findingText = (await privateFinding.innerText()).split('(only you')[0].trim()
  expect(findingText.length).toBeGreaterThan(20)
  await expect(third.page.getByTestId('timeline')).not.toContainText(findingText)
  await expect(third.page.getByTestId('finding-private')).toHaveCount(0)

  // The commander comes back in a fresh tab and finds the same request waiting.
  const back = await second.page.context().newPage()
  await back.goto(`/team?room=${roomId}`)
  await expect(back.getByTestId('team-simulation')).toHaveAttribute('data-my-role', 'commander', WAIT)
  await expect(back.getByTestId('pending-roll_back_release')).toBeVisible(WAIT)
  await expect(host.page.locator('[data-testid="member"][data-role="commander"]')).toHaveAttribute('data-online', 'true', WAIT)
  await expect(back.getByTestId('timeline')).not.toContainText(findingText)
  await expect(back.getByTestId('member')).toHaveCount(3)
  await back.getByTestId('decide-approve-roll_back_release').click()
  for (const page of [host.page, third.page, back]) await expect(page.getByTestId('pending-roll_back_release')).toHaveCount(0, WAIT)
  await expect(third.page.getByTestId('action-status-roll_back_release')).toContainText('Approval processing', WAIT)
  // After the processing time infrastructure can run it; the others see it start.
  await expect(third.page.getByTestId('action-roll_back_release')).toBeEnabled({ timeout: 15_000 })
  await third.page.getByTestId('action-roll_back_release').click()
  for (const page of [host.page, third.page, back]) {
    await expect(page.getByTestId('action-status-roll_back_release')).toContainText('In progress', WAIT)
  }

  // Security shares the finding: now the others have it, attributed.
  await host.page.locator('[data-testid^="share-"]').click()
  for (const page of [third.page, back]) {
    await expect(page.getByTestId('finding-team').filter({ hasText: findingText })).toHaveCount(1, WAIT)
  }
  await expect(host.page.getByTestId('finding-private')).toHaveCount(0, WAIT)

  // Security opens a second tab and presses the same button in both at once: one action.
  const hostTab = await host.page.context().newPage()
  await hostTab.goto(`/team?room=${roomId}`)
  await expect(hostTab.getByTestId('action-correlate_session_events')).toBeEnabled(WAIT)
  await expect(host.page.getByTestId('action-correlate_session_events')).toBeEnabled(WAIT)
  await Promise.all([
    host.page.getByTestId('action-correlate_session_events').click(),
    hostTab.getByTestId('action-correlate_session_events').click(),
  ])
  for (const page of [host.page, hostTab, third.page, back]) {
    await expect(page.getByTestId('action-status-correlate_session_events')).toContainText('In progress', WAIT)
  }

  // The authoritative log agrees with what the pages showed.
  const token = await bearer(host.page)
  const res = await host.page.request.post('/api/actions/syncSimulation', { headers: { Authorization: `Bearer ${token}` }, data: { simulationId: roomId } })
  const body = (await res.json()) as { success: boolean; data: { events: EventView[]; mode: string } }
  expect(body.success).toBe(true)
  expect(body.data.mode).toBe('team')
  const events = body.data.events
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  const started = events.filter((e) => e.type === 'action_started').map((e) => e.actionId)
  expect(started.sort()).toEqual(['correlate_session_events', 'inspect_access_logs', 'roll_back_release'])
  expect(events.filter((e) => e.type === 'approval_requested')).toHaveLength(1)
  expect(events.filter((e) => e.type === 'approval_granted')).toHaveLength(1)
  expect(new Set(events.filter((e) => e.type === 'action_started' || e.type.startsWith('approval')).map((e) => e.actorId)).size).toBe(3)
  // And the fourth person's rooms list never showed this room.
  await fourth.page.goto('/team')
  await expect(fourth.page.getByTestId('create-room')).toBeVisible(WAIT)
  await expect(fourth.page.getByTestId('room-list')).not.toContainText(code)
})
