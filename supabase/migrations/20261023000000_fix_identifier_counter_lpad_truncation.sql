-- ============================================================
-- HOTFIX: Fix LPAD truncation bug in generate_employee_number() and
-- generate_guard_id() -- P0 production incident (Add New Employee
-- failing with HTTP 409 for genuinely new employees)
-- Date: 2026-10-23
-- ============================================================
--
-- ROOT CAUSE (confirmed directly against the PRODUCTION database, not
-- inferred from migration files alone -- see verification queries below,
-- all run read-only before writing this fix):
-- -----------------------------------------------------------
-- generate_employee_number() (20260804000001) ends with:
--   RETURN v_prefix || LPAD(v_next_number::TEXT, 3, '0');
-- Postgres's LPAD TRUNCATES (keeps only the leftmost N characters) when
-- the input string is already LONGER than the target width -- it does
-- NOT simply leave a longer string unchanged. This was never a problem
-- while every tenant+prefix counter stayed below 1000 (a 1-3 digit
-- number always padded correctly to exactly 3 digits), but is a silent,
-- wrong-answer bug the moment any one counter reaches 1000: the stated
-- design intent (this migration's OWN header, and
-- 20260804000000_guard_id_generation.sql's identical header for guard
-- IDs) was always "the number simply grows to more digits rather than
-- wrapping or colliding -- correctness over cosmetic padding" -- but
-- LPAD(..., 3, '0') does the opposite: it silently DISCARDS the leading
-- digit(s) instead of growing.
--
-- CONFIRMED LIVE on production (project mfhmanpdxcloitboylrr, the
-- project the app's default/production Vercel environment variables
-- point to -- NOT the separate STAGING project mcwgzmijzglugsgeayzj,
-- which has its own, unaffected counter state):
--   employee_number_counters for the live tenant's 'SFG-S-' prefix
--   (South region) has last_number = 1036. The next call therefore
--   computes v_next_number = 1037, and
--     SELECT lpad('1037', 3, '0');  -- returns '103', NOT '1037'
--   'SFG-S-103' already belongs to an existing employee (full_name
--   'RITA DESMOND', confirmed by direct query). Every single call to
--   generate_employee_number() for this region, by any user, for ANY
--   new employee, therefore returns an ALREADY-TAKEN number -- not a
--   rare race, a GUARANTEED collision on every attempt. Employees.tsx's
--   own retry loop (up to 5 attempts, specifically for employee_number
--   collisions -- see src/pages/Employees.tsx) does not help: each
--   retry calls this SAME function again, which increments its counter
--   (1038, 1039, ...) and truncates to the SAME 3-digit result for an
--   entire run of 10 consecutive values (1030-1039 all truncate to
--   '103', 1040-1049 all truncate to '104', etc.) -- so multiple
--   consecutive retries can easily land on the identical already-taken
--   value, exhausting all 5 attempts. Once exhausted, the final 23505 on
--   employee_number falls through to the fully generic message
--   (src/utils/errorHandler.ts's getErrorMessage(), which deliberately
--   never echoes raw Postgres text and maps EVERY '23505' to "This
--   record already exists. Please check your data.", regardless of
--   which column/constraint actually fired) -- exactly the message HR
--   reported seeing, on genuinely new employees, specifically (though
--   not exclusively) in the South region.
--
-- WHY THIS ONLY STARTED NOW: the South region's counter just crossed the
-- 999 -> 1000 boundary (last_number already at 1036 at the time of this
-- fix -- meaning this has likely been failing for every South-region
-- hire attempt for some number of days/attempts already, each one
-- silently burning another counter value with no employee actually
-- created, which is why last_number is already well past 1000 despite
-- zero successful 4-digit employee numbers existing yet -- confirmed:
-- max 'SFG-S-%' employee_number in production is 'SFG-S-998', 967 total
-- rows for that prefix). No other tenant/prefix in production is
-- anywhere close to this boundary today (checked directly: 'SFG-C-' at
-- 9, 'SFG-E-' at 2; only one tenant exists in production) -- but ANY
-- region will eventually hit this same wall at its own 999th employee,
-- and generate_guard_id() (20260804000000) has the IDENTICAL
-- `LPAD(v_next_number::TEXT, 4, '0')` pattern for guard IDs (currently
-- at last_number = 5 in production, nowhere near its own 9999 boundary
-- yet, but the same latent bug) -- both are fixed together here since
-- they are the same root cause, confirmed by direct inspection of both
-- live function bodies.
--
-- THE FIX
-- -----------------------------------------------------------
-- Pad to AT LEAST the stated width, but never truncate below the
-- number's own natural length -- i.e. exactly the behavior both
-- migrations' own original design intent already describes in English,
-- which plain LPAD does not actually provide once the number exceeds
-- that width:
--   LPAD(v_next_number::TEXT, GREATEST(LENGTH(v_next_number::TEXT), 3), '0')
-- For a 1-3 digit number this is unchanged (GREATEST(1or2or3, 3) = 3,
-- identical to before). For a 4+ digit number, the target width becomes
-- the number's own length, so LPAD is a no-op on it (nothing to pad,
-- nothing to truncate) -- 1037 remains '1037', never '103'. Applied
-- identically to generate_guard_id()'s own LPAD(..., 4, '0') (target
-- width 4 instead of 3, same GREATEST pattern).
--
-- NO DATA CHANGE, NO RENUMBERING: this migration does not touch
-- `employee_number_counters`, `guard_id_counters`, or `employees`/
-- their existing values at all -- the counter's own last_number state
-- (1036 for 'SFG-S-') was always the CORRECT next-sequence value; only
-- the final string-formatting step was wrong. The very next call after
-- this fix is applied will correctly return 'SFG-S-1037' (brand new,
-- never used) rather than 'SFG-S-103' (already taken) -- no counter
-- reset or backfill is needed or performed.
--
-- NO FRONTEND DEPLOYMENT ORDERING REQUIRED: src/utils/
-- employeeNumberGeneration.ts's generateEmployeeNumberServerSide()
-- already falls back to the old, race-prone browser-side calculation if
-- this RPC call fails for any reason (unchanged by this migration) --
-- but that fallback does NOT help here, since generate_employee_number()
-- was not ERRORING, it was returning a WRONG VALUE that only failed
-- later at the INSERT. This migration is the actual fix; no frontend
-- change is required for correctness, though a companion frontend
-- change (same PR) improves the user-facing message for the rare
-- residual case where all retries still exhaust (e.g. a genuine
-- concurrent collision), replacing the fully generic message with one
-- that specifically names employee-number generation and suggests
-- retrying, instead of silently reusing the single generic 23505
-- message for every possible cause.
-- ============================================================

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

  v_letter := UPPER(LEFT(COALESCE(NULLIF(TRIM(v_region_code), ''), NULLIF(TRIM(v_region_name), ''), 'X'), 1));
  v_prefix := 'SFG-' || v_letter || '-';

  PERFORM pg_advisory_xact_lock(hashtext('employee_number_counter:' || v_tenant_id::text), hashtext(v_prefix));

  SELECT last_number INTO v_last_number
    FROM employee_number_counters
    WHERE tenant_id = v_tenant_id AND prefix = v_prefix
    FOR UPDATE;

  IF NOT FOUND THEN
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

  -- FIX: pad to AT LEAST 3 digits, never truncate below the number's own
  -- length -- see this migration's header for why plain LPAD(..., 3, '0')
  -- silently discarded leading digits once v_next_number reached 1000.
  RETURN v_prefix || LPAD(v_next_number::TEXT, GREATEST(LENGTH(v_next_number::TEXT), 3), '0');
END;
$$;

REVOKE ALL ON FUNCTION generate_employee_number(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION generate_employee_number(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION generate_employee_number(UUID) TO authenticated;

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

  PERFORM pg_advisory_xact_lock(hashtext('guard_id_counter:' || v_tenant_id::text));

  SELECT last_number INTO v_last_number
    FROM guard_id_counters
    WHERE tenant_id = v_tenant_id
    FOR UPDATE;

  IF NOT FOUND THEN
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

  -- FIX: same GREATEST-based pattern as generate_employee_number() above
  -- -- pad to AT LEAST 4 digits, never truncate. Latent only (production's
  -- guard counter is at 5 today), fixed preemptively since it is the
  -- identical bug, confirmed by direct inspection of this function's live
  -- production body.
  RETURN 'G-' || LPAD(v_next_number::TEXT, GREATEST(LENGTH(v_next_number::TEXT), 4), '0');
END;
$$;

REVOKE ALL ON FUNCTION generate_guard_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION generate_guard_id() FROM anon;
GRANT EXECUTE ON FUNCTION generate_guard_id() TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION and the
-- same REVOKE/GRANT statements every time. No table/column/data changes
-- of any kind.
--
-- PREFLIGHT (run before applying, confirms current state -- informational
-- only, does not block applying the fix):
--   SELECT tenant_id, prefix, last_number,
--          (prefix || lpad((last_number+1)::text, 3, '0')) AS buggy_next_value,
--          EXISTS (
--            SELECT 1 FROM employees e
--            WHERE e.tenant_id = c.tenant_id AND e.employee_number = (c.prefix || lpad((c.last_number+1)::text, 3, '0'))
--          ) AS would_currently_collide
--   FROM employee_number_counters c ORDER BY tenant_id, prefix;
--   -- Any row with would_currently_collide = true is actively broken
--   -- right now and is exactly what this migration fixes.
--
-- VERIFICATION (run immediately after applying):
--   SELECT lpad('1037', GREATEST(length('1037'), 3), '0');  -- expect '1037', not '103'
--   SELECT lpad('37', GREATEST(length('37'), 3), '0');      -- expect '037', unchanged behavior for the normal case
--   -- Then, as an authenticated user, actually call it for the affected region:
--   SELECT generate_employee_number('<South region id>');
--   -- Expect 'SFG-S-1037' (or whatever last_number has advanced to by
--   -- then) -- a 4-digit value, and NOT a value that already exists:
--   SELECT employee_number FROM employees WHERE employee_number = '<the value just generated>';
--   -- Expect 0 rows.
--
-- ROLLBACK SQL (run this to fully revert this migration -- SAFE at any
-- time, since no data was changed; this simply restores the previous,
-- truncating LPAD behavior, re-introducing the bug this migration fixes):
--   -- Re-apply 20260804000001_employee_number_generation.sql's own
--   -- CREATE OR REPLACE FUNCTION generate_employee_number block verbatim.
--   -- Re-apply 20260804000000_guard_id_generation.sql's own
--   -- CREATE OR REPLACE FUNCTION generate_guard_id block verbatim.
-- ============================================================
