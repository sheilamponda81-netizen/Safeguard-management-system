# Safeguard HR & Payroll System — Production Readiness Audit

**Branch:** `audit/full-system-hardening`
**Date:** 2026-08-03
**Scope:** Full repository (frontend + Supabase schema/migrations/edge functions). Production URL `https://safeguard-management-system.vercel.app/` referenced for context but not directly tested (see "Access limitations" below).

## Access limitations (read this first)

This audit was performed with:
- Full read/write access to the git repository.
- **No** Supabase service-role key, dashboard access, or staging database. Docker is present but its daemon is not reachable in this environment, so no local Supabase instance could be started either.
- **No** test credentials for any of the four roles (Admin/Manager/Supervisor/Staff), and no ability to log into the live production app.
- **No** Playwright/Vitest/Jest already configured (none existed in this repo before this audit).

Consequences, stated plainly rather than glossed over:
- Every RLS/migration finding below is a **static reading of the SQL migration files**, cross-referenced against what the frontend code actually does. None of it was executed against a real Postgres instance. All new migrations are marked "written, not run" throughout.
- No live per-role, per-region authorization testing was performed (Phase 5's role/region matrix). The matrix in `SECURITY_REVIEW.md` is derived from `src/App.tsx`'s `rolePages` and each page's own client-side checks, cross-referenced against what the RLS policies actually enforce — not from logging in as each role and clicking around.
- No E2E test suite exists yet (Phase 7). See `TEST_PLAN.md` for what's covered by manual static review vs. what remains to be automated.
- No Lighthouse/axe run against a live instance (Phases 9–10 partially covered by build-output analysis and static code grep instead — see `PERFORMANCE_REPORT.md`).

Everywhere this matters, the relevant deliverable says **"unverified — requires [X]"** rather than guessing.

## System map

**Stack:** React 18 + TypeScript + Vite SPA (no router library — hand-rolled `nav` state), Supabase (Postgres + Auth + Storage + 2 Deno Edge Functions), deployed to Vercel with `main` as the production branch.

**Roles** (`profiles.role_level`): 1 = Admin, 2 = Manager, 3 = Supervisor, 4 = Staff, plus an orthogonal `is_super_admin` boolean that bypasses tenant/role checks everywhere.

**Regions:** South, Central, North, East — a `regions` lookup table, referenced by `employees.region_id` and `profiles.region_id` (nullable on both).

**Pages / routes** (`src/App.tsx`'s `pageComponents`, each lazy-loaded), with the role access actually enforced client-side via `rolePages`:

| Page (`NavKey`) | Roles allowed (rolePages) | Backing table(s) |
|---|---|---|
| dashboard | 1,2,3,4 (all) | reads employees/attendance/payroll aggregates |
| employees | 1,2 | `employees` |
| recruitment | 1,2 | `applicants` |
| attendance | 1,2,3 | `attendance`, `employee_deductions` |
| payroll | 1 | `payroll` |
| payslips | 1,4 | `payroll`, `employees` (PDF generation client-side) |
| payments | 1,2 | `payment_status` |
| terminal-dues | 1,2 | `terminal_dues` |
| reports | 1,2 | reads across tables, CSV export |
| settings | 1 | `system_settings`, `regions`, `companies`, `positions` |
| security | 1,2,3 | `employees` (guard/shift/uniform columns) |
| features | 1 | static roadmap page (no table) |
| auditlogs | 1 | `audit_logs` |
| user-manual | 1,2,3,4 (all) | static content |

**Database tables** (from `supabase/migrations/20260727000000_reconstructed_base_schema.sql`, itself a prior reverse-engineered reconstruction since the original `CREATE TABLE` statements were never committed): `tenants`, `regions`, `companies`, `positions`, `profiles`, `employees`, `payroll`, `attendance`, `applicants`, `payment_status`, `employee_deductions`, `terminal_dues`, `user_roles`, `system_settings`, `audit_logs`, `backup_logs` (an 8th, `backup_data`, is referenced by the backup edge function but **does not exist** in any migration — see Finding A6).

**Edge functions:** `supabase/functions/backup`, `supabase/functions/rollback` — see Finding A6, neither is wired to the frontend, no scheduler invokes them, and `restoreBackup` doesn't perform a restore at all.

**Storage buckets:** `company-logo` (public read, unrestricted authenticated write — Finding A7).

## Commands executed (all run for real, in this environment)

| Command | Result |
|---|---|
| `npm ci` | Succeeds |
| `npm run build` | Succeeds, no warnings, throughout every fix in this pass |
| `npx tsc --noEmit` | 218 errors at baseline (unchanged by this audit's fixes — all pre-existing, none touched) |
| `npm run lint` | **Did not exist as a working command before this audit** — no ESLint config had ever existed in this repo's git history. Added `.eslintrc.cjs`; first real run found 528 problems (10 errors, 518 warnings), including 3 live production-crashing bugs (see Findings A2–A4). After fixes: 0 errors, 518 warnings (all pre-existing `@typescript-eslint/no-explicit-any` / `react-hooks/exhaustive-deps`, not addressed in this pass — see "Remaining risks"). |
| `npm audit` | Baseline: 13 vulnerabilities (1 critical, 10 high, 2 moderate). After removing unused `xlsx`: 12 (0 critical, 10 high, 2 moderate). |
| `npm run test` / `test:e2e` | Scripts do not exist; no test runner was ever configured |
| Docker / Supabase local | Not usable in this environment (daemon unreachable) |

## Findings, by severity

### P0 — Security / data-integrity

**A1. Hardcoded admin credential committed to git history.**
`src/tests/auth.test.ts` contained a real-looking email/password pair (git history since commit `58c4a9a`). Not part of the build output (dead code, no test runner ever wired to it), but present in every clone of the repo's history.
- **Fix status:** File deleted from the current branch. **Git history NOT rewritten** — you did not answer when asked how to handle this, so the safe default was taken (remove going forward only).
- **Requires your action:** Rotate that account's password in Supabase Auth now, independent of anything else in this report. Separately decide whether to rewrite git history (destructive, affects every clone) — I have not done this and will not without explicit instruction.

**A2/A3/A4. Three live "Rendered more hooks than during the previous render" (React error #310) production crashes**, all the same root cause: a modal defined via `useCallback` and invoked as a plain function call (`Modal()` instead of `<Modal />`), which puts the modal's own hook calls onto the *parent's* hook sequence for that render.
- `Attendance.tsx`'s `EmployeeModal` (fixed prior to this audit branch, in production already — two separate incidents: hooks after an internal early return, then a second instance where the *parent's* `loading`/`error` early returns skipped the call site entirely).
- `Recruitment.tsx`'s `AddApplicantModal` — **found by this audit**, via the newly-added ESLint config's `react-hooks/rules-of-hooks` rule. Same shape as Attendance's second incident: `RecruitmentPage` has `if (loading) return <div>Loading...</div>` between where the modal closure is defined and where it's invoked. This means **every visit to the Recruitment page crashed**, independent of ever opening the Add Applicant modal, for as long as this code has existed.
- **Fix status:** Both converted to genuine, standalone, props-based components (module-level, not `useCallback`-wrapped), which removes the entire bug class rather than patching another instance of the early-return symptom. Verified: `npm run lint` reports zero `rules-of-hooks` matches anywhere in the codebase after the fix; `npx tsc --noEmit` and `npm run build` clean for both files.
- **Remaining risk:** None known for this specific bug class — a repo-wide search after the fix found no further instances. Recommend keeping the ESLint config permanently enabled (e.g., as a CI gate) so this class of regression can't reappear silently.

**A5. Systemic gap: `role_level` (the app's real Admin/Manager/Supervisor/Staff distinction) was enforced server-side on only 2 of ~13 tables before this audit** (`profiles` self-escalation and `payroll` insert/update, both fixed in a prior migration, `20260727000001_security_hardening.sql`, before this audit began). Every other table's RLS policy gated only on `tenant_id`/`is_super_admin()` — meaning any authenticated Staff account, via a direct API call (e.g. from a browser console), could bypass every client-side permission check: approve terminal dues, mark payments paid, edit payroll deduction rates in `system_settings`, alter attendance deductions, or write recruitment records, none of which their role can even navigate to in the UI.
- **Fix status:** `supabase/migrations/20260803000000_role_level_rls_hardening.sql` extends the same enforcement to `payment_status`, `terminal_dues`, `system_settings`, `employee_deductions`, `applicants` (matching each table's role threshold to the exact `rolePages` restriction already in the app), tightens `payroll`/`employees` DELETE to super-admin-only (neither has a delete UI path — `employees` soft-deletes via `.update()`, verified no `.delete()` call exists in `Employees.tsx`), and pins `search_path` on all 4 `SECURITY DEFINER` functions (closing the standard Postgres/Supabase-linter "function_search_path_mutable" risk).
- **Deliberately not touched, and why:** `employees` INSERT/UPDATE is shared between the Employees page (role_level ≤ 2) and the Security page (role_level ≤ 3, Supervisors manage guard/shift/uniform columns there) — a blanket table-level role check would lock Supervisors out of legitimate Security-page writes. This needs column-level checks (which specific columns each role may touch), which needs a confirmed column list from you before it can be written safely.
- **NOT executed against any database.** Needs to run on a staging Supabase project and be verified there — in particular, check for existing duplicate rows (see A8) and existing data that might violate the new constraints, before ever touching production.

**A6. The User Manual's "Automated daily backups with point-in-time recovery" claim is false.** `supabase/functions/backup/index.ts` exists but: no cron/scheduler anywhere invokes it (confirmed: no `config.toml`, no scheduled trigger config found in the repo); the frontend never calls it (confirmed: no `functions.invoke` for `backup`/`rollback` anywhere in `src/`); its `restoreBackup` handler fetches the backup data and logs, then returns a hardcoded success message **without writing anything back to any table** — it is a no-op that lies about succeeding; and `backupTable` inserts into a `backup_data` table that **does not exist in any migration** (only `backup_logs`, metadata-only, exists), so even a manual invocation by a super-admin would fail with a Postgres "relation does not exist" error.
- **Fix status:** Not fixed — this is a design gap requiring a decision (build a real backup/restore system, or remove the claim from the User Manual and the dead edge-function code). Flagged for your decision, not guessed at.

### P1 — Major workflow / integrity risks

**A7. `company-logo` storage bucket allows any authenticated user to INSERT/UPDATE/DELETE with no tenant or role scoping.** Low-value asset (a logo image), but a real, currently-live gap. Not fixed in this pass (deprioritized behind A5's higher-stakes tables) — recommend scoping to `is_super_admin()` or role_level ≤ 2, matching the Settings page's own access level.

**A8. `payroll` has no `UNIQUE(employee_id, month)` constraint**, unlike `attendance` (`UNIQUE(employee_id, date)`) and `payment_status` (`UNIQUE(employee_id, month)`) which both already have the equivalent protection. Both `processPayroll()` and `copyFromPreviousMonth()` in `Payroll.tsx` work around this with a client-side delete-then-insert sequence that is **not atomic**: if the insert half fails after the delete half already succeeded (dropped connection, one row failing a constraint, the tab closing), that month's payroll for the affected employees is left fully deleted with nothing re-inserted — real, silent data loss.
- **Fix status:** `supabase/migrations/20260803000001_payroll_unique_constraint.sql` adds the missing constraint. **NOT executed** — may fail to apply if production already has duplicate rows (see the migration's own comment for why that's a safe failure mode, not a dangerous one). The larger fix (switching `Payroll.tsx` to a true `.upsert()` to close the non-atomicity itself) is **deliberately not done** in this pass — it changes the code path that writes real salary data and needs staging verification first.

**A9. `npm run lint` has never worked** (no ESLint config existed in this repo's git history at all, ever). Fixed by adding `.eslintrc.cjs`. This alone is why A2–A4 went undetected until now — recommend wiring this into CI so it can't silently regress to "not run" again.

**A10. `xlsx` carries a critical, unfixable (no patched version exists) prototype-pollution + ReDoS vulnerability** and was a runtime dependency. Confirmed via full-repo grep that it was never actually imported anywhere. Removed — `npm audit` now reports 0 critical (was 1).

**A11. 218 pre-existing TypeScript errors**, concentrated in `Payslips.tsx` (25), `Payroll.tsx` (20), `Security.tsx` (17), `Sidebar.tsx` (17), `App.tsx` (17), `UserManual.tsx` (15). Not fixed in this pass (large, cross-cutting, and mostly pre-existing `Badge`/`Button` prop-type mismatches — see "Remaining risks" below for why these weren't touched wholesale).

### P2 — Functional defects with a workaround / lower-severity gaps

**A12. Regional data isolation is entirely UI-only.** No RLS policy anywhere references `region_id`, even though `employees.region_id` and `profiles.region_id` both exist and multiple pages (`Attendance.tsx`, `Payments.tsx`, `TerminalDues.tsx`, `Recruitment.tsx`) filter by region client-side. Any authenticated user can read/write every region's data via a direct API call. **Deliberately not fixed** in this pass: `profiles.region_id` is nullable, and the existing client-side pattern (`if (!is_super_admin && region_id) filter...`) implies a NULL region means "can see all regions" — a business rule I should not guess at in a migration that could lock legitimate Managers out of data they're supposed to see. **This is the single highest-value follow-up and needs your confirmation on the exact semantics before it can be written.**

**A13. Two-Factor Authentication is claimed in the User Manual as "optional" but does not exist at all** — confirmed by the codebase's own comment in `Misc.tsx`: *"no 2FA exists in this app."* Not fixed (feature build vs. documentation fix is a decision for you).

**A14. `withRateLimit` in `src/utils/rateLimiter.ts` is dead code** (never imported anywhere; only `checkRateLimit` is used, from `Login.tsx`). Its useless try/catch and two unused variables were fixed as part of the lint cleanup, but the function itself remains unused — flagged, not deleted, to keep that fix minimal.

**A15. `dev` script used `vite --force --host`**, forcing a full dependency re-optimization on every single dev server start. Verified (by actually starting the dev server both ways) there's no structural reason for this — no linked/monorepo packages, cold start without `--force` is ~270ms and serves the app correctly. Changed the default `dev` script to drop `--force`, kept `dev:force` as a separate script for the rare case someone needs to bust the cache.

## What was inspected

Full `package.json`/scripts/lockfile, `tsconfig.json`, `vite.config.ts`, all 7 SQL migration files (1,753 lines total), both Supabase Edge Functions, `src/lib/supabase.ts`, `.gitignore`/`.env.example`, `App.tsx`'s routing/role model, `Sidebar.tsx`, and full manual review of `Attendance.tsx`, `Recruitment.tsx`, `Payroll.tsx`, `Payments.tsx`, `Payslips.tsx`, `Employees.tsx`, `TerminalDues.tsx`, plus a full-codebase ESLint pass across every `.ts`/`.tsx` file.

## What requires business confirmation (not guessed at)

1. **Region-access semantics** (A12): does a NULL `profiles.region_id` really mean "sees all regions," and is that intended for every role or only Admins/Managers? Needed before writing any RLS fix for regional isolation.
2. **`employees` table column-level access** (see A5): which specific columns should Supervisors (via the Security page) be allowed to write vs. Admin/Manager-only (e.g. `basic_salary`, `account_number`, `region_id`)?
3. **Backup & Recovery** (A6): build a real system, or correct the User Manual's claim? This is currently non-functional in either direction.
4. **2FA** (A13): same question — build it, or remove the claim?
5. **Credential rotation and git-history handling** (A1) — still awaiting your answer from earlier in this session.

## What requires production monitoring / staging verification before merge

- Both new migrations (`20260803000000`, `20260803000001`) — written, reviewed, but **never executed against any database**. Must run on a staging Supabase project first, specifically checking for pre-existing duplicate `(employee_id, month)` rows in `payroll` before the unique-constraint migration is applied to production.
- The `EmployeeModal`/`AddApplicantModal` fixes were verified via lint + typecheck + build, but **not manually clicked through in a running app** (no auth credentials available in this environment) — recommend a manual smoke test of both modals (open, edit, save, cancel) before merging.

## What remains uncertain / not covered by this pass

- Phases 6 (business-logic test suite), 7 (E2E), 9 (Lighthouse/Speed Insights), 10 (full accessibility audit) as originally scoped all require either test credentials, a staging database, or a live browser session against a running instance with auth — none available here. See `TEST_PLAN.md` and `PERFORMANCE_REPORT.md` for what could be verified from the repo alone vs. what's explicitly marked unverified.
- The 218 pre-existing TypeScript errors and 518 lint warnings were catalogued but not fixed wholesale — many are `Badge`/`Button` components being passed props (`className`, extra `color` values) the shared `ui.tsx` components don't actually declare, which is a real but very widespread pattern across the app; fixing all of them is a larger, separate effort than this pass's scope of "confirmed defects."
