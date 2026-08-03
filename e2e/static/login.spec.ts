import { test, expect } from '@playwright/test';

// These tests run against a production build served locally (see
// playwright.config.ts's webServer) with placeholder Supabase
// credentials (.env.test / .env.local -- never real ones), and mock the
// Supabase Auth network call directly rather than needing a reachable
// Supabase project. This is deliberately scoped to what's verifiable
// without any staging credentials: form structure, client-side error
// display, and (for the "invalid credentials" case) the app's own error-
// message mapping logic in Login.tsx. It does NOT and cannot verify a
// real successful login, real role/region-based navigation, or anything
// past the login screen -- see e2e/authenticated/ and TEST_PLAN.md for
// what's blocked on staging credentials.

test.describe('Login page', () => {
  test('renders the login form with email, password, and submit', async ({ page }) => {
    await page.goto('/');

    // Note: Login.tsx's <label> elements for Email/Password have no
    // `htmlFor`/`id` association and don't wrap their <input>s (verified
    // by reading the source), so they are NOT reachable via
    // getByLabel() -- a real accessibility gap, not a test-authoring
    // shortcut. Using getByPlaceholder as the only available text-based
    // selector until that's fixed; flagged in AUDIT_REPORT.md.
    await expect(page.getByPlaceholder('admin@safeguard.mw')).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('the password input has no autocomplete attribute (accessibility/UX gap, documented not fixed)', async ({ page }) => {
    // Chromium itself flags this in the console
    // ("Input elements should have autocomplete attributes (suggested:
    // \"current-password\")") -- confirmed by actually loading the page
    // and reading the real console output, not assumed from the source.
    await page.goto('/');
    const autocomplete = await page.getByPlaceholder('••••••••').getAttribute('autocomplete');
    expect(autocomplete).toBeNull();
  });

  test('shows the mapped error message for invalid credentials', async ({ page }) => {
    // Mocks Supabase Auth's real error shape for invalid credentials
    // (confirmed against Login.tsx's own signInError.message.includes(
    // 'Invalid login credentials') check) so this exercises the app's
    // actual error-mapping logic without needing a reachable Supabase
    // project or real account.
    await page.route('**/auth/v1/token**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        }),
      })
    );

    await page.goto('/');
    await page.getByPlaceholder('admin@safeguard.mw').fill('someone@example.com');
    await page.getByPlaceholder('••••••••').fill('wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText('Invalid email or password. Please try again.')).toBeVisible();
  });

  test('shows a rate-limit-specific message when Supabase returns a rate-limit error', async ({ page }) => {
    await page.route('**/auth/v1/token**', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ msg: 'rate limit exceeded' }),
      })
    );

    await page.goto('/');
    await page.getByPlaceholder('admin@safeguard.mw').fill('someone@example.com');
    await page.getByPlaceholder('••••••••').fill('anything');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText('Too many attempts. Please try again later.')).toBeVisible();
  });
});
