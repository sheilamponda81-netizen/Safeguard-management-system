-- Safeguard HikCentral Attendance MVP -- Phase 2B.1: Roster Management
-- Foundation.
--
-- ============================================================
-- SCOPE
-- ============================================================
-- Adds a roster (Off-day / Day-shift / Night-shift) scheduling system,
-- entirely separate from and never touching `attendance`, `payroll`,
-- `payment_status`, or `employee_deductions`. This migration creates NO
-- link whatsoever to those tables -- no foreign key, no trigger, no RPC
-- here reads or writes any of them. It also does not generate official
-- attendance from HikCentral fingerprint data; that remains out of scope
-- entirely (see hikcentralAttendancePreview.ts's own header for why no
-- schedule/shift concept existed anywhere in this codebase before this
-- migration).
--
-- Confirmed business policy encoded here (see src/utils/rosterSchedule.ts
-- for the identical pure-logic spec this SQL mirrors, unit-tested there):
--   - Day shift 06:00-18:00 (Africa/Blantyre), Night shift 18:00-06:00
--     next day. A Night shift belongs to its STARTING calendar date.
--   - Off days normally repeat on the same weekday until Admin changes
--     them, effective from a specified date (`roster_off_day_patterns`).
--   - A dated Day/Night/Off assignment (`roster_date_assignments`) always
--     overrides whatever the recurring pattern would otherwise say for
--     that exact date.
--   - Every employee must have at least one Off day in every ROLLING
--     seven-day period (not merely once per Mon-Sun calendar week) --
--     enforced by roster_rolling_rest_windows() below, called by every
--     write path. A CONFIRMED violation (every date in a 7-day window
--     resolved, none Off) is a hard block with NO override path at all.
--     An INCOMPLETE window (contains at least one not-yet-assigned date)
--     is never reported as a violation -- there is nothing to confirm yet.
--   - A Night shift finishing into an Off-day morning is explicitly VALID
--     (confirmed policy) and is never flagged. A NEW shift starting ON an
--     Off day is blocked unless explicitly, non-silently overridden
--     (requires a reason); a Night-shift-into-Day-shift adjacency across
--     two dates is ALWAYS hard-blocked, with no override path.
--   - "Unassigned" (no pattern, no dated row) is a distinct state, never
--     interpreted as Absence/Leave/Sick Leave -- those remain exclusively
--     `attendance.status` concerns, untouched here.
--
-- ============================================================
-- SECURITY MODEL (the central engineering requirement this migration
-- exists to satisfy: "application users cannot directly INSERT, UPDATE or
-- DELETE roster records outside controlled write functions")
-- ============================================================
-- Table grants to `authenticated` are SELECT-ONLY (see the REVOKE/GRANT
-- block below) -- there is no INSERT/UPDATE/DELETE grant to `authenticated`
-- on either table AT ALL, and RLS additionally defines no write policy
-- for either table, so even if a future change accidentally granted
-- table-level DML, RLS's own policy-absence-is-deny-by-default behavior
-- is a second independent wall. This is deliberately NOT "RLS alone": the
-- write RPCs below are SECURITY DEFINER (not INVOKER), meaning they write
-- using the function owner's inherent table-owner privileges, which is
-- the ONLY path capable of writing at all -- a direct PostgREST
-- INSERT/UPDATE from any authenticated session, Admin or not, is rejected
-- by Postgres's grant system before RLS is even consulted.
--
-- Each write RPC:
--   - re-derives the caller's tenant_id/role_level/role/is_super_admin
--     directly from `profiles` (never trusts a client-supplied value),
--     matching import_hikcentral_raw_events()'s established pattern over
--     get_current_tenant_id() (the one helper without its own
--     SET search_path, per that migration's documented root cause);
--   - explicitly checks is_super_admin() OR role='admin' OR role_level=1
--     (the exact is_business_admin() definition) and RAISE EXCEPTIONs
--     otherwise -- "Only Admin," no permission-table branch, ever;
--   - verifies every employee_id's tenant_id matches the caller's own,
--     rejecting the ENTIRE call (atomic, no partial writes) if any one
--     fails;
--   - sets assigned_by/superseded_by from auth.uid() captured ONCE at
--     function entry -- SECURITY DEFINER changes which ROLE's privileges
--     apply to table access, it does NOT change what auth.uid() returns
--     (that reads the original caller's JWT claims regardless), so actor
--     attribution cannot be spoofed by a client-supplied parameter,
--     because no such parameter exists in any of these functions' sigs;
--   - takes `SELECT ... FOR UPDATE` on the target employee's own `employees`
--     row as the FIRST statement touching that employee, before any
--     roster read/check/write for them -- this serializes ALL roster
--     mutations for a given employee globally (including a first-time
--     insert, where no roster row yet exists to lock), which also
--     trivially covers neighboring-overnight-assignment races (D and D+1
--     for the same employee are always protected by the same lock).
--     Employee ids within a bulk call are processed in SORTED order to
--     prevent a classic deadlock between two concurrent bulk calls
--     locking an overlapping employee set in opposite orders.
--   - performs its writes, THEN calls roster_rolling_rest_windows() for
--     every affected employee/date and RAISE EXCEPTIONs (aborting the
--     ENTIRE transaction -- including every row already written earlier
--     in the same bulk call) if any CONFIRMED violation resulted. This
--     "write inside the transaction, validate after, abort on failure"
--     sequencing is what makes multi-row bulk operations and the atomic
--     Off-day-reschedule-plus-work-assignment composite operation both
--     genuinely atomic without duplicating the resolution logic against
--     an in-memory overlay in PL/pgSQL.
--   - SET search_path = public, pg_temp (standard hardening, matches
--     every other SECURITY DEFINER function in this codebase).
--
-- The two read-only helper functions (roster_resolve_schedule,
-- roster_rolling_rest_windows) are SECURITY INVOKER -- they perform no
-- writes, and when called from inside a SECURITY DEFINER caller they
-- execute with that caller's already-elevated privileges regardless (a
-- nested INVOKER function runs as whatever role is CURRENTLY executing,
-- which is the DEFINER function's owner role at that point in the call
-- stack) -- there is no privilege-separation benefit to making them
-- DEFINER too, and keeping them INVOKER keeps the DEFINER surface (the
-- part of this migration that must be most carefully reviewed) to
-- exactly the three write RPCs.
--
-- History is append-only: a `BEFORE UPDATE` trigger on both tables
-- (roster_prevent_illegal_mutation) permits ONLY the narrow
-- is_active:true->false "close out" transition (with superseded_at/
-- superseded_by/correction_reason all required), rejecting any other
-- column mutation on an existing row -- even the write RPCs themselves
-- (and, redundantly, any future direct superuser UPDATE) can only ever
-- express a correction as close-old-row + insert-new-row, never an
-- in-place rewrite of a historical fact. There is no DELETE policy and
-- no DELETE grant to `authenticated` on either table at all.

-- ============================================================
-- PART 1: TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS roster_off_day_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- 0 = Sunday .. 6 = Saturday, matching JS Date#getUTCDay() so the
  -- client-side pure module (rosterSchedule.ts) never needs a translation
  -- layer between the two.
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  effective_from DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NOT NULL REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correction_reason TEXT,
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES profiles(id),
  CONSTRAINT roster_off_day_patterns_supersession_shape CHECK (
    (is_active AND superseded_at IS NULL AND superseded_by IS NULL)
    OR
    (NOT is_active AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND correction_reason IS NOT NULL)
  )
);

-- At most one row per (employee, effective_from) may be simultaneously
-- "currently believed correct" -- NOT "at most one active row per
-- employee" (a routine forward-looking change and a routine backdated
-- correction are both perfectly normal and coexist as multiple active
-- rows with DIFFERENT effective_from values; only a genuine correction of
-- a specific wrong fact goes through supersession).
CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_off_day_patterns_active_employee_effective
  ON roster_off_day_patterns(employee_id, effective_from) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_roster_off_day_patterns_employee_effective
  ON roster_off_day_patterns(employee_id, effective_from);

CREATE TABLE IF NOT EXISTS roster_date_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assignment_date DATE NOT NULL,
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('day', 'night', 'off')),
  -- true only when this row was written knowing it replaces what the
  -- recurring pattern (or an existing dated 'off' exception) said was an
  -- Off day -- stamped by the write RPC, never client-supplied, so an
  -- override always stays visibly distinguishable from an ordinary
  -- assignment forever.
  overrides_recurring_off_day BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NOT NULL REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correction_reason TEXT,
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES profiles(id),
  CONSTRAINT roster_date_assignments_supersession_shape CHECK (
    (is_active AND superseded_at IS NULL AND superseded_by IS NULL)
    OR
    (NOT is_active AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND correction_reason IS NOT NULL)
  )
);

-- A single calendar date has only one true assignment at a time (unlike
-- the pattern table above) -- at most one ACTIVE row per (employee, date).
CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_date_assignments_active_employee_date
  ON roster_date_assignments(employee_id, assignment_date) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_roster_date_assignments_employee_date
  ON roster_date_assignments(employee_id, assignment_date);

-- ============================================================
-- PART 2: APPEND-ONLY ENFORCEMENT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION roster_prevent_illegal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.is_active = false THEN
    RAISE EXCEPTION 'Roster records are append-only: an already-superseded row can never be modified again' USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
  THEN
    RAISE EXCEPTION 'Roster records are append-only: identity/origin columns cannot be modified on an existing row -- insert a new row instead' USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'roster_off_day_patterns' THEN
    IF NEW.weekday IS DISTINCT FROM OLD.weekday OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
      RAISE EXCEPTION 'Roster records are append-only: weekday/effective_from cannot be modified on an existing row -- supersede it instead' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'roster_date_assignments' THEN
    IF NEW.assignment_date IS DISTINCT FROM OLD.assignment_date
       OR NEW.assignment_type IS DISTINCT FROM OLD.assignment_type
       OR NEW.overrides_recurring_off_day IS DISTINCT FROM OLD.overrides_recurring_off_day
    THEN
      RAISE EXCEPTION 'Roster records are append-only: assignment_date/assignment_type cannot be modified on an existing row -- supersede it instead' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The ONLY permitted transition: closing a row out.
  IF NEW.is_active = true THEN
    RAISE EXCEPTION 'Roster records are append-only: an UPDATE may only close a row out (is_active -> false), never leave it active' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_at IS NULL OR NEW.superseded_by IS NULL OR NEW.correction_reason IS NULL OR btrim(NEW.correction_reason) = '' THEN
    RAISE EXCEPTION 'Closing out a roster row requires superseded_at, superseded_by, and a non-empty correction_reason to all be set' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_roster_off_day_patterns_append_only ON roster_off_day_patterns;
CREATE TRIGGER trg_roster_off_day_patterns_append_only
  BEFORE UPDATE ON roster_off_day_patterns
  FOR EACH ROW EXECUTE FUNCTION roster_prevent_illegal_mutation();

DROP TRIGGER IF EXISTS trg_roster_date_assignments_append_only ON roster_date_assignments;
CREATE TRIGGER trg_roster_date_assignments_append_only
  BEFORE UPDATE ON roster_date_assignments
  FOR EACH ROW EXECUTE FUNCTION roster_prevent_illegal_mutation();

-- ============================================================
-- PART 3: RLS -- SELECT only, Admin-only (default UI scope; Operations
-- read access is explicitly deferred to a separate, later approval, per
-- confirmed policy). No INSERT/UPDATE/DELETE policy exists for either
-- table at all -- RLS's own default-deny-when-no-policy-exists behavior
-- is a second wall behind the REVOKEd table grants in Part 4.
-- ============================================================

ALTER TABLE roster_off_day_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_date_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Roster off-day patterns: view is Admin-only" ON roster_off_day_patterns;
CREATE POLICY "Roster off-day patterns: view is Admin-only" ON roster_off_day_patterns
FOR SELECT USING (
  is_current_user_active()
  AND (is_super_admin() OR (tenant_id = get_current_tenant_id() AND is_business_admin()))
);

DROP POLICY IF EXISTS "Roster date assignments: view is Admin-only" ON roster_date_assignments;
CREATE POLICY "Roster date assignments: view is Admin-only" ON roster_date_assignments
FOR SELECT USING (
  is_current_user_active()
  AND (is_super_admin() OR (tenant_id = get_current_tenant_id() AND is_business_admin()))
);

-- ============================================================
-- PART 4: TABLE GRANTS -- SELECT only to `authenticated`. No INSERT,
-- UPDATE, or DELETE grant to `authenticated` (or anon/PUBLIC) exists on
-- either table at all -- the three SECURITY DEFINER RPCs in Part 6 are
-- the ONLY possible write path, full stop.
-- ============================================================

REVOKE ALL ON roster_off_day_patterns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON roster_date_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON roster_off_day_patterns TO authenticated;
GRANT SELECT ON roster_date_assignments TO authenticated;

-- ============================================================
-- PART 5: READ-ONLY RESOLUTION / VALIDATION HELPERS (SECURITY INVOKER)
-- ============================================================

-- Resolves the effective schedule for one employee on one date, applying
-- the exact precedence rule src/utils/rosterSchedule.ts's
-- resolveScheduleForDate() implements and unit-tests: an active dated
-- assignment always wins; else the active off-day pattern with the
-- largest effective_from <= p_date, if its weekday matches; else
-- 'unassigned'.
CREATE OR REPLACE FUNCTION roster_resolve_schedule(p_employee_id UUID, p_date DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dated_type TEXT;
  v_weekday SMALLINT;
  v_pattern_weekday SMALLINT;
BEGIN
  SELECT assignment_type INTO v_dated_type
  FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_date AND is_active
  LIMIT 1;
  IF v_dated_type IS NOT NULL THEN
    RETURN v_dated_type;
  END IF;

  SELECT weekday INTO v_pattern_weekday
  FROM roster_off_day_patterns
  WHERE employee_id = p_employee_id AND is_active AND effective_from <= p_date
  ORDER BY effective_from DESC
  LIMIT 1;

  IF v_pattern_weekday IS NULL THEN
    RETURN 'unassigned';
  END IF;

  v_weekday := EXTRACT(DOW FROM p_date);
  IF v_weekday = v_pattern_weekday THEN
    RETURN 'off';
  END IF;
  RETURN 'unassigned';
END;
$$;

-- Every consecutive 7-day window in [p_center_date - 13, p_center_date + 13]
-- for this employee, classified exactly as
-- src/utils/rosterSchedule.ts's checkRollingRestWindows() does: 'ok' (an
-- Off day is present), 'confirmed_violation' (every date resolved, none
-- Off), or 'incomplete' (at least one 'unassigned' date -- nothing can be
-- confirmed yet).
CREATE OR REPLACE FUNCTION roster_rolling_rest_windows(p_employee_id UUID, p_center_date DATE)
RETURNS TABLE(window_start DATE, window_end DATE, status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_buffer_days CONSTANT INTEGER := 13;
  v_range_start DATE := p_center_date - v_buffer_days;
  v_total_days CONSTANT INTEGER := v_buffer_days * 2 + 1;
  v_resolved TEXT[];
  i INTEGER;
BEGIN
  v_resolved := ARRAY(
    SELECT roster_resolve_schedule(p_employee_id, v_range_start + (gs - 1))
    FROM generate_series(1, v_total_days) AS gs
  );

  FOR i IN 1 .. (v_total_days - 7 + 1) LOOP
    window_start := v_range_start + (i - 1);
    window_end := window_start + 6;
    IF 'off' = ANY (v_resolved[i : i + 6]) THEN
      status := 'ok';
    ELSIF 'unassigned' = ANY (v_resolved[i : i + 6]) THEN
      status := 'incomplete';
    ELSE
      status := 'confirmed_violation';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION roster_resolve_schedule(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_resolve_schedule(UUID, DATE) TO authenticated;
REVOKE ALL ON FUNCTION roster_rolling_rest_windows(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_rolling_rest_windows(UUID, DATE) TO authenticated;

-- ============================================================
-- PART 6: WRITE RPCs (SECURITY DEFINER -- the only write path)
-- ============================================================

-- Bounded bulk limit (2,000 target rows per call, per confirmed policy):
-- shared as a SQL constant comment only (PL/pgSQL has no module-level
-- constant; each function below repeats the literal 2000 with this same
-- comment rather than a shared helper, to keep every bound trivially
-- greppable in one file).

CREATE OR REPLACE FUNCTION roster_assign_off_pattern(
  p_employee_ids UUID[],
  p_weekday SMALLINT,
  p_effective_from DATE,
  p_correction_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_role TEXT;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_employee_id UUID;
  v_employee_tenant_id UUID;
  v_existing_id UUID;
  v_existing_weekday SMALLINT;
  v_assigned_count INTEGER := 0;
  v_noop_count INTEGER := 0;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id, role_level, role, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_role, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE(v_is_super_admin, false) OR v_role = 'admin' OR v_role_level = 1) THEN
    RAISE EXCEPTION 'Only Admin may manage roster Off-day patterns' USING ERRCODE = '42501';
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL OR array_length(p_employee_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one employee id is required' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_employee_ids, 1) > 2000 THEN
    RAISE EXCEPTION 'Bulk roster operations are limited to 2000 target employees per request -- split into multiple calls' USING ERRCODE = '22023';
  END IF;
  IF p_weekday IS NULL OR p_weekday < 0 OR p_weekday > 6 THEN
    RAISE EXCEPTION 'weekday must be between 0 (Sunday) and 6 (Saturday)' USING ERRCODE = '22023';
  END IF;
  IF p_effective_from IS NULL THEN
    RAISE EXCEPTION 'effective_from is required' USING ERRCODE = '22023';
  END IF;

  -- Sorted order prevents a deadlock between two concurrent bulk calls
  -- whose employee sets overlap but are supplied in different orders.
  FOR v_employee_id IN SELECT unnest(p_employee_ids) ORDER BY 1 LOOP
    SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = v_employee_id FOR UPDATE;
    IF v_employee_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Employee % not found' , v_employee_id USING ERRCODE = '22023';
    END IF;
    IF v_employee_tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'Employee % does not belong to your tenant', v_employee_id USING ERRCODE = '42501';
    END IF;

    SELECT id, weekday INTO v_existing_id, v_existing_weekday
    FROM roster_off_day_patterns
    WHERE employee_id = v_employee_id AND is_active AND effective_from = p_effective_from;

    IF v_existing_id IS NOT NULL AND v_existing_weekday = p_weekday THEN
      v_noop_count := v_noop_count + 1;
      CONTINUE; -- idempotent no-op
    END IF;

    IF v_existing_id IS NOT NULL THEN
      -- A genuine correction of a wrong fact -- a reason is mandatory.
      IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
        RAISE EXCEPTION 'A correction_reason is required to change an existing Off-day pattern for employee %', v_employee_id USING ERRCODE = '22023';
      END IF;
      UPDATE roster_off_day_patterns
      SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
      WHERE id = v_existing_id;
    END IF;

    INSERT INTO roster_off_day_patterns (tenant_id, employee_id, weekday, effective_from, assigned_by, correction_reason)
    VALUES (v_tenant_id, v_employee_id, p_weekday, p_effective_from, v_caller_id, p_correction_reason);
    v_assigned_count := v_assigned_count + 1;

    -- No override path exists for a confirmed rolling-rest violation --
    -- this check runs AFTER the write above (see this migration's header
    -- for why), and a violation here aborts the ENTIRE transaction,
    -- including every employee already written earlier in this same loop.
    FOR v_violation IN
      SELECT * FROM roster_rolling_rest_windows(v_employee_id, p_effective_from) WHERE status = 'confirmed_violation'
    LOOP
      RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
        v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('assigned_count', v_assigned_count, 'already_set_count', v_noop_count);
END;
$$;

CREATE OR REPLACE FUNCTION roster_assign_dates(
  p_employee_ids UUID[],
  p_date_from DATE,
  p_date_to DATE,
  p_assignment_type TEXT,
  p_override_off_day BOOLEAN DEFAULT false,
  p_correction_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_role TEXT;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_employee_id UUID;
  v_employee_tenant_id UUID;
  v_date DATE;
  v_total_rows INTEGER;
  v_resolved TEXT;
  v_overrides BOOLEAN;
  v_existing_id UUID;
  v_existing_type TEXT;
  v_existing_overrides BOOLEAN;
  v_adjacent_type TEXT;
  v_assigned_count INTEGER := 0;
  v_noop_count INTEGER := 0;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id, role_level, role, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_role, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE(v_is_super_admin, false) OR v_role = 'admin' OR v_role_level = 1) THEN
    RAISE EXCEPTION 'Only Admin may manage roster assignments' USING ERRCODE = '42501';
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL OR array_length(p_employee_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one employee id is required' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
    RAISE EXCEPTION 'A valid date_from <= date_to is required' USING ERRCODE = '22023';
  END IF;
  IF p_assignment_type NOT IN ('day', 'night', 'off') THEN
    RAISE EXCEPTION 'assignment_type must be day, night, or off' USING ERRCODE = '22023';
  END IF;

  v_total_rows := array_length(p_employee_ids, 1) * ((p_date_to - p_date_from) + 1);
  IF v_total_rows > 2000 THEN
    RAISE EXCEPTION 'Bulk roster operations are limited to 2000 target assignments per request (this request would produce %) -- split into multiple calls', v_total_rows USING ERRCODE = '22023';
  END IF;

  FOR v_employee_id IN SELECT unnest(p_employee_ids) ORDER BY 1 LOOP
    SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = v_employee_id FOR UPDATE;
    IF v_employee_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Employee % not found', v_employee_id USING ERRCODE = '22023';
    END IF;
    IF v_employee_tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'Employee % does not belong to your tenant', v_employee_id USING ERRCODE = '42501';
    END IF;

    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      v_overrides := false;

      IF p_assignment_type <> 'off' THEN
        v_resolved := roster_resolve_schedule(v_employee_id, v_date);
        IF v_resolved = 'off' THEN
          IF NOT p_override_off_day OR p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
            RAISE EXCEPTION 'Employee % is scheduled Off on % -- assigning % requires override_off_day=true and a correction_reason (a working assignment may never silently replace an Off day)',
              v_employee_id, v_date, p_assignment_type USING ERRCODE = '23514';
          END IF;
          v_overrides := true;
        END IF;
      END IF;

      -- Night-to-Day adjacency: ALWAYS hard-blocked, no override path.
      IF p_assignment_type = 'day' THEN
        SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
        WHERE employee_id = v_employee_id AND assignment_date = v_date - 1 AND is_active;
        IF v_adjacent_type = 'night' THEN
          RAISE EXCEPTION 'Employee % has a Night shift starting % -- a Day shift cannot start the following morning', v_employee_id, (v_date - 1) USING ERRCODE = '23514';
        END IF;
      ELSIF p_assignment_type = 'night' THEN
        SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
        WHERE employee_id = v_employee_id AND assignment_date = v_date + 1 AND is_active;
        IF v_adjacent_type = 'day' THEN
          RAISE EXCEPTION 'Employee % already has a Day shift starting % -- a Night shift cannot start the night before it', v_employee_id, (v_date + 1) USING ERRCODE = '23514';
        END IF;
      END IF;

      SELECT id, assignment_type, overrides_recurring_off_day INTO v_existing_id, v_existing_type, v_existing_overrides
      FROM roster_date_assignments
      WHERE employee_id = v_employee_id AND assignment_date = v_date AND is_active;

      IF v_existing_id IS NOT NULL AND v_existing_type = p_assignment_type AND v_existing_overrides = v_overrides THEN
        v_noop_count := v_noop_count + 1;
        v_date := v_date + 1;
        CONTINUE; -- idempotent no-op
      END IF;

      IF v_existing_id IS NOT NULL THEN
        IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
          RAISE EXCEPTION 'A correction_reason is required to change an existing assignment for employee % on %', v_employee_id, v_date USING ERRCODE = '22023';
        END IF;
        UPDATE roster_date_assignments
        SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
        WHERE id = v_existing_id;
      END IF;

      INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
      VALUES (v_tenant_id, v_employee_id, v_date, p_assignment_type, v_overrides, v_caller_id, p_correction_reason);
      v_assigned_count := v_assigned_count + 1;

      FOR v_violation IN
        SELECT * FROM roster_rolling_rest_windows(v_employee_id, v_date) WHERE status = 'confirmed_violation'
      LOOP
        RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
          v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
      END LOOP;

      v_date := v_date + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('assigned_count', v_assigned_count, 'already_set_count', v_noop_count);
END;
$$;

-- The composite, explicitly atomic operation requirement #3 calls out by
-- name: moving a recurring Off day to a different date for one week
-- AND/OR assigning working hours on the vacated date, validated and
-- committed as a single transaction -- either both changes land, or
-- neither does.
CREATE OR REPLACE FUNCTION roster_reschedule_off_day(
  p_employee_id UUID,
  p_new_off_date DATE,
  p_vacated_work_date DATE DEFAULT NULL,
  p_vacated_work_assignment_type TEXT DEFAULT NULL,
  p_correction_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_role_level INTEGER;
  v_role TEXT;
  v_is_super_admin BOOLEAN;
  v_is_active BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_employee_tenant_id UUID;
  v_existing_id UUID;
  v_adjacent_type TEXT;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id, role_level, role, is_super_admin, is_active, deleted_at
    INTO v_tenant_id, v_role_level, v_role, v_is_super_admin, v_is_active, v_deleted_at
  FROM profiles WHERE id = v_caller_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_is_active, false) = false OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE(v_is_super_admin, false) OR v_role = 'admin' OR v_role_level = 1) THEN
    RAISE EXCEPTION 'Only Admin may reschedule roster Off days' USING ERRCODE = '42501';
  END IF;

  IF p_new_off_date IS NULL THEN
    RAISE EXCEPTION 'new_off_date is required' USING ERRCODE = '22023';
  END IF;
  IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
    RAISE EXCEPTION 'A correction_reason is required to reschedule an Off day' USING ERRCODE = '22023';
  END IF;
  IF p_vacated_work_assignment_type IS NOT NULL AND p_vacated_work_assignment_type NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'vacated_work_assignment_type must be day or night' USING ERRCODE = '22023';
  END IF;
  IF (p_vacated_work_date IS NULL) <> (p_vacated_work_assignment_type IS NULL) THEN
    RAISE EXCEPTION 'vacated_work_date and vacated_work_assignment_type must be supplied together, or not at all' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;
  IF v_employee_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id USING ERRCODE = '22023';
  END IF;
  IF v_employee_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Employee % does not belong to your tenant', p_employee_id USING ERRCODE = '42501';
  END IF;

  -- Step A: the new Off date.
  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_new_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_new_off_date, 'off', false, v_caller_id, p_correction_reason);

  -- Step B (optional): working assignment on the vacated date.
  IF p_vacated_work_date IS NOT NULL THEN
    IF p_vacated_work_assignment_type = 'day' THEN
      SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
      WHERE employee_id = p_employee_id AND assignment_date = p_vacated_work_date - 1 AND is_active;
      IF v_adjacent_type = 'night' THEN
        RAISE EXCEPTION 'Employee % has a Night shift starting % -- a Day shift cannot start the following morning', p_employee_id, (p_vacated_work_date - 1) USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
      WHERE employee_id = p_employee_id AND assignment_date = p_vacated_work_date + 1 AND is_active;
      IF v_adjacent_type = 'day' THEN
        RAISE EXCEPTION 'Employee % already has a Day shift starting % -- a Night shift cannot start the night before it', p_employee_id, (p_vacated_work_date + 1) USING ERRCODE = '23514';
      END IF;
    END IF;

    SELECT id INTO v_existing_id FROM roster_date_assignments
    WHERE employee_id = p_employee_id AND assignment_date = p_vacated_work_date AND is_active;
    IF v_existing_id IS NOT NULL THEN
      UPDATE roster_date_assignments
      SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
      WHERE id = v_existing_id;
    END IF;
    INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
    VALUES (v_tenant_id, p_employee_id, p_vacated_work_date, p_vacated_work_assignment_type, true, v_caller_id, p_correction_reason);
  END IF;

  -- Validate the NET effect of BOTH changes together, around both dates --
  -- a violation here rolls back Step A and Step B atomically (no override
  -- path exists for a confirmed rolling-rest violation).
  FOR v_violation IN
    SELECT * FROM roster_rolling_rest_windows(p_employee_id, p_new_off_date) WHERE status = 'confirmed_violation'
  LOOP
    RAISE EXCEPTION 'This reschedule would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
      p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
  END LOOP;
  IF p_vacated_work_date IS NOT NULL THEN
    FOR v_violation IN
      SELECT * FROM roster_rolling_rest_windows(p_employee_id, p_vacated_work_date) WHERE status = 'confirmed_violation'
    LOOP
      RAISE EXCEPTION 'This reschedule would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
        p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION roster_assign_off_pattern(UUID[], SMALLINT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_assign_off_pattern(UUID[], SMALLINT, DATE, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION roster_assign_dates(UUID[], DATE, DATE, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_assign_dates(UUID[], DATE, DATE, TEXT, BOOLEAN, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) TO authenticated;
