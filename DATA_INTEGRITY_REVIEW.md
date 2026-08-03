# Data Integrity Review — Safeguard HR & Payroll System

**Last updated:** 2026-08-03 (second pass). Static review of `supabase/migrations/*.sql`. No live database was available to run these against real data.

## Constraints — current state

| Table | Primary key | Foreign keys | Unique constraints | Check constraints |
|---|---|---|---|---|
| `employees` | ✓ | tenant, region, company, deleted_by | `(tenant_id, employee_number)` | none |
| `payroll` | ✓ | tenant, employee (CASCADE) | **added this session** — `(employee_id, month)`, not yet executed | `approval_status IN (...)` |
| `attendance` | ✓ | tenant, employee (CASCADE) | `(employee_id, date)` | `status IN (...)` |
| `payment_status` | ✓ | tenant, employee (CASCADE) | `(employee_id, month)` | `status IN (...)` |
| `audit_logs` | ✓ | tenant | none needed (append-only) | — |
| `profiles` | ✓ (→ auth.users, CASCADE) | tenant, region | none | — |

## Duplicate-row risks — status

| Risk | Status |
|---|---|
| Duplicate `attendance` (employee+date) | Prevented (pre-existing) |
| Duplicate `payment_status` (employee+month) | Prevented (pre-existing) — and now has a real, executable staging test (`e2e/authenticated/rls-policy-matrix.spec.ts`) confirming a denied UPDATE affects zero rows rather than silently succeeding |
| Duplicate `payroll` (employee+month) | **Was NOT prevented.** Fixed via `20260803000001_payroll_unique_constraint.sql`. **NOT executed** — may fail to apply if production already has duplicates (a safe failure mode, not corruption — see the migration's own comment) |
| Duplicate `employees` (employee_number) | Prevented (pre-existing) |
| Duplicate guard IDs (`employees."guardId"`) | **No unique constraint found.** Not fixed this pass — flagged, not newly investigated in this second pass either |

## Concurrency and atomicity — the real fix this pass adds

**`processPayroll()`/`copyFromPreviousMonth()`'s delete-then-insert was not atomic** (two separate client-side network calls, no transaction spanning both). If the insert failed after the delete succeeded, that month's payroll for the affected employees was left **fully deleted, nothing re-inserted**.

**Fix: `supabase/migrations/20260803000002_payroll_atomic_process_rpc.sql`**, a `process_payroll_batch(month, records, user_email, audit_context)` Postgres function. What it actually guarantees, and how:

| Requirement | How it's met |
|---|---|
| Existing payroll not deleted unless replacement succeeds | Both DELETE and INSERT happen inside one function call, which Postgres runs as a single implicit transaction — any exception anywhere rolls back everything, including the delete |
| Partial insertion impossible | The insert is one `INSERT INTO payroll (...) SELECT ... FROM jsonb_array_elements(p_records)` statement — atomic by construction, not a per-row loop that could succeed for some rows and fail for others |
| Approved payroll cannot silently return to pending | Validated *before* any destructive change: the function counts existing `approval_status = 'approved'` rows for the targeted employees/month and raises an exception (aborting before the DELETE even runs) if any exist |
| Reprocessing is idempotent | Same end-state each call: delete-then-insert with the same inputs produces the same final rows. Concurrent calls are serialized (below), so "idempotent" here means safe-to-repeat, not race-free without the lock |
| Concurrent processing controlled | `pg_advisory_xact_lock(hashtext(tenant_id || ':' || month))` — a second concurrent call for the same tenant+month blocks until the first transaction commits or rolls back |
| All validation before destructive changes | Role check (Admin/super-admin only) → tenant-membership check on every targeted employee_id → approved-row check, all before the DELETE |
| Audit-log operation coordinated | The `audit_logs` INSERT happens in the *same* transaction as the payroll DELETE/INSERT — if the payroll write fails, no orphaned audit entry describing a write that didn't happen gets created (unlike today's separate client-side `logAudit()` call, which fires independently of whether the actual write succeeded) |
| Any failure rolls back everything | Natural Postgres behavior for an unhandled exception inside a single function call — no explicit `BEGIN`/`COMMIT` needed or used |

**Deliberately does not recompute payroll figures itself** — `calculatePayroll`/`calculateLivePayroll` stay in TypeScript, unchanged, per the standing rule against altering payroll math without a confirmed source. This function only owns the transactional mechanics around persisting already-computed records.

**NOT wired up to `Payroll.tsx` yet, deliberately** — seeing rollout-order reasoning in the migration's own header comment and `AUDIT_REPORT.md`'s "Production deployment and rollback order." Changing the frontend to call this RPC before the migration is verified and applied to production would break payroll processing outright if the two ever became out of sync during rollout.

**Rollback SQL** (included directly in the migration file):
```sql
REVOKE EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM authenticated;
DROP FUNCTION IF EXISTS process_payroll_batch(TEXT, JSONB, TEXT, JSONB);
```
Safe to run at any time — nothing calls this function yet, so dropping it affects no live code path.

**Staging test procedure** (also in the migration file, 8 scenarios): happy path, reprocessing, approved-month protection (confirms nothing changes when it should refuse), concurrency (two sessions, confirms the second blocks then proceeds against the first's post-commit state), partial-failure simulation (confirms a bad row aborts the *entire* batch, not just that row), cross-tenant isolation, authorization, audit log correctness.

## Migration execution status (all three, unexecuted)

- `20260803000000_role_level_rls_hardening.sql` — role_level enforcement on 5 tables + search_path pinning.
- `20260803000001_payroll_unique_constraint.sql` — the missing unique constraint.
- `20260803000002_payroll_atomic_process_rpc.sql` — the atomic RPC above.

None have run against any database (no reachable Docker/Supabase-local in this environment). See `AUDIT_REPORT.md`'s "Production deployment and rollback order" for the specific sequencing recommended before any of these reach production, and `e2e/authenticated/rls-policy-matrix.spec.ts` / the RPC's own staging test procedure for how to actually verify each one on staging first.

## Schema changes identified for the region/access-control model (documented only — see `SECURITY_REVIEW.md`)

Not implemented, per explicit instruction. Summary (full detail in `SECURITY_REVIEW.md`'s new section):
- **`profiles.employee_id`** (new column, nullable UUID → `employees(id)`) — needed regardless of any other decision, to make Staff-level "own payslip only" access mean anything at all. Currently there is no link between an auth account and an employee record.
- **A `profile_regions` join table** (or keep the existing single `profiles.region_id`) — depends entirely on whether Managers/Supervisors ever need more than one region at a time, which is a business question, not a technical one.
- **A real `workstations` table** (currently `employees.workstation` is free text) plus a `profile_workstations` join — needed only if Supervisor-level workstation authorization is to be enforced by more than string matching.

## Backup and rollback considerations

Unchanged from the first pass: the app's own backup/rollback Edge Functions are non-functional (`AUDIT_REPORT.md` A6); real backup/recovery depends entirely on whatever the Supabase project's own plan provides, unverified here. All three of this session's migrations are additive (new constraints/policies/functions, no data deletion or column drops) and each has a documented, low-risk rollback path.
