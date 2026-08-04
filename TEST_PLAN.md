# Test Plan — Safeguard HR & Payroll System

**Last updated:** 2026-08-04 (third pass). Read `AUDIT_REPORT.md`'s "Corrections from the first pass" section first. This document now describes a **real, running test setup** — not a plan for one. Every number below comes from actually executing the relevant command in this environment.

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
Exit code **0**. `Test Files 7 passed (7)`, `Tests 80 passed (80)`. This script did not exist before this audit (`npm error: Missing script: "test"`, exit code 1) — that is a failure, not something to silently classify as N/A, per your explicit instruction. (Was 39 tests across 2 files in the second pass; this third pass added 5 more utility files and 41 more tests — see below.)

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

**`src/utils/employeeNumberGeneration.test.ts` — 9 tests, all passing.** Extracted from `Employees.tsx`'s `generateEmployeeNumber`: region-letter derivation (including the fallback for an unrecognized/missing region), prefix construction, and the increment step — including the 999→1000 rollover, which does **not** re-pad back to 3 digits (documents existing behavior, not a designed spec).

**`src/utils/guardIdGeneration.test.ts` — 3 tests, all passing.** Consolidates 5 previously-separate inline `` `G-${Math.floor(...)}` `` expressions in `Security.tsx` (two of which used different, inconsistent random ranges) into one function. Tests confirm the `G-####` format and the 1000–9999 range, and — deliberately, by mocking `Math.random` — prove there is **no** de-duplication state across calls. This is not a regression introduced by the extraction; it documents a pre-existing gap (Finding A-guard-id in `AUDIT_REPORT.md`): with no DB-level uniqueness constraint or check, a birthday-paradox collision becomes roughly a coin flip at ~112 guards. Not fixed this pass — fixing it (e.g., a `UNIQUE` constraint plus retry-on-conflict, or switching to a sequence) is a schema change and was out of scope for a pure-function extraction.

**`src/utils/terminalDuesCalculations.test.ts` — 11 tests, all passing.** Extracted from `TerminalDues.tsx`'s `calculateTerminalDues`: whole-calendar-month period calculation (`calculateMonthsDiff`, confirmed to use year/month arithmetic only, not exact days), gratuity at 10% of basic salary per month worked, annual leave as a flat one month's basic salary, the `basicSalary` default of 150,000 when unset, and the subtotal/deductions/total-payable composition — including a test that a total payable can legitimately go negative if deductions exceed the subtotal (not clamped, matching existing behavior).

**`src/utils/payrollPermissions.test.ts` — 15 tests, all passing.** Extracted from `Payroll.tsx`'s `fetchUserProfile` role-boolean assignment and its `isMonthApproved`/`isPendingApproval` logic: `canProcessPayroll`/`canApprovePayroll` (Admin or super admin only), `canEditPayroll` (Admin or Manager), `canViewPayroll` (Admin, Manager, or Supervisor), each checked against all 4 role levels plus a super-admin override. Separately covers payroll-approval immutability: an empty run is neither approved nor pending; a fully-approved run is approved; a partially-approved or fully-rejected run is pending, never "mostly approved."

**`src/utils/attendanceDeductions.test.ts` — 10 tests, all passing.** Extracted from `Attendance.tsx`'s `calculateEmployeeDeductions`: absent/late day counting and their respective deduction rates, the lecture-deduction threshold logic (per-lecture-day charge when some but not all lecture days in the month are missed, vs. a flat full-month rate when every lecture day is missed), the flat appearance deduction, and the total-deductions summation. Includes a no-Wednesday/Thursday-in-range edge case to confirm no division-by-zero when a month selection has no lecture days at all.

All five extractions were verified with the same rigor as the payroll/CSV extractions in the second pass: `npx tsc --noEmit` after each showed the exact same 211-error baseline (0 new errors — confirmed by diffing normalized error sets against the pre-extraction baseline, not just comparing counts), `npx eslint` reported 0 new errors on every touched file, and `npm run build` stayed clean. One real type error surfaced during this: extracting `isMonthApproved`/`isPendingApproval` required loosening `PayrollApprovalRecord.approval_status` from required to optional to match `Payroll.tsx`'s own `PayrollRecord` type, and left `Payroll.tsx`'s local `isMonthApproved` variable genuinely dead (its only prior use was as an internal dependency of the old inline `isPendingApproval` computation, which now lives entirely inside the pure function) — removed rather than left as an unused variable.

**Still not covered by an automated test, and explicitly called out rather than silently dropped:**
- **Duplicate payroll prevention** — depends on the new `UNIQUE(employee_id, month)` constraint in `20260803000001_payroll_unique_constraint.sql`, which is written but **not applied to any database** (see `DATA_INTEGRITY_REVIEW.md`). A real test needs a database to violate the constraint against; a pure-function test can't exercise a DB constraint.
- **Recruitment status transitions** — investigated, not tested. There is no transition-validation logic anywhere in the codebase to extract: `Recruitment.tsx` writes a plain string value with only a database-level `CHECK` constraint restricting it to a fixed set of allowed values (no rule preventing, e.g., `rejected` → `hired`, or any other specific sequence). Writing a unit test here would mean inventing a business rule that doesn't exist in the app today, which is exactly what the standing instruction not to redesign business rules without a confirmed source rules out. If a transition policy is wanted, that's a product decision to make first, then implement, then test — not something to test into existence.
- **Double-submission prevention** — `Attendance.tsx` and other pages guard against it in the UI with an `updating[key]`-style in-flight flag, but the actual prevention that matters (concurrent identical writes) is a database/RPC-layer concern. The payroll case specifically is covered by the atomic RPC's `pg_advisory_xact_lock` (see `DATA_INTEGRITY_REVIEW.md`), which is written but not yet applied to any database, so there's nothing running to test against yet.

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
10–13. Employee add/edit/double-submit/delete-restore — partially ✅ (employee-number generation logic specifically — 9 unit tests); the add/edit/delete-restore UI flows themselves, and double-submission prevention, are not tested
14. Recruitment status workflow — ❌ (investigated, not tested — see "still not covered" above: there is no transition-validation logic in the app to test; testing it would mean inventing a rule that doesn't exist)
15–16. Attendance status changes, failed-update rollback — partially ✅ (the deduction *math* that attendance status feeds into — 10 unit tests); the status-change UI flow and rollback-on-failed-update itself are not tested
17–20. Payroll processing/duplicate-prevention/approval/unauthorized-approval — 🔒 for the RLS layer; role-gating and approval-immutability logic ✅ (15 unit tests, `payrollPermissions.test.ts`); the atomicity fix itself (A8) has its own staging test procedure written directly in `20260803000002_payroll_atomic_process_rpc.sql`; duplicate-prevention still needs a database to test against (see above)
21. Payslip download — ❌ (and see A17 — the underlying feature has a real gap to fix first)
22–23. Payment/terminal-dues workflows — 🔒 for the RLS layer (payment_status covered in the RLS matrix); terminal-dues calculation math ✅ (11 unit tests, `terminalDuesCalculations.test.ts`)
24. Security-personnel creation — partially ✅ (guard-ID generation logic specifically — 3 unit tests, including proof there's no collision protection); the creation UI flow itself is not tested
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
