# Safeguard HR & Payroll System — Production Readiness Audit

**Branch:** `audit/full-system-hardening`
**Last updated:** 2026-08-04 (fourth pass — reached 0 TypeScript errors, added server-side guard-ID/employee-number generation, wired the payroll RPC into the frontend, documented the A19 recruitment decision table; see "Corrections from the first pass" below for the second pass's corrections)

**Do not treat this audit as complete or ready to merge.** PR #36 remains a draft. Several P0/P1 items below are documented and, where possible, fixed on this branch — but none of the migrations have been applied to any database, and item-by-item business decisions are still outstanding (see "What requires business confirmation").
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
| `npm run type-check` | **0** | **Zero errors.** Was 211 at the start of this (fourth) pass, 218 on `origin/main`. Every one of the 211 was fixed as a genuine correction this pass — no `any`, no `@ts-ignore`/`@ts-nocheck`, no tsconfig exclusions, no type-widening. See `TEST_PLAN.md`'s "TypeScript error resolution" section for the full breakdown, including one fix that turned out to be a real regression (a `vite.config.ts` change) caught only by re-running the actual E2E suite, not just `tsc`/`build`. |
| `npm run lint` | 0 | 386 warnings, 0 errors (was 518 at the start of the third pass; fewer now as dead code was removed while fixing type errors). ESLint's own convention is exit 0 with only warnings; the remaining warnings are **not** fixed and remain outstanding (`@typescript-eslint/no-explicit-any`, a couple of `react-hooks/exhaustive-deps`). Before this audit, this command **could not run at all** — no config file had ever existed. |
| `npm run test` | 0 | **97 tests, 97 passed, 8 test files.** Was 80/7 files at the start of this pass. This pass added `generateEmployeeNumberServerSide`/`generateGuardIdServerSide` tests to the two existing generation-utility files (4 and 5 new tests respectively) and a new `payrollProcessing.test.ts` (7 tests) for the newly-wired payroll RPC wrapper. Actually executed, not assumed. |
| `npm run test:e2e` | 0 | **54 tests: 16 passed, 38 skipped, 0 failed.** Was 16 passed/14 skipped at the start of this pass. A new staging-gated file, `rpc-workflow-matrix.spec.ts` (12 scenarios × 2 browser projects = 24), covers employee-number/guard-ID generation and duplicate prevention, payroll processing/reprocessing/approval-immutability/partial-failure-rollback via the atomic RPC, terminal-dues persistence, payment-status transitions, and a test documenting the current unrestricted recruitment-status behavior (Finding A19). All correctly report as skipped without staging credentials — verified by actually running it in this credential-less environment. |
| `npm run build` | 0 | Succeeds, clean, throughout every commit in this branch |
| `npm audit` | n/a | 12 vulnerabilities: **1 critical (`jspdf`), 9 high, 2 moderate.** (Was 13: 1 critical, 10 high, 2 moderate — the 1 high removed was `xlsx`.) **The critical vulnerability is not fixed** — see Finding A16. Unchanged this pass; no dependency changes were made. |

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

Deliberately does **not** recompute payroll figures itself — that logic stays in TypeScript, unchanged, per the standing rule against altering payroll/tax/pension math without a confirmed source. The migration file itself contains a full staging test procedure (8 scenarios) and rollback SQL. **NOT executed against any database.**

**Update, this pass: now wired to `Payroll.tsx`.** `src/utils/payrollProcessing.ts`'s `processPayrollBatch()` wraps the RPC call and is called from both `processPayroll()` and `copyFromPreviousMonth()`, replacing their previous separate client-side DELETE-then-INSERT entirely. **This is a real deployment-order dependency, unlike the guard-ID/employee-number generation below**: `process_payroll_batch()` has no client-side fallback, so if this code reaches production before the migration is applied there, payroll processing breaks outright (`function process_payroll_batch does not exist`). See "Production deployment and rollback order" below — this specific commit must not ship ahead of its migration. 7 new unit tests (`payrollProcessing.test.ts`) plus a full staging integration suite (`e2e/authenticated/rpc-workflow-matrix.spec.ts`, covering the success path, idempotent reprocessing, approved-month protection, partial-failure rollback, and unauthorized-role rejection — see `TEST_PLAN.md`).

**A9. `npm run lint` never worked.** Fixed (see above). This alone is why A2–A4 went undetected until now.

**A18 (new). CSV export had zero escaping on 5 of 6 export sites.** Found while investigating "CSV escaping and formula-injection protection" for `TEST_PLAN.md` (previously flagged as unverified rather than actually checked). `Employees.tsx`, `Payments.tsx`, `Security.tsx`, and both `AuditLogs.tsx` copies did a bare `row.join(',')` with no quoting at all — any field containing a comma silently corrupted the export's column alignment, and the AuditLogs exports were guaranteed to hit this in practice (every row includes a `JSON.stringify(...)` cell). `Reports.tsx` was the one partial exception (quote/escape already present) but had no formula-injection protection (a cell starting with `=`/`+`/`-`/`@` executing as a formula when opened in Excel/Sheets). Fixed: extracted correct behavior into `src/utils/csvExport.ts` (`escapeCsvCell`/`toCsvRow`, 19 passing tests), pointed all 6 sites at it, added formula-injection protection across the board.

**A11. TypeScript errors — RESOLVED this pass.** Was 211 (218 on `origin/main`) at the start of the third pass; **0 remain** as of this fourth pass. Every one was fixed as a genuine correction — see `TEST_PLAN.md`'s "TypeScript error resolution" for the full breakdown, including several real bugs the type errors were pointing at (a `Badge`/`Button`/`TD` component silently dropping props across dozens of call sites, a dead function with a real `ReferenceError` bug, and a `vite.config.ts` "fix" that turned out to be a genuine regression, caught only by re-running the full E2E suite rather than trusting `tsc`/`build` alone).

**A20 (new). Guard IDs and employee numbers were generated client-side with no real concurrency safety.** Guard IDs (`` `G-${Math.floor(Math.random() * 1000)}` `` and inconsistent variants) had a ~9,000-value random range with **zero** uniqueness check anywhere — collision probability crosses 50% at ~112 guards (birthday paradox). Employee numbers were computed by querying the browser for the highest existing number matching a region prefix, then incrementing client-side — a read-then-write race under concurrent creation in the same region. **Fixed via two new migrations, both written and NOT applied to any database:**
- `20260804000000_guard_id_generation.sql` — a real Postgres `SEQUENCE` (inherently concurrency-safe; `nextval()` guarantees distinct values under true concurrent access, a stronger guarantee than any client-side scheme), seeded above every existing legacy value, plus a `UNIQUE` constraint as a second, independent guarantee.
- `20260804000001_employee_number_generation.sql` — a row-locked per-region-prefix counter table (a single global sequence doesn't fit employee numbers, which restart per region and whose regions are a dynamic, admin-editable set) — see the migration's own honest limitation note on why this narrows, but does not fully close, the residual race window between "a number is generated" and "the employee INSERT reaches the database" (closed instead by the existing `UNIQUE(tenant_id, employee_number)` constraint plus retry-on-conflict logic in `Employees.tsx`, which turned out to already exist from earlier work this session).

Both wired into the frontend this pass (`Security.tsx`, `Employees.tsx`), each via a wrapper (`generateGuardIdServerSide()`/`generateEmployeeNumberServerSide()`) that **falls back to the original client-side generator if the RPC call errors** (including "function does not exist," i.e. the migration not yet applied) — unlike the payroll RPC, wiring these two now does **not** create a hard deployment-order dependency; the app degrades to its previous (working, if collision-prone) behavior rather than breaking. 13 new unit tests total (5 for guard-ID generation, 4 for employee-number generation, plus the pre-existing pure-function tests) and a staging integration suite covering real duplicate-prevention via the `UNIQUE` constraints (`e2e/authenticated/rpc-workflow-matrix.spec.ts`).

### P2 — Functional defects with a workaround / lower-severity gaps

**A12. Regional data isolation is UI-only.** No RLS policy anywhere references `region_id`. **Deliberately not fixed** — `profiles.region_id` is nullable and a NULL appears to mean "all regions" client-side, a business rule this audit should not guess at. **See `SECURITY_REVIEW.md`'s new "Candidate region/access-control model" section for the exact candidate rules (Super Admin/Admin/Manager/Supervisor/Staff) and precisely which schema changes each one needs — documented, not implemented, per your explicit instruction.**

**A7. `company-logo` storage bucket** allows any authenticated user unrestricted INSERT/UPDATE/DELETE. Not fixed (lower priority — a logo image, not sensitive data).

**A14. `withRateLimit` in `rateLimiter.ts` is dead code** (never imported anywhere). Its useless try/catch and 2 unused variables were cleaned up; the function itself remains, flagged not deleted.

**A15. `dev` script's unnecessary `--force`** — removed, verified (dev server starts in ~270ms and serves correctly without it).

**A21 (new). `showNotification()`'s success/error/info `type` parameter is accepted but silently ignored everywhere.** Found while resolving a `noUnusedParameters` error in `src/utils/clickHandlers.ts`. The function's entire body is a plain `alert(safeMessage)` regardless of the `type` argument — every one of the 15 files calling it (with a `'success'`/`'error'`/`'info'` argument, presumably expecting a styled toast) gets the same unstyled browser `alert()` either way. Not fixed this pass: the `type` parameter was renamed to `_type` (satisfying the compiler's unused-parameter check without changing behavior) rather than silently redesigning the notification system, which is exactly the kind of "preserve current design unless a change is required to correct a confirmed defect" call this audit is instructed to leave for a deliberate follow-up rather than fold into a type-error fix. This app already imports `sonner` (`<Toaster/>` in `App.tsx`) — wiring `showNotification()` to `sonner`'s `toast.success()`/`toast.error()`/`toast()` instead of `alert()` would be the natural fix, and would need its own visual verification pass across all 15 call sites before shipping.

**A19 (new). Recruitment applicant status has no transition validation at any layer.** `applicants` has two status-like columns: `interview_status` (`Pending`/`Shortlisted`/`Interviewed`/`Accepted`/`Rejected`) and `decision` (`Pending`/`Hire`/`Reject`), each with only a value-level `CHECK` constraint (`20260727000000_reconstructed_base_schema.sql`). There is no rule anywhere — not in `Recruitment.tsx`, not in the database — preventing an invalid *sequence*: e.g. clicking "Hire" on a still-`Pending` applicant who was never shortlisted or interviewed, re-`Reject`-ing an already-`Accepted` hire, or "Shortlist"-ing an applicant back out of `Rejected`. **Deliberately not fixed and not given a test**: writing either would mean inventing a transition policy this audit has no source for, which the standing instruction against changing/inventing business rules without a confirmed requirement rules out.

**Current statuses and transitions actually exposed by the UI** (`Recruitment.tsx`'s action buttons, one row per applicant):

| Button | Writes `interview_status` | Writes `decision` | Enabled when |
|---|---|---|---|
| Shortlist | `Shortlisted` | *(unchanged)* | `interview_status !== 'Shortlisted'` — i.e. from any other status, including `Accepted`/`Rejected` |
| Interview | `Interviewed` | *(unchanged)* | `interview_status !== 'Interviewed'` — i.e. from any other status, including `Accepted`/`Rejected` |
| ✓ Hire | `Accepted` | `Hire` | **always enabled**, regardless of current status — a still-`Pending` applicant can be hired with one click, with no shortlist/interview step in between |
| Reject | `Rejected` | `Reject` | **always enabled**, regardless of current status — including an already-`Accepted`/hired applicant |

No button is disabled based on `decision` at all, only (partially) on `interview_status`. This is a real, exercisable gap today, not a hypothetical: an Admin/Manager can currently hire a `Pending` applicant with zero intermediate steps, or reject someone already marked `Accepted`, and the database accepts either write silently.

**Recommended state machine (documented here for business approval — NOT implemented anywhere in this pass, per instruction):**

```
Pending → Shortlisted or Rejected
Shortlisted → Interviewed or Rejected
Interviewed → Accepted or Rejected
Accepted → Hired
Hired → terminal state
Rejected → terminal state
```

This is a conservative, linear pipeline — every stage can still end in `Rejected`, but forward progress must go through each intermediate stage in order, and both `Hired` and `Rejected` are terminal (no transitions out). It does not yet reconcile the app's current two-column design (`interview_status` + a separate `decision` field) with the single-status model above — that reconciliation (e.g. folding `decision` into the same state machine as an `Accepted → Hired` step, as sketched here, versus keeping them as two independently-governed fields) is itself part of what needs business confirmation before implementing anything.

**If and only if this (or an amended version of it) is approved**, enforcement should exist at both layers, with the database as the final authority regardless of what the UI allows or hides:
- **Interface**: disable/hide buttons that don't represent a valid transition from the applicant's current status (extending the existing partial `disabled={...}` pattern to cover all four buttons and both hire/reject cases, not just the two that already check `interview_status`).
- **Database**: a trigger (`BEFORE UPDATE ON applicants`) or a dedicated `SECURITY DEFINER` RPC (mirroring the payroll/guard-ID/employee-number pattern elsewhere in this audit) that rejects a disallowed transition outright — so a direct API call bypassing the UI (or a bug in the UI's own disabled-state logic) can never produce an invalid sequence. The UI-only check above is a UX convenience, not a substitute for this.

Not implemented in this pass. If a specific transition policy is wanted, that's a product decision to make first — then it can be implemented and tested for real, rather than tested into existence here.

## What was inspected

Everything from prior passes, plus this pass: every one of the 211 TypeScript errors, file by file (see `TEST_PLAN.md`); `Recruitment.tsx`'s complete action-button wiring against `interview_status`/`decision` (for the A19 decision table); `Security.tsx`'s and `Employees.tsx`'s guard-ID/employee-number generation and persistence call sites, reconciled against the new server-side functions (see `TEST_PLAN.md`'s wiring reconciliation table); `vite.config.ts`'s actual build output (caught the treeshake regression); `showNotification()`'s complete implementation across all 15 call sites (A21).

## What requires business confirmation (not guessed at)

1. **Region-access semantics** (A12) — see `SECURITY_REVIEW.md`'s candidate rules; specifically, does a NULL `profiles.region_id` mean "all regions" for every role, or only some?
2. **Whether Staff-level payslip self-service should exist at all**, and if so, the `profiles`↔`employees` linking approach (A17) — a schema decision with real implications for how Staff accounts get provisioned.
3. **`employees` table column-level access** (A5's deferred item) — which columns Supervisors may write via the Security page vs. Admin/Manager-only.
4. **Backup & Recovery, `jspdf` upgrade** (A6, A16) — build a real backup system or leave the claim removed; schedule dedicated, visually-verified testing time for the `jspdf` major-version upgrade rather than a blind bump.
5. **Credential rotation and git-history handling** (A1) — still outstanding.
6. **Recruitment status state machine** (A19) — is the recommended conservative pipeline (Pending → Shortlisted/Rejected → Interviewed/Rejected → Accepted/Rejected → Hired) the right model, and should `interview_status`/`decision` be reconciled into one field or kept as two independently-governed ones?
7. **`showNotification()`'s notification style** (A21) — is a plain browser `alert()` acceptable long-term, or should it be replaced with the `sonner` toast library already present in the app (`<Toaster/>` in `App.tsx`) — and if so, is a full visual re-verification across all 15 call sites in scope for the team doing that work?

## Production deployment and rollback order

None of this branch's migrations or code changes should reach production in one step. **Important update this pass**: earlier guidance here said the payroll-RPC frontend change would be "a separate, deliberately later change" after the migration was verified in production. That is no longer the plan this branch implements — this pass's instructions explicitly asked for the frontend to be wired now, so `Payroll.tsx` already calls `process_payroll_batch()` as of this branch. That means the code and its migration are now bundled together and **cannot** both go out in the "safe, code-only" step below. Recommended order, revised:

1. Merge this branch's **code-only, migration-independent** changes (bug fixes, CSV escaping, dependency removal, test suites, doc updates, and the component-prop fixes from reaching 0 TypeScript errors) to `main` and deploy normally.
2. **Guard-ID and employee-number generation are safe to include in that same code-only batch**, even though their migrations aren't applied yet: `generateGuardIdServerSide()`/`generateEmployeeNumberServerSide()` both fall back to the original client-side generator if their RPC call errors (including "function does not exist"), so the app keeps working exactly as it did before this PR until their migrations are actually applied — at which point the safer, concurrency-controlled path takes over automatically, with no further code deploy needed. Still apply their migrations to staging and verify (see below) before applying to production, to get the actual safety benefit sooner rather than later.
3. **`process_payroll_batch()`'s frontend wiring is NOT safe to ship ahead of its migration** — it has no fallback, so payroll processing would break outright in production until the migration is applied. Either (a) hold this branch's merge until the migration below is applied to production first, or (b) if merged as one PR, apply the migration to production **immediately, before or atomically with** the deploy, with a fast rollback plan ready (see below) in case anything goes wrong.
4. Apply `20260803000000_role_level_rls_hardening.sql` to a **staging** Supabase project. Run `e2e/authenticated/rls-policy-matrix.spec.ts` against it with real 4-role test credentials (see `TEST_PLAN.md`). Confirm no legitimate workflow is newly blocked.
5. Apply `20260803000001_payroll_unique_constraint.sql` to staging. **Check for existing duplicate `(employee_id, month)` rows in `payroll` first** — the migration will fail safely (not corrupt anything) if any exist; resolving those is a manual, business-judgment task.
6. Apply `20260804000000_guard_id_generation.sql` and `20260804000001_employee_number_generation.sql` to staging. Run `e2e/authenticated/rpc-workflow-matrix.spec.ts`'s generation/duplicate-prevention tests against it.
7. Apply `20260803000002_payroll_atomic_process_rpc.sql` to staging, run its own 8-scenario test procedure (in the migration file) plus `rpc-workflow-matrix.spec.ts`'s payroll-atomicity tests (success, reprocessing, approved-month protection, partial-failure rollback, unauthorized-role rejection).
8. Apply all four migrations to production once staging is clean, during a low-traffic window, with rollback SQL ready for each (all four migrations include their own rollback SQL as comments; `DATA_INTEGRITY_REVIEW.md` has the consolidated list). **The payroll migration (step 7) must land in production no later than the same deploy as the `Payroll.tsx` code that calls it** — this is the one hard ordering constraint in this list; getting it backwards breaks payroll processing.
9. Do not attempt the `jspdf` major-version upgrade (A16) as part of this rollout — it needs dedicated, visually-verified testing time on its own, unrelated to the migrations above.

## What remains uncertain / not covered by this pass

- Full Lighthouse/Core Web Vitals measurement (blocked — see `PERFORMANCE_REPORT.md`).
- Exhaustive audit-log coverage across every sensitive action (spot-checked only).
- `employee_deductions`/`terminal_dues`/`applicants` DELETE policies, and `regions`/`companies`/`positions` DELETE — not extended with role_level checks this pass (scope-control decision, not an oversight — flagged as follow-up).
- Full accessibility audit (one concrete finding — Login's unassociated labels, Finding in `SECURITY_REVIEW.md`/E2E tests — but no full axe-core/Lighthouse pass was possible).
