import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

/**
 * Runs the same specs against the DEPLOYED app instead of the local worker.
 *
 * No web server is started and nothing here deploys: it only points the
 * browser at the live URL. Test accounts sign in on that origin exactly as
 * they do locally. Always pass the spec files to run; some suites are meant
 * for the local worker only and must not be aimed at production:
 *   - hardening.spec "abuse limits" (creates rooms until the limit refuses);
 *   - hardening.spec "room lifecycle" and "server restart" (need the
 *     development-only clock shift or a server the test can stop).
 *
 *   npx playwright test ui.spec --config tests/prod.playwright.config.ts
 */
const BASE_URL = process.env.BLACKOUT_PROD_URL ?? 'https://blackout.app.space'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 45_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    launchOptions: chromiumLaunchOptions(),
  },
})
