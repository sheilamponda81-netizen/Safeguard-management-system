# Data Integrity Review — Safeguard HR & Payroll System

**Date:** 2026-08-03. Static review of `supabase/migrations/*.sql` (1,753 lines across 7 files) cross-referenced against how the frontend actually writes to each table. No live database was available to run these constraints against real data — see "Migration execution status" below before assuming anything here has been applied.

## Constraints — what exists today

| Table | Primary key | Foreign keys | Unique constraints | Check constraints | Notes |
|---|---|---|---|---|---|
| `employees` | ✓ | `tenant_id→tenants`, `region_id→regions`, `company_id→companies`, `deleted_by→profiles` | `(tenant_id, employee_number)` | none | Soft-delete columns present (`is_deleted`, `deleted_at`, `deleted_reason`, `deleted_by`) and correctly used — verified no `.delete()` call exists anywhere in `Employees.tsx` |
| `payroll` | ✓ | `tenant_id→tenants`, `employee_id→employees` (CASCADE) | **none** (fixed this pass, unexecuted — see below) | `approval_status IN ('pending','approved','rejected')` | Highest-stakes table with the weakest constraint coverage before this pass |
| `attendance` | ✓ | `tenant_id→tenants`, `employee_id→employees` (CASCADE) | `(employee_id, date)` | `status IN ('P','A','L','LV','SL','-')` | Already well-constrained |
| `applicants` | ✓ | `tenant_id→tenants`, `region_id→regions` (assumed, not re-verified column-by-column this pass) | not reviewed in depth this pass | not reviewed in depth this pass | |
| `payment_status` | ✓ | `tenant_id→tenants`, `employee_id→employees` (CASCADE) | `(employee_id, month)` | `status IN ('pending','processing','paid','confirmed','failed')` | Already well-constrained |
| `employee_deductions` | not re-verified column-by-column this pass | | | | |
| `terminal_dues` | not re-verified column-by-column this pass | | | | |
| `system_settings` | not re-verified column-by-column this pass | | | | |
| `audit_logs` | ✓ | `tenant_id→tenants` | none needed (append-only by design) | | INSERT-only by RLS, correctly immutable |
| `profiles` | ✓ (references `auth.users`, CASCADE) | `tenant_id→tenants`, `region_id→regions` | none | none visible | `role_level`/`is_super_admin`/`tenant_id` protected from self-modification by a trigger (pre-existing fix), not by a table constraint |

## Indexes

`20240618000000_create_indexes.sql` exists (44 lines) — skimmed, not exhaustively cross-referenced against every actual query pattern in this pass. This needs `EXPLAIN ANALYZE` against realistic data volume to say anything meaningful about whether current indexes actually serve the app's real filter/join patterns (e.g. attendance-by-month-and-employee-list, payroll-by-month). **Unverified — flagged as a follow-up requiring a staging database with representative row counts.**

## Foreign keys and cascade behavior

- `employees.tenant_id`, `payroll.employee_id`, `attendance.employee_id`, `payment_status.employee_id` are all `ON DELETE CASCADE`. This is **appropriate given the app never actually hard-deletes an employee** (soft-delete via `is_deleted`, verified), but it means the DB-level DELETE policy tightening this pass (AUDIT_REPORT.md A5 — `employees` DELETE now super-admin-only) is genuinely important: a hard delete via direct API call, previously reachable by any tenant member, would have cascaded into silently destroying that employee's entire payroll and attendance history. That path is now closed to non-super-admins.
- `employees.deleted_by→profiles`, `employees.region_id→regions`, `employees.company_id→companies` are all `ON DELETE SET NULL` — reasonable (losing a region/company reference shouldn't cascade-delete the employee record itself).
- `payroll.approved_by→profiles` is `ON DELETE SET NULL` — if an approving profile is later deleted, historical payroll records keep existing but lose the reference to who approved them. This is a minor historical-accountability gap (you'd know a record was approved but not by whom, if that profile is later removed) — not fixed this pass, flagged for awareness since it interacts with the audit-trail claim in SECURITY_REVIEW.md.

## Duplicate-row risks

| Risk | Status |
|---|---|
| Duplicate `attendance` rows (same employee, same date) | **Prevented** — `UNIQUE(employee_id, date)` already existed |
| Duplicate `payment_status` rows (same employee, same month) | **Prevented** — `UNIQUE(employee_id, month)` already existed |
| Duplicate `payroll` rows (same employee, same month) | **Was NOT prevented** — no unique constraint existed. Fixed this pass via `20260803000001_payroll_unique_constraint.sql`, **not yet executed against any database**. May fail to apply if production already has duplicates for some employee/month — see the migration's own comment for why that's the correct, safe failure mode (it surfaces the problem via a clear constraint-violation error rather than silently corrupting data), and why resolving any such duplicates is a manual, business-judgment task (which row is authoritative?) that shouldn't be automated blind. |
| Duplicate `employees` (same employee_number) | **Prevented** — `UNIQUE(tenant_id, employee_number)` |
| Duplicate guard IDs | Column is `"guardId"` (quoted camelCase, on `employees`) — **no unique constraint found**. Not deeply investigated this pass; flagged as a follow-up given the audit brief specifically calls out "duplicate guard IDs" as a concern. |

## Concurrency risks

- **`processPayroll`/`copyFromPreviousMonth` (`Payroll.tsx`): non-atomic delete-then-insert.** Two sequential network calls, not wrapped in a database transaction (client-side Supabase calls cannot be atomic across two separate requests without an RPC). If the delete succeeds and the insert then fails (dropped connection, one row violating a constraint, browser tab closing mid-operation), the affected employees' payroll for that month is left **fully deleted with nothing re-inserted** — real data loss, not just a duplicate-row risk. The client-side "Process/Reprocess" button is disabled during the operation and once approved, which prevents the *most obvious* double-click scenario, but does not protect against the partial-failure window described here. **Recommended real fix** (not applied this pass, needs staging verification): a Postgres RPC function that performs the delete+insert (or better, a true `upsert`) inside a single transaction, called via `supabase.rpc(...)` instead of two sequential `.from('payroll')` calls. This changes the actual code path that writes real salary data and should not be done without testing against a staging copy first.
- **`payment_status` double-click race**: investigated specifically because `updatePaymentStatus` in `Payments.tsx` has no per-row "in flight" disabled state (unlike `Attendance.tsx`'s `updating[key]` pattern). However, the existing `UNIQUE(employee_id, month)` constraint means a genuine race (two concurrent inserts for a brand-new payment record) would have the **second** request fail with a clean constraint-violation error rather than silently create a duplicate row. The UX of that failure (a generic "Failed to update status" toast) isn't great, but the data integrity itself is protected. Not fixed this pass (UX polish, not a data-integrity bug).
- **RLS policy application itself is not transactional across multiple statements** — each `CREATE POLICY`/`ALTER FUNCTION` in the new migrations is independent; if one statement in `20260803000000_role_level_rls_hardening.sql` fails partway through (e.g. a policy name collision), earlier statements in the same file will have already committed (Postgres migrations in Supabase typically run as a single transaction per migration file, which would actually roll back the whole file atomically — this depends on how the migration runner is invoked; **not verified**, since no execution against a real database was possible in this environment).

## Transaction / RPC recommendations

1. **Payroll processing** (see above) — the highest-value candidate for moving to an RPC function, given it's the only unprotected-by-constraint, non-atomic, financial write path found in this review.
2. **Recruitment "Accept"/"Hire" → employee creation**: not reviewed in depth this pass for whether retrying a hire action after a network failure could create a duplicate employee record. Flagged as an explicit follow-up (the original audit brief calls this out specifically: *"Verify that accepting or hiring an applicant does not create duplicate employees when retried"*) — **unverified in this pass**, should be checked before relying on it.

## Migration execution status (repeated here for emphasis — do not skip)

Both new migrations from this audit:
- `supabase/migrations/20260803000000_role_level_rls_hardening.sql`
- `supabase/migrations/20260803000001_payroll_unique_constraint.sql`

were **written and reviewed but never executed against any database** — this environment has no reachable Docker daemon and no Supabase staging project credentials. Before applying either to production:

1. Apply both to a **staging** copy of the real schema/data first.
2. For the unique-constraint migration specifically: check for existing duplicate `(employee_id, month)` rows in `payroll` before it runs, since the migration will fail outright (safely — see its own comment) if any exist, and resolving those requires a business decision about which row is authoritative, not an automated script.
3. Re-run the app's full test surface (once one exists — see TEST_PLAN.md) against the staging database after applying, specifically exercising payroll processing, terminal dues approval, payment status changes, and recruitment writes as each affected role, to confirm the new role_level restrictions match every legitimate workflow and don't accidentally lock out a role that needs access.

## Backup and rollback considerations

- The app's own `supabase/functions/backup`/`rollback` Edge Functions are **not a working backup system** — see AUDIT_REPORT.md Finding A6 (no scheduler, no frontend wiring, restore is a no-op, target storage table doesn't exist). Do not rely on this for actual disaster recovery.
- Real backup/recovery for this app currently depends entirely on whatever backup mechanism the Supabase project itself provides at the platform level (point-in-time recovery is a paid-plan Supabase feature, not something this repo implements) — **not verified in this pass** (would need Supabase dashboard/billing access to confirm what plan/PITR settings are actually active).
- For the two new migrations specifically: both are purely additive (new constraints, new policies, a `search_path` pin) with no data deletion or column drops, so rollback is straightforward — `DROP CONSTRAINT`/`DROP POLICY`/recreate the old policy text (all preserved in the prior migration files' own history) would fully revert either one if needed.
