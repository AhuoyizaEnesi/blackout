/**
 * Interface behaviour: navigation, the public landing page, the lobby's
 * copy and close controls, the evidence dialog, the postmortem's arithmetic,
 * history, and layout at three widths. Runs against the real local worker.
 *
 * Game rules, authorization and timing are covered by the other specs; this
 * one checks that what the server decided is presented and reachable.
 */
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(loadAllTestAccounts().length < 1, 'Needs a test account.')

const WAIT = { timeout: 20_000 }
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
] as const

async function expectNoSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, `${label} scrolls sideways`).toBeLessThanOrEqual(1)
  const inner = await page.evaluate(() => {
    const main = document.querySelector('main#main')
    return main ? main.scrollWidth - main.clientWidth : 0
  })
  expect(inner, `${label} content is wider than its container`).toBeLessThanOrEqual(1)
}

test.describe('landing page', () => {
  test('shows the scenario as it really starts and leads into the app', async ({ page }) => {
    await page.goto('/')
    const landing = page.getByTestId('static-landing')
    await expect(landing).toBeVisible()
    await expect(landing.getByRole('heading', { level: 1 })).toContainText('Eight minutes')
    await expect(landing).toContainText('Operation Nightfall')

    // The preview carries the engine's own starting values, not invented figures.
    const preview = page.getByTestId('landing-preview')
    await expect(preview).toContainText('SEV-1')
    await expect(preview).toContainText('08:00')
    for (const [label, value] of [
      ['Infrastructure health', '82'],
      ['Threat containment', '20'],
      ['Customer trust', '64'],
      ['Evidence collected', '10'],
    ]) {
      await expect(preview.locator('div', { hasText: label }).last()).toContainText(value)
    }
    for (const role of ['Incident Commander', 'Security Engineer', 'Infrastructure Engineer']) {
      await expect(landing.getByRole('heading', { name: role })).toBeVisible()
    }
    for (const ending of ['Complete Recovery', 'Costly Recovery', 'Partial Containment', 'Incident Escalation']) {
      await expect(landing).toContainText(ending)
    }
    await expect(page.getByTestId('landing-schedule').locator('li').last()).toContainText('08:00')

    await expect(page.getByTestId('landing-start')).toHaveAttribute('href', '/simulation')
    await expect(page.getByTestId('landing-join')).toHaveAttribute('href', '/team')
    await expect(page.getByTestId('landing-sign-in')).toHaveAttribute('href', '/home')

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      await expectNoSidewaysScroll(page, `landing at ${viewport.name}`)
    }
  })

  test('a signed-out visitor who starts is asked to sign in, not shown a broken page', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('landing-join').click()
    await expect(page).toHaveURL(/\/team$/)
    await expect(page.getByTestId('signed-out-panel')).toBeVisible(WAIT)
    await expect(page.getByTestId('gate-sign-in')).toBeEnabled()
    await expect(page.getByTestId('create-room')).toHaveCount(0)

    await page.goto('/history')
    await expect(page.getByTestId('signed-out-panel')).toBeVisible(WAIT)
    await expect(page.getByTestId('history-solo')).toHaveCount(0)

    await page.goto('/home')
    await expect(page.getByTestId('home-signed-out')).toBeVisible(WAIT)
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible()
  })
})

test.describe('navigation', () => {
  test('every section is reachable from the side rail and marks where you are', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/home')
    const nav = page.getByTestId('app-navigation')
    await expect(page.getByTestId('home-solo')).toBeVisible(WAIT)

    const stops: [string, RegExp, string][] = [
      ['Simulation', /\/simulation$/, 'create-simulation'],
      ['Team', /\/team$/, 'create-room'],
      ['History', /\/history$/, 'history-solo'],
      ['Home', /\/home$/, 'home-team'],
    ]
    for (const [label, url, landmark] of stops) {
      await nav.getByRole('link', { name: label, exact: true }).click()
      await expect(page).toHaveURL(url)
      await expect(page.getByTestId(landmark)).toBeVisible(WAIT)
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    }
    await nav.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible(WAIT)

    await page.goto('/home')
    await page.getByTestId('home-history').click()
    await expect(page).toHaveURL(/\/history$/)
  })

  test('on a phone the same links sit behind a menu button', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/home')
    await expect(page.getByTestId('home-solo')).toBeVisible(WAIT)
    const nav = page.getByTestId('app-navigation')
    const toggle = nav.getByRole('button', { name: 'Toggle menu' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(nav.getByRole('link', { name: 'History', exact: true })).toBeHidden()

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await nav.getByRole('link', { name: 'History', exact: true }).click()
    await expect(page).toHaveURL(/\/history$/)
    await expect(page.getByTestId('history-solo')).toBeVisible(WAIT)
    // Navigating closes the menu again.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Controls are large enough to hit with a thumb.
    const box = await toggle.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(40)
    expect(box!.height).toBeGreaterThanOrEqual(40)
  })

  test('signed-in screens fit desktop, tablet and phone without sideways scrolling', async ({ users }) => {
    const [{ page }] = await users(1)
    const screens: [string, string][] = [
      ['/home', 'home-solo'],
      ['/simulation', 'create-simulation'],
      ['/team', 'create-room'],
      ['/history', 'history-team'],
    ]
    for (const [path, landmark] of screens) {
      await page.goto(path)
      await expect(page.getByTestId(landmark)).toBeVisible(WAIT)
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport)
        await expectNoSidewaysScroll(page, `${path} at ${viewport.name}`)
        // Inside the app shell only <main> scrolls; a taller document means something escaped it.
        const stray = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
        expect(stray, `${path} at ${viewport.name} leaves blank scroll space`).toBeLessThanOrEqual(1)
      }
    }
  })
})

test.describe('team lobby controls', () => {
  test('the code can be copied, and closing the room needs a second, deliberate step', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/team')
    await page.getByTestId('create-room').click()
    await expect(page.getByTestId('lobby')).toBeVisible(WAIT)

    const code = (await page.getByTestId('invite-code').innerText()).trim()
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/)
    await expect(page.getByTestId('copy-status')).toHaveText('')
    await page.getByTestId('copy-code').click()
    await expect(page.getByTestId('copy-status')).toHaveText('Invitation code copied.')
    await expect(page.getByTestId('copy-code')).toContainText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)

    // One person, no roles: the lobby says so and will not start.
    await expect(page.getByTestId('readiness')).toHaveAttribute('data-ready', 'false')
    await expect(page.getByTestId('start-room')).toBeDisabled()
    await expect(page.getByTestId('member')).toHaveCount(1)
    await expect(page.getByTestId('member')).toContainText('Host')
    for (const role of ['commander', 'security', 'infrastructure']) {
      await expect(page.getByTestId(`role-holder-${role}`)).toHaveText('Open')
    }

    // Closing: the first press only asks.
    await page.getByTestId('abandon-room').click()
    await expect(page.getByTestId('abandon-confirm')).toBeVisible()
    await expect(page.getByTestId('abandon-room')).toHaveCount(0)
    await page.getByTestId('abandon-cancel').click()
    await expect(page.getByTestId('abandon-confirm')).toHaveCount(0)
    await expect(page.getByTestId('room-view')).toHaveAttribute('data-status', 'lobby')
    await expect(page.getByTestId('lobby')).toBeVisible()

    await page.getByTestId('abandon-room').click()
    await page.getByTestId('abandon-confirm').click()
    await expect(page.getByTestId('room-abandoned')).toBeVisible(WAIT)
    await expect(page.getByTestId('room-abandoned')).toHaveAttribute('data-reason', 'host')
    await expect(page.getByTestId('room-view')).toHaveAttribute('data-status', 'abandoned')
    await expect(page.getByTestId('lobby')).toHaveCount(0)
    await expect(page.getByTestId('start-room')).toHaveCount(0)
  })
})

/** The shortest line to Complete Recovery, played through the interface. */
async function playWinningLine(page: Page) {
  const run = async (actionId: string) => {
    await expect(page.getByTestId(`action-${actionId}`)).toBeEnabled({ timeout: 90_000 })
    await page.getByTestId(`action-${actionId}`).click()
  }
  const done = (actionId: string) => expect(page.getByTestId(`action-status-${actionId}`)).toHaveText('Completed', { timeout: 90_000 })
  await run('correlate_session_events')
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
}

test.describe('command center, evidence and postmortem', () => {
  test('a solo run: status, locked actions, evidence by keyboard, then a postmortem that adds up', async ({ users }) => {
    test.setTimeout(360_000)
    const [{ page }] = await users(1)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/simulation')
    await page.getByTestId('create-simulation').click()
    const view = page.getByTestId('simulation-view')
    await expect(view).toBeVisible(WAIT)

    // Header: identity, severity and a clock that says where its time comes from.
    await expect(view).toContainText('Operation Nightfall', { ignoreCase: true })
    await expect(page.getByTestId('severity')).toHaveText('SEV-1')
    await expect(page.getByTestId('time-remaining')).toHaveAttribute('role', 'timer')
    await expect(page.getByTestId('time-remaining')).toHaveText(/^0[67]:\d\d$/)
    await expect(page.getByTestId('clock-label')).toContainText('server time')
    await expect(page.getByTestId('live-announcement')).toHaveAttribute('aria-live', 'polite')

    // A locked action names what it is waiting for, and cannot be pressed.
    await expect(page.getByTestId('action-investigate_signing_access')).toBeDisabled()
    await expect(page.getByTestId('action-requires-investigate_signing_access')).toContainText('Correlate session events')
    await expect(page.getByTestId('action-requires-restore_auth')).toContainText('Revoke admin sessions')
    await expect(page.getByTestId('action-inspect_access_logs')).toBeEnabled()
    await expectNoSidewaysScroll(page, 'command center at desktop')

    // The pinned line names what can be started now and leads to its control, without starting anything.
    await expect(page.getByTestId('now-bar')).toBeVisible()
    await page.getByTestId('now-inspect_access_logs').click()
    await expect(page.getByTestId('action-inspect_access_logs')).toBeFocused()
    await expect(page.getByTestId('event-action_started')).toHaveCount(0)

    // Every control in the room has a name.
    const unnamed = await view.evaluate(
      (root) => [...root.querySelectorAll('button, a, summary, [role="button"]')].filter((el) => !(el.getAttribute('aria-label') || el.textContent || '').trim()).length,
    )
    expect(unnamed, 'controls without an accessible name').toBe(0)
    // Keyboard focus is drawn on whatever Tab lands on.
    await page.keyboard.press('Tab')
    const focusMark = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!)
      return { tag: document.activeElement!.tagName, outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px', shadow: style.boxShadow !== 'none' }
    })
    expect(focusMark.tag).not.toBe('BODY')
    expect(focusMark.outline || focusMark.shadow, 'focused control shows a focus indicator').toBe(true)
    // Motion stops when the reader asks for less of it.
    const pulse = page.getByTestId('severity').locator('span').first()
    expect(await pulse.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeGreaterThan(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await pulse.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThan(0.01)
    await page.emulateMedia({ reducedMotion: null })

    // Evidence: opened and closed with the keyboard alone, focus handed back.
    const firstRecord = page.locator('[data-testid^="open-evidence-"]').first()
    await firstRecord.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('evidence-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Initial alert')
    await expect(page.getByTestId('evidence-text')).toContainText('Sign-in failures')
    await expect(page.getByTestId('evidence-visibility')).toContainText('solo run')
    // Focus cannot leave the open record by tabbing.
    const seen: string[] = []
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('Tab')
      seen.push(
        await dialog.evaluate((el) => {
          const active = document.activeElement
          if (active && el.contains(active)) return 'dialog'
          if (active && document.getElementById('root')?.contains(active)) return `page behind: ${active.tagName} ${active.getAttribute('data-testid') ?? ''}`
          return `outside: ${active?.tagName ?? 'none'} ${[...(active?.attributes ?? [])].map((a) => a.name).join(',')}`
        }),
      )
    }
    expect(seen.filter((where) => where.startsWith('page behind')), `focus reached the page behind the dialog: ${seen.join(' | ')}`).toEqual([])
    expect(seen, `focus was never inside the dialog: ${seen.join(' | ')}`).toContain('dialog')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(firstRecord).toBeFocused()

    // An investigation produces a finding; its record shows the same text the timeline does.
    await page.getByTestId('action-inspect_access_logs').click()
    await page.getByTestId('action-review_deployment').click()
    await expect(page.getByTestId('action-status-inspect_access_logs')).toHaveText(/In progress/)
    await expect(page.getByTestId('action-status-inspect_access_logs')).toHaveText('Completed', { timeout: 40_000 })
    const finding = page.getByTestId('event-action_completed').first()
    await expect(finding).toContainText('07:42')
    await finding.locator('[data-testid^="open-evidence-"]').click()
    await expect(page.getByTestId('evidence-text')).toContainText('07:42')
    await expect(dialog).toContainText('Evidence +15')
    await dialog.getByRole('button', { name: /close/i }).click()
    await expect(dialog).toHaveCount(0)

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      await expectNoSidewaysScroll(page, `command center at ${viewport.name}`)
    }
    await page.setViewportSize({ width: 1440, height: 900 })

    await playWinningLine(page)

    // Postmortem: the ending, and a score whose parts are shown and sum to it.
    const result = page.getByTestId('result')
    await expect(result).toBeVisible(WAIT)
    await expect(result).toHaveAttribute('data-outcome', 'complete_recovery')
    await expect(page.getByTestId('outcome')).toHaveText('Complete Recovery')
    await expect(page.getByTestId('end-reason')).toContainText('confirmed resolution')
    await expect(page.getByTestId('clock-label')).toHaveText('Simulation ended')
    const score = Number(await page.getByTestId('score').innerText())
    expect(score).toBeGreaterThanOrEqual(96)
    expect(score).toBeLessThanOrEqual(100)
    let sum = 0
    for (const part of ['containment', 'restoration', 'validation', 'evidence', 'trust', 'health']) {
      const points = Number(await page.getByTestId(`score-part-${part}`).innerText())
      expect(Number.isInteger(points), `${part} is a whole number`).toBe(true)
      sum += points
    }
    expect(sum).toBe(score)
    expect(Number(await page.getByTestId('score-total').innerText())).toBe(score)
    await expect(page.getByTestId('outcome-criteria').locator('li')).toHaveCount(5)
    await expect(page.getByTestId('outcome-criteria').locator('li[data-met="true"]')).toHaveCount(5)

    // The record stays readable after the end, and nothing can be started any more.
    await expect(page.getByTestId('timeline')).toContainText('Confirm resolution completed')
    await expect(page.getByTestId('action-confirm_resolution')).toBeDisabled()
    await expect(page.getByTestId('action-validate_containment')).toBeDisabled()
    // The full log is folded under the report: closed at first, opened with the keyboard.
    const record = page.getByTestId('full-record')
    await expect(page.getByTestId('timeline')).toBeHidden()
    await expect(page.getByTestId('score-breakdown')).toBeVisible()
    await record.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('timeline')).toBeVisible()
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      await expectNoSidewaysScroll(page, `postmortem at ${viewport.name}`)
      // A metric at 100 must fit its cell at every width.
      const clipped = await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-testid^="metric-"]')].filter((el) => {
            const cell = el.closest('div')!.getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return box.right > cell.right + 1 || box.left < cell.left - 1
          }).length,
      )
      expect(clipped, `metric values clipped at ${viewport.name}`).toBe(0)
    }
    await expect(page.getByTestId('metric-health')).toHaveText('100')
    await page.setViewportSize({ width: 1440, height: 900 })

    // History lists the run with the same ending and score, and opens it again.
    const runId = new URL(page.url()).searchParams.get('id')
    expect(runId).toBeTruthy()
    await page.getByTestId('app-navigation').getByRole('link', { name: 'History', exact: true }).click()
    // Other specs use this account at the same time, so find this run by its id rather than by position.
    const newest = page.getByTestId('history-solo').getByTestId('simulation-list').locator(`li[data-run-id="${runId}"]`)
    await expect(newest).toHaveCount(1, WAIT)
    await expect(newest.getByTestId('run-result')).toContainText('Complete Recovery', WAIT)
    await expect(newest.getByTestId('run-result')).toContainText(`${score} / 100`)
    await newest.getByRole('button').click()
    await expect(page).toHaveURL(new RegExp(`/simulation\\?id=${runId}`))
    await expect(page.getByTestId('outcome')).toHaveText('Complete Recovery', WAIT)
    await expect(page.getByTestId('score')).toHaveText(String(score))

    // "New simulation" goes to the start screen; it does not start a clock by itself.
    await page.getByTestId('run-again').click()
    await expect(page.getByTestId('create-simulation')).toBeVisible(WAIT)
    await expect(page.getByTestId('simulation-view')).toHaveCount(0)
  })
})
