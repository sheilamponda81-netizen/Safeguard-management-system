import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'fs';

// Two kinds of E2E test live in e2e/:
//   - e2e/static/**    -- run against `vite preview` of a real production
//     build, need NO Supabase credentials, and run in CI/this environment
//     today (login page renders, validation, unauthenticated route
//     redirects, mobile viewport, etc.)
//   - e2e/authenticated/** -- need real Supabase staging credentials for
//     each of the 4 roles (see TEST_PLAN.md's "Test accounts needed").
//     These are written but gated behind env vars (see e2e/fixtures.ts)
//     and will report as skipped, not passing, when those aren't set --
//     never silently green without actually running.
// This environment pre-installs Chromium at a fixed path rather than
// letting Playwright download/manage its own -- see the repo's own
// environment notes. Without this override, Playwright's default browser
// resolution for device-emulation projects (e.g. "mobile-chrome" below)
// can look for a *different* pinned build (a "headless_shell" variant)
// than the one actually installed here, and fail outright -- a real
// failure this config previously had, caught only by actually running
// `npm run test:e2e` (which exercises every project) rather than just
// `--project=chromium` in isolation. Applied at the top level so every
// project inherits it, instead of duplicating it per-project.
const chromiumLaunchOptions = existsSync('/opt/pw-browsers/chromium')
  ? { executablePath: '/opt/pw-browsers/chromium' }
  : {};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: chromiumLaunchOptions,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
    },
  ],
  // `vite preview` serves the production build already produced by
  // `npm run build` -- this starts it automatically for local/CI runs
  // against e2e/static/**. Authenticated tests point E2E_BASE_URL at a
  // real staging deployment instead (see e2e/fixtures.ts).
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
