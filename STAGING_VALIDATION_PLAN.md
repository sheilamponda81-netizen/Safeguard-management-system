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

## 9. Verification order (after all migrations applied)

1. Re-run each migration's own verification SQL above, in the same order.
2. Between 8g and 8h specifically: do not proceed to 8h until 8h's own
   3-item precondition checklist is satisfied — this is not just
   "verify," it's a hard gate.
3. Run the full E2E suite against staging with all `REQUIRED_VARS` set (see
   `e2e/fixtures.ts`) — `npm run test:e2e` — confirm every currently-skipped
   test in `e2e/authenticated/*.spec.ts` converts to a real pass, not a new
   skip or failure.
4. Only once step 3 is fully green, proceed to any manual/exploratory
   click-through testing against the Preview deployment (§2).

## 10. Rollback order

Reverse of the apply order in §8, migration-by-migration, stopping at
whichever migration introduced the problem — do not blanket-rollback all of
them if only one is at fault. For 8d/8e/8f/8g specifically, roll back the
dependent **frontend** commit first (per the "General ordering rule" above)
before dropping the function it calls, to avoid turning a planned rollback
into an outage. 8h can be rolled back independently of 8g (see 8h's own
rollback note) if only the SELECT restriction, not the RPC itself, needs
reverting.

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
   verified policy.
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
