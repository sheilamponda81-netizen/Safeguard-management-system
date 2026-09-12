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
  test('renders the login form, reachable via accessible label', async ({ page }) => {
    await page.goto('/');

    // Login.tsx's Email/Password <label>s previously had no
    // htmlFor/id association (a real accessibility gap found via a real
    // Lighthouse run against this same local build -- Lighthouse
    // accessibility score 70/100, "Buttons do not have an accessible
    // name" among the flagged audits). Fixed alongside this test: labels
    // now use htmlFor/id, so getByLabel() is the real, working selector
    // rather than a placeholder-based workaround.
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('the password input has an autocomplete attribute', async ({ page }) => {
    // Was previously missing (Chromium's own console flagged it); fixed
    // alongside this test, not left as a documented-but-unfixed gap.
    await page.goto('/');
    const autocomplete = await page.getByLabel('Password', { exact: true }).getAttribute('autocomplete');
    expect(autocomplete).toBe('current-password');
  });

  test('the password visibility toggle has an accessible name', async ({ page }) => {
    // The specific button Lighthouse's "button-name" audit flagged
    // (an icon-only toggle with no text or aria-label). Fixed alongside
    // this test.
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeVisible();
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
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
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
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Password', { exact: true }).fill('anything');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText('Too many attempts. Please try again later.')).toBeVisible();
  });
});
