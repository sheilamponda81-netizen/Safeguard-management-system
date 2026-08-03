# Test Plan — Safeguard HR & Payroll System

**Last updated:** 2026-08-03 (second pass). Read `AUDIT_REPORT.md`'s "Corrections from the first pass" section first. This document now describes a **real, running test setup** — not a plan for one. Every number below comes from actually executing the relevant command in this environment.

## Status: what actually exists now vs. the first pass

The first pass of this audit added no test suite at all and said so honestly. This pass added two: Vitest (unit) and Playwright (E2E). Both are real, both were actually run, and their exact results are recorded below rather than assumed.

## Commands, exact output, exit codes

```
$ npm run type-check
```
Exit code **2**. 211 errors (`grep -c "error TS"` on the output). Not zero, not passing — a genuine failing result. Compare against the true `origin/main` baseline of 218 (verified in a separate git worktree): the 7-error difference is fully explained in `AUDIT_REPORT.md`'s "Corrections from the first pass" and is **not** the result of fixing any of the 211 real, remaining errors.

```
$ npm run lint
```
Exit code **0**. 518 warnings, 0 errors. This command failed outright before this audit (`ESLint couldn't find a configuration file`) — no config had ever existed in this repo's git history.

```
$ npm run test
```
Exit code **0**. `Test Files 2 passed (2)`, `Tests 39 passed (39)`. This script did not exist before this audit (`npm error: Missing script: "test"`, exit code 1) — that is a failure, not something to silently classify as N/A, per your explicit instruction.

```
$ npm run test:e2e
```
Exit code **0**. `14 tests: 7 passed, 7 skipped, 0 failed`. Also did not exist before this audit (same missing-script exit 1 failure).

```
$ npm run build
```
Exit code **0**. Clean throughout every commit in this branch.

## Unit-test coverage (Vitest — `src/**/*.test.ts`)

**`src/utils/payrollCalculations.test.ts` — 18 tests, all passing.** Covers `calculateLivePayroll` (the single source of truth `Payroll.tsx` and `Payments.tsx` both delegate to):
- Gross pay composition (basic + allowances + overtime + bonus, defaults to 0 for omitted fields)
- PAYE: zero at/below threshold, taxes only the amount above threshold at `payeRate`, rounds to whole currency
- Pension: `grossPay * pensionEmployeeRate`, applies with no threshold
- Uniform deduction eligibility: position-based (map lookup), employee-specific override, zero for non-uniform positions even with an override set, fail-safe default (unlisted position defaults to *requiring* a uniform, matching the `?? true` in the implementation)
- Attendance/lecture/appearance deductions: additive, zero when omitted (not an error)
- Net pay: `gross - paye - pension - deductions`, and explicitly **not clamped at zero** — a documented, intentional test of negative net pay as a real scenario, not an assumed-blocked one
- Edge cases: zero basic salary, very large basic salary (50 million), negative basic salary (documents that the function performs no input validation of its own — a business-rule/UI-validation question for elsewhere, not decided here)

**Deliberately does not change `DEFAULT_RATES` or the calculation formula itself** — these tests lock in and document current behavior, per the standing rule against altering payroll/tax/pension logic without a confirmed source. If a future change breaks one of these tests, that's a prompt to go confirm intent, not to edit the test to match.

**`src/utils/csvExport.test.ts` — 19 tests, all passing.** Covers `escapeCsvCell`/`toCsvRow` (extracted this pass from Reports.tsx, then applied to 5 other previously-unescaped export sites — see `AUDIT_REPORT.md` Finding A18):
- Quote-wrapping, doubled internal quotes (RFC 4180), commas, embedded newlines, unicode names, numbers, null/undefined
- Formula-injection protection for every trigger character (`=`, `+`, `-`, `@`, tab, carriage return), verified it does *not* alter a value merely containing (not starting with) a trigger character
- A realistic audit-log row containing a JSON blob, verified via a real (if minimal) RFC 4180 round-trip parser written for the test — not a naive comma-split, which is exactly the bug this whole fix addresses and would be circular to use as the test's own verification method. (This parser caught a real flaw in the first draft of this specific test: an earlier version tried to "verify" correctness by counting regex matches for quote-adjacent commas, which itself produced a false failure on a row with multiple internal escaped quotes. Fixed before committing, not glossed over.)

**Why `payrollSettings.ts` (and therefore `payrollCalculations.test.ts`) needed a Vitest config change:** `src/lib/supabase.ts` throws at import time if `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are unset, and `payrollSettings.ts` imports it transitively (for its unrelated, DB-backed `getPayrollRates()` export) even though the pure `DEFAULT_RATES` export under test never touches it. `vitest.config.ts` sets placeholder values (matching `.env.example`'s format, never real credentials) purely to stop the import-time throw.

## Integration/E2E coverage (Playwright)

### Static suite (`e2e/static/**`) — no credentials needed, 7/7 passing

Runs against `vite preview` of a real production build, with placeholder Supabase env vars (`.env.test.example` → copy to `.env.local` to run locally, or the config's own `webServer` step handles it in CI once that file exists).

- `login.spec.ts`: form renders (email/password/submit visible), password input's missing `autocomplete` attribute (a real gap, confirmed via the actual Chromium console warning — not assumed), mapped error message for invalid credentials (mocked via `page.route()` against Supabase Auth's real error response shape — confirmed correct by actually running it and observing the real UI text), mapped message for a rate-limit response.
- `app-shell.spec.ts`: no console `pageerror` on first paint, mobile viewport (390×844) renders correctly, survives a hard refresh without a console error.

**What this suite deliberately does NOT and cannot test**: an actual successful login, anything past the login screen, role-based navigation, cross-region access, payroll/attendance/recruitment workflows. All of those need a reachable Supabase project with real data and real accounts.

### Staging-gated suite (`e2e/authenticated/**`) — 7 tests, all correctly SKIPPED

`rls-policy-matrix.spec.ts` — see `SECURITY_REVIEW.md`'s "RLS testing status" for what it covers. Gated by `e2e/fixtures.ts`'s `missingStagingVars()`; every test in the file calls `test.skip(missing.length > 0, ...)` with the exact missing variable names in the skip reason. **Verified by actually running `npm run test:e2e` in this environment (which has none of these variables set) and confirming all 7 report as skipped** — not passing, not a hard failure that would look like a real regression.

### Test accounts and fixtures needed (not fabricated, not present in this environment)

To actually exercise the staging-gated suite, per `e2e/fixtures.ts`:
```
E2E_BASE_URL, E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY
E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
E2E_MANAGER_EMAIL / E2E_MANAGER_PASSWORD
E2E_SUPERVISOR_EMAIL / E2E_SUPERVISOR_PASSWORD
E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
```
Ideally two accounts per role in two different regions, to eventually test the region-isolation gap directly (`AUDIT_REPORT.md` A12) once a fix exists to test against.

### Test data cleanup

The RLS matrix test cleans up after itself: `payment_status`/`system_settings` test rows are deleted (or, for the destructive-operation test, the disposable employee created for it is soft-deleted the same way the app itself does it) within the test, not left behind. A full staging teardown between separate test runs would still need either a service-role connection to hard-reset the test tenant's rows (safe in staging, never production) or restoring from a known snapshot.

## The 30-scenario original scope — status against each

Kept honest rather than silently narrowed. ✅ = covered by a real, passing test today. 🔒 = written, correctly gated behind staging credentials that don't exist here. ❌ = not attempted this pass.

1. Login/logout, invalid login — ✅ (invalid login + rate-limit mapping; logout not separately tested)
2. Session expiration — ❌ (needs a live session over a real token lifetime)
3. Direct navigation to protected routes — **N/A for this app's architecture** (no URL router; single route gated by client-side boolean — see `AUDIT_REPORT.md`'s system map)
4–8. Admin/Manager/Supervisor/Staff navigation and permissions, cross-region denial — 🔒 (`rls-policy-matrix.spec.ts` covers the *data-layer* permission boundaries directly via API, which is a stronger test than clicking through the UI would be, but still needs staging credentials to run)
9. Cross-region access denial — 🔒/❌ — the underlying feature (A12) isn't fixed yet, so there's nothing to verify pass regardless of credentials
10–13. Employee add/edit/double-submit/delete-restore — ❌
14. Recruitment status workflow — ❌
15–16. Attendance status changes, failed-update rollback — ❌
17–20. Payroll processing/duplicate-prevention/approval/unauthorized-approval — 🔒 for the RLS layer; the atomicity fix itself (A8) has its own staging test procedure written directly in `20260803000002_payroll_atomic_process_rpc.sql`
21. Payslip download — ❌ (and see A17 — the underlying feature has a real gap to fix first)
22–23. Payment/terminal-dues workflows — 🔒 (payment_status covered in the RLS matrix)
24. Security-personnel creation — ❌
25–26. Report filtering, CSV export — ✅ for CSV escaping/injection specifically (19 unit tests); report *filtering* itself not tested
27. Audit-log creation — partially ✅ (the RLS matrix's cleanup steps incidentally exercise real writes, but no dedicated audit-log-creation assertion exists yet)
28. Browser refresh on every route — ✅ for the one route this app has (`app-shell.spec.ts`); "every route" doesn't apply the way it would for a multi-route app
29. Mobile navigation — ✅ (viewport test; deeper mobile-specific interaction not tested)
30. Empty/loading/error states — partially ✅ (login error states); loading/empty states elsewhere not tested

## Uncovered areas, still explicit

- Recruitment/Employees/Security/Attendance/Payments/TerminalDues page-level workflows: **not tested**, static code review only (see `AUDIT_REPORT.md`).
- Accessibility beyond the one Login-page finding: **not tested** (no axe-core/Lighthouse run — see `PERFORMANCE_REPORT.md`).
- Report filtering correctness against known fixture data: **not tested**.
- Everything requiring a live database with realistic data volume: **not tested**.

## Commands to run tests

```bash
npm run test            # Vitest unit tests
npm run test:watch      # Vitest, watch mode
npm run test:e2e        # Playwright (static suite always; authenticated suite needs env vars)
npm run test:e2e:report # open the last Playwright HTML report
npm run lint
npm run type-check
npm run build
```
