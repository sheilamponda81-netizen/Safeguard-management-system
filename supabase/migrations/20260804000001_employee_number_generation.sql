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
-- STAGING TEST PROCEDURE
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
--    per-prefix, not global, scoping):
--
--   SELECT generate_employee_number('<region A id>'); -- e.g. SFG-N-001
--   SELECT generate_employee_number('<region B id>'); -- e.g. SFG-S-001,
--                                                      -- NOT SFG-S-002
--
-- 3. CONCURRENT GENERATION for the SAME region/prefix -- confirms the
--    row lock actually serializes concurrent callers (run in two
--    separate sessions/tabs at the same time):
--
--   -- Session A:                           -- Session B (same moment):
--   SELECT generate_employee_number('<r>');  SELECT generate_employee_number('<r>');
--
--   Expected: two distinct, consecutive numbers -- never the same value
--   twice. For a stronger automated check within one session:
--
--   SELECT count(DISTINCT v), count(v) FROM (
--     SELECT generate_employee_number('<region id>') AS v FROM generate_series(1, 200)
--   ) t;
--   -- Expected: both counts equal 200.
--
-- 4. LEGACY EMPLOYEE NUMBER PRESERVATION -- confirms the seed step
--    protects real existing data (run BEFORE applying this migration to
--    capture the true pre-migration state):
--
--   SELECT employee_number FROM employees
--     WHERE employee_number LIKE 'SFG-N-%' ORDER BY employee_number DESC LIMIT 3;
--   -- note the highest existing value for that prefix, e.g. SFG-N-047
--
--   -- after applying the migration:
--   SELECT generate_employee_number('<the "N" region id>');
--   -- Expected: SFG-N-048, never SFG-N-001 (which could collide with an
--   -- existing legacy number in that range).
--
-- 5. UNIQUE CONSTRAINT BACKSTOP still rejects a real duplicate (proves
--    the residual race window this migration doesn't fully close is
--    still safe against actual data corruption, even if the app-level
--    retry logic in Employees.tsx were somehow bypassed):
--
--   INSERT INTO employees (tenant_id, employee_number, full_name, basic_salary)
--     VALUES (get_current_tenant_id(), (SELECT employee_number FROM employees LIMIT 1), 'Test Duplicate', 0);
--   -- Expected: ERROR: duplicate key value violates unique constraint
--   -- on (tenant_id, employee_number)
-- ============================================================
