# October 2026 Payroll Hotfix — Deliverables Report

Branch: `hotfix/october-payroll-consistency` (based on latest `origin/main`, commit `9f00715`)
Status: **committed locally only — not pushed, not merged, not deployed.**

---

## 1. Root cause of each issue

**Issue 1 — Dashboard/Reports/Payroll total disagreement.** Two independent, compounding bugs:
- Reports.tsx's own headline "Total Payroll" stat card used a stale local variable (`totalCompanyPayroll`) instead of `payrollSummary.totalNet` — the value every CSV export on that same screen already used. The screen disagreed with itself.
- Dashboard.tsx and Reports.tsx both built their payroll population from `employees.filter(e => !e.is_deleted)` only. Payroll.tsx's own roster query additionally restricts to `PAYABLE_EMPLOYEE_STATUSES` (`Active`, `On Leave`). A non-deleted employee with status `Terminated`/`Suspended` (set via Security.tsx, which never touches `is_deleted`) was summed into Dashboard/Reports totals that Payroll.tsx correctly excludes.
- The Dashboard/Payroll gap is *not* a bug: `estimateMonthlyPayrollTotal()` already, deliberately, omits salary-advance deductions — pre-existing and documented in its own header. Only mislabeled, not miscalculated.

**Issue 2 — paid-leave eligibility.** No defect found. `calculateAttendanceDeductions()` only counts a day as absent when its status is the literal `'A'`; an approved leave day is recorded as `'LV'`, never `'A'`, so it can never reach the absence-deduction branch. `calculateLivePayroll()` takes `basicSalary` as a flat figure with no proration logic tied to attendance at all — a leave day (full or partial month) cannot reduce it. `PAYABLE_EMPLOYEE_STATUSES` already includes `'On Leave'`. Salary-advance deduction is applied as an independent subtraction after `calculateLivePayroll()`, so it cannot double-count with attendance deductions.

**Issue 3 — payroll approval authorization.** `approve_payroll_run()`'s authorization check only ever accepted `is_super_admin() OR role_level = 1`. `role_permissions` already seeds `('accountant', 'payroll.approve')` (2026-08-17) and the UI's `canApprovePayroll` already shows Approve/Reject controls to an Accountant on that basis — but the RPC itself never checked `has_permission('payroll.approve')`. An authorized Accountant clicking Approve has always failed server-side with "Only managers and admins can approve payroll."

---

## 2. Exact current source of truth for payroll totals

- **Payroll.tsx (preview/unprocessed month)** and **Payments.tsx**: `calculateLivePayroll()` (`src/utils/payrollCalculations.ts`), per employee, summed over `PAYABLE_EMPLOYEE_STATUSES` roster.
- **Reports.tsx**: `payrollSummary.totalNet`, a `useMemo` summing `getEmployeeFigures(emp).net_pay` (itself calling `calculateLivePayroll()` or reading a processed `payroll` row) over `activeEmployees` — now filtered to the same whitelist.
- **Dashboard.tsx**: `estimateMonthlyPayrollTotal()` (`dashboardMetrics.ts`), a simplified estimate that deliberately excludes salary advances and lecture/appearance deductions — now filtered to the same whitelist, label updated to disclose the exclusion.
- **Processed month**: the `payroll` table itself (`gross_pay`/`paye`/`pension`/`net_pay` columns), written by `process_payroll_batch()`/`process_payroll_with_terminal_dues()`.

---

## 3. The three-way October discrepancy, explained

| Screen | Was | Cause |
|---|---|---|
| Reports | MK 124,393,400 | Stale `totalCompanyPayroll` variable, disagreeing with its own CSV export on the same page |
| Dashboard | MK 123,310,200 | Correct simplified-estimate math, but summed over a looser population (is_deleted-only) and excludes salary advances, unlabeled |
| Payroll | Gross 135,503,000 / Net 121,038,200 | Correct, full-fidelity preview (includes salary advances), correct population, PAYE/Pension = 0 by owner's explicit configuration |

After the fix: Dashboard and Reports both use the same `PAYABLE_EMPLOYEE_STATUSES` population as Payroll; Reports' net-pay figure now matches its own CSV; Dashboard is clearly labeled as a net-pay estimate excluding salary advances (by design, not a residual bug) so it will still differ from Payroll's gross figure, and from Payroll's net figure by exactly the salary-advance total for the month — a labeled, intentional difference, not a defect.

---

## 4. Employee eligibility / paid-leave test results

New file: `src/utils/payrollPaidLeaveEligibility.test.ts` — 6/6 passed.

1. Active, full attendance → full salary, zero deduction. **PASS**
2. Approved paid leave, entire month → identical net pay to scenario 1, zero absence deduction. **PASS**
3. Partial-month paid leave → identical net pay to scenario 1, no pro-rating. **PASS**
4. Unauthorized absences → correctly deducted (engine still penalizes real absence). **PASS**
5. Non-payable statuses (Terminated/Suspended) and soft-deleted → confirmed excluded from `PAYABLE_EMPLOYEE_STATUSES` / roster filter. **PASS**
6. Paid leave + salary-advance deduction → full salary preserved, advance deducted independently, no double-counting. **PASS**

---

## 5. Payroll approval permission investigation

Two distinct, coexisting approval mechanisms confirmed:
- `approve_payroll_run()` — post-commit sign-off on already-processed `payroll` rows. **This hotfix's target.**
- `payroll_processing_requests` workflow (`20261028000000`) — a separate pre-commit gate, deliberately Admin-only to prevent an Accountant approving their own submitted processing request. **Deliberately left untouched** — widening it would reopen the exact self-approval bypass it exists to close.

`payroll.approve` is seeded only for `accountant` (confirmed by direct query against the rehearsal database) — no other functional role is granted it.

---

## 6. Minimal code changes made

- `src/pages/Dashboard.tsx` — payable-employee whitelist filter + label fix.
- `src/pages/Reports.tsx` — payable-employee whitelist filter + headline-card source fix + dead-variable removal.
- `src/utils/payrollPaidLeaveEligibility.test.ts` — new regression test file (Issue 2).
- `supabase/migrations/20261106000000_payroll_approval_accountant_authorization.sql` — new migration (Issue 3).

No changes to `calculateLivePayroll()`, `calculateAttendanceDeductions()`, `process_payroll_batch()`, `process_payroll_with_terminal_dues()`, or the `payroll_processing_requests` workflow — all confirmed already correct.

---

## 7. New migration

`20261106000000_payroll_approval_accountant_authorization.sql`: adds `OR public.has_permission('payroll.approve')` to `approve_payroll_run()`'s existing authorization check, and adds an `audit_logs` entry on every successful approval/rejection decision. Additive, forward-only — does not edit any already-applied migration. Full rollback SQL included in the migration's own trailing notes.

**Not yet applied to any real database.**

---

## 8. Test results and remaining risks

- Migration rehearsed end-to-end against a disposable local Postgres with the full 60-file migration chain applied (0 failures). Rehearsal caught and fixed **two real bugs** in the draft migration before they could reach production: `has_permission(...)` and `audit_logs` were both unqualified identifiers, which fail to resolve under this function's `SET search_path = ''` — the exact bug class the migration's own header was trying to avoid. Both now schema-qualified as `public.has_permission(...)` / `public.audit_logs`.
- Full authorization matrix run against the rehearsed function, all as expected: Accountant with `payroll.approve` → allowed; Admin (role_level=1) → allowed; super admin → allowed; HR manager / operations manager / guard (no permission) → denied; NULL-role account → denied; cross-tenant Accountant → denied; disabled account → denied (account-disabled check fires first); financial figures (gross/PAYE/pension/net) unchanged across every approval attempt; `audit_logs` entry written on each successful decision with correct identity/timestamp/decision.
- Re-approving an already-approved row **succeeds again** (overwrites `approved_by`/`approved_at`/`approval_notes`, writes a second audit entry) rather than being blocked outright — this is the function's pre-existing behavior, unchanged by this migration, and causes no data corruption (confirmed: financial columns never change). No duplicate-approval guard was added, since none existed before and adding one was outside this hotfix's minimal scope.
- `npm run type-check`: 0 errors. `npm run build`: succeeds. `npm run lint`: 0 errors (pre-existing `any` warnings only, no new ones introduced). `npx vitest run`: 1580 passed, 16 skipped (pre-existing, documented: a separate SQL-parity test file that requires a live Postgres connection string not set in this run — not caused by this hotfix).
- **Remaining risk**: no automated test exercises RLS policies directly (the rehearsal matrix ran as `authenticated` with `SET ROLE`, bypassing RLS the way `SECURITY DEFINER` functions always do in production too — this matches real request behavior for this RPC, but a full RLS-policy fuzz test was out of scope for this hotfix).

---

## 9. Outstanding Finance/HR sign-off

- **PAYE = 0 / Pension = 0**: per the system owner's explicit instruction, this is confirmed **intentional configuration**, not a defect — rates are deliberately zeroed pending the Accountant establishing approved statutory rates. No change made; preview and processing both faithfully reflect the configured zero rates. Statutory-rate verification by Accounting remains a **pending business action**, not a software task.
- **Separation of duties (self-approval)**: see item 10 — needs an explicit Finance/HR decision.

---

## 10. Separation of duties — decision needed, not invented

`approve_payroll_run()` has never checked, and still does not check, whether the caller approving a payroll run is the same person who processed it. The `payroll` table has no `processed_by` column — only `processed_at` (a timestamp) and `audit_logs`'s own `combined_payroll_run` entries, which aren't joinable back to a `payroll.id` without schema work. After this fix, this gap applies to both Admin and an authorized Accountant equally (previously it only mattered for Admin, since Accountant couldn't approve at all).

**This hotfix deliberately does not invent a same-person rejection rule.** Closing it would require: (a) a new `processed_by` column, and (b) a product decision on whether same-person approval should be blocked, merely flagged, or allowed depending on role. Recommend routing to Finance/HR for a policy decision before building it.

---

## GO / NO-GO for October payroll

**GO for processing October payroll**, conditional on:
1. This branch being reviewed and the migration applied to a real environment by someone with that authorization (not done by this session, per instruction).
2. Finance/HR acknowledging PAYE/Pension = 0 is intentional pending statutory-rate confirmation (already stated as fact by the task).
3. Finance/HR reviewing item 10 (separation of duties) and deciding whether it blocks October specifically, or is accepted as a known gap for now.

No defect was found in the core payroll calculation engine, paid-leave handling, or the pre-commit `payroll_processing_requests` workflow — all were confirmed correct by evidence, not assumed. The only code changes made are the two display/population consistency fixes (Issue 1) and the narrowly-scoped approval-authorization migration (Issue 3), both minimal and both verified.
