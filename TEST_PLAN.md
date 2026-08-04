# Test Plan — Safeguard HR & Payroll System

**Last updated:** 2026-08-04 (fifth pass — jsPDF upgraded to a patched version with a new real test file, all 16 `react-hooks/exhaustive-deps` warnings fixed as genuine bugs, ESLint warnings classified/partially fixed). Read `AUDIT_REPORT.md`'s "Corrections from the first pass" section first. This document describes a **real, running test setup** — not a plan for one. Every number below comes from actually executing the relevant command in this environment.

## Status: what actually exists now vs. the first pass

The first pass of this audit added no test suite at all and said so honestly. The second pass added two: Vitest (unit) and Playwright (E2E). This (fourth) pass reached **0 TypeScript errors for the first time** (was 211 at the start of this pass), added two new server-side generation migrations with their own unit and integration tests, wired the previously-unwired atomic payroll RPC into the frontend, and added a second staging-gated integration test file. Every number below is real, not assumed.

## Commands, exact output, exit codes

```
$ npm run type-check
```
Exit code **0**. **Zero errors** — down from 211 at the start of this pass (218 on `origin/main`). Every one of the 211 was fixed as a genuine correction (unused imports/dead state removed, real prop/type mismatches fixed, real config bugs fixed — see "TypeScript error resolution" below) — none were hidden via `any`, `@ts-ignore`/`@ts-nocheck`, tsconfig source exclusions, or type-widening. This is a hard requirement verified by re-running the command, not inferred from the diff.

```
$ npm run lint
```
Exit code **0**. **339 warnings, 0 errors** (was 386 at the start of this pass, 518 at the start of the third). This pass fixed all 16 `react-hooks/exhaustive-deps` (each a real bug — see `AUDIT_REPORT.md`'s "ESLint warning remediation"), all 7 `no-unused-vars`, both `react-refresh/only-export-components`, and 22 of 361 `no-explicit-any`. The remaining 339 are every one `no-explicit-any`, classified by file/risk in `AUDIT_REPORT.md` — not silenced, not globally disabled.

```
$ npm run test
```
Exit code **0**. `Test Files 9 passed (9)`, `Tests 105 passed (105)` (was 97/8 files at the start of this pass; new this pass — `pdfGeneration.test.ts`, 8 tests exercising real, non-mocked jsPDF calls against both API-usage patterns this app has, post-upgrade to `^4.2.1` — see `AUDIT_REPORT.md` Finding A16).

```
$ npm run test:e2e
```
Exit code **0**. `66 tests: 16 passed, 50 skipped, 0 failed` (Playwright's own "Running 66 tests" line, re-verified fresh this pass). Previously documented as 54 -- that figure had gone stale/incorrect since no `e2e/` file was touched in the intervening passes; corrected here rather than carried forward unchecked.

```
$ npm run build
```
Exit code **0**. Clean throughout every commit in this branch.

## TypeScript error resolution (211 → 0)

Every fix in this pass was verified to be a genuine correction, not a suppression — see the git history on this branch for the full, itemized reasoning per file. The three that mattered most, because they were real behavior bugs, not just type-checker noise:

1. **`Badge`/`Button`/`TD` in `src/components/ui.tsx` were silently dropping real props.** `Badge` never declared or forwarded `className`, so all 36 call sites passing one had it silently ignored; `Badge`'s color union was also missing `orange`/`purple`/`teal`/`emerald`/`cyan` (used across `TerminalDues.tsx`/`AuditLogs.tsx`) and several pages passed a nonexistent `amber` (always meant `yellow`) — both cases meant those badges were rendering **unstyled** in production. `Button` never declared `size` (4 call sites got a full-size button instead of the intended `sm`) or accepted the native click event (blocking `e.stopPropagation()` call sites from type-checking). `TD` never forwarded `colSpan` (2 empty-state table rows weren't actually spanning the full table width). All four are real, fixed bugs, not type-widening.
2. **A real ReferenceError bug in dead code, found and deleted.** `src/utils/clickHandlers.ts`'s `handleHireEmployee` referenced a nonexistent `applicants` variable (only `applicant`, singular, was ever a parameter) — confirmed via `grep` to have **zero call sites anywhere in the app**, so this bug was never actually triggered, but it would have thrown outright the moment anything called it. Deleted rather than "fixed" a function nobody uses.
3. **A `vite.config.ts` fix that turned out to be a real regression, caught by actually running the E2E suite (not just `tsc`/`build`).** `build.treeshake` was invalid (`BuildOptions` doesn't have that key — it belongs under `build.rollupOptions.treeshake`); moving it to the "correct" location made Rollup **actually apply** `moduleSideEffects: false` for the first time, which tree-shook every single manual vendor chunk down to empty and broke the entire app (login page rendered nothing). The original config bug was harmless precisely because it was inert; the "correct" fix was not. Reverted to simply deleting the dead key instead of relocating it — this is the one instance in this pass where "fix the type error" and "don't change behavior" pointed in different directions, and behavior preservation won. This is exactly why every fix in this document was re-verified against the full command set, including Playwright, not just `tsc`/`lint`/`build`.

Everything else was unused imports, unused/dead local state (confirmed via `grep` to have zero reads before removal), a couple of real `null` vs `undefined` type corrections matching actual nullable DB columns, and DOM API type-narrowing casts (`performance.getEntriesByType(...)`, which the DOM lib types generically) — see the branch's commit history for the file-by-file detail.

## Unit-test coverage (Vitest — `src/**/*.test.ts`)

**`src/utils/payrollCalculations.test.ts` — 18 tests.** Covers `calculateLivePayroll` (gross/PAYE/pension/uniform/attendance math, net-pay composition, edge cases). Unchanged this pass — see prior passes' notes for full detail; not re-derived here since the formula itself was not touched.

**`src/utils/csvExport.test.ts` — 19 tests.** Covers `escapeCsvCell`/`toCsvRow` (RFC 4180 quoting, formula-injection protection). Unchanged this pass.

**`src/utils/terminalDuesCalculations.test.ts` — 11 tests.** Covers gratuity/annual-leave/period-months/subtotal math. Unchanged this pass.

**`src/utils/payrollPermissions.test.ts` — 15 tests.** Covers the 4 role-gate functions and payroll-approval immutability. Unchanged this pass.

**`src/utils/attendanceDeductions.test.ts` — 10 tests.** Covers absent/late/lecture-threshold/appearance deduction math. Unchanged this pass.

**`src/utils/employeeNumberGeneration.test.ts` — now 13 tests (was 9).** The original 9 (region-letter derivation, prefix construction, the 999→1000 non-repadding rollover) are unchanged. **4 new tests** cover `generateEmployeeNumberServerSide()`, added this pass to call `generate_employee_number(region_id)` (see `supabase/migrations/20260804000001_employee_number_generation.sql`) instead of solely querying the browser for the highest existing number: RPC-success passthrough, fallback to the original browser-side calculation when the RPC errors (with and without existing employees for that prefix), fallback on a thrown/network exception, and that two concurrent calls each get whatever distinct value the (mocked) RPC returns rather than being memoized or coalesced.

**`src/utils/guardIdGeneration.test.ts` — now 8 tests (was 3).** The original 3 (format, 1000-9999 range, no dedup state proven by mocking `Math.random`) are unchanged and still document the pre-existing collision risk this pass's migration fixes. **5 new tests** cover `generateGuardIdServerSide()`, added this pass to call `generate_guard_id()` (see `supabase/migrations/20260804000000_guard_id_generation.sql`, a real Postgres `SEQUENCE` — inherently concurrency-safe): RPC-success passthrough, fallback to the client-side generator on an RPC error/thrown exception/missing data, and that two concurrent calls each get whatever distinct value the (mocked) RPC returns.

**`src/utils/payrollProcessing.test.ts` — 7 tests, new this pass.** Covers `processPayrollBatch()`, the wrapper around `process_payroll_batch()` now wired into `Payroll.tsx` (see below): the empty-input guard (never calls the RPC for zero records), the exact RPC argument shape (month, records, caller email resolved via `supabase.auth.getUser()`, audit context), a structured success result with delete/insert counts, a validation error raised inside the RPC (e.g. "already approved") surfaced as `{success: false, error}` rather than a thrown exception, a network-level throw handled the same way, a malformed/missing RPC response treated as failure rather than assumed success, and the null-email fallback when `auth.getUser()` can't resolve one.

**Still not covered by a Vitest unit test, and explicitly called out rather than silently dropped:**
- **Recruitment status transitions** — there is still no transition-validation logic anywhere in the app to unit-test (see `AUDIT_REPORT.md` Finding A19's decision table). This pass instead added a live integration test (`rpc-workflow-matrix.spec.ts`) that documents the current, unrestricted behavior concretely — see below.
- **Duplicate payroll/employee-number/guard-ID prevention, payroll reprocessing/approval-immutability/partial-failure-rollback** — all of these are database-constraint or RPC-transaction behaviors that a pure-function unit test structurally cannot exercise (there's no database to violate a constraint against in Vitest's node environment). All are covered instead by the new staging-gated integration test file below.
- **Double-submission prevention** — the payroll case is covered by `process_payroll_batch()`'s `pg_advisory_xact_lock`, itself only testable against a real database (also in the integration suite below, implicitly — this isn't its own dedicated concurrency test yet; see "Uncovered areas" at the end of this document).

## Utility-to-page wiring reconciliation

For every pure utility extracted from a page component in this and the prior pass, this section confirms — by reading the actual call site, not just trusting the extraction — that the page passes the correct shape of input and stores/uses the output correctly. This is code-inspection verification, not a new automated test category; it's listed here explicitly because "does the page actually call this correctly" is a different question from "is the pure function itself correct," and the second doesn't answer the first.

| Utility | Call site | Verified |
|---|---|---|
| `employeeNumberGeneration.generateEmployeeNumberServerSide` | `Employees.tsx:471` (`getNextEmployeeNumberForRegion`, the collision-retry helper) and `:1546` (`generateEmployeeNumber`, the region-select preview) | Both pass `(regionId, region)` where `region` is the actual `regions.find(...)` result (or `{}` fallback if not found, matching `RegionForNumbering`'s all-optional shape) — matches the function's signature exactly. Both `await` the result before using it. |
| `guardIdGeneration.generateGuardIdServerSide` | `Security.tsx:292`, `:357` (the two actual persistence call sites — existing-employee update and new-employee insert) and `:1063` (`AddGuardForm`'s mount-time ID-reservation effect) | All three `await` the async result. The two display-only fallback reads (`:324`, `:383`, reading `guardId` back off an already-successful insert/update response) deliberately still use the synchronous `generateGuardId()` — correct, since those are defensive UI-only paths after the real write already happened, not the persistence decision itself. |
| `terminalDuesCalculations.calculateTerminalDues` (as `calculateTerminalDuesPure`) | `TerminalDues.tsx:306` | Passes `hireDate`/`dateLeft`/`basicSalary`/`uniformRefund`/`otherBenefits`/`deductions` reading from `selectedEmployee`/`formData` — field names match the function's `TerminalDuesInputs` interface exactly. |
| `payrollPermissions` (4 role-gate functions + `isPendingApproval`) | `Payroll.tsx:186-189` (role booleans, inside `fetchUserProfile`) and `:123` (`isPendingApproval` `useMemo`) | Role functions all receive the same `roleContext = { isSuperAdmin, roleLevel }` object built from the just-fetched profile. `isPendingApproval` receives `payrollRecords` (the real fetched array) — matches `PayrollApprovalRecord[]`'s shape (`approval_status?: string`). |
| `attendanceDeductions.calculateAttendanceDeductions` | `Attendance.tsx:860` (`calculateEmployeeDeductions`) | Passes `employeeAttendance` (from `attendanceByEmployee.get(employeeId)`, real per-employee records), `datesArr` (`getDatesForMonth(selectedMonth)`), and `deductionRates` (the page's configured rates state) — matches the function's 3-parameter signature. |
| `payrollCalculations.calculateLivePayroll` | `Payroll.tsx:381`, `Payments.tsx:211` | Both pages build the same input shape from their own employee/attendance/rates state; `Payments.tsx`'s own comment explicitly notes it exists specifically so this page "never shows" a figure computed by a different formula than `Payroll.tsx` uses — i.e. this reconciliation was already a stated design goal of the extraction, not newly checked here. |
| `csvExport.toCsvRow`/`escapeCsvCell` | 6 files: `Reports.tsx`, `Employees.tsx`, `Payments.tsx`, `Security.tsx`, `src/pages/AuditLogs.tsx`, `src/components/AuditLogs.tsx` | All 6 call `toCsvRow(row)` per row before joining with `\n` — confirmed via `grep` that no call site reverted to a bare `row.join(',')` anywhere (which is the exact bug this extraction fixed at 5 of the 6 sites). |
| `payrollProcessing.processPayrollBatch` | `Payroll.tsx`'s `processPayroll()` and `copyFromPreviousMonth()` | Both build a `records` array matching `PayrollRecordInput`'s shape (the same fields `calculatePayroll`/`calculateLivePayroll` already produce) and pass an `auditContext` object with the same total/source-month fields the old separate `logAudit()` calls used to pass directly. |

All of the above is additionally corroborated by this pass reaching **0 TypeScript errors** — a genuine shape mismatch at most of these call sites (wrong parameter count, wrong field names, wrong async handling) would have been a compile error, not just a logic bug, given how these utilities are typed. TypeScript correctness is not a substitute for a behavioral test, but it is real evidence, not nothing.

**Not done, and why:** full component-level tests (rendering `Payroll.tsx`/`Employees.tsx`/etc. in a DOM and asserting on rendered output) were not added. These page components are large (1,000–2,900 lines), each with many Supabase calls, and this repository has no jsdom/React Testing Library setup at all (Vitest currently runs in `environment: 'node'` — see `vitest.config.ts`). Standing one up correctly for components this size, without introducing brittle tests that mock half the file, is a bigger undertaking than this pass's scope; the reconciliation table above is the honest, achievable substitute — verifying the actual wiring by reading it, rather than claiming component-test coverage that doesn't exist.

## Integration/E2E coverage (Playwright)

### Static suite (`e2e/static/**`) — no credentials needed, 8/8 passing

Runs against `vite preview` of a real production build, with placeholder Supabase env vars (`.env.test.example` → copy to `.env.local` to run locally; this pass's environment needed exactly this step done fresh, since it's gitignored and a new container never has it). Unchanged this pass: `login.spec.ts` (5 tests) + `app-shell.spec.ts` (3 tests).

**What this suite deliberately does NOT and cannot test**: an actual successful login, anything past the login screen, role-based navigation, cross-region access, payroll/attendance/recruitment workflows. All of those need a reachable Supabase project with real data and real accounts.

### Staging-gated suite (`e2e/authenticated/**`) — 46 tests (23 scenarios × 2 browser projects), all correctly SKIPPED

- **`rls-policy-matrix.spec.ts`** (7 scenarios) — see `SECURITY_REVIEW.md`'s "RLS testing status." Unchanged this pass.
- **`rpc-workflow-matrix.spec.ts`** (12 scenarios, new this pass) — real integration coverage for:
  - `generate_employee_number()`/`generate_guard_id()`: correct format, monotonic increment across consecutive calls, and that a real duplicate `employee_number`/`guardId` is rejected by their respective `UNIQUE` constraints (Postgres error `23505`).
  - `process_payroll_batch()`: a successful batch (with `insertedCount` returned), idempotent reprocessing (old rows actually deleted, new ones inserted, no duplicates left behind), that an already-approved month is refused **and confirmed unchanged via a re-read** (not just checking for a returned error — the same discipline the RLS matrix already applied to UPDATE denials), that a single bad row in an otherwise-valid batch aborts the entire batch with zero partial inserts, and that a Staff account is rejected outright by the function's own internal role check.
  - `terminal_dues` insert/select round-trip.
  - `payment_status` pending → paid transition.
  - Recruitment status: a dedicated test that a `Pending` applicant can currently be moved straight to `Accepted`/`Hire` with **zero** intermediate steps — framed explicitly as documenting Finding A19's gap, not endorsing it, so this exact assertion is the one to flip (expect a rejection instead) once a transition policy is approved and enforced.

Both files gated identically by `e2e/fixtures.ts`'s `missingStagingVars()`; every test calls `test.skip(missing.length > 0, ...)` with the exact missing variable names in the skip reason. **Verified by actually running `npm run test:e2e` in this environment (which has none of these variables set) and confirming all 23 scenarios (46 across both browser projects) report as skipped** — not passing, not a hard failure that would look like a real regression.

### Test accounts and fixtures needed (not fabricated, not present in this environment)

Unchanged from prior passes — see `e2e/fixtures.ts`:
```
E2E_BASE_URL, E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY
E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
E2E_MANAGER_EMAIL / E2E_MANAGER_PASSWORD
E2E_SUPERVISOR_EMAIL / E2E_SUPERVISOR_PASSWORD
E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
```
Ideally two accounts per role in two different regions, to eventually test the region-isolation gap directly (`AUDIT_REPORT.md` A12) once a fix exists to test against.

**Additionally required to activate `rpc-workflow-matrix.spec.ts` specifically**: the target staging project must have `20260804000000_guard_id_generation.sql` and `20260804000001_employee_number_generation.sql` applied (for the generation tests) and `20260803000002_payroll_atomic_process_rpc.sql` applied (for the payroll-atomicity tests) — none of these are applied anywhere yet (see `DATA_INTEGRITY_REVIEW.md`'s migration execution status). Running this file against a staging project that only has the base schema will fail the generation/payroll tests with "function does not exist" rather than skip them — that's a real, informative failure (wrong migration state), not a bug in the test.

### Test data cleanup

Both staging-gated files clean up after themselves: disposable employees/applicants/payroll/terminal-dues rows created for a test are deleted (or soft-deleted, matching the app's own deletion path) within an `afterAll`/inline cleanup step, not left behind. A full staging teardown between separate test runs would still need either a service-role connection to hard-reset the test tenant's rows (safe in staging, never production) or restoring from a known snapshot.

## The 30-scenario original scope — status against each

Kept honest rather than silently narrowed. ✅ = covered by a real, passing test today. 🔒 = written, correctly gated behind staging credentials that don't exist here. ❌ = not attempted this pass.

1. Login/logout, invalid login — ✅ (invalid login + rate-limit mapping; logout not separately tested)
2. Session expiration — ❌ (needs a live session over a real token lifetime)
3. Direct navigation to protected routes — **N/A for this app's architecture** (no URL router; single route gated by client-side boolean — see `AUDIT_REPORT.md`'s system map)
4–8. Admin/Manager/Supervisor/Staff navigation and permissions, cross-region denial — 🔒 (`rls-policy-matrix.spec.ts` covers the *data-layer* permission boundaries directly via API, which is a stronger test than clicking through the UI would be, but still needs staging credentials to run)
9. Cross-region access denial — 🔒/❌ — the underlying feature (A12) isn't fixed yet, so there's nothing to verify pass regardless of credentials
10–13. Employee add/edit/double-submit/delete-restore — partially ✅ (employee-number generation logic — 13 unit tests — plus 🔒 live duplicate-prevention/generation tests in `rpc-workflow-matrix.spec.ts`); the add/edit/delete-restore UI flows themselves, and double-submission prevention specifically, are not tested
14. Recruitment status workflow — 🔒/documented (no transition-validation logic exists to unit-test — see A19's decision table; `rpc-workflow-matrix.spec.ts` has a staging-gated test documenting the current unrestricted behavior concretely)
15–16. Attendance status changes, failed-update rollback — partially ✅ (the deduction *math* that attendance status feeds into — 10 unit tests); the status-change UI flow and rollback-on-failed-update itself are not tested
17–20. Payroll processing/duplicate-prevention/approval/unauthorized-approval — ✅/🔒: role-gating and approval-immutability logic ✅ (15 unit tests) and the RPC wrapper ✅ (7 unit tests); the atomic RPC itself now has a full 🔒 staging integration suite (`rpc-workflow-matrix.spec.ts` — success, idempotent reprocessing, approved-month protection with a re-read confirmation, partial-failure rollback, and unauthorized-role rejection)
21. Payslip download — ❌ (and see A17 — the underlying feature has a real gap to fix first)
22–23. Payment/terminal-dues workflows — ✅/🔒: terminal-dues calculation math ✅ (11 unit tests); payment_status transition and terminal_dues persistence now both have 🔒 staging tests too
24. Security-personnel creation — partially ✅ (guard-ID generation logic — 8 unit tests, including the fallback path — plus 🔒 live generation/duplicate-prevention tests); the creation UI flow itself is not tested
25–26. Report filtering, CSV export — ✅ for CSV escaping/injection specifically (19 unit tests); report *filtering* itself not tested
27. Audit-log creation — partially ✅ (the RLS matrix's cleanup steps incidentally exercise real writes; `process_payroll_batch()`'s own audit-log write is exercised indirectly by the 🔒 payroll integration tests since it happens in the same transaction, but there's no dedicated assertion reading the resulting `audit_logs` row back yet)
28. Browser refresh on every route — ✅ for the one route this app has (`app-shell.spec.ts`); "every route" doesn't apply the way it would for a multi-route app
29. Mobile navigation — ✅ (viewport test; deeper mobile-specific interaction not tested)
30. Empty/loading/error states — partially ✅ (login error states); loading/empty states elsewhere not tested

## Uncovered areas, still explicit

- Recruitment/Employees/Security/Attendance/Payments/TerminalDues page-level UI workflows (clicking through the actual rendered form, not the underlying data operation): **not tested** — no component-test harness exists (see "Utility-to-page wiring reconciliation" above for why, and what was done instead).
- Accessibility beyond the one Login-page finding: **not tested** (no axe-core/Lighthouse run — see `PERFORMANCE_REPORT.md`).
- Report filtering correctness against known fixture data: **not tested**.
- A dedicated concurrency test for `process_payroll_batch()`'s `pg_advisory_xact_lock` (two genuinely simultaneous callers, not just two sequential calls) — the migration's own staging test procedure documents how to run this manually (two sessions/tabs); it is not automated in Playwright, since reliably forcing two HTTP requests to arrive at the database at the exact same instant from a single test runner is nontrivial and was judged lower value than the tests that are automated.
- Everything requiring a live database with realistic data volume: **not tested**.

## Test-environment isolation (verified explicitly this pass)

- **Which Supabase project did the E2E tests use?** None, actually — every staging-gated test (`rls-policy-matrix.spec.ts`, `rpc-workflow-matrix.spec.ts`) is skipped in this environment before `createClient()` is ever called (`missingStagingVars()` short-circuits in `test.skip(...)`, checked before `beforeAll` runs), so **no real Supabase project was ever contacted by the authenticated suites in this session**. The static suite (`e2e/static/**`) runs against `vite preview` of a local production build using `.env.local`'s placeholder values (`https://test-placeholder.supabase.co`) and mocks every Supabase Auth response via Playwright's `page.route()` — confirmed by reading `login.spec.ts` itself — so it never makes a real network call to any Supabase project either.
- **Did any test perform writes?** No. Nothing in this session's actual test runs wrote to any real database — see above. If/when the staging-gated suites are activated with real credentials, both files clean up every row they create (disposable employees/applicants/payroll/terminal-dues rows, all named with an `E2E-`/`SFG-E2E-*` prefix) within an `afterAll` or inline cleanup step.
- **Does Vercel preview point to staging or production Supabase?** **Not verified — flagged, not guessed at.** This session has no access to the Vercel project's configured environment variables (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` as set in the Vercel dashboard for the `safeguard-management-system` project), only to this repository's own `.env.example`/`.env.test.example` (placeholders) and this session's own `.env.local` (also placeholders, created fresh this pass — see below). **If the Vercel preview deployment's Supabase env vars actually point at the production project** (a common but risky default for small projects that never provisioned a separate staging Supabase instance), **no mutation/write test should ever be pointed at that preview URL** — confirm this directly in the Vercel dashboard before ever setting `E2E_BASE_URL` to a preview URL for the authenticated suite.
- **Does `.env.local` in this environment contain only non-production credentials?** Yes, confirmed by reading it directly: `VITE_SUPABASE_URL=https://test-placeholder.supabase.co`, `VITE_SUPABASE_ANON_KEY=test-placeholder-anon-key` — copied verbatim from the committed `.env.test.example` template, created fresh in this session's container (a new container never has this gitignored file until created). No real credential of any kind is present.
- **Is a service-role key ever exposed to Vite or the browser?** No — confirmed by `grep -rn "SERVICE_ROLE\|service_role" src/ vite.config.ts`, which returns zero matches. The only Supabase credentials referenced anywhere in `src/` are `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (`src/lib/supabase.ts`), both of which are the anon key — designed to be public/client-exposed by Supabase's own security model (RLS is the actual boundary, not secrecy of this key). The service-role key is used only server-side, in the two Deno Edge Functions (`supabase/functions/backup`, `supabase/functions/rollback`), read via `Deno.env`, never bundled into any Vite/browser output.
- **Is test data identifiable and safely removable?** Yes — every disposable record either staging-gated suite creates uses a distinctive, greppable prefix (`E2E-`, `SFG-E2E-*`, `E2E Test Employee`/`E2E Test Applicant`/etc. in name fields), making a full manual sweep trivial (`DELETE FROM employees WHERE employee_number LIKE 'SFG-E2E-%' OR full_name LIKE 'E2E %';` and equivalent for `applicants`) even if an automated cleanup step were ever skipped (e.g. a test crashing mid-run before its own `afterAll` fires).

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
