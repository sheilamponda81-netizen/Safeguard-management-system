# Staging Validation Plan — Safeguard HR & Payroll System

**Branch:** `audit/full-system-hardening` (PR #36, draft)
**Purpose:** everything required to actually execute staging validation for
this branch, without executing any of it here. This environment has no
Supabase dashboard/Auth Admin API access, no reachable staging database, and
no Vercel dashboard access — every item below is either a checklist for
whoever does have that access, or material (SQL, test files, credential
lists) already prepared and waiting for that access to exist.

**No passwords, API keys, tokens, or private employee data appear anywhere
in this document.** Every credential this plan needs is named by its env
var / role, never by its actual value. Every synthetic data example is
fabricated, following the same `ZZSTAGING_`-prefixed convention already used
in `supabase/staging-seed/`.

**This plan does not authorize merging, deploying, applying migrations,
modifying production data, or running any staging test.** It is preparation
only, per this pass's explicit instruction. See "What this plan is not" at
the end.

---

## 1. Required Supabase staging project setup

1. A **separate** Supabase project from production — not a schema/branch
   inside the same project. Confirm this before doing anything else; a
   "staging" that shares a database with production is not staging.
2. Apply this repo's migrations to it, in the exact order in §5 below
   (oldest-timestamp-first — Supabase's own migration tooling does this
   automatically if you `supabase db push` in the normal way; the order
   matters if applying by hand).
3. Confirm `supabase/migrations/20260727000000_reconstructed_base_schema.sql`
   actually matches this staging project's real schema — that file's own
   header notes it is a **reconstruction** derived from reading application
   code, not exported from a real database, and may not match column-for-
   column. Diff before trusting it.
4. Generate real TypeScript types once the project exists (not done anywhere
   in this repo yet — see `AUDIT_REPORT.md`'s "Supabase generated types"
   section):
   ```bash
   npx supabase login
   npx supabase gen types typescript --project-id <STAGING_PROJECT_REF> > src/types/database.types.ts
   ```
   Never run this against the production project reference.
5. Seed synthetic data — see §4 below; the template already exists at
   `supabase/staging-seed/`.

## 2. Required Vercel Preview environment setup

1. Confirm (Vercel dashboard → Project Settings → Environment Variables)
   that the **Preview** environment's `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY` point at the **staging** Supabase project from
   §1, not production. This is currently **unconfirmed** — see §7, gate 4.
2. Confirm no `SUPABASE_SERVICE_ROLE_KEY` (or any other server-only secret)
   is assigned to a `VITE_`-prefixed variable in any environment — a
   `VITE_`-prefixed var is bundled into the client and shipped to every
   browser. Confirmed by static grep that the frontend code itself never
   reads such a variable (`AUDIT_REPORT.md` item 4), but the Vercel
   dashboard's actual variable assignments still need a human check.
3. Once confirmed, this branch's own preview deployment URL becomes safe to
   use for the E2E `E2E_BASE_URL` value (§3) and for manual click-through
   testing. **Until confirmed, treat every preview URL for this branch as
   unsafe for any mutation** — read-only browsing only.

## 3. Required test accounts

Minimum (already required by `e2e/fixtures.ts`, `REQUIRED_VARS`) — 4 accounts
in **Tenant A**, all in the **same region**:

| Role | role_level | Purpose |
|---|---|---|
| Admin | 1 | full tenant access, payroll processing, settings |
| Manager | 2 | payment_status/terminal_dues/applicants write access, no payroll processing |
| Supervisor | 3 | attendance/security-page access, denied payroll/payment/terminal-dues writes |
| Staff | 4 | most restricted; self-service only once A17 is fixed (see §6) |

Recommended, to unlock currently-skipped test scenarios (`e2e/fixtures.ts`'s
`getSecondRegionAdmin()` / `getTenantBAdmin()`, both optional — tests using
them self-skip with a named reason if absent, so staging can start without
these and add them later without touching test code again):

| Role | Purpose | Env var pair |
|---|---|---|
| Admin, Tenant A, **second region** | region-isolation testing once §6's policy exists | `E2E_ADMIN2_EMAIL` / `E2E_ADMIN2_PASSWORD` |
| Admin, **Tenant B** (separate tenant) | cross-tenant isolation testing (already exercised by the new "payload employee_id belonging to a different tenant" test) | `E2E_TENANT_B_ADMIN_EMAIL` / `E2E_TENANT_B_ADMIN_PASSWORD` |

## 4. Required tenants, regions, workstations, synthetic data

Already templated in `supabase/staging-seed/` (not run anywhere — see that
directory's own README for the manual auth-user-creation step it cannot do
itself):

- **2 tenants** (`ZZSTAGING_TenantA`, `ZZSTAGING_TenantB`) — for cross-tenant
  isolation testing.
- **2 regions per tenant** (4 total) — for region-isolation testing once §6's
  policy exists; the seed provides the *data*, not the policy.
- **8 auth-backed profiles** (Admin/Manager/Supervisor/Staff × 2 tenants).
- **Workstations**: not a real table yet (`employees.workstation` is free
  text — see §6, Supervisor row). Seed a handful of distinct workstation
  string values per region so a future workstation-scoping policy has
  something realistic to filter against.
- Synthetic **employee data**: a handful of guards + office staff per
  tenant/region, matching the existing `positions` categories
  (`security`/`office`/etc.), with `requires_uniform` set on at least one
  position of each kind (true and false) to exercise the uniform-eligibility
  logic.
- Synthetic **payroll data**: at least one processed month per tenant,
  including one row with `approval_status = 'approved'` (to exercise the
  "approved month cannot be reprocessed" test) and one employee with a `0`
  `uniform_deduction` (to exercise the falsy-zero-bug regression fixed in
  `Payroll.tsx`'s `calculatePayroll`).
- Synthetic **attendance data**: enough rows in the current month to produce
  a non-zero absent/late count for at least one employee, so payroll's
  live-attendance-deduction path (§ "Automatic attendance deductions" in the
  payroll accuracy overhaul, already implemented — see `git log`, commit
  `347b066`) has something real to compute against.
- Synthetic **security-personnel data**: guard-specific columns
  (`guardId`, shift, uniform size) populated for at least 2 guards per
  tenant, to exercise `generate_guard_id()`'s legacy-value-safety check
  (§5, migration `20260804000000`).

## 5. Test-data naming convention

Already established, do not deviate: **`ZZSTAGING_`** prefix on every
human-readable field (full name, email local-part, employee number, guard
ID, applicant name) — see `supabase/staging-seed/README.md`. E2E tests
written in this pass follow the same spirit with their own disposable-row
prefixes (`E2E-TEST-`, `SFG-E2E-*`, `E2E Test Employee`, etc.) so staging-run
test data and seed-script data are both trivially distinguishable from any
real record by a single `LIKE` pattern.

## 6. Cleanup procedure

1. **Automated, per-test**: every test in `e2e/authenticated/*.spec.ts`
   deletes its own disposable rows in an `afterAll`/inline cleanup step
   (`createdEmployeeIds` array + a final `.delete().in('id', ...)`, or an
   immediate delete right after each assertion) — confirmed by reading both
   spec files; no test leaves synthetic data behind on a normal pass. A
   test that fails mid-way (e.g. an assertion throws before cleanup runs)
   can leave a row behind — since everything is `ZZSTAGING_`/`E2E-`-prefixed,
   a periodic sweep (`DELETE FROM employees WHERE full_name LIKE 'E2E %'`,
   etc.) is a safe backstop.
2. **Bulk, seed-level**: `supabase/staging-seed/cleanup_staging_data.sql` —
   deletes everything the seed script created, by prefix, in FK-safe order
   (children before parents). Tenants/regions/profiles themselves are left
   alone by default (commented out in the script) so a cleanup run resets
   *data* between test passes without needing to recreate the 8 auth users
   each time; uncomment those sections only for a full teardown.
3. Never run either cleanup path against production — both are scoped by
   the `ZZSTAGING_`/`E2E-` prefixes specifically so a mistaken run against
   the wrong database deletes nothing (no real record will ever match those
   patterns), but confirm the target project/connection string before
   running regardless.

## 7. Backup procedure

Per `AUDIT_REPORT.md` Finding A6 and `SECURITY_REVIEW.md §"Backup and
recovery"`: this application has **no working backup/restore of its own**
(the `supabase/functions/backup` edge function is an unfinished stub, never
wired to any frontend code path). The only backup that exists is whatever
Supabase's own platform provides for the project's specific paid tier
(automatic physical backups, PITR on paid plans) — **unverified from this
environment**, confirmed neither present nor absent. Before running any
migration against staging (§8) or, later, production:
1. Confirm in the Supabase dashboard (Project Settings → Database →
   Backups) what backup/PITR tier the target project is actually on.
2. If staging is a fresh, empty project, this is low-stakes (nothing to
   lose). If staging is later seeded with anything resembling real data, or
   before any of this is repeated against production, take a manual
   snapshot/export first and confirm a restore has actually been tested at
   least once — "Supabase generally offers this" is not the same claim as
   "this project has it configured and a tested restore," and only the
   project owner can confirm the second from the dashboard.

## 8. Migration order and commands (written, NOT executed)

Apply in this exact order — oldest timestamp first, matching the filenames
already in `supabase/migrations/`:

1. `20240618000000_create_indexes.sql`
2. `20240619000000_tenant_isolation.sql`
3. `20240619000001_create_tenants.sql`
4. `20260727000000_reconstructed_base_schema.sql`
5. `20260727000001_security_hardening.sql`
6. `20260728000000_position_uniform_flag.sql`
7. `20260730000000_company_logo_storage.sql`
8. `20260803000000_role_level_rls_hardening.sql`
9. `20260803000001_payroll_unique_constraint.sql`
10. `20260803000002_payroll_atomic_process_rpc.sql`
11. `20260804000000_guard_id_generation.sql`
12. `20260804000001_employee_number_generation.sql`
13. `20260804000002_applicant_dashboard_counts_rpc.sql` — **Phase 1 / EXPAND**
14. `20260804000003_restrict_applicants_select.sql` — **Phase 2 / CONTRACT**

**Correction to this document's own prior claim:** an earlier version of
this section stated "migrations 1–7 are inherited/pre-existing." That was
checked directly against `main` via `git diff --name-status main...HEAD --
supabase/migrations/` during a later investigation pass and found to be
**wrong** — only migrations **1–3** actually exist on `main` (the PR's base
branch); migrations **4–14** are all new, added by this PR. Corrected here
rather than silently left stale, consistent with this whole audit's own
standing rule against carrying forward an unverified number.

**Standard command for all of them**, once a staging project exists and its
connection is confirmed:
```bash
npx supabase db push          # applies every not-yet-applied migration, in order
# or, one at a time:
psql "$STAGING_DATABASE_URL" -f supabase/migrations/<file>.sql
```

**Migrations 13–14 are a deliberate 2-phase (expand/contract) rollout, not
independent migrations** — see §8g/§8h below for why, and do not apply #14
until its own precondition checklist (frontend deployment confirmed live)
is satisfied. This is the one place in this migration set where "apply
everything in order, back to back" is explicitly NOT the safe procedure —
every other migration here is safe to apply immediately after the one
before it.

**Per-migration detail** (preflight / command / verification / rollback /
expected output / failure conditions / locking / data-loss / reversibility)
for the migrations written and reviewed during this audit's own passes —
each one's own file also carries this exact SQL as inline comments,
extracted here rather than re-derived, consistent with
`DATA_INTEGRITY_REVIEW.md`'s own migration-safety table:

### 8a. `20260730000000_company_logo_storage.sql`

- **Purpose:** creates the `company-logo` public storage bucket for
  Settings → Company's logo upload.
- **VERIFIED deployment rule (business decision, this pass):**
  - **SELECT (read): public**, unrestricted — unchanged. The logo is
    shown pre-login (Login.tsx) and in the authenticated Sidebar/Payslips;
    it is not sensitive data.
  - **INSERT/UPDATE/DELETE (write): Admin (role_level 1) / Manager
    (role_level 2) / Super Admin only.** The original version of this
    migration allowed *any authenticated user* to write — that was wider
    than the app's own UI ever permits (the upload control lives on
    Settings → Company, role_level 1 only per `rolePages`) and let a
    Supervisor/Staff account replace or delete the shared logo file via a
    direct API call. Fixed using the same two helper functions every
    other role-aware policy in this schema uses, schema-qualified since
    storage policies don't default to the `public` search_path:
    `public.is_super_admin() = true OR public.current_user_role_level() <= 2`.
- **Preflight:** none needed — bucket/policy creation only, no existing
  data touched.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260730000000_company_logo_storage.sql`
- **Verification:**
  ```sql
  SELECT policyname, cmd FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname LIKE '%company logo%' ORDER BY cmd;
  -- expected: SELECT = "Public read access for company logo";
  -- INSERT/UPDATE/DELETE = "Admins and managers can ... company logo"
  ```
- **Dependencies:** `public.current_user_role_level()`, defined in
  `20260727000001_security_hardening.sql` (dated/ordered before this
  migration, so already satisfied by this repo's own migration order).
- **Locking risk:** brief catalog lock only, no table scan.
- **Data-loss risk:** none.
- **Rollback fully reversible?** **Yes** — widens write access back to any
  authenticated user; exact rollback SQL is in the migration file's own
  comments. Does not affect the stored logo file itself.

### 8b. `20260803000000_role_level_rls_hardening.sql`

- **VERIFIED deployment rule:** closes role-level policy gaps on
  `payment_status` (SELECT/DELETE now role-restricted, was tenant-wide),
  `terminal_dues` (same), `employee_deductions` (DELETE now super-admin
  only), `system_settings` (DELETE now super-admin only), and `applicants`
  (INSERT/UPDATE/DELETE role_level ≤ 2 — unchanged from the original
  version of this file). **This migration deliberately does NOT restrict
  `applicants` SELECT** — that specific change depends on a counts-only
  RPC existing first (Dashboard.tsx's recruitment-count tile needs it) and
  is its own, later migration — see §8g/§8h. Bundling it here would risk
  a real deployment-ordering hazard (Staff/Supervisor losing direct
  `applicants` access with no working RPC substitute yet).
- **Preflight:** none needed — adds/replaces policies and pins function
  `search_path`s; no constraint added that could fail against existing data.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260803000000_role_level_rls_hardening.sql`
- **Verification:**
  ```sql
  SELECT tablename, policyname, cmd FROM pg_policies
    WHERE tablename IN ('payment_status','terminal_dues','system_settings','employee_deductions','applicants','payroll','employees')
    ORDER BY tablename, cmd;
  -- confirm every expected policy name from the file is present
  SELECT proname, proconfig FROM pg_proc
    WHERE proname IN ('get_current_tenant_id','is_super_admin','current_user_role_level','prevent_profile_privilege_escalation');
  -- expected: proconfig contains 'search_path=public, pg_temp' for all 4
  ```
- **Expected output:** policy list matches the file's own `CREATE POLICY`
  statements; all 4 functions show the pinned `search_path`; `applicants`
  SELECT policy is still the pre-existing tenant-wide one (unchanged by
  this file).
- **Failure conditions:** none expected — no data-dependent constraint.
- **Locking risk:** brief `ACCESS EXCLUSIVE` per policy change (catalog
  update only, no table scan) — near-instantaneous, still recommend a
  low-traffic window since it's an authorization change.
- **Data-loss risk:** none.
- **Rollback fully reversible?** **No, not trivially** — the DROP POLICY
  statements in this migration don't preserve the prior policy's exact SQL
  text. A rollback must re-create each dropped policy using its *original*
  `CREATE POLICY` statement, sourced from `20240619000000_tenant_isolation.sql`
  / `20260727000001_security_hardening.sql`. No data is at risk either way —
  only who can read/write changes — but this is the one rollback in the set
  that needs lookup work first, not a one-liner.

### 8c. `20260803000001_payroll_unique_constraint.sql`

- **Preflight:**
  ```sql
  SELECT employee_id, month, COUNT(*) FROM payroll
    GROUP BY employee_id, month HAVING COUNT(*) > 1;
  -- expected: 0 rows. Any row = a real pre-existing duplicate that must be
  -- manually resolved (keep the most recently approved/processed row) BEFORE
  -- this migration will apply successfully.
  ```
- **VERIFIED STAGING status (reported by the person with STAGING access,
  not independently re-run from this environment — no STAGING credentials
  exist here):**
  ```
  current_payroll_rows        = 450
  unique_employee_month_pairs = 450
  remaining_duplicate_groups  = 0
  safety backup rows          = 450
  ```
  These four numbers matching (450/450/0/450) is consistent with the
  preflight above already returning 0 rows in STAGING today, and with a
  450-row safety backup having been taken before whatever cleanup produced
  this state. **This is STAGING-only evidence, reported to this session,
  not evidence this session independently generated or verified against a
  live database.**
  **Do not treat this as proof for production.** Production has its own,
  independent data history and requires its own fresh preflight run
  immediately before this migration is ever applied there — a clean
  STAGING result says nothing about production's current duplicate-row
  state.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260803000001_payroll_unique_constraint.sql`
- **Verification:** `SELECT conname FROM pg_constraint WHERE conname = 'payroll_employee_month_unique';` — expected 1 row.
- **Expected output:** constraint created; second/duplicate run fails loudly (not silently).
- **Failure conditions:** `ERROR: constraint ... already exists` on a re-run
  (safe, not destructive — no action needed); constraint creation itself
  fails if the preflight query returns any row.
- **Locking risk:** `ACCESS EXCLUSIVE` on `payroll` for the full validation
  scan — blocks all reads/writes on that table for every session, including
  the app, until the scan completes. Expected sub-second to a few seconds
  for a realistic HR-payroll table size; apply during low-traffic only,
  never during active payroll processing.
- **Data-loss risk:** none — adds a constraint only.
- **Rollback fully reversible?** **Yes** — `ALTER TABLE payroll DROP CONSTRAINT IF EXISTS payroll_employee_month_unique;` — safe at any time, though it re-opens the duplicate-row risk this migration exists to close.

### 8d. `20260803000002_payroll_atomic_process_rpc.sql`

- **Preflight:** none specific to this migration itself (creates/replaces a
  function only) — the actual data guard is 8c's own constraint; run 8c's
  preflight, not a separate one here.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260803000002_payroll_atomic_process_rpc.sql`
- **Verification:**
  ```sql
  SELECT proname, prosecdef FROM pg_proc WHERE proname = 'process_payroll_batch';
  -- expected: 1 row, prosecdef = true
  SELECT has_function_privilege('authenticated', 'process_payroll_batch(text, jsonb, text, jsonb)', 'EXECUTE');
  -- expected: true
  SELECT has_function_privilege('anon', 'process_payroll_batch(text, jsonb, text, jsonb)', 'EXECUTE');
  -- expected: false (confirms anonymous callers cannot reach it at all)
  ```
- **Expected output:** function exists, `SECURITY DEFINER` confirmed,
  `authenticated`-only execute grant confirmed.
- **Failure conditions:** none expected — pure function definition change.
- **Locking risk:** none (function redefinition only, no table scan).
- **Data-loss risk:** none — modifies no existing data or constraint.
- **Rollback fully reversible?** **Yes:**
  ```sql
  REVOKE EXECUTE ON FUNCTION process_payroll_batch(TEXT, JSONB, TEXT, JSONB) FROM authenticated;
  DROP FUNCTION IF EXISTS process_payroll_batch(TEXT, JSONB, TEXT, JSONB);
  ```
  Safe at any time **unless** the frontend commit that calls this RPC
  (`src/utils/payrollProcessing.ts`) has already reached that environment —
  this RPC has no client-side fallback, so dropping it while the frontend
  still calls it breaks payroll processing outright. Roll back the frontend
  commit first, per `AUDIT_REPORT.md`'s deployment-order note.
- **Staging test procedure** (11 scenarios, full detail in the migration
  file itself, now backed by real executable tests in
  `e2e/authenticated/rpc-workflow-matrix.spec.ts`): happy path, idempotent
  reprocess, approved-month protection, 2-way and 10-way concurrency,
  partial-failure rollback, cross-tenant rejection, Staff-authorization
  rejection, duplicate-employee-id-in-payload rejection, negative-monetary
  rejection (with legitimate-negative-net_pay allowed), rounding, audit-log
  correctness.

### 8e. `20260804000000_guard_id_generation.sql`

- **Preflight:**
  ```sql
  SELECT tenant_id, "guardId", COUNT(*) FROM employees
    WHERE "guardId" IS NOT NULL
    GROUP BY tenant_id, "guardId" HAVING COUNT(*) > 1;
  -- expected: 0 rows. Any row = a real pre-existing duplicate guardId within
  -- one tenant that must be manually corrected first.
  ```
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260804000000_guard_id_generation.sql`
- **Verification:**
  ```sql
  SELECT proname, prosecdef FROM pg_proc WHERE proname = 'generate_guard_id';
  -- expected: 1 row, prosecdef = true
  SELECT has_function_privilege('authenticated', 'generate_guard_id()', 'EXECUTE');
  -- expected: true
  SELECT conname FROM pg_constraint WHERE conname = 'employees_tenant_guard_id_unique';
  -- expected: 1 row
  ```
- **Expected output:** function + constraint both present as above.
- **Failure conditions:** the guarded `ADD CONSTRAINT` fails only if the
  preflight query above would have returned a row (existing cross-tenant-
  scoped duplicate).
- **Locking risk:** `ACCESS EXCLUSIVE` on `employees`, briefly, for the
  guarded constraint add (validates existing values) — brief given a
  realistic HR-system table size.
- **Data-loss risk:** none — adds new objects + a constraint on existing
  data, nothing dropped or deleted.
- **Rollback fully reversible?** **Yes:**
  ```sql
  REVOKE EXECUTE ON FUNCTION generate_guard_id() FROM authenticated;
  DROP FUNCTION IF EXISTS generate_guard_id();
  DROP POLICY IF EXISTS guard_id_counters_tenant_select ON guard_id_counters;
  DROP TABLE IF EXISTS guard_id_counters;
  ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_tenant_guard_id_unique;
  ```
  Safe at any time — the frontend's `generateGuardIdServerSide()` wrapper
  falls back to the original client-side generator on any RPC error,
  including "function does not exist," so there is no hard deployment-order
  dependency the way there is for 8c. Roll back the frontend commit first
  anyway, as good practice.
- **Staging test procedure** (in the migration file): consecutive
  generation, 2-simultaneous-request concurrency (now also covered by
  `e2e/authenticated/rpc-workflow-matrix.spec.ts`'s new "2 concurrent
  requests" test, in addition to the pre-existing 10-simultaneous test),
  10-simultaneous, and a legacy-value-non-collision check.

### 8f. `20260804000001_employee_number_generation.sql`

- **Preflight:**
  ```sql
  SELECT tenant_id, employee_number, COUNT(*) FROM employees
    GROUP BY tenant_id, employee_number HAVING COUNT(*) > 1;
  -- expected: 0 rows -- this migration doesn't add the UNIQUE constraint
  -- itself (it already exists from the base schema), but this function
  -- assumes it's enforced; a row here means that constraint isn't doing
  -- its job and must be investigated first.
  ```
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260804000001_employee_number_generation.sql`
- **Verification:**
  ```sql
  SELECT proname, prosecdef FROM pg_proc WHERE proname = 'generate_employee_number';
  -- expected: 1 row, prosecdef = true
  SELECT has_function_privilege('authenticated', 'generate_employee_number(uuid)', 'EXECUTE');
  -- expected: true
  SELECT * FROM employee_number_counters LIMIT 5;
  -- expected: succeeds, 0 rows immediately after migration (rows created lazily per prefix's first real call)
  ```
- **Expected output:** function + empty counter table present as above.
- **Failure conditions:** none expected — this migration only creates a new,
  initially-empty table and a function; no `ADD CONSTRAINT` of its own.
- **Locking risk:** none beyond the new table's own creation (fast, starts empty).
- **Data-loss risk:** none.
- **Rollback fully reversible?** **Yes:**
  ```sql
  REVOKE EXECUTE ON FUNCTION generate_employee_number(UUID) FROM authenticated;
  DROP FUNCTION IF EXISTS generate_employee_number(UUID);
  DROP POLICY IF EXISTS employee_number_counters_tenant_select ON employee_number_counters;
  DROP TABLE IF EXISTS employee_number_counters;
  ```
  Same no-hard-dependency reasoning as 8d — the frontend wrapper falls back
  to the original browser-side calculation on any RPC error.
- **Staging test procedure** (in the migration file): sequential generation,
  independent-per-region-prefix counters, 2-simultaneous-request
  concurrency (now also covered by the new "2 concurrent requests" e2e
  test), 10-simultaneous, legacy-numbering-gap safety (seed from `MAX`, not
  `COUNT`).

**General ordering rule across 8d–8f** (from `DATA_INTEGRITY_REVIEW.md`):
roll back the **frontend** commit that calls a given RPC before dropping
that RPC's function — dropping a function a deployed frontend is still
actively calling turns a planned rollback into an outage.

### 8g. `20260804000002_applicant_dashboard_counts_rpc.sql` — PHASE 1 / EXPAND

- **VERIFIED deployment rule:** creates `get_applicant_dashboard_counts()`,
  a `SECURITY DEFINER` RPC returning ONLY 3 aggregate integers (pending/
  shortlisted/interviewed applicant counts) — no applicant name, email,
  phone, notes, interview detail, decision, or id, ever. Callable by
  every `role_level` (1–4); tenant-scoped internally via
  `get_current_tenant_id()`/`is_super_admin()`, never from a client
  parameter. **Purely additive — does not touch `applicants`' existing
  (tenant-wide) SELECT policy.**
- **MUST be applied BEFORE the Dashboard.tsx build that calls this RPC is
  deployed** — a frontend calling an RPC that doesn't exist yet fails
  outright (`function get_applicant_dashboard_counts does not exist`),
  same class of hard dependency as `process_payroll_batch` (8d) but with
  no client-side fallback written for this one either.
- **Preflight:** none — new function only, no existing data/constraint
  touched.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260804000002_applicant_dashboard_counts_rpc.sql`
- **Verification:**
  ```sql
  SELECT proname, prosecdef FROM pg_proc WHERE proname = 'get_applicant_dashboard_counts';
  -- expected: 1 row, prosecdef = true
  SELECT has_function_privilege('authenticated', 'get_applicant_dashboard_counts()', 'EXECUTE');
  -- expected: true
  SELECT has_function_privilege('anon', 'get_applicant_dashboard_counts()', 'EXECUTE');
  -- expected: false
  ```
- **Locking risk:** none beyond the function-definition catalog lock.
- **Data-loss risk:** none.
- **Rollback fully reversible?** Yes, but only safe once the frontend that
  calls it is rolled back first — same reasoning as 8d.

### 8h. `20260804000003_restrict_applicants_select.sql` — PHASE 2 / CONTRACT

- **VERIFIED deployment rule:** narrows `applicants` SELECT (full row
  access) from tenant-wide to `role_level ≤ 2 OR is_super_admin()` — final
  state: **direct `applicants` SELECT = Admin / Manager / Super Admin
  only.** INSERT/UPDATE/DELETE on `applicants` are unaffected (already
  restricted by 8b).
- **MUST NOT be applied until ALL of the following are true (this
  migration's own file carries the same checklist):**
  1. `20260804000002` (8g, above) has been applied to this database.
  2. The `Dashboard.tsx` build that calls `get_applicant_dashboard_counts()`
     is confirmed the one actually live for all traffic to this
     environment — no stale/cached old build still doing a direct
     `applicants` count SELECT.
  3. A Supervisor or Staff test account has been manually confirmed to see
     correct recruitment counts on the Dashboard, via the RPC, BEFORE this
     migration is applied.
  Applying this migration before all three hold silently breaks the
  Dashboard's recruitment-count tile for every Supervisor/Staff user (an
  empty SELECT result, not an error — nothing in the UI would indicate
  why).
- **Preflight:** none — policy change only.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260804000003_restrict_applicants_select.sql`
- **Verification:**
  ```sql
  SELECT policyname, cmd FROM pg_policies WHERE tablename = 'applicants' ORDER BY cmd;
  -- expected: SELECT/INSERT/UPDATE/DELETE all = "Managers can ... applicants in their tenant"
  -- As Supervisor/Staff: SELECT * FROM applicants LIMIT 1;              -- expect 0 rows
  -- As Supervisor/Staff: SELECT * FROM get_applicant_dashboard_counts(); -- expect a real row (RPC bypasses RLS)
  ```
- **Locking risk:** brief catalog lock only.
- **Data-loss risk:** none.
- **Rollback fully reversible?** Yes, independently of 8g — widens
  `applicants` SELECT back to tenant-wide without removing the RPC.

### 8i. `20260813000000_salary_advances_schema.sql`

- **BUSINESS RULE (revised across several drafts — "1 open advance", then
  "sum of independent rates", then this pass's own correction — a
  `pending` APPLICATION is not active debt):** an employee may have **UP
  TO TWO** simultaneously `pending`/`active` salary advances. A plain
  `UNIQUE` index can express "at most one" but not "at most two," so this
  migration does NOT use an index for the count limit — see the
  "concurrency-safe RPCs" bullet below. `create_salary_advance()` inserts
  a `pending` APPLICATION only — it counts toward the max-2 limit and is
  visible in the UI, but is not yet debt: it does not touch the combined
  plan and is never picked up by payroll. `approve_salary_advance()` is
  the ONLY path from `pending` to `active`, and it is the SOLE moment the
  combined plan is established or updated — **when two advances are
  active, there is exactly ONE COMBINED monthly deduction figure for the
  employee's total outstanding balance**, never the sum of each advance's
  own independently-configured rate, and approving a SECOND advance onto
  an existing plan REQUIRES the caller to explicitly supply new combined
  terms (management action, not silent reuse of the first advance's plan).
- **VERIFIED deployment rule:** creates FOUR new tables —
  `salary_advances` (application terms AS ORIGINALLY APPLIED FOR +
  lifecycle status — immutable history once inserted, see the guard
  trigger below), `salary_advance_deductions` (the append-only repayment
  ledger, one row per `(salary_advance_id, payroll_month)` actually
  deducted, enforced by a `UNIQUE(salary_advance_id, payroll_month)`
  constraint), `salary_advance_repayment_plans` (**the ONE current,
  living combined plan per employee** — `UNIQUE(employee_id)`; a
  dedicated table rather than fields duplicated onto both open advances,
  specifically so "what was originally applied for" (immutable, per
  advance) never blurs with "what's currently being deducted" (living,
  per employee) — see the migration's own "WHY A DEDICATED PLAN TABLE"
  header note), and `salary_advance_repayment_plan_changes` (audit
  history for combined-plan changes, both at second-advance approval and
  for the later "Edit / Adjust Repayment Plan" action, employee-scoped).
  All four start empty; no existing table, column, or row is touched. RLS
  is enabled on all four: `salary_advances` gets SELECT/UPDATE for
  `role_level ≤ 2 OR is_super_admin()` and DELETE restricted to
  super-admin only, and **deliberately has NO INSERT policy at all** (see
  below); the other three each get a SELECT-only policy for the same role
  set and **deliberately no INSERT/UPDATE/DELETE policy at all** — all
  three are written exclusively by `SECURITY DEFINER` functions (the
  ledger by `process_payroll_batch()`, the plan table and change-history
  table by `approve_salary_advance()`/`adjust_combined_repayment_plan()`
  as applicable), which bypass RLS for their own writes — the same "only
  one function may write here" pattern already used for
  `guard_id_counters`/`employee_number_counters`.
  **SAFETY REVIEW CONFIRMATION (re-audited, this pass, specifically for
  `salary_advance_repayment_plans`/`salary_advance_repayment_plan_changes`):**
  no INSERT, UPDATE, or DELETE policy exists on either table for ANY role,
  including Admin/Manager/super-admin — a direct `supabase-js`
  `.insert()`/`.update()`/`.delete()` call against either table is
  rejected by RLS outright for every role, with no bypass. Both tables are
  writable ONLY via `approve_salary_advance()`/
  `adjust_combined_repayment_plan()` (and, for the ledger analog,
  `process_payroll_batch()`), which are `SECURITY DEFINER` and bypass RLS
  for their own writes only. This is proven directly (not just asserted)
  by two dedicated e2e tests in `e2e/authenticated/salary-advances-matrix.spec.ts`'s
  RLS describe block, each covering INSERT + UPDATE + DELETE for BOTH
  Admin and Manager, immediately followed by proof that the authorized RPC
  path still succeeds.
- **Concurrency-safe RPCs, not a UNIQUE index, enforce the max-2 rule; a
  dedicated pair of RPCs, not a shared one, enforce the
  single-combined-plan rule — split across APPLICATION and APPROVAL:**
  - `create_salary_advance()` — the ONLY way to create a new advance,
    always as a `pending` APPLICATION. An employee-scoped
    `pg_advisory_xact_lock` + `SELECT COUNT(*) ... WHERE status IN
    ('pending','active')` check inside one `SECURITY DEFINER` transaction
    rejects a 3rd. **Authorization (`is_super_admin() OR
    current_user_role_level() <= 2`) is enforced INSIDE the function body
    itself** — since there is no INSERT RLS policy to also fall back on,
    this in-function check is the sole gate; an authenticated
    Supervisor/Staff session calling the RPC directly fails with an
    explicit exception. **This function never creates or refreshes
    `salary_advance_repayment_plans` and is never picked up by payroll —
    a pending application is a request, not debt.**
  - `approve_salary_advance()` — the ONLY path from `pending` to `active`,
    same authorization gate as `create_salary_advance()`. Locks the target
    advance row, verifies it is still `pending` and belongs to the
    caller's tenant, takes the same employee-scoped advisory lock, then
    computes the employee's ACTIVE outstanding balance (across every OTHER
    `'active'` advance) plus this advance's own amount. If this is the
    employee's FIRST active advance, it establishes the combined plan from
    the advance's own (optionally overridden) terms. **If the employee
    already has an active advance, the caller MUST supply explicit new
    combined terms (method + monthly amount or period) — the RPC raises
    an exception rather than silently reusing or leaving the old plan.**
    Writes a `salary_advance_repayment_plan_changes` audit row whenever an
    EXISTING plan is changed (not on first establishment — there is no
    "previous" state to record). Sets a transaction-local flag
    (`app.allow_salary_advance_approval`) immediately before its own
    `status = 'active'` UPDATE — this is what the guard trigger below
    checks to reject the same transition via any other path. Both the
    plan upsert and the status transition happen inside this one RPC
    invocation (one Postgres transaction), so there is no observable
    intermediate state where the advance is active but the plan is stale.
  - `adjust_combined_repayment_plan()` — the LATER "Edit / Adjust
    Repayment Plan" action, EMPLOYEE-scoped (not advance-scoped), for
    changing an already-established plan's terms independently of
    approving a new advance. Recomputes FUTURE terms only, from the
    employee's current TOTAL derived outstanding balance across every
    `'active'` advance — never any single advance's own original amount.
    Never writes to `salary_advances` or `salary_advance_deductions`.
    Requires a plan to already exist (raises otherwise — use
    `approve_salary_advance()` to establish the first one). Never allows
    the new start month to move earlier than the month after the last
    already-posted deduction for ANY of the employee's advances. Writes an
    audit row to `salary_advance_repayment_plan_changes`.
  - Two `BEFORE UPDATE` triggers on `salary_advances` provide defense in
    depth beyond the RPC-only design:
    - `guard_salary_advance_plan_terms` — an advance's original
      application-term columns (amount, method, monthly deduction,
      period, start/payoff month) are now **permanently immutable** after
      insert, full stop, no bypass — nothing legitimate needs to change
      them post-creation now that the combined plan table is what payroll
      actually reads from.
    - `guard_salary_advance_status_transition` — defines and enforces the
      full lifecycle state machine at the database level (see "LIFECYCLE
      / STATUS INTEGRITY" below): `pending -> active` ONLY when
      `approve_salary_advance()`'s own transaction-local flag is set (a
      direct `UPDATE`, even by Admin, is rejected); `pending ->
      rejected|cancelled` freely; `active -> paid` ONLY if the derived
      outstanding balance (recomputed from `salary_advance_deductions`
      inside the trigger, never trusted from the caller) is exactly zero;
      **`active -> cancelled` is NOT permitted — there is no
      write-off/cancellation path once an advance is approved, since no
      business-approved settlement process exists yet** (a future one
      must be a separate, explicitly audited workflow — not silently
      reintroduced here); `paid`/`rejected`/`cancelled` are terminal — no
      further transition, by anyone, including super-admin.
- **Independent of the 8g/8h applicant expand/contract pair above** — this
  is a wholly new feature with no existing frontend caller to stage
  around, so it does not need (and must not be forced into) a 2-phase
  expand/contract sequence. It has its own, simpler ordering constraint
  relative to 8j below.
- **MUST be applied BEFORE 8j** (8j's `process_payroll_batch()`
  replacement references `salary_advances`/`salary_advance_deductions`/
  `salary_advance_repayment_plans` by name in the same transaction it
  redefines the function in; applying 8j first would fail outright with
  `relation "salary_advances" does not exist`).
- **MUST be applied BEFORE the `SalaryAdvancesPage` frontend build (the one
  that calls `create_salary_advance()`/`approve_salary_advance()`/
  `adjust_combined_repayment_plan()` and reads these tables) is
  deployed** — same "backend before frontend"
  ordering already used throughout this document for every other
  new-table/new-RPC migration.
- **Preflight:** none — all four tables are new and start empty; only
  pre-existing dependencies are `get_current_tenant_id()`,
  `is_super_admin()`, `current_user_role_level()`, and the `employees`/
  `tenants`/`profiles` tables, all already present in STAGING per this
  plan's own §1 setup.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260813000000_salary_advances_schema.sql`
- **Verification:**
  ```sql
  SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN
    ('salary_advances','salary_advance_deductions','salary_advance_repayment_plans','salary_advance_repayment_plan_changes');
  -- expected: all four rowsecurity = true
  SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN
    ('salary_advances','salary_advance_deductions','salary_advance_repayment_plans','salary_advance_repayment_plan_changes') ORDER BY tablename, cmd;
  -- expected: salary_advances has SELECT/UPDATE/DELETE policies -- NO INSERT policy;
  -- the other three tables each have ONLY a SELECT policy
  SELECT conname FROM pg_constraint WHERE conrelid = 'salary_advance_repayment_plans'::regclass AND contype = 'u';
  -- expected: 1 row -- UNIQUE(employee_id)
  SELECT indexname FROM pg_indexes WHERE tablename = 'salary_advances' AND indexname = 'salary_advances_one_open_per_employee';
  -- expected: 0 rows -- this index does NOT exist; the max-2 rule is RPC-enforced, not index-enforced
  SELECT proname, prosecdef FROM pg_proc WHERE proname IN
    ('create_salary_advance','approve_salary_advance','adjust_combined_repayment_plan');
  -- expected: all three prosecdef = true
  SELECT tgname FROM pg_trigger WHERE tgname IN
    ('trg_guard_salary_advance_plan_terms','trg_guard_salary_advance_status_transition');
  -- expected: 2 rows
  ```
  Functional checks (require a STAGING project with a test employee):
  - **Application vs approval:** call `create_salary_advance()` for a test
    employee as Admin/Manager — the advance is `pending` and
    `salary_advance_repayment_plans` has NO row for that employee yet
    (confirm with a `SELECT`). Call `approve_salary_advance()` for it —
    status becomes `active`, `approved_by`/`approved_at` are set, and the
    plan row NOW exists with `combined_monthly_deduction` equal to the
    advance's own rate.
  - **Max-2 + second approval requires new terms:** call
    `create_salary_advance()` a second time for the same employee (now 1
    open, 1 more allowed) — succeeds, still `pending`, plan still reflects
    only the first advance. Call `approve_salary_advance()` for it WITHOUT
    supplying new combined terms — expect an explicit exception, and
    confirm the advance is still `pending` (not partially applied). Call
    it again WITH explicit new terms — succeeds, and the plan now reflects
    the new combined figure. Call `create_salary_advance()` a 3rd time —
    expect the "maximum of 2 open salary advances" exception. Pay one off
    via `process_payroll_batch()` and call `create_salary_advance()` again
    — expect success.
  - **Authorization:** call `create_salary_advance()` and
    `approve_salary_advance()` each as Supervisor/Staff — expect an
    explicit authorization exception, not a silent no-op, from both.
  - **Lifecycle:** attempt `UPDATE salary_advances SET status = 'active'`
    directly (bypassing `approve_salary_advance()`) on a `pending` row, as
    Admin — expect the guard trigger's exception. Attempt `UPDATE
    salary_advances SET status = 'paid'` on an advance with a nonzero
    derived balance, as Admin — expect the guard trigger's exception.
    Attempt `UPDATE salary_advances SET status = 'cancelled'` on an
    `active` row — expect rejection (no cancellation path once approved).
    Attempt any status UPDATE on a `paid`/`rejected`/`cancelled` row —
    expect rejection.
- **Locking risk:** none beyond the table/index/function/trigger-creation
  catalog lock.
- **Data-loss risk:** none — pure addition.
- **Rollback fully reversible?** Yes, but only safe if 8j has not yet been
  applied (or is rolled back first) — dropping these tables while
  `process_payroll_batch()` still references them breaks payroll
  processing entirely, not just the new feature.
  ```sql
  DROP FUNCTION IF EXISTS adjust_combined_repayment_plan(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT);
  DROP FUNCTION IF EXISTS approve_salary_advance(UUID, TEXT, NUMERIC, INTEGER, TEXT, TEXT);
  DROP FUNCTION IF EXISTS create_salary_advance(UUID, DATE, NUMERIC, TEXT, NUMERIC, INTEGER, NUMERIC, TEXT, TEXT, TEXT);
  DROP TRIGGER IF EXISTS trg_guard_salary_advance_status_transition ON salary_advances;
  DROP FUNCTION IF EXISTS guard_salary_advance_status_transition();
  DROP TRIGGER IF EXISTS trg_guard_salary_advance_plan_terms ON salary_advances;
  DROP FUNCTION IF EXISTS guard_salary_advance_plan_terms();
  DROP TABLE IF EXISTS salary_advance_repayment_plan_changes;
  DROP TABLE IF EXISTS salary_advance_repayment_plans;
  DROP TABLE IF EXISTS salary_advance_deductions;
  DROP TABLE IF EXISTS salary_advances;
  ```

### 8j. `20260813000001_payroll_salary_advance_integration.sql`

- **VERIFIED deployment rule:** two changes in one file: (1)
  `ALTER TABLE payroll ADD COLUMN IF NOT EXISTS salary_advance_deduction
  NUMERIC(14,2) NOT NULL DEFAULT 0` — a plain additive column with a
  constant default, no rewrite lock on a modern Postgres/Supabase version,
  and (2) `CREATE OR REPLACE FUNCTION process_payroll_batch(...)` with the
  **same signature** as 8d's original, preserving every existing
  validation/authorization/locking/audit-log behavior byte-for-byte and
  adding oldest-advance-first allocation of the employee's ONE COMBINED
  plan figure across up to 2 open advances per employee (per the
  max-2-open-advances rule in 8i): for each employee in the batch, resolve
  every advance "relevant" to this month — either `status = 'active' AND
  deduction_start_month <= p_month`, OR a `salary_advance_deductions` row
  for `(that advance, p_month)` already exists (see the CRITICAL fix below
  for why) — ordered oldest `application_date` first. **The combined
  monthly budget is read from the employee's ONE
  `salary_advance_repayment_plans.combined_monthly_deduction` row — NOT a
  sum of each advance's own independently-configured rate** (corrected
  from an earlier draft of this migration, which wrongly summed). The
  oldest advance is allocated `LEAST(its own remaining balance, the
  remaining budget)` first — no per-advance rate caps it anymore — and any
  budget it doesn't use (because it finished paying off that month)
  carries forward to the next advance the SAME month — reproducing the
  business rule's own worked examples exactly (a 20,000 combined figure
  with a 10,000 final deduction on the older advance leaves exactly 10,000
  for the younger one that same month). Per advance, this is — governed
  entirely by the `salary_advance_deductions` table's own
  `UNIQUE(salary_advance_id, payroll_month)` constraint — either a new
  ledger row (first time this advance+month is processed) or a reuse of
  the existing one's already-stored amount (idempotent reprocessing; never
  recomputes against an already-decremented balance, which would silently
  produce a wrong, smaller second deduction). `payroll.salary_advance_deduction`
  stores the TOTAL across both advances; the per-advance split lives in
  the ledger. Each advance is marked `'paid'` independently the moment ITS
  OWN derived balance reaches zero — this RPC's own transition passes the
  8i lifecycle guard trigger automatically (it only ever sets `'paid'`
  when the balance IS already zero).
- **CRITICAL FIX verified in this pass:** a naive `WHERE status =
  'active'` eligibility lookup would make an advance INVISIBLE to a
  reprocess of the same month once its final deduction flips it to
  `'paid'` during that run — silently reporting that month's deduction as
  `0` on reprocess instead of preserving the original amount. The
  `OR EXISTS (... salary_advance_deductions ...)` clause in the eligibility
  query fixes this: an advance already posted for this specific month
  stays visible (and its stored amount is reused verbatim) regardless of
  its CURRENT status. Verified for both a single advance and for 2
  simultaneously open advances reprocessed after both flip to `'paid'` in
  the same run — see `e2e/authenticated/salary-advances-matrix.spec.ts`
  tests 20 and 21.
- **GLOBAL NET-PAY INVARIANT (CONFIRMED BUSINESS DECISION — supersedes the
  earlier, narrower "advance-only" guard from a prior pass of this
  document):** **final payroll net pay must never be negative, for ANY
  employee, for ANY reason** — attendance deductions, employee deductions,
  salary advances, terminal/other deductions, or any combination. This is
  no longer scoped to salary advances specifically. Enforced in TWO places
  inside `process_payroll_batch()`, forming ONE rule:
  1. **STEP 1.5 payload validation** now REJECTS a negative
     client-supplied `net_pay` outright, for every record, whether or not
     that employee has any salary advance. **This is a real, intentional
     behavior change**: the earlier rule (see `20260803000002`'s own STEP
     1.5b comment, and its own test documenting "net_pay may legitimately
     be negative") has been explicitly REMOVED per this pass's confirmed
     business decision — any existing caller that relied on submitting an
     already-negative `net_pay` will now get a clear validation error
     instead.
  2. Immediately after allocating an employee's salary advance(s) for the
     month, IF `net_pay - deduction < 0` (this is now unconditional, not
     gated on `deduction > 0`, since step 1 above already guarantees the
     pre-advance figure is `>= 0`), the function `RAISE EXCEPTION`s.
  Since this function has no exception handler, either failure rolls back
  the **ENTIRE batch transaction**, not just the offending employee: every
  payroll row, `salary_advance_deductions` ledger row, `'paid'` status
  flip, and repayment-plan retirement written so far in that call, for
  every employee in the batch. Deliberately does **not** invent a new
  "advance ≤ salary" cap (no silent reduction of any deduction) — failing
  loudly and atomically is the chosen behavior, per explicit instruction
  not to invent an unapproved business rule. `net_pay` of exactly `0` is
  the inclusive boundary — allowed, not rejected.
- **PLAN RETIREMENT ON FINAL PAYOFF (safety review finding, this pass):**
  once an employee has **no remaining `'active'` advance**, their
  `salary_advance_repayment_plans` row is deleted in the same
  per-employee iteration — a paid-off employee must never keep showing a
  live "Current Combined Monthly Deduction" / "Expected Payoff" for debt
  that no longer exists. A no-op `DELETE` (0 rows) for every employee who
  either has no plan row at all, or still has an active advance (e.g. only
  one of their two active advances just paid off — the plan correctly
  survives). `salary_advance_repayment_plan_changes` audit history is
  **never** touched by this (no foreign key to the plan table) and remains
  permanently. The next advance `approve_salary_advance()`s for this
  employee finds no existing plan row and cleanly establishes a fresh one
  from that advance's own terms, with no interference from the retired
  one.
- **BEHAVIOR CHANGE FOR EXISTING CALLERS:** an employee with no current
  combined repayment plan AND a non-negative `net_pay` sees ZERO behavior
  change — `salary_advance_deduction` is simply `0` on their payroll row
  and `net_pay` is bit-for-bit identical to pre-migration behavior. Safe
  to apply even before any salary advance has ever been created in this
  tenant. **ONE real, intentional behavior change (confirmed business
  decision, this pass):** a record whose client-supplied `net_pay` is
  already negative — previously accepted regardless of salary advances —
  is now REJECTED outright at payload validation, whether or not the
  employee has any salary advance at all. Any existing caller relying on
  submitting an already-negative `net_pay` must be updated before this
  migration reaches STAGING/production, or that call will start failing
  loudly (by design — see the GLOBAL NET-PAY INVARIANT note above).
- **MUST be applied AFTER 8i** (references `salary_advances`/
  `salary_advance_deductions`/`salary_advance_repayment_plans` by name)
  **and AFTER 8d** (`20260803000002_payroll_atomic_process_rpc.sql`, whose
  function this replaces via `CREATE OR REPLACE`, not a fresh `CREATE`).
- **MUST be applied BEFORE the `SalaryAdvancesPage`/updated `Payroll.tsx`
  frontend build (the one that reads `payroll.salary_advance_deduction`
  and sends `net_pay` values that assume the RPC subtracts the advance
  server-side) is deployed** — deploying the frontend first would show a
  UI-computed advance deduction that the (not-yet-updated) RPC never
  actually applies, silently producing payroll rows whose real `net_pay`
  doesn't match what the screen showed before processing.
- **Only ever reads `'active'` advances (plus the same-month-ledger-row
  idempotency clause below) — a merely `pending`, not-yet-approved
  application is invisible to payroll entirely**, whether or not it has
  its own configured terms; those terms only take effect the moment
  `approve_salary_advance()` (8i) transitions it to `active` and
  establishes/updates the combined plan this RPC reads from.
- **Preflight:** confirm 8i has already been applied and verified (its own
  §8i verification SQL above passes) before running this one.
- **Command:** `psql "$STAGING_DATABASE_URL" -f supabase/migrations/20260813000001_payroll_salary_advance_integration.sql`
- **Verification:**
  ```sql
  SELECT column_name, column_default, is_nullable FROM information_schema.columns
    WHERE table_name = 'payroll' AND column_name = 'salary_advance_deduction';
  -- expected: 1 row, column_default = '0', is_nullable = 'NO'
  SELECT proname, prosecdef FROM pg_proc WHERE proname = 'process_payroll_batch';
  -- expected: 1 row, prosecdef = true (unchanged from before)
  ```
  Functional check (requires a STAGING project with a test employee):
  create a salary advance via the UI (it starts `pending`), process
  payroll for it — confirm `salary_advance_deduction` is `0`, since a
  pending application must never be deducted. Then approve it via the UI
  (or `approve_salary_advance()` directly) and process payroll again for
  its `deduction_start_month`; confirm the resulting payroll row's
  `salary_advance_deduction` matches the employee's
  `salary_advance_repayment_plans.combined_monthly_deduction` (capped by
  the advance's remaining balance) and `net_pay` reflects it exactly once;
  reprocess the SAME month and confirm the ledger still has exactly one
  row for that `(salary_advance_id, payroll_month)` pair, not two. Then,
  with a SECOND advance created and approved for the same employee (the
  max-2 rule, second approval given explicit new combined terms), confirm
  the payroll row's `salary_advance_deduction` equals exactly that
  combined figure (or less, if both balances together are smaller), the
  older advance is funded first, and — the critical regression check —
  process the month that flips an advance to `'paid'` and reprocess that
  SAME month again, confirming the deduction is preserved (not reset to
  `0`). The full automated version of all of this is
  `e2e/authenticated/salary-advances-matrix.spec.ts`, the "approve_salary_advance()
  workflow" and "payroll integration" describe blocks specifically for the
  application-vs-approval, 2-advance, and reprocessing-after-paid cases.
  Additionally, for the GLOBAL NET-PAY INVARIANT (confirmed business
  decision — see §8j's own note above): (a) submit a record with an
  already-negative client-supplied `net_pay` and NO salary advance —
  confirm the call is now REJECTED at payload validation, before any table
  write (this is the REVERSED behavior — it used to succeed); (b) approve
  an advance whose combined monthly deduction (e.g. 20,000) exceeds the
  employee's net pay before the advance (e.g. 15,000) and process payroll
  — confirm the call raises an exception and NOTHING is written (no
  payroll row, no ledger row, advance status unchanged); (c) confirm a
  COMBINATION — modest ordinary deductions plus a salary advance that
  together go negative — is also rejected; (d) confirm `net_pay` of
  EXACTLY `0` is accepted, and a normal positive `net_pay` is unaffected;
  (e) submit a multi-employee batch where only ONE employee's payroll
  would go negative — confirm the ENTIRE batch rolls back, including the
  employees who would otherwise have succeeded; (f) design a case where
  the failing deduction would ALSO have fully paid off the advance and
  retired its plan in the same call — confirm BOTH the `'paid'` status
  flip AND the plan retirement are rolled back along with everything else.
  Then, separately, pay an advance off completely under normal (non-failing)
  conditions — confirm `salary_advance_repayment_plans` has no row for
  that employee afterward, `salary_advance_repayment_plan_changes` history
  for them is still present, the next month deducts `0`, and a brand-new
  advance approved afterward establishes a fresh plan cleanly. See the
  "plan retirement after final payoff" and the "GLOBAL NET-PAY INVARIANT"
  tests in the "payroll integration" describe block, and
  `src/utils/payrollProcessing.test.ts`'s `describeProcessPayrollBatchError`
  describe block for the frontend's human-readable error translation.
- **Locking risk:** `ADD COLUMN ... DEFAULT 0` — brief metadata-only lock,
  no full table rewrite. `CREATE OR REPLACE FUNCTION` — catalog-only
  change. Neither should be noticeable in production traffic, though a
  low-traffic window remains the more conservative choice given this
  changes payroll-processing behavior.
- **Data-loss risk:** none — additive column with a safe default;
  existing payroll rows unaffected until reprocessed.
- **Rollback fully reversible?** The function can be reverted to 8d's
  original definition (re-run 8d's own file) independently of the column.
  The column itself is safe to leave in place (unused, always 0) or drop:
  ```sql
  ALTER TABLE payroll DROP COLUMN IF EXISTS salary_advance_deduction;
  ```
  Only safe once the frontend reading that column has been rolled back
  first — same "frontend before backend" rollback ordering used
  throughout this document.

## 9. Verification order (after all migrations applied)

1. Re-run each migration's own verification SQL above, in the same order.
2. Between 8g and 8h specifically: do not proceed to 8h until 8h's own
   3-item precondition checklist is satisfied — this is not just
   "verify," it's a hard gate.
3. Between 8i and 8j specifically: do not proceed to 8j until 8i's own
   verification SQL passes — 8j's `CREATE OR REPLACE FUNCTION` references
   both new tables by name and fails outright if they don't exist yet.
4. Run the full E2E suite against staging with all `REQUIRED_VARS` set (see
   `e2e/fixtures.ts`) — `npm run test:e2e` — confirm every currently-skipped
   test in `e2e/authenticated/*.spec.ts` converts to a real pass, not a new
   skip or failure. This includes the new `salary-advances-matrix.spec.ts`
   (RLS + payroll-integration coverage) and
   `recruitment-hooks-regression.spec.ts` (React error #310 regression).
5. Only once step 4 is fully green, proceed to any manual/exploratory
   click-through testing against the Preview deployment (§2).

## 10. Rollback order

Reverse of the apply order in §8, migration-by-migration, stopping at
whichever migration introduced the problem — do not blanket-rollback all of
them if only one is at fault. For 8d/8e/8f/8g specifically, roll back the
dependent **frontend** commit first (per the "General ordering rule" above)
before dropping the function it calls, to avoid turning a planned rollback
into an outage. 8h can be rolled back independently of 8g (see 8h's own
rollback note) if only the SELECT restriction, not the RPC itself, needs
reverting. 8j can be rolled back independently of 8i (reverting the
function to 8d's original definition without dropping the new tables); 8i
must not be rolled back while 8j (or the frontend that depends on it) is
still live, for the same reason described in 8i's own rollback note.

---

## 11. Staging credentials and access required (exact list)

Nothing below requests or should ever record a service-role key, in this
document, in chat, in any repository file, in any frontend variable, or in
any test output. Every item is either a public anon key or a named
individual test-account credential to be supplied directly to the
environment running the tests (e.g. CI secrets, a local `.env.e2e` — never
committed; see `e2e/fixtures.ts`'s own header comment).

**Required before any staging test can execute** (`e2e/fixtures.ts`'s
`REQUIRED_VARS`):
- Staging Supabase **project reference** (to confirm it's the correct,
  separate project before running anything against it).
- Staging Supabase **anon key** (`E2E_SUPABASE_URL` / `E2E_SUPABASE_ANON_KEY`)
  — the anon key is public-by-design per Supabase's own security model, safe
  to use in a browser/test client; **never** the service-role key.
- A **safe method for migration access** — i.e., a connection string or CLI
  login scoped to the staging project only, held by whoever applies
  migrations, not pasted into chat or committed to this repo.
- **Admin / Manager / Supervisor / Staff test accounts** (email + password
  each) for Tenant A, one region — `E2E_ADMIN_EMAIL`/`_PASSWORD`,
  `E2E_MANAGER_EMAIL`/`_PASSWORD`, `E2E_SUPERVISOR_EMAIL`/`_PASSWORD`,
  `E2E_STAFF_EMAIL`/`_PASSWORD`.
- `E2E_BASE_URL` — the staging/Preview deployment URL these accounts log
  into for any UI-level test.
- **Confirmation that Preview does not point to Production** (§2, item 1) —
  a yes/no answer from whoever has Vercel dashboard access, not something
  this environment or any test can verify on its own.

**Optional, unlocks additional already-written tests** (self-skip with a
named reason if absent — see `e2e/fixtures.ts`'s `getSecondRegionAdmin()` /
`getTenantBAdmin()`):
- A **second-region Admin account** (Tenant A) — `E2E_ADMIN2_EMAIL`/`_PASSWORD`.
- A **second-tenant Admin account** (Tenant B) — `E2E_TENANT_B_ADMIN_EMAIL`/`_PASSWORD`,
  now actually exercised by the new "a payload employee_id belonging to a
  different tenant is rejected" test in `rpc-workflow-matrix.spec.ts`.

**Never required, never to be requested or recorded, anywhere:** the
Supabase **service-role key** for any project (staging or production). No
test in this repo needs it — every test authenticates as a real role-level
user via `signInWithPassword`, the same code path the app itself uses.

## 12. Test readiness (item 4)

`e2e/authenticated/rls-policy-matrix.spec.ts` and
`e2e/authenticated/rpc-workflow-matrix.spec.ts` now cover, gated on
`missingStagingVars()`/`getStagingCredentials()`/optional per-scenario
skips as noted:

- Anonymous denial (new: `rls-policy-matrix.spec.ts`, "anonymous access" —
  unauthenticated read returns no rows, unauthenticated insert is denied).
- Staff/Supervisor/Manager/Admin permissions — `payment_status`,
  `system_settings`, `terminal_dues` (new this pass), destructive-op
  restriction.
- Guard-ID / employee-number generation: format, increment, **2 concurrent**
  (new this pass) and 10-simultaneous requests, duplicate-constraint
  rejection.
- Payroll processing, idempotent reprocessing, **2-concurrent processing for
  different employees in the same month** (new this pass, proves the
  advisory lock's per-tenant+month scope doesn't corrupt unrelated rows),
  approved-payroll immutability, duplicate-employee-ID-in-payload rejection,
  negative-monetary-value rejection, partial-failure rollback,
  audit-log-creation-with-real-prior-figures.
- **Invalid-tenant-employee rejection** (new this pass, gated on
  `getTenantBAdmin()` — self-skips with a named reason if that optional
  credential is absent): a Tenant B employee_id included in a Tenant A
  `process_payroll_batch` payload is rejected, and the batch's other,
  otherwise-valid row is also not inserted.
- Recruitment direct-API transitions (documents the current A19 gap).
- Payment-status and terminal-dues permission checks.
- System-settings permission checks.

**Correct-region / incorrect-region access**: **not yet testable** — no RLS
policy references `region_id` anywhere in this schema (Finding A12). Writing
an allow/deny test against a non-existent policy would be a fake assertion,
not a real test. This is blocked on §13's business decisions, not on missing
credentials — even with `E2E_ADMIN2_EMAIL` supplied, there is no policy yet
for a "wrong region" test to exercise. Once §13 is resolved and a policy is
written and applied, the corresponding allow/deny tests should be added at
that time, following the same signed-in-as-each-role pattern already used
throughout both spec files.

As of this pass, 132 E2E tests exist (16 static, always-run; 116
staging-gated), up from 88 in the previous revision of this document — the
new `applicants`/RPC-counts coverage (§4/§6 above) accounts for the
increase. All 116 staging-gated tests currently report **SKIPPED**, not
passing, not failing, re-verified by actually running `npx playwright test`
in this environment (16 passed / 116 skipped / 0 failed) — not carried
forward from an earlier count.

## 13. Regional isolation — schema and policy design options (NOT applied)

Full detail already documented in `SECURITY_REVIEW.md`'s "Candidate
region/access-control model" section; summarized here for this plan's own
completeness, cross-referenced rather than re-invented:

| Role | Candidate rule | Schema change needed |
|---|---|---|
| Super Admin | Global access, all tenants/regions | None — `profiles.is_super_admin` already the universal bypass everywhere |
| Admin | All regions within own tenant | None, **if** "Admin's `region_id` is NULL" is confirmed as the intended way to express "all regions." If an *explicit* all-regions flag is wanted instead (clearer than NULL doing double duty), a new `profiles.all_regions_access` boolean |
| Manager | Assigned region **or regions** (plural) | If a Manager can ever legitimately oversee more than one region: a `profile_regions (profile_id, region_id)` join table, replacing/supplementing the current single nullable `profiles.region_id`. **This is the single biggest schema decision in the whole model** |
| Supervisor | Assigned region **and** authorized workstations | (1) a real `workstations` table — `employees.workstation` is currently free text, not a foreign key; (2) a `profile_workstations` join table recording which workstations a Supervisor may access |
| Staff | Own profile/payslips/permitted personal info only | **A new `profiles.employee_id` column** (nullable UUID → `employees(id)`) — there is currently no link at all between an auth account and an employee record, which is why Finding A17 (Staff can view every employee's payslip in-region, not just their own) exists in the first place |
| User with no assigned region | — | Depends entirely on the Admin/Manager NULL-meaning decision above — needs to be the same answer for every role, not decided ad hoc per role |
| User assigned to multiple regions | — | Same as the Manager row — requires the `profile_regions` join table if this is a real requirement |
| User assigned to individual workstations | — | Same as the Supervisor row — requires the `workstations` + `profile_workstations` tables |

**Business decisions that must be confirmed before writing or applying any
final regional RLS policy** (from `AUDIT_REPORT.md`'s "What requires
business confirmation" and `SECURITY_REVIEW.md`'s summary):
1. Does a NULL `profiles.region_id` mean "all regions" for **every** role,
   or only some (e.g. only Admin, not Manager)?
2. Does Super Admin need an *explicit* all-regions flag, or does
   `is_super_admin` alone remain sufficient?
3. Do Managers or Supervisors ever need **more than one** region
   simultaneously (a real multi-region assignment), or is "one region, or
   all via NULL" sufficient? This single answer determines whether
   `profiles.region_id` must be replaced with a join table before any of
   this is built — retrofitting that after RLS policies already depend on
   the single-column shape is far more disruptive than deciding now.
4. Is workstation-level scoping (for Supervisors) an actual current
   requirement, or a future one? This determines whether the `workstations`
   table work is in scope now or can be deferred.
5. Is `profiles.employee_id` (the Staff self-service link) approved to add
   regardless of the answers above? This one is needed no matter how the
   other four are answered, since without it Staff self-service cannot be
   scoped at all, at any layer.

**Client-side region filters are not, and must never be treated as,
authorization.** Every region-scoping check that exists in the app today is
explicitly UI-only (Finding A12) — a determined caller hitting the Supabase
API directly, bypassing the UI entirely, is not stopped by any of it. This
plan does not propose relying on those filters as a substitute for RLS at
any point, temporarily or otherwise.

**`salary_advances`/`salary_advance_deductions`/`salary_advance_repayment_plans`/
`salary_advance_repayment_plan_changes` (8i/8j, §8) inherit this exact
same gap — stated explicitly here rather than left implicit.** Their RLS
policies (§8i above) restrict by `tenant_id` and `role_level` only,
identically to every other financial table in this schema
(`payment_status`, `terminal_dues`, `employee_deductions`). None of the
four tables has, or is claimed to have, any `region_id` column or
region-scoped policy — this also applies to `create_salary_advance()`,
`approve_salary_advance()`, and `adjust_combined_repayment_plan()`
themselves, all three of which authorize by `role_level`/tenant only, with
no region check. Concretely: an Admin or
Manager account can create, view, or adjust salary advances for **any
employee in the tenant**, regardless of which region that employee
belongs to or which region the caller's own `profiles.region_id` is
scoped to in the UI — the same "Manager South can reach North's data via
a direct API call" gap Finding A12 already describes for every other
table, now also true here. This is not a new,
separate regional bypass introduced by this feature; it is the
pre-existing, already-documented gap extending to four more tables (and
two more RPCs), and it is resolved (or not) by the same single §13
regional RLS design decision as everything else — no separate fix is
proposed or needed specifically for salary advances.

## 14. Credential and environment gates (explicit, unresolved)

Recorded as open gates — **none of the following is claimed complete, and
no evidence is offered for any of them, because none exists in this
environment.** Each must be independently confirmed by someone with the
relevant access before staging/production work proceeds past it.

| Gate | Status | Evidence available from this environment |
|---|---|---|
| Exposed administrator password rotated | **Unresolved** | None — no Supabase Auth dashboard/Admin API access here to check or rotate it |
| Old password still present in Git history | **Yes, confirmed present** | `src/tests/auth.test.ts` was deleted from the branch tip but remains reachable in every commit before that deletion (and any prior clone/fork) |
| Git-history rewrite | **Deferred** | Per this audit's standing instruction not to force-push or rewrite history without explicit authorization; none given |
| Vercel Preview isolated from Production | **Unresolved** | None — no Vercel dashboard/API access here; static grep confirms no service-role key exists anywhere in frontend code regardless of how Vercel env vars are set, but that's a different, narrower claim than "Preview points at staging" |
| Preview uses staging Supabase | **Unresolved** | Same — cannot be checked from here |
| No service-role key exposed to Vite | **Confirmed by static analysis** | `grep`-confirmed: no `SUPABASE_SERVICE_ROLE_KEY` or equivalent appears anywhere in `src/` or `vite.config.ts`; only `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are read, both anon-key-based by design |
| No mutation test has touched production | **Confirmed by absence of access** | This environment has no production credentials, no production database connection, and no ability to reach the production Vercel URL's backing project — nothing could have mutated it from here even accidentally |

**No gate above is claimed resolved without a named piece of evidence.**
Where evidence exists (the last two rows), it is stated narrowly — "no
service-role key in frontend code" is not the same claim as "Preview is
definitely isolated," and this table does not conflate them.

## 15. PR #36 merge readiness

Stated explicitly, not left implicit in the sections above:

1. **Regional RLS (§13) is a PR #36 merge blocker.** No RLS policy in this
   schema — not in this PR, not in any migration listed in §8 — restricts
   any table by `region_id`. Manager South (or any role) can access every
   region's data within their tenant via a direct API call today, and
   nothing in this PR changes that. Regional RLS design is documented
   (§13) but explicitly **not implemented**, pending the 5 business
   decisions §13 lists. PR #36 must not merge with this gap unresolved,
   or with it resolved only in documentation rather than in an applied,
   verified policy. **This blocker now explicitly includes the new
   `salary_advances`/`salary_advance_deductions`/`salary_advance_repayment_plans`/
   `salary_advance_repayment_plan_changes` tables and the
   `create_salary_advance()`/`approve_salary_advance()`/
   `adjust_combined_repayment_plan()` RPCs
   (8i/8j, §8)** — see §13's own note — since they were built with
   tenant-only authorization, consistent with every other table/RPC in
   this schema, and it would be inaccurate for this document to claim
   otherwise for the newest additions while leaving the rest of the
   schema's gap unresolved.
2. **PR #36 stays draft/unmerged until full STAGING validation is green** —
   concretely: every migration in §8 applied to STAGING in the order and
   with the preconditions specified (including 8h's own 3-item checklist),
   every staging-gated E2E test in §12 converted from SKIPPED to a real
   PASS (not a new SKIP, not a FAIL), the credential/environment gates in
   §14 resolved with real evidence (not this document's placeholders),
   and — independent of all of the above — the regional RLS blocker in
   item 1 either resolved or explicitly, separately signed off as
   acceptable to ship without. None of these conditions has been met from
   this environment; none can be, since this environment has no STAGING
   or Vercel access.

---

## What this plan is not

- Not a confirmation that staging exists, is seeded, or has been touched in
  any way — nothing in `supabase/staging-seed/` or this document has been
  run against any database.
- Not an authorization to apply any migration, anywhere.
- Not an authorization to run any of the staging-gated E2E tests — those
  remain skipped until the environment variables in §11 are actually
  supplied to whoever runs them.
- Not a substitute for the business decisions in §13 — regional RLS remains
  blocked until those are answered, independent of anything else in this
  plan being ready.

See `AUDIT_REPORT.md`, `SECURITY_REVIEW.md`, and `DATA_INTEGRITY_REVIEW.md`
for the full findings this plan draws from; this document is the
consolidated "what to do once access exists" checklist, not a replacement
for those three's own detail.
