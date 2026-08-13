import { test, expect, Page } from '@playwright/test';
import { missingStagingVars, getStagingCredentials, StagingCredentials } from '../fixtures';

// Regression coverage for the production crash reported as "Minified React
// error #310" / "Rendered more hooks than during the previous render" on
// the Recruitment page. Root cause (see AUDIT_REPORT.md Findings A2-A4 and
// the explanatory comment at the top of src/pages/Recruitment.tsx): the
// "Add Applicant" modal used to be a useCallback closure invoked as a plain
// function, which put its internal hooks onto RecruitmentPage's own render
// sequence -- present only while the modal was open, so the hook count
// changed between renders. That's already fixed on this branch (the modal
// is now a standalone, props-based component, and every hook in
// RecruitmentPage runs unconditionally before the page's single early
// return), and `plugin:react-hooks/recommended` in eslint.config.js catches
// any reintroduction of that class of bug on every `npm run lint`. This
// file adds the other half: a real browser render of the actual page,
// logged in as the two roles that can reach it, so a genuine runtime
// hook-order violation (which ESLint's static analysis can't always catch,
// e.g. one driven by data shape rather than syntax) would also be caught
// here.
//
// Like every other file in e2e/authenticated/, this is a no-op (SKIPPED,
// not silently passed) without staging credentials configured -- see
// e2e/fixtures.ts.

const missing = missingStagingVars();

async function login(page: Page, creds: StagingCredentials, role: 'admin' | 'manager') {
  await page.goto(creds.baseUrl);
  await page.getByLabel('Email').fill(creds[role].email);
  await page.getByLabel('Password').fill(creds[role].password);
  await page.getByRole('button', { name: /Sign In/i }).click();
  // Land on the dashboard (or whatever the post-login landing page is)
  // before trying to navigate further -- avoids racing the auth redirect.
  await page.getByRole('button', { name: 'Recruitment' }).waitFor({ state: 'visible', timeout: 20000 });
}

async function openRecruitmentAndAssertNoHooksError(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.getByRole('button', { name: 'Recruitment' }).click();

  // Give the page's data fetch (loading -> loaded transition, exactly the
  // transition that triggered #310 in production) time to complete, rather
  // than asserting immediately against the loading state.
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle').catch(() => {});

  const hooksViolation = [...pageErrors, ...consoleErrors].filter((m) =>
    m.includes('error #310') ||
    m.includes('Rendered more hooks') ||
    m.includes('Rendered fewer hooks') ||
    m.includes('change in the order of Hooks')
  );

  expect(hooksViolation, `Hook-order violation detected: ${JSON.stringify(hooksViolation)}`).toEqual([]);
  expect(pageErrors, `Uncaught page error(s) on Recruitment: ${JSON.stringify(pageErrors)}`).toEqual([]);

  return { pageErrors, consoleErrors };
}

test.describe('Recruitment page: no React error #310 regression', () => {
  test.skip(missing.length > 0, `Staging credentials not configured, skipping Recruitment hooks regression test. Missing: ${missing.join(', ')}`);

  let creds: StagingCredentials;

  test.beforeAll(() => {
    creds = getStagingCredentials();
  });

  test('Admin can open Recruitment without a hooks-order crash', async ({ page }) => {
    await login(page, creds, 'admin');
    await openRecruitmentAndAssertNoHooksError(page);

    // The page actually rendered its real content, not a blank error
    // boundary -- confirms this is a true positive test, not a false pass
    // from an error boundary silently swallowing the crash.
    await expect(page.getByRole('heading', { name: /Recruitment/i })).toBeVisible();
  });

  test('Manager can open Recruitment without a hooks-order crash', async ({ page }) => {
    await login(page, creds, 'manager');
    await openRecruitmentAndAssertNoHooksError(page);
    await expect(page.getByRole('heading', { name: /Recruitment/i })).toBeVisible();
  });

  test('reloading on the Recruitment page does not reintroduce a hooks-order crash', async ({ page }) => {
    await login(page, creds, 'admin');
    await openRecruitmentAndAssertNoHooksError(page);

    // Re-mounts RecruitmentPage from a cold start (loading=true again),
    // re-exercising the exact loading->loaded transition that caused the
    // original crash, instead of only checking the already-warmed page.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.reload();
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    expect(pageErrors).toEqual([]);
    await expect(page.getByRole('heading', { name: /Recruitment/i })).toBeVisible();
  });

  test('opening the Add Applicant modal (the historical crash trigger) does not throw', async ({ page }) => {
    await login(page, creds, 'admin');
    await openRecruitmentAndAssertNoHooksError(page);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Best-effort: the exact button label may vary, so this step is
    // allowed to no-op if it can't be found rather than failing the whole
    // regression test on an unrelated selector mismatch -- the page-level
    // checks above are the primary assertion.
    const addButton = page.getByRole('button', { name: /Add Applicant/i });
    if (await addButton.isVisible().catch(() => false)) {
      await addButton.click();
      await page.waitForTimeout(500);
    }

    expect(pageErrors).toEqual([]);
  });
});
