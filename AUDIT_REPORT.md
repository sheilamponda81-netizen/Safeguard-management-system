# Safeguard HR & Payroll System — Production Readiness Audit

**Branch:** `audit/full-system-hardening`
**Last updated:** 2026-08-04 (third pass — added Finding A19 and refreshed test-suite numbers; see "Corrections from the first pass" below for the second pass's corrections)
**Scope:** Full repository (frontend + Supabase schema/migrations/edge functions). Production URL `https://safeguard-management-system.vercel.app/` referenced for context but not directly tested.

## Corrections from the first pass

The first version of this report contained real errors, found and fixed only because they were challenged rather than taken on faith. Documented here explicitly rather than quietly edited away:

1. **TypeScript error count.** First pass claimed "218 errors at baseline... unchanged by this audit's fixes." Re-verified by actually checking out `origin/main` into a separate worktree and running `npx tsc --noEmit` there: the true baseline is **218**, and the current branch has **211** — a real reduction of 7, fully reconciled by diffing the two error lists file-by-file: 5 errors disappeared because `src/tests/auth.test.ts` (the file holding the hardcoded credential) was deleted, and 2 disappeared because `src/utils/rateLimiter.ts`'s unused `useState` import and unused `remainingTime` variable were removed as part of an ESLint cleanup commit. **Zero of the 218 real, pre-existing type errors were fixed.** The claim of "unchanged" was wrong; "reduced only as an accidental side effect of unrelated fixes, not touched otherwise" is the accurate statement.
2. **Critical vulnerability count.** First pass claimed removing `xlsx` brought `npm audit`'s critical count from 1 to 0. Re-verified with `npm audit --json` (reliable) rather than the text-output `grep` the first pass used (unreliable — it silently matched nothing and was read as "zero criticals" without double-checking against the JSON summary). The actual truth, checked at three points in this branch's history:
   - `origin/main` baseline: 13 vulnerabilities = **1 critical (`jspdf`/`dompurify`)**, 10 high (including `xlsx` as **high**, not critical), 2 moderate.
   - Immediately after removing `xlsx`: 12 vulnerabilities = **1 critical, still `jspdf`**, 9 high, 2 moderate.
   - `xlsx` was never the critical vulnerability. Removing it was still worthwhile (it was dead code with real high-severity issues and no fix available), but **the actual critical vulnerability (`jspdf`/`dompurify`) was never fixed and remains critical right now.** A fix exists (`jspdf` 4.2.1) but is a major-version breaking change; this environment has no way to visually verify payslip PDF generation still works after such an upgrade, so it was not attempted blind. See Finding A16 below.

Both corrections are now reflected everywhere in this document and the other 4. Every verification claim below was re-run and its exact exit code recorded — see "Commands executed" — rather than restated from memory.

## Access limitations

- No Supabase service-role key, dashboard access, or staging database. Docker is present but its daemon is not reachable, so no local Supabase instance could be started either.
- No test credentials for any of the four roles, and no ability to log into the live production app.
- Outbound network to the production Vercel domain is blocked by this environment's proxy.

Consequences: every RLS/migration finding is a static reading of the SQL cross-referenced against the frontend, none of it executed against a real Postgres instance. All new migrations are marked "written, not run." A real, running E2E suite now exists (see `TEST_PLAN.md`), but its staging-credential-gated tests report as explicitly **skipped**, verified by actually running them and confirming that outcome — not silently passing.

## System map

Unchanged from the first pass — see the "Pages / routes," "Database tables," "Edge functions," and "Storage buckets" material below.

**Stack:** React 18 + TypeScript + Vite SPA (no router library — hand-rolled `nav` state in `App.tsx`, meaning "direct navigation to a protected route" as a URL-based concept does not apply to this app's architecture; the entire app is one route gated by a client-side `loggedIn` boolean), Supabase (Postgres + Auth + Storage + 2 Deno Edge Functions), deployed to Vercel with `main` as the production branch.

**Roles** (`profiles.role_level`): 1 = Admin, 2 = Manager, 3 = Supervisor, 4 = Staff, plus an orthogonal `is_super_admin` boolean.

**Regions:** South, Central, North, East — `regions` lookup table, referenced by `employees.region_id` and `profiles.region_id` (both nullable).

**Pages / routes** (`src/App.tsx`'s `pageComponents`, `rolePages` for access):

| Page | Roles allowed | Backing table(s) |
|---|---|---|
| dashboard | 1,2,3,4 | aggregates |
| employees | 1,2 | `employees` |
| recruitment | 1,2 | `applicants` |
| attendance | 1,2,3 | `attendance`, `employee_deductions` |
| payroll | 1 | `payroll` |
| payslips | 1,4 | `payroll`, `employees` — **see Finding A17: no per-employee scoping exists for role 4** |
| payments | 1,2 | `payment_status` |
| terminal-dues | 1,2 | `terminal_dues` |
| reports | 1,2 | cross-table, CSV export |
| settings | 1 | `system_settings`, `regions`, `companies`, `positions` |
| security | 1,2,3 | `employees` (guard/shift/uniform columns) |
| features | 1 | static |
| auditlogs | 1 | `audit_logs` |
| user-manual | 1,2,3,4 | static |

**Database tables:** `tenants`, `regions`, `companies`, `positions`, `profiles`, `employees`, `payroll`, `attendance`, `applicants`, `payment_status`, `employee_deductions`, `terminal_dues`, `user_roles`, `system_settings`, `audit_logs`, `backup_logs` (an 8th, `backup_data`, is referenced by the backup edge function but does not exist in any migration).

**Edge functions:** `supabase/functions/backup`, `supabase/functions/rollback` — see Finding A6.

**Storage buckets:** `company-logo` (public read, unrestricted authenticated write — Finding A7).

## Commands executed (exact, re-run fresh, exit codes recorded)

| Command | Exit code | Result |
|---|---|---|
| `npm ci` | 0 | Succeeds |
| `npm run type-check` | **2** | **211 errors.** (Baseline on `origin/main`, checked in a separate worktree: 218. See "Corrections from the first pass.") This is a genuine failing result — not classified as passing, not glossed over. |
| `npm run lint` | 0 | 518 warnings, 0 errors. ESLint's own convention is exit 0 with only warnings; the 518 warnings themselves are **not** fixed and remain outstanding (`@typescript-eslint/no-explicit-any`, `react-hooks/exhaustive-deps`). Before this audit, this command **could not run at all** — no config file had ever existed. |
| `npm run test` | 0 | **80 tests, 80 passed, 7 test files.** This command did not exist before this audit (`npm error: Missing script "test"`, exit 1). Second pass added Vitest with tests for `calculateLivePayroll` and `csvExport` (39 tests, 2 files); this third pass added 5 more extracted utilities (`employeeNumberGeneration`, `guardIdGeneration`, `terminalDuesCalculations`, `payrollPermissions`, `attendanceDeductions` — see `TEST_PLAN.md`), bringing the total to 80. Actually executed, not assumed. |
| `npm run test:e2e` | 0 | **14 tests: 7 passed, 7 skipped, 0 failed.** Did not exist before this audit (same "Missing script" exit 1 failure). Playwright was added. The 7 passing are a static suite needing no credentials; the 7 skipped are an RLS-policy staging matrix that correctly reports as skipped (not passing) without staging credentials — verified by actually running it in this credential-less environment. |
| `npm run build` | 0 | Succeeds, clean, throughout every commit in this branch |
| `npm audit` | n/a | 12 vulnerabilities: **1 critical (`jspdf`), 9 high, 2 moderate.** (Was 13: 1 critical, 10 high, 2 moderate — the 1 high removed was `xlsx`.) **The critical vulnerability is not fixed** — see Finding A16. |

## Findings, by severity

### P0 — Security / data-integrity

**A1. Hardcoded admin credential committed to git history.** `src/tests/auth.test.ts` (git history since `58c4a9a`). Deleted from the current branch; **git history not rewritten** (no answer received on how to handle this). **Still needs your action: rotate the password in Supabase Auth.**

**A2–A4. Three live "React error #310" production crashes**, same root cause (a modal defined via `useCallback`, invoked as a plain function, putting its hooks on the parent's render sequence): two in `Attendance.tsx` (already fixed in production before this audit branch existed), one **found by this audit** in `Recruitment.tsx` via a newly-added ESLint config's `react-hooks/rules-of-hooks` rule — this one crashed on every single visit to the Recruitment page, independent of ever opening a modal. Both remaining instances converted to genuine standalone, props-based components. Verified: zero `rules-of-hooks` matches anywhere in the codebase after the fix.

**A5. Systemic gap: `role_level` was enforced server-side on only 2 of ~13 tables.** `supabase/migrations/20260803000000_role_level_rls_hardening.sql` extends this to `payment_status`, `terminal_dues`, `system_settings`, `employee_deductions`, `applicants`, and tightens `payroll`/`employees` DELETE to super-admin-only. **A detailed executable staging test matrix now exists**: `e2e/authenticated/rls-policy-matrix.spec.ts`, using real `supabase-js` calls (the same code path the app itself uses) logged in as each of the 4 roles — not a hand-simulated SQL/JWT harness, which risks silently not matching this project's actual Supabase/PostgREST version. It reports every test as skipped (verified) until staging credentials exist. **NOT executed against any database.**

**A6. "Automated daily backups with point-in-time recovery" is false.** No scheduler, no frontend wiring, `restoreBackup` is a no-op, target `backup_data` table doesn't exist. **Fixed the documentation**: removed this claim (and the 2FA claim) from the User Manual rather than leave a false promise live. The underlying non-functional backup code itself is unchanged (a design decision — build vs. remove — still needs your input).

**A16 (new, corrected severity). `jspdf` carries a critical, currently-unfixed vulnerability chain (via `dompurify`)** — confirmed via `npm audit --json`, at every point in this branch's history, including right now. A fix exists (`jspdf` 4.2.1) but is a major-version breaking change from the currently-pinned `^2.5.2`; `jspdf-autotable` and the app's own PDF-generation code (`Payslips.tsx`, `clickHandlers.ts`) would need re-verification against the new major version, which requires actually generating and visually inspecting a payslip PDF — not possible in this environment (no auth, no way to click through the live app). **Not fixed. This needs someone who can run the app, generate a payslip, and confirm the PDF still renders correctly after the upgrade — do not force-upgrade this blind.**

**A17 (new). There is no schema link between a `profiles` row and an `employees` row.** Discovered while writing the region-isolation candidate rules (`SECURITY_REVIEW.md`'s new section). The Payslips page's `rolePages` grants Staff (role_level 4) access specifically for **self-service** payslip viewing, but `Payslips.tsx`'s data-fetching (`fetchPayslipData`) has **zero per-employee scoping** — it fetches every active, non-deleted employee in the user's region (same region-wide filter as every other role), with no email-matching, no `employee_id` link, nothing. **A Staff account can currently view and download every other employee's payslip PDF in their region, not just their own.** This is more severe than the general region-isolation gap (A12) because it isn't just "no DB-level enforcement of an existing app-level scoping rule" — the app-level scoping rule for individual employee self-service **does not exist at all**, at any layer. See `SECURITY_REVIEW.md` for the schema change this requires (a `profiles.employee_id` link, at minimum) before any fix — client-side or RLS — can be written.

### P1 — Major workflow / integrity risks

**A8. `payroll` had no `UNIQUE(employee_id, month)` constraint** (unlike `attendance`/`payment_status`, which both already have the equivalent). Fixed via `20260803000001_payroll_unique_constraint.sql`. Additionally, **`processPayroll()`/`copyFromPreviousMonth()`'s underlying delete-then-insert was not atomic** — if the insert half failed after the delete half succeeded, that month's payroll was left fully deleted with nothing re-inserted. Addressed with a new, fully-designed atomic RPC: `supabase/migrations/20260803000002_payroll_atomic_process_rpc.sql`'s `process_payroll_batch()` function. It:
- Resolves the caller's tenant/role itself (required — `SECURITY DEFINER` bypasses RLS, so it cannot rely on the table's own policies).
- Takes an advisory transaction lock keyed by tenant+month, serializing concurrent processing attempts.
- Validates every targeted employee belongs to the caller's tenant, and **refuses outright if any targeted employee already has an approved payroll row for that month** — reprocessing can never silently revert an approval to pending.
- Only after validation: deletes, then inserts via a single `INSERT...SELECT` (atomic by construction — no partial-insert state is possible), then writes the audit log entry in the *same* transaction as the data change it describes.
- Any exception at any step rolls back everything, including the delete.

Deliberately does **not** recompute payroll figures itself — that logic stays in TypeScript, unchanged, per the standing rule against altering payroll/tax/pension math without a confirmed source. **Deliberately not wired up to `Payroll.tsx` yet** — see the migration's own header comment for the exact rollout order and why (wiring the frontend to an RPC that doesn't yet exist in production would break payroll processing outright). The migration file itself contains a full staging test procedure (8 scenarios) and rollback SQL. **NOT executed against any database.**

**A9. `npm run lint` never worked.** Fixed (see above). This alone is why A2–A4 went undetected until now.

**A18 (new). CSV export had zero escaping on 5 of 6 export sites.** Found while investigating "CSV escaping and formula-injection protection" for `TEST_PLAN.md` (previously flagged as unverified rather than actually checked). `Employees.tsx`, `Payments.tsx`, `Security.tsx`, and both `AuditLogs.tsx` copies did a bare `row.join(',')` with no quoting at all — any field containing a comma silently corrupted the export's column alignment, and the AuditLogs exports were guaranteed to hit this in practice (every row includes a `JSON.stringify(...)` cell). `Reports.tsx` was the one partial exception (quote/escape already present) but had no formula-injection protection (a cell starting with `=`/`+`/`-`/`@` executing as a formula when opened in Excel/Sheets). Fixed: extracted correct behavior into `src/utils/csvExport.ts` (`escapeCsvCell`/`toCsvRow`, 19 passing tests), pointed all 6 sites at it, added formula-injection protection across the board.

**A11. 211 pre-existing TypeScript errors remain, unfixed** (was 218; see "Corrections from the first pass" for exactly why the count moved and why that's not the same as "fixed"). Concentrated in `Payslips.tsx`, `Payroll.tsx`, `Security.tsx`, `Sidebar.tsx`, `App.tsx`, `UserManual.tsx`.

### P2 — Functional defects with a workaround / lower-severity gaps

**A12. Regional data isolation is UI-only.** No RLS policy anywhere references `region_id`. **Deliberately not fixed** — `profiles.region_id` is nullable and a NULL appears to mean "all regions" client-side, a business rule this audit should not guess at. **See `SECURITY_REVIEW.md`'s new "Candidate region/access-control model" section for the exact candidate rules (Super Admin/Admin/Manager/Supervisor/Staff) and precisely which schema changes each one needs — documented, not implemented, per your explicit instruction.**

**A7. `company-logo` storage bucket** allows any authenticated user unrestricted INSERT/UPDATE/DELETE. Not fixed (lower priority — a logo image, not sensitive data).

**A14. `withRateLimit` in `rateLimiter.ts` is dead code** (never imported anywhere). Its useless try/catch and 2 unused variables were cleaned up; the function itself remains, flagged not deleted.

**A15. `dev` script's unnecessary `--force`** — removed, verified (dev server starts in ~270ms and serves correctly without it).

**A19 (new). Recruitment applicant status has no transition validation at any layer.** `Recruitment.tsx` writes `applicants.status` as a plain string field; the only constraint anywhere is a database-level `CHECK` restricting it to a fixed set of allowed values — there is no rule, client-side or server-side, preventing an invalid *sequence* (e.g. `rejected` → `hired`, or skipping an intermediate stage the workflow is meant to require). **Deliberately not fixed and not given a test**: writing either would mean inventing a transition policy this audit has no source for, which the standing instruction against changing/inventing business rules without a confirmed requirement rules out. If a specific transition policy is wanted (e.g. a fixed pipeline order, or certain roles being barred from certain transitions), that's a product decision to make first — then it can be implemented and tested for real, rather than tested into existence here.

## What was inspected

Everything from the first pass, plus: a byte-for-byte reconciliation of the TypeScript error count against a clean `origin/main` worktree; `npm audit --json` output at three points in this branch's history; `Payslips.tsx`'s complete data-fetching path (for the new profile↔employee link finding); all 6 CSV export call sites; `Login.tsx`'s complete markup and actual rendered DOM (via a real, running local build — see `TEST_PLAN.md`).

## What requires business confirmation (not guessed at)

1. **Region-access semantics** (A12) — see `SECURITY_REVIEW.md`'s candidate rules; specifically, does a NULL `profiles.region_id` mean "all regions" for every role, or only some?
2. **Whether Staff-level payslip self-service should exist at all**, and if so, the `profiles`↔`employees` linking approach (A17) — a schema decision with real implications for how Staff accounts get provisioned.
3. **`employees` table column-level access** (A5's deferred item) — which columns Supervisors may write via the Security page vs. Admin/Manager-only.
4. **Backup & Recovery, `jspdf` upgrade** (A6, A16) — build a real backup system or leave the claim removed; schedule dedicated, visually-verified testing time for the `jspdf` major-version upgrade rather than a blind bump.
5. **Credential rotation and git-history handling** (A1) — still outstanding.

## Production deployment and rollback order

None of this branch's migrations or code changes should reach production in one step. Recommended order:

1. Merge this branch's **code-only** changes (bug fixes, CSV escaping, dependency removal, test suites, doc updates) to `main` and deploy normally — none of these depend on the unexecuted migrations and are independently safe (all verified via lint/typecheck/build in this session).
2. Apply `20260803000000_role_level_rls_hardening.sql` to a **staging** Supabase project. Run `e2e/authenticated/rls-policy-matrix.spec.ts` against it with real 4-role test credentials (see `TEST_PLAN.md`). Confirm no legitimate workflow is newly blocked.
3. Apply `20260803000001_payroll_unique_constraint.sql` to staging. **Check for existing duplicate `(employee_id, month)` rows in `payroll` first** — the migration will fail safely (not corrupt anything) if any exist; resolving those is a manual, business-judgment task.
4. Apply both to production once staging is clean, during a low-traffic window, with a rollback plan ready (`DROP POLICY`/recreate the prior policy text for #1; `DROP CONSTRAINT payroll_employee_month_unique` for #2 — both are trivial to revert, see `DATA_INTEGRITY_REVIEW.md`).
5. Apply `20260803000002_payroll_atomic_process_rpc.sql` to staging, run its own 8-scenario test procedure (in the migration file itself). Once verified, apply to production. **Only then**, as a separate, deliberately later change, update `Payroll.tsx` to actually call `process_payroll_batch()` instead of its current two-step delete+insert.
6. Do not attempt the `jspdf` major-version upgrade (A16) as part of this rollout — it needs dedicated, visually-verified testing time on its own, unrelated to the migrations above.

## What remains uncertain / not covered by this pass

- Full Lighthouse/Core Web Vitals measurement (blocked — see `PERFORMANCE_REPORT.md`).
- Exhaustive audit-log coverage across every sensitive action (spot-checked only).
- `employee_deductions`/`terminal_dues`/`applicants` DELETE policies, and `regions`/`companies`/`positions` DELETE — not extended with role_level checks this pass (scope-control decision, not an oversight — flagged as follow-up).
- Full accessibility audit (one concrete finding — Login's unassociated labels, Finding in `SECURITY_REVIEW.md`/E2E tests — but no full axe-core/Lighthouse pass was possible).
