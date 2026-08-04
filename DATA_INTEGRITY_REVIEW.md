# Data Integrity Review — Safeguard HR & Payroll System

**Last updated:** 2026-08-04 (fourth pass — guard-ID and employee-number generation fixed via two new migrations, payroll RPC wired to the frontend). Static review of `supabase/migrations/*.sql`. No live database was available to run these against real data.

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
| Duplicate `employees` (employee_number) | Prevented (pre-existing) — **and now generated safely too**: `20260804000001_employee_number_generation.sql` adds a row-locked per-region-prefix counter (`employee_number_counters`), replacing the browser-only "highest existing + 1" calculation. Written, **not applied to any database**. |
| Duplicate guard IDs (`employees."guardId"`) | **FIXED this pass** (was "no unique constraint found," confirmed via `guardIdGeneration.test.ts` proving no de-dup state existed at the application layer either). `20260804000000_guard_id_generation.sql` adds `UNIQUE("guardId")` plus a Postgres `SEQUENCE`-backed generator function, seeded above every existing legacy value. Written, **not applied to any database**. |

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

**Update, this pass: NOW WIRED to `Payroll.tsx`.** The previous pass deliberately left this unwired to avoid a rollout-order hazard; this pass's explicit instruction was to wire it, so `src/utils/payrollProcessing.ts`'s `processPayrollBatch()` now calls this RPC from both `processPayroll()` and `copyFromPreviousMonth()`. **This creates a real, hard deployment-order dependency that did not exist before**: since this RPC has no client-side fallback (unlike the guard-ID/employee-number generators below), the migration **must** reach production no later than this frontend code does — see `AUDIT_REPORT.md`'s revised "Production deployment and rollback order."

## Guard ID and employee number generation (new this pass)

Both replace a client-side scheme with no real concurrency safety, following the same "extract, wire with a safe fallback, test" pattern used throughout this audit. Both migrations are written and **NOT applied to any database**.

**`20260804000000_guard_id_generation.sql`** — guard IDs were `` `G-${Math.floor(Math.random() * 1000)}` `` (and inconsistent variants), a ~9,000-value random range with zero uniqueness check anywhere; collision probability crosses 50% at ~112 guards. Fixed with:
- `UNIQUE("guardId")` on `employees`, added defensively first (surfaces any pre-existing legacy duplicate as a loud migration failure, not silently ignored).
- A real Postgres `SEQUENCE` (`guard_id_seq`), seeded strictly above the highest existing legacy `"guardId"` value across all tenants, so new IDs can never collide with old ones. `nextval()` is inherently concurrency-safe — two simultaneous callers are guaranteed distinct values by Postgres's own internal locking, a stronger guarantee than any client-side or hand-rolled scheme.
- `generate_guard_id()`, `SECURITY DEFINER` (needed only so any authenticated caller can advance the sequence; the function reads/writes no table of its own and needs no authorization check beyond that).
- **Frontend**: `generateGuardIdServerSide()` calls the RPC and **falls back to the original client-side generator on any error** (including "function does not exist") — this means wiring `Security.tsx` to call it now does **not** create a deployment-order hazard the way the payroll RPC does; the app just keeps its previous (working, if collision-prone) behavior until the migration is actually applied, then automatically gets the safer path with no further code change.

**`20260804000001_employee_number_generation.sql`** — employee numbers are scoped per region prefix (`SFG-N-001`, `SFG-S-001`, ... each region restarts its own count), so a single sequence doesn't fit the way it does for guard IDs, and regions are a dynamic, admin-editable table (can't pre-create a sequence for a prefix that doesn't exist yet). Fixed with:
- `employee_number_counters(tenant_id, prefix, last_number)`, a standard Postgres pattern for a dynamic set of independent counters.
- `generate_employee_number(region_id)`, `SECURITY DEFINER`, locks the specific counter row (`SELECT ... FOR UPDATE`) for the duration of its read-increment-write, serializing concurrent calls to the function for the same prefix. Seeds a prefix's counter from the highest existing legacy number the first time it's used.
- **Honest limitation, stated directly in the migration**: this makes the *calculation* safe under concurrent calls to the function, but does not make generate-then-insert-employee fully atomic, since the actual `employees` INSERT (many more fields — personal details, contract terms) still happens as a separate step from `Employees.tsx` afterward. The residual race window is guarded by the pre-existing `UNIQUE(tenant_id, employee_number)` constraint (see the row above) plus retry-on-conflict logic in `Employees.tsx`'s `addEmployee()` — which, on inspection, turned out to already exist from earlier work this session (`getNextEmployeeNumberForRegion` + a 5-attempt retry loop), now updated to call the RPC instead of duplicating the browser-side query inline.
- **Frontend**: same safe-fallback pattern as guard IDs — `generateEmployeeNumberServerSide()` falls back to the original browser-side calculation on any RPC error, so wiring it now is not a deployment-order hazard either.

Both have a full staging test procedure (consecutive generation, concurrent generation via a 200-500-call-in-one-session no-duplicates check, legacy-value collision safety) and rollback SQL included as comments in their respective migration files, and both now have a staging-gated integration test (`e2e/authenticated/rpc-workflow-matrix.spec.ts`) covering the RPC's format/increment behavior and that a real duplicate is rejected by the `UNIQUE` constraint.

**Rollback SQL** (included directly in the migration file):
```sql
REVOKE EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM authenticated;
DROP FUNCTION IF EXISTS process_payroll_batch(TEXT, JSONB, TEXT, JSONB);
```
Safe to run at any time — nothing calls this function yet, so dropping it affects no live code path.

**Staging test procedure** (also in the migration file, 8 scenarios): happy path, reprocessing, approved-month protection (confirms nothing changes when it should refuse), concurrency (two sessions, confirms the second blocks then proceeds against the first's post-commit state), partial-failure simulation (confirms a bad row aborts the *entire* batch, not just that row), cross-tenant isolation, authorization, audit log correctness.

## Migration execution status (all five, unexecuted)

- `20260803000000_role_level_rls_hardening.sql` — role_level enforcement on 5 tables + search_path pinning.
- `20260803000001_payroll_unique_constraint.sql` — the missing unique constraint.
- `20260803000002_payroll_atomic_process_rpc.sql` — the atomic RPC above. **Now wired to the frontend** — see the deployment-order note above.
- `20260804000000_guard_id_generation.sql` (new this pass) — guard ID sequence + unique constraint.
- `20260804000001_employee_number_generation.sql` (new this pass) — employee number counter table.

None have run against any database (no reachable Docker/Supabase-local in this environment). See `AUDIT_REPORT.md`'s "Production deployment and rollback order" for the specific sequencing recommended before any of these reach production, and each migration's own staging test procedure (plus `e2e/authenticated/rls-policy-matrix.spec.ts` / `rpc-workflow-matrix.spec.ts`) for how to actually verify each one on staging first.

## Schema changes identified for the region/access-control model (documented only — see `SECURITY_REVIEW.md`)

Not implemented, per explicit instruction. Summary (full detail in `SECURITY_REVIEW.md`'s new section):
- **`profiles.employee_id`** (new column, nullable UUID → `employees(id)`) — needed regardless of any other decision, to make Staff-level "own payslip only" access mean anything at all. Currently there is no link between an auth account and an employee record.
- **A `profile_regions` join table** (or keep the existing single `profiles.region_id`) — depends entirely on whether Managers/Supervisors ever need more than one region at a time, which is a business question, not a technical one.
- **A real `workstations` table** (currently `employees.workstation` is free text) plus a `profile_workstations` join — needed only if Supervisor-level workstation authorization is to be enforced by more than string matching.

## Backup and rollback considerations

Unchanged from the first pass: the app's own backup/rollback Edge Functions are non-functional (`AUDIT_REPORT.md` A6); real backup/recovery depends entirely on whatever the Supabase project's own plan provides, unverified here. All five of this session's migrations are additive (new constraints/policies/functions/tables, no data deletion or column drops) and each has a documented, low-risk rollback path.
