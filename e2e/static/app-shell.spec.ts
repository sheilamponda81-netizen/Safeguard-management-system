import { test, expect } from '@playwright/test';

// Covers what's testable about page-load robustness without auth: this
// app crashed in production twice this same day from React error #310
// (Rendered more hooks than during the previous render) triggered
// specifically by the very first render after `loading` flips from true
// to false -- see AUDIT_REPORT.md Findings A2-A4. A real regression test
// for that needs an authenticated session (the bug was on the Attendance/
// Recruitment pages, both behind login), so it belongs in
// e2e/authenticated/ once staging credentials exist -- this file only
// covers the unauthenticated shell load, which is what's actually
// reachable here.

test('loads the app shell without a console error on first paint', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await page.waitForLoadState('networkidle').catch(() => {
    // The placeholder Supabase URL isn't reachable, so some background
    // fetches never resolve -- that's expected here and unrelated to
    // what this test checks (uncaught render-time exceptions).
  });

  expect(pageErrors).toEqual([]);
});

test('renders correctly at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 12-ish
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('survives a hard refresh without crashing', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await page.reload();
  await page.waitForTimeout(500);

  expect(pageErrors).toEqual([]);
  await expect(page.getByLabel('Email')).toBeVisible();
});
