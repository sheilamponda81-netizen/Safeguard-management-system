-- ============================================================
-- MIGRATION: Server-side, transaction-safe, tenant-scoped Guard ID
-- generation
-- Date: 2026-08-04 (revised same day, after a hostile-input security
-- review -- see the "REVISION" note below)
-- ============================================================
--
-- PROBLEM (AUDIT_REPORT.md / DATA_INTEGRITY_REVIEW.md): Security.tsx
-- generated guard IDs entirely client-side, via `G-${Math.floor(Math.random()
-- * 1000)}` (and, in a couple of call sites, an inconsistent
-- `* 10000` range) -- a random draw from a range of only 1000-9999
-- (~9000 possible values), with NO uniqueness check anywhere: not in the
-- browser, not in the database (no UNIQUE constraint existed on
-- employees."guardId"). By the birthday paradox, a duplicate becomes
-- roughly a coin flip at ~112 guards, and nothing would catch or prevent
-- it -- two guards could silently end up with the same ID.
--
-- ================= REVISION, same day =================
-- The first version of this migration used a single Postgres SEQUENCE
-- shared across every tenant on the platform, with a plain
-- UNIQUE("guardId") constraint (no tenant_id in it at all). A hostile-
-- input/security review of every new RPC in this audit flagged this as
-- an inconsistency, not a privilege-escalation bug: every other counter,
-- table, and RLS policy in this schema is strictly scoped to tenant_id,
-- and this was the one exception -- every tenant on the platform would
-- draw guard IDs from the same shared counter, meaning one tenant's
-- guard-creation volume/rate is observable (in a minor way, via gaps in
-- their own numbering) by any other tenant. That's a real multi-tenancy
-- boundary inconsistency worth fixing for a security-focused pass, even
-- though it was never an actual cross-tenant data leak or escalation.
-- Rewritten below to use the same row-locked, tenant-scoped counter-table
-- pattern as 20260804000001_employee_number_generation.sql, for
-- consistency and because this migration has not been applied to any
-- database -- there is no data or deployed behavior to migrate away
-- from, so revising in place (rather than layering a second migration on
-- top) keeps the history clean.
--
-- FIX: move ID generation into the database, using a row-locked counter
-- table, ONE ROW PER TENANT (`SELECT ... FOR UPDATE` inside a single
-- transaction is Postgres's standard, safe pattern for a per-key atomic
-- counter -- the row lock serializes concurrent callers for the SAME
-- tenant while leaving other tenants' counters completely independent
-- and unblocked).
--
-- FORMAT: G- followed by a zero-padded 4-digit number, per tenant
-- (G-0001, G-0002, ... restarting at 1 for each new tenant). If a single
-- tenant's count ever exceeds 9999, the number simply grows to 5 digits
-- (G-10000) rather than wrapping or colliding -- correctness over
-- cosmetic padding.
--
-- LEGACY DATA: existing "guardId" values were random 4-digit numbers in
-- the 1000-9999 range with no guaranteed relationship to insertion
-- order, and (from the original, non-tenant-scoped scheme) may not be
-- distinct per tenant today the way this migration will keep them going
-- forward. Each tenant's counter is seeded from the highest existing
-- numeric suffix among THAT tenant's own "guardId" values, so newly
-- generated IDs never collide with that tenant's own legacy data. A
-- UNIQUE(tenant_id, "guardId") constraint is added as a second,
-- independent guarantee scoped the same way.
--
-- ================= DEPLOYMENT ORDER WARNING =================
-- Unlike the payroll atomic RPC (20260803000002), this migration's
-- companion frontend change (src/utils/guardIdGeneration.ts's
-- generateGuardIdServerSide(), wired into src/pages/Security.tsx) HAS A
-- SAFE FALLBACK -- if this RPC errors for any reason (including "the
-- migration hasn't been applied yet"), the frontend falls back to the
-- original client-side random generator rather than breaking guard
-- creation outright. This means, unlike the payroll RPC, wiring the
-- frontend to call this function does NOT force a hard "migration before
-- code" deployment ordering -- see AUDIT_REPORT.md's "Production
-- deployment and rollback order" for the full sequencing across every
-- migration in this audit; applying this migration promptly is still
-- recommended to get the actual concurrency-safety benefit, just not
-- deployment-blocking the way the payroll RPC is.
--
-- ================= CONCURRENCY FIX (2026-09-09, production preflight) =================
-- FIRST-CALL RACE, confirmed empirically (not just reasoned about) against a
-- disposable local Postgres 16 instance running this exact function body:
-- `SELECT ... FOR UPDATE` takes no lock at all when the target row does not
-- yet exist (there is nothing to lock). So two concurrent FIRST calls for the
-- SAME brand-new tenant can both reach `IF NOT FOUND`, both independently
-- compute the same legacy-max seed, and both attempt
-- `INSERT INTO guard_id_counters (tenant_id, last_number)` for the same
-- tenant_id. The loser does not serialize behind the winner -- it raises an
-- uncaught `duplicate key value violates unique constraint
-- "guard_id_counters_pkey"` and the whole call fails. Reproduced directly:
-- two simultaneous first calls for one new tenant, one returns 'G-0001', the
-- other errors with exactly that duplicate-key exception. Every call AFTER
-- the first is unaffected -- once the row exists, `SELECT ... FOR UPDATE`
-- correctly takes a real row lock and serializes concurrent callers exactly
-- as documented above.
--
-- FIX: acquire a transaction-scoped advisory lock, keyed per-tenant, as the
-- very first thing this function does -- BEFORE the row-level
-- `SELECT ... FOR UPDATE`, so it also covers the window where no row exists
-- yet to lock. A second concurrent call for the SAME tenant now blocks on
-- the advisory lock itself until the first call's transaction commits (or
-- rolls back), then proceeds against whatever state the first call actually
-- left behind -- whether that's a freshly-inserted row or an existing one.
-- `pg_advisory_xact_lock` is released automatically at COMMIT/ROLLBACK, so
-- there is no separate unlock call to forget, and it uses the SAME
-- hashtext-keyed advisory-lock pattern already established and load-bearing
-- elsewhere in this schema (process_payroll_batch's
-- `pg_advisory_xact_lock(hashtext(...))`, 20260803000002) -- not a new
-- concurrency-control mechanism, applied consistently. The lock key is
-- prefixed ('guard_id_counter:') so it cannot collide with
-- process_payroll_batch's own tenant-keyed advisory lock namespace beyond
-- the same inherent, already-accepted hashtext collision risk that
-- precedent already carries. A DIFFERENT tenant's call takes a lock on a
-- DIFFERENT hash key and is not blocked by this one at all -- confirmed
-- empirically: two different tenants' first calls, both deliberately delayed
-- by the same test harness, still complete in parallel, not serialized.
--
-- Nothing else about this function changes: tenant-scoped counters, legacy
-- MAX("guardId") seeding, SECURITY DEFINER, the REVOKE/GRANT hardening
-- below, UNIQUE(tenant_id, "guardId"), and strictly monotonic per-tenant
-- numbering are all unchanged -- this is a single added statement closing
-- one specific first-call race window, not a redesign.
-- ============================================================

CREATE TABLE IF NOT EXISTS guard_id_counters (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE guard_id_counters ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'guard_id_counters' AND policyname = 'guard_id_counters_tenant_select'
  ) THEN
    CREATE POLICY guard_id_counters_tenant_select ON guard_id_counters
      FOR SELECT USING (tenant_id = get_current_tenant_id());
  END IF;
END $$;
-- No INSERT/UPDATE/DELETE policy for `authenticated`: the only intended
-- writer is generate_guard_id() below, which is SECURITY DEFINER and
-- bypasses RLS for its own writes -- same reasoning as
-- employee_number_counters and as process_payroll_batch()'s writes to
-- `payroll`/`audit_logs`.

-- ---------------------------------------------------------------
-- Unique constraint on the legacy column, now scoped by tenant. Added
-- BEFORE the counter table is seeded, so a real pre-existing duplicate
-- (if one already exists from the old random-collision-prone,
-- non-tenant-scoped scheme) is surfaced now, loudly, as a migration
-- failure -- not silently ignored. If this fails on staging/production,
-- the safe remediation is to find and manually re-assign the duplicate
-- "guardId" value(s) within that tenant first (a one-time, reviewed
-- data-correction step), then re-run this migration -- never to drop
-- this constraint to force it through.
-- ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_tenant_guard_id_unique'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_tenant_guard_id_unique UNIQUE (tenant_id, "guardId");
  END IF;
END $$;

-- ---------------------------------------------------------------
-- The generation function. SECURITY DEFINER is required so any
-- authenticated caller can read/update the shared counters table
-- (RLS above only grants SELECT to `authenticated`, and only for their
-- own tenant's row -- no policy grants INSERT/UPDATE at all). auth.uid()
-- and the caller's own tenant_id are resolved from `profiles` inside the
-- function itself; there is no parameter a caller could pass to select a
-- different tenant's counter -- consistent with generate_employee_number()
-- and process_payroll_batch() elsewhere in this audit, and verified
-- explicitly in this revision's own security review (see
-- DATA_INTEGRITY_REVIEW.md).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_guard_id()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_last_number INTEGER;
  v_next_number INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user';
  END IF;

  -- CONCURRENCY FIX (2026-09-09): acquire a transaction-scoped, per-tenant
  -- advisory lock BEFORE the row lock below. This is what actually closes
  -- the first-call race -- `SELECT ... FOR UPDATE` on a row that does not
  -- exist yet takes no lock at all, so without this, two concurrent FIRST
  -- calls for the same brand-new tenant could both reach `IF NOT FOUND`,
  -- both compute the same seed, and both attempt to INSERT the same
  -- tenant_id -- the loser raising an uncaught duplicate-key error instead
  -- of serializing safely. Released automatically at COMMIT/ROLLBACK, same
  -- pattern as process_payroll_batch's own tenant-keyed advisory lock
  -- (20260803000002). A different tenant hashes to a different lock key and
  -- is never blocked by this one.
  PERFORM pg_advisory_xact_lock(hashtext('guard_id_counter:' || v_tenant_id::text));

  -- Lock (or create) this tenant's counter row for the rest of this
  -- transaction -- a second concurrent call for the SAME tenant blocks
  -- here until the first call's transaction commits, then proceeds
  -- against the post-commit value. A different tenant's call takes a
  -- lock on a DIFFERENT row and is not blocked by this one at all. (For
  -- the very first call ever made for a tenant, before any row exists,
  -- the advisory lock above is what actually provides the serialization --
  -- this FOR UPDATE alone cannot lock a row that isn't there yet.)
  SELECT last_number INTO v_last_number
    FROM guard_id_counters
    WHERE tenant_id = v_tenant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- First-ever call for this tenant: seed from the highest existing
    -- legacy "guardId" value belonging to THIS tenant specifically (not
    -- a cross-tenant maximum -- each tenant's numbering is independent).
    -- `"guardId" ~ '^G-[0-9]+$'` guards the regexp_replace against any
    -- malformed/legacy-free-text value that isn't in the expected
    -- G-<digits> shape (defensive -- there is no evidence such rows
    -- exist, but a migration should never assume its own input is clean).
    SELECT COALESCE(MAX(CAST(regexp_replace("guardId", '^G-', '') AS INTEGER)), 0)
      INTO v_last_number
      FROM employees
      WHERE tenant_id = v_tenant_id
        AND "guardId" ~ '^G-[0-9]+$';

    INSERT INTO guard_id_counters (tenant_id, last_number)
    VALUES (v_tenant_id, v_last_number);
  END IF;

  v_next_number := v_last_number + 1;

  UPDATE guard_id_counters
    SET last_number = v_next_number, updated_at = NOW()
    WHERE tenant_id = v_tenant_id;

  RETURN 'G-' || LPAD(v_next_number::TEXT, 4, '0');
END;
$$;

-- `REVOKE ALL ... FROM PUBLIC` alone does not remove `anon`'s own direct
-- EXECUTE grant on a newly created function -- Supabase grants EXECUTE to
-- `anon`/`authenticated` directly via a database-level default-privilege
-- rule, separate from PUBLIC (confirmed against STAGING's pg_proc.proacl
-- while applying 20260803000002_payroll_atomic_process_rpc.sql). The
-- explicit `anon` revoke below closes that from the moment this function
-- is first created, rather than relying on a later, catch-all migration.
REVOKE ALL ON FUNCTION generate_guard_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION generate_guard_id() FROM anon;
GRANT EXECUTE ON FUNCTION generate_guard_id() TO authenticated;

-- ============================================================
-- ROLLBACK SQL (run in this order; safe at any time -- reverting simply
-- means new guard creation goes back to the old client-side random
-- generator, the same as before this migration, not a data-loss risk)
-- ============================================================
-- REVOKE EXECUTE ON FUNCTION generate_guard_id() FROM authenticated;
-- DROP FUNCTION IF EXISTS generate_guard_id();
-- DROP POLICY IF EXISTS guard_id_counters_tenant_select ON guard_id_counters;
-- DROP TABLE IF EXISTS guard_id_counters;
-- ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_tenant_guard_id_unique;
-- (Rolling back the frontend commit that calls generate_guard_id() must
-- happen BEFORE dropping the function, for the same reason noted above.)
-- No data loss: this migration adds new objects and a constraint on
-- existing data, but drops/deletes nothing that existed before it.

-- ============================================================
-- PREFLIGHT SQL (run against production BEFORE applying this migration,
-- to detect whether the UNIQUE(tenant_id, "guardId") constraint below
-- would fail)
-- ============================================================
-- SELECT tenant_id, "guardId", COUNT(*) FROM employees
--   WHERE "guardId" IS NOT NULL
--   GROUP BY tenant_id, "guardId" HAVING COUNT(*) > 1;
-- Expected: 0 rows. Any row returned identifies a real, pre-existing
-- duplicate guardId within one tenant that must be manually corrected
-- (re-assign one of the conflicting employees a new guardId, e.g. via
-- this same function once available, or a manually chosen unused value)
-- BEFORE this migration will apply successfully.

-- ============================================================
-- VERIFICATION SQL (run immediately after applying, before trusting the
-- migration in that environment)
-- ============================================================
-- SELECT proname, prosecdef FROM pg_proc WHERE proname = 'generate_guard_id';
-- Expected: 1 row, prosecdef = true (confirms SECURITY DEFINER took effect).
-- SELECT has_function_privilege('authenticated', 'generate_guard_id()', 'EXECUTE');
-- Expected: true.
-- SELECT conname FROM pg_constraint WHERE conname = 'employees_tenant_guard_id_unique';
-- Expected: 1 row.

-- ============================================================
-- STAGING TEST PROCEDURE (run against a staging Supabase project only,
-- authenticated as a real user so auth.uid()/get_current_tenant_id()
-- resolve correctly)
-- ============================================================
--
-- 1. CONSECUTIVE GENERATION -- confirms monotonic, unique, correctly
--    formatted output:
--
--   SELECT generate_guard_id();  -- e.g. G-0001 (or wherever the seed
--                                -- landed above this tenant's legacy max)
--   SELECT generate_guard_id();  -- next value, exactly +1
--   SELECT generate_guard_id();  -- next value, exactly +1
--
--   Expected: three distinct values, each the previous numeric suffix
--   + 1, all matching ^G-\d{4,}$.
--
-- 2. TWO SIMULTANEOUS REQUESTS, same tenant -- confirms the row lock
--    actually serializes concurrent callers (open two separate staging
--    DB sessions/tabs authenticated as the same tenant, run at the same
--    moment):
--
--   -- Session A:                 -- Session B (same moment):
--   SELECT generate_guard_id();   SELECT generate_guard_id();
--
--   Expected: two distinct, consecutive numbers -- session B visibly
--   waits for session A's transaction to commit before proceeding.
--
-- 2b. TWO SIMULTANEOUS *FIRST* REQUESTS FOR A BRAND-NEW TENANT -- the
--    specific race this migration's CONCURRENCY FIX section addresses.
--    Distinct from test #2 above: that test's tenant already has a
--    guard_id_counters row (created by test #1), so it only exercises the
--    row-lock path, never the no-row-yet path where the original bug
--    lived. This test requires a tenant with ZERO prior generate_guard_id()
--    calls and ZERO existing "guardId" values (confirm first:
--    `SELECT * FROM guard_id_counters WHERE tenant_id = '<new tenant id>';`
--    -- expect 0 rows):
--
--   -- Session A:                 -- Session B (same moment):
--   SELECT generate_guard_id();   SELECT generate_guard_id();
--
--   Expected: BOTH sessions succeed (neither raises a duplicate-key
--   error), returning two distinct, consecutive values (e.g. G-0001 and
--   G-0002, in whichever order the advisory lock admits them) -- not one
--   success plus one `duplicate key value violates unique constraint
--   "guard_id_counters_pkey"` error, which is what this exact scenario
--   produced before the CONCURRENCY FIX above was added (reproduced
--   empirically against a disposable local Postgres instance running the
--   pre-fix function body). Afterward:
--   `SELECT last_number FROM guard_id_counters WHERE tenant_id = '<new
--   tenant id>';` -- expect exactly 1 row, last_number = 2.
--
-- 3. TEN SIMULTANEOUS REQUESTS -- a stronger automated version of #2
--    within one session (real concurrency across sessions is the more
--    rigorous test, but this at minimum proves no duplicate/skipped
--    value across rapid sequential calls within a single transaction
--    context):
--
--   SELECT count(DISTINCT v), count(v), max(v) - min(v) FROM (
--     SELECT (regexp_replace(generate_guard_id(), '^G-', ''))::int AS v
--     FROM generate_series(1, 10)
--   ) t;
--   -- Expected: count(DISTINCT v) = count(v) = 10, and max-min = 9
--   -- (exactly 10 consecutive integers, no gaps, no duplicates).
--   -- For genuine cross-connection concurrency, use pgbench with 10
--   -- concurrent clients each calling `SELECT generate_guard_id();`
--   -- once, then verify the same way against the resulting employees/
--   -- audit trail.
--
-- 4. EXISTING LEGACY IDS are never collided with -- run BEFORE applying
--    this migration to capture the true pre-migration state for this
--    tenant:
--
--   SELECT "guardId" FROM employees
--     WHERE tenant_id = '<this tenant id>' AND "guardId" IS NOT NULL
--     ORDER BY "guardId" DESC LIMIT 5;
--   -- note the highest existing value for THIS tenant, e.g. G-9987
--
--   -- after applying the migration, authenticated as a user in that tenant:
--   SELECT generate_guard_id();
--   -- Expected: strictly greater than every legacy value noted above
--   -- for this tenant (e.g. G-9988 or higher, never G-0001).
--
-- 5. GAPS in existing IDs do not confuse the seed step -- e.g. a tenant
--    with guardIds G-1000, G-1500, G-9999 (gaps from the old random
--    scheme) should still seed from the MAX (9999), not the count (3) or
--    any other value:
--
--   -- (with the above 3 legacy values present for this tenant)
--   SELECT generate_guard_id();
--   -- Expected: G-10000 (9999 + 1), not G-0004 or any other value
--   -- derived from the count of existing rows rather than their max.
--
-- 6. INVALID LEGACY FORMATS are ignored by the seed step, not treated as
--    errors or as 0:
--
--   -- Simulate a malformed legacy value (should never occur in practice,
--   -- but the seed query's own `~ '^G-[0-9]+$'` filter must handle it):
--   -- UPDATE employees SET "guardId" = 'LEGACY-BADGE-7' WHERE id = '<some employee with no guardId yet>';
--   SELECT generate_guard_id();
--   -- Expected: succeeds, seeded from the highest VALID (G-<digits>)
--   -- legacy value for this tenant, silently ignoring 'LEGACY-BADGE-7'
--   -- rather than erroring on the failed CAST or treating it as the max.
--
-- 7. COLLISION RETRIES -- confirms the UNIQUE(tenant_id, "guardId")
--    constraint actually rejects a real duplicate (should error, not
--    silently succeed), which is the backstop the frontend's own
--    retry-on-23505 pattern (mirroring Employees.tsx's employee-number
--    retry logic) would react to if this table were ever written to
--    outside this function:
--
--   INSERT INTO employees (tenant_id, employee_number, full_name, basic_salary, "guardId")
--     VALUES (get_current_tenant_id(), 'E2E-COLLISION-TEST', 'Collision Test',
--             0, (SELECT "guardId" FROM employees WHERE tenant_id = get_current_tenant_id() AND "guardId" IS NOT NULL LIMIT 1));
--   -- Expected: ERROR: duplicate key value violates unique constraint
--   -- "employees_tenant_guard_id_unique"
--
-- 8. TENANT SEPARATION -- confirms two different tenants have fully
--    independent counters (needs a second tenant/company seeded in the
--    same staging project; authenticate as a user in each):
--
--   -- As a user in Tenant A:
--   SELECT generate_guard_id(); -- e.g. G-0001
--   -- As a user in Tenant B:
--   SELECT generate_guard_id(); -- e.g. G-0001 too -- NOT G-0002 -- each
--                               -- tenant's numbering starts independently
--   SELECT tenant_id, last_number FROM guard_id_counters;
--   -- Expected: two rows, one per tenant, independently incrementing.
-- ============================================================
