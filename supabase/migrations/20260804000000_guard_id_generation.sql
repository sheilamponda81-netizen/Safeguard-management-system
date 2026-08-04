-- ============================================================
-- MIGRATION: Server-side, transaction-safe Guard ID generation
-- Date: 2026-08-04
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
-- FIX: move ID generation into the database, using a Postgres SEQUENCE
-- (the standard, battle-tested atomic-counter primitive -- `nextval()` is
-- inherently concurrency-safe: two simultaneous callers are guaranteed
-- distinct, monotonically increasing values with no possibility of a
-- race, by Postgres's own internal locking of the sequence's counter
-- state, independent of and stronger than anything achievable with
-- client-side random generation or even a hand-rolled "SELECT MAX +
-- INSERT" pattern, which is NOT safe under concurrent access).
--
-- FORMAT: G- followed by a zero-padded 4-digit number (G-0001, G-0002,
-- ...). If the count of guards ever exceeds 9999, the number simply
-- grows to 5 digits (G-10000) rather than wrapping or colliding --
-- correctness over cosmetic padding.
--
-- LEGACY DATA: existing "guardId" values were random 4-digit numbers in
-- the 1000-9999 range with no guaranteed relationship to insertion order.
-- The sequence below is seeded to start strictly above the highest
-- numeric suffix among all EXISTING "guardId" values (across every
-- tenant), so newly-generated IDs can never collide with a legacy one
-- already in use. A UNIQUE constraint is added as a second, independent
-- guarantee (belt-and-suspenders): even if some future code path ever
-- inserts a guardId outside this function, a real duplicate is rejected
-- by the database itself rather than silently accepted.
--
-- ================= DEPLOYMENT ORDER WARNING =================
-- Unlike the payroll atomic RPC (20260803000002), this migration's
-- companion frontend change (src/utils/guardIdGeneration.ts's
-- generateGuardIdServerSide(), wired into src/pages/Security.tsx) DOES
-- call this new RPC. That means: if the frontend code reaches production
-- before this migration is applied there, guard creation will break
-- outright (`function generate_guard_id() does not exist`). The correct
-- rollout order is: (1) apply this migration to staging, run the test
-- procedure below, (2) apply this migration to production, verify the
-- function exists and the sequence is seeded correctly, (3) only then
-- deploy the frontend commit that calls it. See AUDIT_REPORT.md's
-- "Production deployment and rollback order" for the full sequencing
-- across every migration in this audit.
-- ============================================================

-- ---------------------------------------------------------------
-- STEP 1: unique constraint on the legacy column, so a real duplicate
-- (if one already exists from the old random-collision-prone scheme) is
-- surfaced now, loudly, as a migration failure -- not silently ignored.
-- If this fails on staging/production, the safe remediation is to find
-- and manually re-assign the duplicate "guardId" value(s) first (a
-- one-time, reviewed data-correction step), then re-run this migration --
-- never to drop this constraint to force it through.
-- ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_guard_id_unique'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_guard_id_unique UNIQUE ("guardId");
  END IF;
END $$;

-- ---------------------------------------------------------------
-- STEP 2: the sequence, seeded above every existing legacy value.
-- `"guardId" ~ '^G-[0-9]+$'` guards the regexp_replace against any
-- malformed/legacy-free-text value that isn't in the expected G-<digits>
-- shape (defensive -- there is no evidence such rows exist, but a
-- migration should never assume its own input is clean).
-- ---------------------------------------------------------------
DO $$
DECLARE
  max_existing INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(regexp_replace("guardId", '^G-', '') AS INTEGER)), 0)
    INTO max_existing
    FROM employees
    WHERE "guardId" ~ '^G-[0-9]+$';

  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS guard_id_seq START WITH %s', max_existing + 1);
END $$;

-- ---------------------------------------------------------------
-- STEP 3: the generation function itself. SECURITY DEFINER is required
-- purely so any authenticated caller can advance the sequence (sequence
-- ownership/USAGE would otherwise need a separate GRANT); the function
-- does no table reads/writes of its own and returns only a formatted
-- string, so it does not need to (and does not) perform any tenant/role
-- authorization check -- generating an unused guard ID string has no
-- security-relevant side effect on its own. The actual employees INSERT/
-- UPDATE that uses this value remains subject to that table's own RLS
-- policies exactly as before.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_guard_id()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_id INTEGER;
BEGIN
  next_id := nextval('guard_id_seq');
  RETURN 'G-' || LPAD(next_id::TEXT, 4, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION generate_guard_id() TO authenticated;

-- ============================================================
-- ROLLBACK SQL (run in this order; safe at any time -- reverting simply
-- means new guard creation goes back to the old client-side random
-- generator, the same as before this migration, not a data-loss risk)
-- ============================================================
-- REVOKE EXECUTE ON FUNCTION generate_guard_id() FROM authenticated;
-- DROP FUNCTION IF EXISTS generate_guard_id();
-- DROP SEQUENCE IF EXISTS guard_id_seq;
-- ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_guard_id_unique;
-- (Rolling back the frontend commit that calls generate_guard_id() must
-- happen BEFORE dropping the function, for the same reason noted above.)

-- ============================================================
-- STAGING TEST PROCEDURE (run against a staging Supabase project only)
-- ============================================================
--
-- 1. CONSECUTIVE GENERATION -- confirms monotonic, unique, correctly
--    formatted output:
--
--   SELECT generate_guard_id();  -- e.g. G-0001 (or wherever the seed
--                                -- landed above your existing legacy max)
--   SELECT generate_guard_id();  -- next value, exactly +1
--   SELECT generate_guard_id();  -- next value, exactly +1
--
--   Expected: three distinct values, each the previous numeric suffix
--   + 1, all matching ^G-\d{4,}$.
--
-- 2. CONCURRENT GENERATION -- confirms no duplicate under real concurrent
--    access (open two separate psql/staging DB sessions/tabs and run
--    each block at the same time, or use pgbench):
--
--   -- Session A:                      -- Session B (run within the same
--   SELECT generate_guard_id();        -- second):
--                                       SELECT generate_guard_id();
--
--   Expected: the two returned values are different -- sequences never
--   hand out the same value twice, even under true concurrency, which is
--   exactly why this is the correct primitive here (unlike a client-side
--   "SELECT MAX(guardId) + 1" pattern, which is NOT safe under
--   concurrent access and could hand out the same "next" value to two
--   simultaneous callers).
--   For a stronger, automated version of this check:
--
--   SELECT count(DISTINCT v), count(v) FROM (
--     SELECT generate_guard_id() AS v FROM generate_series(1, 500)
--   ) t;
--   -- Expected: both counts equal 500 (no duplicates even across 500
--   -- rapid-fire calls in the same session).
--
-- 3. LEGACY GUARD ID HANDLING -- confirms the seed step actually
--    protected existing data (run BEFORE applying this migration, to
--    capture the true pre-migration state):
--
--   SELECT "guardId" FROM employees WHERE "guardId" IS NOT NULL ORDER BY "guardId" DESC LIMIT 5;
--   -- note the highest existing value, e.g. G-9987
--
--   -- after applying the migration:
--   SELECT generate_guard_id();
--   -- Expected: a value strictly greater than every legacy value noted
--   -- above (e.g. if the highest legacy value was G-9987, the first
--   -- generated value is G-9988 or higher -- never G-0001, which would
--   -- collide with legacy IDs at the low end of their random range if
--   -- any existed, though in practice legacy IDs are always >= 1000 so
--   -- a fresh low-end sequence would technically be safe too; seeding
--   -- above the legacy max is the more conservative, defensively-correct
--   -- choice and requires no assumption about the legacy range at all).
--
--   -- Also confirm the UNIQUE constraint actually rejects a real
--   -- duplicate (should error, not silently succeed):
--   -- UPDATE employees SET "guardId" = (SELECT "guardId" FROM employees WHERE "guardId" IS NOT NULL LIMIT 1)
--   --   WHERE id = (SELECT id FROM employees WHERE "guardId" IS NULL OR "guardId" != (SELECT "guardId" FROM employees WHERE "guardId" IS NOT NULL LIMIT 1) LIMIT 1);
--   -- Expected: ERROR: duplicate key value violates unique constraint "employees_guard_id_unique"
-- ============================================================
