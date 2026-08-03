# Test Plan — Safeguard HR & Payroll System

**Status at time of writing:** no automated test suite existed anywhere in this repo before this audit (no Vitest/Jest/Playwright config, no `test`/`test:e2e` npm scripts). None was added in this pass either — see "Why no test suite was added" below before assuming this is an oversight.

## Why no test suite was added in this pass

Setting up Playwright and writing the 30 E2E scenarios requested in the original audit brief requires:
- A running instance of the app (local `vite preview` against a build works for this).
- **Real Supabase credentials for at least one account per role** (Admin/Manager/Supervisor/Staff) to test login, navigation, and permission boundaries — none were available in this environment, and fabricating fake ones would produce tests that either fail immediately (no real backend to hit) or, worse, silently pass without testing anything real.
- A database with representative seed data (employees, attendance, payroll records) — no staging Supabase project was available to seed.

Installing the Playwright *package* and writing tests that can't actually run against anything real would just be theater — tests that pass trivially or fail for environment reasons teach nothing and create false confidence. Instead, this plan documents exactly what's covered by the manual static review already done, what a real E2E suite needs once credentials/staging exist, and the commands to run it.

## What was actually verified in this pass, and how

| Area | Method | Result |
|---|---|---|
| Rules-of-Hooks correctness across every page | `npm run lint` (react-hooks/rules-of-hooks) after adding a working ESLint config | Found and fixed 1 additional live crash (Recruitment.tsx); 0 remaining matches repo-wide |
| Type correctness | `npx tsc --noEmit` | 218 pre-existing errors catalogued, none introduced by this pass's fixes |
| Build correctness | `npm run build` after every fix | Clean throughout |
| Payroll/Attendance/Recruitment modal logic | Manual code reading (calculation formulas, state transitions, dependency arrays) | See AUDIT_REPORT.md findings A5, A8, A12 |
| RLS policy coverage | Full read of all 7 migration files, cross-referenced against `rolePages` and each page's client-side permission checks | See SECURITY_REVIEW.md's authorization matrix |
| Dependency vulnerabilities | `npm audit` before/after | 13 → 12 (1 critical → 0) |
| Bundle composition | `npm run build` output, before/after `jszip` lazy-load fix | Payslips chunk: 38.5KB → 9.6KB gzip |

## Unit-test coverage needed (none exists yet)

Priority order, matching AUDIT_REPORT.md's severity ranking:

1. **Payroll calculation** (`calculatePayroll` in `Payroll.tsx`): gross pay, PAYE, pension, uniform deduction, attendance deduction, rounding, zero/negative/very-large salary inputs, month-boundary and leap-year date handling. This is pure-function-shaped (given an employee + attendance data, returns a payroll record) and is the highest-value candidate for unit tests once a test runner exists, since it needs no database or auth to test in isolation.
2. **Attendance deduction calculation** (`calculateEmployeeDeductions` in `Attendance.tsx`): lecture-missed counting, full-month vs. per-lecture deduction thresholds, Wednesday/Thursday-only lecture-day logic.
3. **Terminal dues calculation** (`TerminalDues.tsx`): the `monthsDiff` calculation fixed in this pass (prefer-const) is a good candidate to lock in with a regression test once a runner exists, along with gratuity/leave/uniform-refund math.
4. **CSV/report export escaping** (`Reports.tsx` and wherever CSV strings are built): commas, quotes, newlines, and formula-injection risk (a name starting with `=`, `+`, `-`, or `@`) in exported values — **not verified in this pass at all**; flagged as an unverified area needing a dedicated read of the CSV-building code before either a fix or a "this is already safe" conclusion can be stated.

Recommended runner once set up: **Vitest** (already Vite-native, zero extra bundler config, fast) over Jest, given this is a Vite project.

## Integration-test coverage needed

- `processPayroll`/`copyFromPreviousMonth` against a real (staging) Supabase instance: confirm the delete-then-insert sequence behaves correctly, and specifically **test what happens if the insert half is forced to fail after the delete half succeeds** (e.g. by temporarily breaking a constraint) — this directly tests the non-atomicity gap documented in AUDIT_REPORT.md A8 and DATA_INTEGRITY_REVIEW.md.
- The new `20260803000000`/`20260803000001` migrations, applied to a staging project, then exercised via `supabase-js` calls as each role to confirm the intended role_level restrictions actually take effect (this is the live-testing step this audit could not perform itself).

## End-to-end scenarios (Playwright), to build once credentials/staging exist

Scaffolding recommendation: `npm install -D @playwright/test`, `npx playwright install --with-deps chromium`, config pointed at `vite preview`'s local build output plus a staging Supabase project's URL/anon key via `.env.test` (never committed).

Test accounts needed (create these in a staging project, not production):
- One Admin, one Manager, one Supervisor, one Staff account, ideally two of each spread across two different regions, to test the region-isolation gap directly (Finding A12) once it's fixed.
- Fixture data: a small number of employees per region, one processed-but-not-approved payroll month, one approved payroll month, a few attendance records, a few applicants at different pipeline stages.

Scenarios, grouped by what they'd actually catch (all currently unimplemented — this is the target list from the original audit brief, kept here rather than discarded):

1. Login/logout, invalid login, session expiration — auth flow correctness.
2. Direct navigation to a protected route while logged out — redirect correctness.
3. Each role's navigation across every page it should/shouldn't see — cross-checks `rolePages` against actual reachability.
4. Cross-region access denial — **this will currently fail**, since region isolation is UI-only (A12); this test's purpose once written is specifically to prove that gap live, and later to confirm the fix.
5. Add/edit/soft-delete/restore employee; double-submission prevention on the add form.
6. Recruitment pipeline transitions (Pending → Shortlisted → Interviewed → Accepted/Rejected → Hired); confirm accepting twice doesn't create duplicate employees.
7. Attendance status cycling, rapid-click/duplicate-update handling (Attendance.tsx already has an `updating[key]` guard for this — confirm it holds under real network latency).
8. Payroll processing, reprocessing-while-approved denial (button disable already exists client-side — confirm it holds server-side once role_level checks are live), duplicate-processing prevention (now backed by the new unique constraint once applied).
9. Payslip download (single + bulk ZIP), confirm the lazy-loaded `jszip` path still produces a correct archive.
10. Payment/terminal-dues status transitions, confirm the existing `UNIQUE(employee_id, month)` constraint on `payment_status` actually prevents the double-click race described in AUDIT_REPORT.md's investigation (expected: second click errors cleanly rather than creating a duplicate row — worth confirming the UI surfaces that error usefully rather than a raw constraint-violation message).
11. CSV export correctness against known fixture data, specifically injection-risk characters.
12. Browser refresh on every route (confirms the app doesn't lose critical state / crash on direct load — related to the two `loading`-state hook bugs found this session, since both were specifically about the very first render after a fresh load).
13. Mobile viewport navigation and layout.

## Test data and cleanup

- All fixture data must live in a staging Supabase project, never production. Given `tenant_id` scoping exists, a dedicated test tenant is the cleanest isolation if the staging project is shared.
- Cleanup: since `employees` soft-deletes and `payroll`/`attendance` cascade-delete from `employees`, a full teardown between test runs means either (a) hard-deleting the test tenant's rows directly via a service-role connection (safe in staging, never production), or (b) resetting the staging database from a known snapshot before each run. Prefer (b) for determinism.

## Commands to run tests (once set up)

```bash
# Unit/integration (once Vitest is added)
npm run test          # to be added: "vitest run"
npm run test:watch    # to be added: "vitest"

# E2E (once Playwright is added)
npm run test:e2e      # to be added: "playwright test"
npx playwright show-report

# Always, before/after any of the above
npm run lint
npm run type-check
npm run build
```

## Uncovered areas (explicit, not hidden)

- Everything in this document marked "needed"/"to build" is, honestly, **not done** — this plan is the roadmap, not a completed suite. The one thing this audit pass could and did verify without a test runner was static correctness (types, lint, build, RLS-policy reading) and manual code review of the highest-stakes business logic (payroll, attendance, recruitment).
- CSV/export injection safety: unverified, not even statically reviewed in this pass — highest-priority next static read, doesn't need staging access.
- Accessibility (keyboard nav, screen reader, focus trapping): not tested at all — see PERFORMANCE_REPORT.md for why (needs a live browser + axe-core, not attempted with confidence via grep alone).
