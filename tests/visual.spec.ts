/**
 * Screenshots of every designed screen at desktop, tablet and phone widths,
 * taken against the real local worker with real data. Opt-in
 * (BLACKOUT_SHOTS=1): it asserts nothing about pixels — the images in
 * .deepspace/shots are for a person to look at — but it does fail if a screen
 * scrolls sideways at any width.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(!process.env.BLACKOUT_SHOTS, 'Set BLACKOUT_SHOTS=1 to capture screenshots.')
test.skip(loadAllTestAccounts().length < 3, 'Needs 3 test accounts.')

const OUT = fileURLToPath(new URL('../.deepspace/shots/', import.meta.url))
// BLACKOUT_SHOT_SIZES=desktop (or a comma list) limits the widths captured.
const WANTED = (process.env.BLACKOUT_SHOT_SIZES ?? 'desktop,tablet,phone').split(',')
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
].filter((viewport) => WANTED.includes(viewport.name))
const WAIT = { timeout: 20_000 }

async function shoot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true })
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.waitForTimeout(350)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `${name} scrolls sideways at ${viewport.name}`).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${OUT}${name}-${viewport.name}.png` })
    // The app scrolls inside <main>, so a whole-screen image needs a viewport as tall as the content.
    const tall = await page.evaluate(() => {
      const main = document.querySelector('main#main')
      return main ? main.scrollHeight + (window.innerHeight - main.clientHeight) : 0
    })
    // Inside the app shell only <main> scrolls; a taller document means something escaped it.
    const stray = await page.evaluate(() => (document.querySelector('main#main') ? document.documentElement.scrollHeight - window.innerHeight : 0))
    expect(stray, `${name} leaves blank scroll space at ${viewport.name}`).toBeLessThanOrEqual(1)
    // A page outside the app shell scrolls as a document: capture it whole at the real viewport height.
    if (tall === 0) await page.screenshot({ path: `${OUT}${name}-${viewport.name}-full.png`, fullPage: true })
    if (tall > viewport.height + 1) {
      await page.setViewportSize({ width: viewport.width, height: Math.min(tall, 7000) })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${OUT}${name}-${viewport.name}-full.png`, fullPage: true })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
    return ((await res.json()) as { token: string }).token
  })
}
async function call<T>(page: Page, token: string, name: string, data: Record<string, unknown>): Promise<T> {
  const res = await page.request.post(`/api/actions/${name}`, { headers: { Authorization: `Bearer ${token}` }, data })
  const body = (await res.json()) as { success: boolean; data?: T; error?: string }
  expect(body.success, `${name}: ${body.error}`).toBe(true)
  return body.data as T
}

test('public and setup screens', async ({ page, users }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await expect(page.getByTestId('static-landing')).toBeVisible()
  await shoot(page, '01-landing')
  await page.goto('/home')
  await expect(page.getByTestId('home-signed-out')).toBeVisible(WAIT)
  await shoot(page, '02-home-signed-out')
  await page.goto('/simulation')
  await expect(page.getByTestId('signed-out-panel')).toBeVisible(WAIT)
  await shoot(page, '03-gate')
  await page.goto('/no-such-page')
  await shoot(page, '04-not-found')

  const [alice] = await users(1)
  await alice.page.goto('/home')
  await expect(alice.page.getByTestId('home-solo')).toBeVisible(WAIT)
  await shoot(alice.page, '05-home')
  await alice.page.goto('/simulation')
  await expect(alice.page.getByTestId('create-simulation')).toBeVisible(WAIT)
  await expect(alice.page.getByTestId('simulation-list').locator('li').first()).toBeVisible(WAIT)
  await alice.page.waitForTimeout(1500)
  await shoot(alice.page, '06-solo-setup')
  await alice.page.goto('/team')
  await expect(alice.page.getByTestId('create-room')).toBeVisible(WAIT)
  await alice.page.waitForTimeout(1500)
  await shoot(alice.page, '07-team-setup')
  await alice.page.goto('/history')
  await expect(alice.page.getByTestId('history-solo')).toBeVisible(WAIT)
  await alice.page.waitForTimeout(2500)
  await shoot(alice.page, '08-history')
  await alice.page.goto('/settings')
  await alice.page.waitForTimeout(1000)
  await shoot(alice.page, '09-settings')
})

test('solo command center and postmortem', async ({ users }) => {
  test.setTimeout(420_000)
  const [{ page }] = await users(1)
  await page.goto('/simulation')
  await page.getByTestId('create-simulation').click()
  await expect(page.getByTestId('simulation-view')).toBeVisible(WAIT)
  await page.getByTestId('action-inspect_access_logs').click()
  await page.getByTestId('action-review_deployment').click()
  await page.getByTestId('approve-roll_back_release').click().catch(() => {})
  await expect(page.getByTestId('action-status-inspect_access_logs')).toHaveText('Completed', { timeout: 40_000 })
  await page.getByTestId('action-correlate_session_events').click()
  await page.waitForTimeout(1500)
  await shoot(page, '10-solo-active')
  // Scrolled down: the pinned line carries the clock once the header has gone.
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.evaluate(() => document.querySelector('main#main')!.scrollTo(0, 900))
    await expect(page.getByTestId('now-clock')).toBeVisible()
    await page.screenshot({ path: `${OUT}13-solo-scrolled-${viewport.name}.png` })
    await page.evaluate(() => document.querySelector('main#main')!.scrollTo(0, 0))
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('[data-testid^="open-evidence-"]').last().click()
  await expect(page.getByTestId('evidence-dialog')).toBeVisible()
  await shoot(page, '11-evidence-dialog')
  await page.keyboard.press('Escape')

  // Play the rest of the winning line so the postmortem is a real one.
  const run = async (actionId: string) => {
    await expect(page.getByTestId(`action-${actionId}`)).toBeEnabled({ timeout: 90_000 })
    await page.getByTestId(`action-${actionId}`).click()
  }
  const done = (actionId: string) => expect(page.getByTestId(`action-status-${actionId}`)).toHaveText('Completed', { timeout: 90_000 })
  await done('correlate_session_events')
  await page.getByTestId('approve-revoke_admin_sessions').click()
  await run('investigate_signing_access')
  await run('issue_customer_advisory')
  await done('investigate_signing_access')
  await run('revoke_admin_sessions')
  await page.getByTestId('approve-rotate_signing_keys').click()
  await run('rotate_signing_keys')
  await done('revoke_admin_sessions')
  await done('rotate_signing_keys')
  await run('restore_auth')
  await done('restore_auth')
  await run('validate_recovery')
  await done('validate_recovery')
  await run('confirm_resolution')
  await expect(page.getByTestId('outcome')).toBeVisible(WAIT)
  await page.waitForTimeout(800)
  await shoot(page, '12-postmortem')
  await page.getByTestId('full-record').locator('summary').click()
  await expect(page.getByTestId('timeline')).toBeVisible()
  await shoot(page, '14-postmortem-record')
})

test('team lobby and command center', async ({ users }) => {
  test.setTimeout(240_000)
  const [host, second, third] = await users(3)
  for (const user of [host, second, third]) await user.page.goto('/team')
  const tokens = await Promise.all([host, second, third].map((user) => tokenOf(user.page)))
  await host.page.getByTestId('create-room').click()
  await expect(host.page.getByTestId('lobby')).toBeVisible(WAIT)
  const roomId = new URL(host.page.url()).searchParams.get('room')!
  const code = (await host.page.getByTestId('invite-code').innerText()).trim()
  await shoot(host.page, '20-lobby-empty')
  await call(second.page, tokens[1], 'joinRoom', { inviteCode: code })
  await call(third.page, tokens[2], 'joinRoom', { inviteCode: code })
  await second.page.goto(`/team?room=${roomId}`)
  await third.page.goto(`/team?room=${roomId}`)
  await host.page.getByTestId('claim-security').click()
  await second.page.getByTestId('claim-commander').click()
  await expect(host.page.getByTestId('member')).toHaveCount(3, WAIT)
  await expect(host.page.locator('[data-testid="member"][data-online="true"]')).toHaveCount(3, WAIT)
  await shoot(host.page, '21-lobby-filling')
  await third.page.getByTestId('claim-infrastructure').click()
  await expect(host.page.getByTestId('start-room')).toBeEnabled(WAIT)
  await shoot(host.page, '22-lobby-ready')
  await host.page.getByTestId('start-room').click()
  for (const user of [host, second, third]) await expect(user.page.getByTestId('team-simulation')).toBeVisible(WAIT)

  await host.page.getByTestId('action-inspect_access_logs').click()
  await third.page.getByTestId('approve-roll_back_release').click()
  await expect(second.page.getByTestId('pending-roll_back_release')).toBeVisible(WAIT)
  await expect(host.page.getByTestId('finding-private')).toBeVisible({ timeout: 40_000 })
  await shoot(host.page, '23-team-security')
  await host.page.getByTestId('finding-private').locator('xpath=..').locator('[data-testid^="open-evidence-"]').click()
  await expect(host.page.getByTestId('evidence-share')).toBeVisible()
  await shoot(host.page, '26-team-evidence-private')
  await host.page.keyboard.press('Escape')
  await shoot(second.page, '24-team-commander')
  await shoot(third.page, '25-team-infrastructure')
})
