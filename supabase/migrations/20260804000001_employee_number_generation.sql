-- ============================================================
-- MIGRATION: Server-side employee number generation with a per-prefix
-- counter table, reducing (see honest limitation note below) the
-- concurrency window in Employees.tsx's employee number generation.
-- Date: 2026-08-04
-- ============================================================
--
-- PROBLEM: Employees.tsx's generateEmployeeNumber() queries the browser-
-- side Supabase client for the highest existing employee_number matching
-- a region's prefix (`SFG-<RegionLetter>-`), then computes "highest + 1"
-- entirely in the browser (src/utils/employeeNumberGeneration.ts's
-- nextEmployeeNumber()). Two admins creating an employee in the same
-- region at close to the same time can both read the same "highest
-- existing" value and both compute the same "next" number -- a classic
-- read-then-write race, not safe under concurrent access.
--
-- WHY THIS ISN'T THE SAME FIX AS GUARD IDs: guard IDs are a single,
-- ever-growing, tenant-wide 4+ digit counter with no reset points, which
-- maps perfectly onto one Postgres SEQUENCE (20260804000000). Employee
-- numbers are scoped PER REGION PREFIX (SFG-N-001, SFG-S-001, ... each
-- region restarts its own 001, 002, ... run) and regions are a dynamic,
-- admin-editable table -- a fixed SEQUENCE object can't be created ahead
-- of time for a prefix that doesn't exist yet. The standard, safe
-- Postgres pattern for a dynamic set of independent counters is a
-- counters table with row-level locking (SELECT ... FOR UPDATE), which is
-- what this migration adds.
--
-- ================= HONEST LIMITATION =================
-- This migration moves the "what's the next number for this prefix"
-- CALCULATION into the database (no longer "solely querying the browser",
-- per the instruction this migration responds to) and makes THAT
-- calculation itself safe under concurrent calls to generate_employee_
-- number() (the row lock below is held for the duration of the counter
-- read-increment-write, serializing concurrent callers). It does NOT
-- make the full generate-then-insert-employee flow a single atomic
-- operation, because the actual employees INSERT still happens
-- separately from Employees.tsx afterward, with many more fields
-- (personal details, contract terms, etc.) that this function has no
-- business owning or validating. A residual race window exists between
-- "the function returns a number" and "the browser's INSERT for that
-- employee actually reaches the database" (network latency, a slow
-- client, etc.) -- see DATA_INTEGRITY_REVIEW.md for why a true single-RPC
-- design (mirroring the payroll atomic RPC) was considered and not done
-- here, and what would be needed to close this residual gap completely.
--
-- THE BACKSTOP: employees already has UNIQUE(tenant_id, employee_number)
-- (20260727000000_reconstructed_base_schema.sql) -- so even in the
-- residual race window, the database itself will NEVER accept two rows
-- with the same employee_number; the worst case is one of the two
-- concurrent inserts fails with a real, visible error instead of silently
-- creating a duplicate. src/pages/Employees.tsx is updated in this same
-- commit to catch that specific error (Postgres code 23505) and retry
-- (re-generating a fresh number and re-attempting the insert, up to 3
-- times) rather than surfacing a raw database error to the user -- this
-- is the practical mitigation for the residual window this migration's
-- row-locking alone does not fully close.
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_number_counters (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  last_number INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, prefix)
);

ALTER TABLE employee_number_counters ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'employee_number_counters' AND policyname = 'employee_number_counters_tenant_select'
  ) THEN
    CREATE POLICY employee_number_counters_tenant_select ON employee_number_counters
      FOR SELECT USING (tenant_id = get_current_tenant_id());
  END IF;
END $$;
-- No INSERT/UPDATE/DELETE policy is added for regular roles: this table
-- is only ever written to by generate_employee_number() below, which is
-- SECURITY DEFINER and therefore bypasses RLS entirely for its own
-- writes -- exactly like the payroll atomic RPC bypasses RLS on
-- `payroll`/`audit_logs` for the same reason (see 20260803000002's own
-- comment on this). No other code path should ever write to this table
-- directly.

CREATE OR REPLACE FUNCTION generate_employee_number(p_region_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_region_code TEXT;
  v_region_name TEXT;
  v_letter TEXT;
  v_prefix TEXT;
  v_last_number INTEGER;
  v_next_number INTEGER;
BEGIN
  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'generate_employee_number: no tenant resolved for the calling user';
  END IF;

  SELECT code, name INTO v_region_code, v_region_name
    FROM regions
    WHERE id = p_region_id AND tenant_id = v_tenant_id;

  -- Mirrors src/utils/employeeNumberGeneration.ts's getRegionLetter()
  -- exactly: the region's own code if set, else the first letter of its
  -- name, else 'X' if the region can't be resolved at all (matches the
  -- TypeScript function's own fallback for a null/unrecognized region).
  v_letter := UPPER(LEFT(COALESCE(NULLIF(TRIM(v_region_code), ''), NULLIF(TRIM(v_region_name), ''), 'X'), 1));
  v_prefix := 'SFG-' || v_letter || '-';

  -- Lock (or create) this tenant+prefix's counter row for the rest of
  -- this transaction -- a second concurrent call for the SAME prefix
  -- blocks here until the first call's transaction commits, exactly the
  -- same serialization principle as the payroll RPC's
  -- pg_advisory_xact_lock, just via a real row lock instead (equally
  -- safe; a row lock is the more idiomatic choice when the "key" is a
  -- natural table row rather than an arbitrary hash).
  SELECT last_number INTO v_last_number
    FROM employee_number_counters
    WHERE tenant_id = v_tenant_id AND prefix = v_prefix
    FOR UPDATE;

  IF NOT FOUND THEN
    -- First-ever call for this prefix: seed from the highest existing
    -- legacy employee_number matching it, so newly-generated numbers
    -- never collide with or precede pre-existing ones.
    SELECT COALESCE(MAX(CAST(regexp_replace(employee_number, '^' || v_prefix, '') AS INTEGER)), 0)
      INTO v_last_number
      FROM employees
      WHERE tenant_id = v_tenant_id
        AND employee_number LIKE v_prefix || '%'
        AND regexp_replace(employee_number, '^' || v_prefix, '') ~ '^[0-9]+$';

    INSERT INTO employee_number_counters (tenant_id, prefix, last_number)
    VALUES (v_tenant_id, v_prefix, v_last_number);
  END IF;

  v_next_number := v_last_number + 1;

  UPDATE employee_number_counters
    SET last_number = v_next_number, updated_at = NOW()
    WHERE tenant_id = v_tenant_id AND prefix = v_prefix;

  RETURN v_prefix || LPAD(v_next_number::TEXT, 3, '0');
END;
$$;

-- SECURITY CORRECTION (closed at source, see
-- 20260817000005_functional_roles_corrections_lockdown.sql's own header
-- for how this gap was originally found downstream): unlike every other
-- SECURITY DEFINER function in this schema, this one shipped with no
-- REVOKE at all, leaving it fully PUBLIC- and anon-executable. Both are
-- closed here now, at the function's own creation, rather than left open
-- until a later migration finds and fixes it.
REVOKE ALL ON FUNCTION generate_employee_number(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION generate_employee_number(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION generate_employee_number(UUID) TO authenticated;

-- ============================================================
-- ROLLBACK SQL (run in this order; safe at any time -- reverting means
-- new employee creation goes back to the old browser-only calculation,
-- the same as before this migration; no data loss, since employees.
-- employee_number itself is untouched)
-- ============================================================
-- REVOKE EXECUTE ON FUNCTION generate_employee_number(UUID) FROM authenticated;
-- DROP FUNCTION IF EXISTS generate_employee_number(UUID);
-- DROP POLICY IF EXISTS employee_number_counters_tenant_select ON employee_number_counters;
-- DROP TABLE IF EXISTS employee_number_counters;
-- (Roll back the frontend commit that calls generate_employee_number()
-- BEFORE dropping the function, for the same reason as the guard ID
-- migration.)

-- ============================================================
-- PREFLIGHT SQL (run against production BEFORE applying this migration)
-- ============================================================
-- SELECT tenant_id, employee_number, COUNT(*) FROM employees
--   GROUP BY tenant_id, employee_number HAVING COUNT(*) > 1;
-- Expected: 0 rows -- this migration does not itself add the
-- UNIQUE(tenant_id, employee_number) constraint (that already exists,
-- from 20260727000000_reconstructed_base_schema.sql), but this function
-- assumes it's present and enforced; if this query returns rows, that
-- constraint is somehow not doing its job and must be investigated
-- before relying on this migration's "backstop" reasoning above.

-- ============================================================
-- VERIFICATION SQL (run immediately after applying)
-- ============================================================
-- SELECT proname, prosecdef FROM pg_proc WHERE proname = 'generate_employee_number';
-- Expected: 1 row, prosecdef = true.
-- SELECT has_function_privilege('authenticated', 'generate_employee_number(uuid)', 'EXECUTE');
-- Expected: true.
-- SELECT * FROM employee_number_counters LIMIT 5;
-- Expected: succeeds (confirms the table and its SELECT policy exist);
-- returns 0 rows immediately after migration (rows are created lazily,
-- on each prefix's first real call).

-- ============================================================
-- STAGING TEST PROCEDURE (authenticated as a real user so
-- get_current_tenant_id() resolves correctly)
-- ============================================================
--
-- 1. SEQUENTIAL GENERATION for a single region -- confirms increment +
--    zero-padding matches the existing format exactly:
--
--   SELECT generate_employee_number('<a real region id from your regions table>');
--   -- e.g. SFG-N-001 (or wherever the seed landed above your existing
--   -- legacy max for that prefix)
--   SELECT generate_employee_number('<same region id>');
--   -- next value, exactly +1, e.g. SFG-N-002
--
-- 2. TWO DIFFERENT REGIONS run independent counters (confirms the
--    per-prefix, not global, scoping) -- this IS the region-prefix
--    separation test:
--
--   SELECT generate_employee_number('<region A id>'); -- e.g. SFG-N-001
--   SELECT generate_employee_number('<region B id>'); -- e.g. SFG-S-001,
--                                                      -- NOT SFG-S-002
--
-- 3. TWO SIMULTANEOUS REQUESTS for the SAME region/prefix -- confirms
--    the row lock actually serializes concurrent callers (open two
--    separate staging DB sessions/tabs, run at the same moment):
--
--   -- Session A:                           -- Session B (same moment):
--   SELECT generate_employee_number('<r>');  SELECT generate_employee_number('<r>');
--
--   Expected: two distinct, consecutive numbers -- session B visibly
--   waits for session A's transaction to commit.
--
-- 4. TEN SIMULTANEOUS REQUESTS -- a stronger automated version of #3
--    within one session:
--
--   SELECT count(DISTINCT v), count(v), max(v) - min(v) FROM (
--     SELECT (regexp_replace(generate_employee_number('<region id>'), '^SFG-[A-Z]-', ''))::int AS v
--     FROM generate_series(1, 10)
--   ) t;
--   -- Expected: count(DISTINCT v) = count(v) = 10, max-min = 9 (10
--   -- consecutive integers, no gaps, no duplicates). For genuine
--   -- cross-connection concurrency, use pgbench with 10 concurrent
--   -- clients each calling this function once for the same region.
--
-- 5. EXISTING LEGACY NUMBERS are never collided with, INCLUDING GAPS in
--    the existing numbering (e.g. a region with SFG-N-001, SFG-N-005,
--    SFG-N-047 already present -- from manual entry or deleted-and-
--    reused numbers -- must seed from the MAX (47), not the count (3)):
--
--   -- Run BEFORE applying this migration to capture the true state:
--   SELECT employee_number FROM employees
--     WHERE employee_number LIKE 'SFG-N-%' ORDER BY employee_number DESC LIMIT 3;
--   -- note the highest existing value for that prefix, e.g. SFG-N-047
--
--   -- after applying the migration:
--   SELECT generate_employee_number('<the "N" region id>');
--   -- Expected: SFG-N-048 (47 + 1), never SFG-N-001 or SFG-N-004 (which
--   -- would be derived from the row count instead of the max).
--
-- 6. INVALID LEGACY FORMATS are ignored by the seed step, not treated as
--    errors or as 0 (the seed query's own
--    `regexp_replace(employee_number, '^' || v_prefix, '') ~ '^[0-9]+$'`
--    filter must handle a malformed value gracefully):
--
--   -- Simulate a malformed legacy value for a not-yet-seeded prefix:
--   -- UPDATE employees SET employee_number = 'SFG-N-UNKNOWN' WHERE id = '<some employee>';
--   SELECT generate_employee_number('<the "N" region id>');
--   -- Expected: succeeds, seeded from the highest VALID (SFG-N-<digits>)
--   -- legacy value, silently ignoring 'SFG-N-UNKNOWN' rather than
--   -- erroring on the failed CAST or treating it as the max.
--
-- 7. COLLISION RETRIES -- UNIQUE CONSTRAINT BACKSTOP still rejects a
--    real duplicate (proves the residual race window this migration
--    doesn't fully close is still safe against actual data corruption,
--    even if the app-level retry logic in Employees.tsx were somehow
--    bypassed) -- this is exactly the error Employees.tsx's own
--    getNextEmployeeNumberForRegion() retry loop reacts to:
--
--   INSERT INTO employees (tenant_id, employee_number, full_name, basic_salary)
--     VALUES (get_current_tenant_id(), (SELECT employee_number FROM employees LIMIT 1), 'Test Duplicate', 0);
--   -- Expected: ERROR: duplicate key value violates unique constraint
--   -- on (tenant_id, employee_number)
--
-- 8. TENANT SEPARATION -- confirms two different tenants' counters for
--    the "same" region letter are fully independent (needs a second
--    tenant/company seeded in the same staging project, each with its
--    own region using the same letter, e.g. both named "North"):
--
--   -- As a user in Tenant A, region "North":
--   SELECT generate_employee_number('<Tenant A North region id>'); -- e.g. SFG-N-001
--   -- As a user in Tenant B, region "North":
--   SELECT generate_employee_number('<Tenant B North region id>'); -- e.g. SFG-N-001 too --
--                                                                  -- NOT SFG-N-002
--   SELECT tenant_id, prefix, last_number FROM employee_number_counters WHERE prefix = 'SFG-N-';
--   -- Expected: two rows, one per tenant, independently incrementing
--   -- despite sharing the same prefix text.
-- ============================================================
