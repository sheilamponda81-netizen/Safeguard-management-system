-- ============================================================
-- MIGRATION: Roster Management -- Stage C Step 6B: recurring
-- Day/Night shift patterns
-- Date: 2026-10-13
-- ============================================================
--
-- SCOPE: adds a recurring Day/Night shift baseline, symmetric to the
-- existing recurring Off-day pattern (roster_off_day_patterns,
-- 20261008000000_roster_management_foundation.sql), and one small
-- transactional RPC that can change either or both recurring rules for
-- a set of employees atomically. This closes the gap confirmed by
-- direct code inspection in Stage C Step 6A: roster_resolve_schedule()
-- recurred Off days indefinitely but had no equivalent for working
-- shifts, so every date past an employee's last explicit
-- roster_date_assignments row resolved 'unassigned' even on a normal
-- working day.
--
-- Nothing in this migration touches attendance, payroll,
-- payment_status, or employee_deductions directly, and it creates no
-- foreign key to them -- same isolation guarantee as the foundation
-- migration this one extends. It also does not touch
-- roster_off_day_patterns or roster_date_assignments as tables (no
-- ALTER TABLE against either), only CREATE OR REPLACE on two existing
-- shared functions (roster_prevent_illegal_mutation,
-- roster_resolve_schedule) to extend them additively -- both keep
-- their existing signatures, so no DROP is required for either.
--
-- PREPARED ONLY per this round's authorization -- NOT applied to
-- STAGING or PRODUCTION as part of this change. Isolated-Postgres and
-- local verification only; a separate, explicit authorization is
-- required before any STAGING install.
--
-- ============================================================
-- PART 1: NEW TABLE -- recurring Day/Night baseline
-- ============================================================
-- Structurally identical to roster_off_day_patterns (same append-only/
-- supersession shape, same "one active row per employee+effective_from"
-- uniqueness, same Admin-only SELECT RLS, same SELECT-only grant to
-- `authenticated`) -- shift_type replaces weekday as the varying column.

CREATE TABLE IF NOT EXISTS roster_shift_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_type TEXT NOT NULL CHECK (shift_type IN ('day', 'night')),
  effective_from DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NOT NULL REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correction_reason TEXT,
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES profiles(id),
  CONSTRAINT roster_shift_patterns_supersession_shape CHECK (
    (is_active AND superseded_at IS NULL AND superseded_by IS NULL)
    OR
    (NOT is_active AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND correction_reason IS NOT NULL)
  )
);

-- Same semantics as roster_off_day_patterns's own index: at most one
-- row per (employee, effective_from) may be simultaneously "currently
-- believed correct" -- multiple active rows with DIFFERENT
-- effective_from values are normal (a timeline of changes), only a
-- genuine correction of one specific wrong fact goes through
-- supersession.
CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_shift_patterns_active_employee_effective
  ON roster_shift_patterns(employee_id, effective_from) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_roster_shift_patterns_employee_effective
  ON roster_shift_patterns(employee_id, effective_from);

-- ============================================================
-- PART 2: EXTEND the shared append-only trigger function to cover the
-- new table. Purely additive ELSIF branch -- the existing
-- roster_off_day_patterns/roster_date_assignments branches are
-- untouched, so this cannot change behavior for either of those tables.
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
  ELSIF TG_TABLE_NAME = 'roster_shift_patterns' THEN
    IF NEW.shift_type IS DISTINCT FROM OLD.shift_type OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
      RAISE EXCEPTION 'Roster records are append-only: shift_type/effective_from cannot be modified on an existing row -- supersede it instead' USING ERRCODE = '42501';
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

DROP TRIGGER IF EXISTS trg_roster_shift_patterns_append_only ON roster_shift_patterns;
CREATE TRIGGER trg_roster_shift_patterns_append_only
  BEFORE UPDATE ON roster_shift_patterns
  FOR EACH ROW EXECUTE FUNCTION roster_prevent_illegal_mutation();

-- ============================================================
-- PART 3: RLS + GRANTS -- identical shape to roster_off_day_patterns.
-- ============================================================

ALTER TABLE roster_shift_patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Roster shift patterns: view is Admin-only" ON roster_shift_patterns;
CREATE POLICY "Roster shift patterns: view is Admin-only" ON roster_shift_patterns
FOR SELECT USING (
  is_current_user_active()
  AND (is_super_admin() OR (tenant_id = get_current_tenant_id() AND is_business_admin()))
);

REVOKE ALL ON roster_shift_patterns FROM PUBLIC, anon, authenticated;
GRANT SELECT ON roster_shift_patterns TO authenticated;

-- ============================================================
-- PART 4: RESOLVER -- extend roster_resolve_schedule() with the new
-- recurring Day/Night step. Same signature/return type (TEXT), so
-- CREATE OR REPLACE needs no DROP. Precedence, confirmed in Step 6A and
-- unchanged here except for the one new inserted step:
--   1. Explicit dated assignment (roster_date_assignments) -- always wins.
--   2. Matching recurring weekly Off (roster_off_day_patterns) -- unchanged.
--   3. NEW: applicable recurring Day/Night pattern (roster_shift_patterns).
--   4. Unassigned -- unchanged fallback when no pattern of either kind
--      exists; an employee with no recurring pattern configured at all
--      is still correctly Unassigned, not silently defaulted to Day.
-- roster_rolling_rest_windows() and every caller of
-- roster_resolve_schedule() (attendance_resolve_and_calculate chief
-- among them) need ZERO changes: they already treat whatever TEXT
-- comes back ('day'/'night'/'off'/'unassigned') as authoritative
-- without any awareness of which table produced it.
-- ============================================================

CREATE OR REPLACE FUNCTION roster_resolve_schedule(p_employee_id UUID, p_date DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dated_type TEXT;
  v_weekday INTEGER;
  v_pattern_weekday INTEGER;
  v_shift_pattern TEXT;
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

  IF v_pattern_weekday IS NOT NULL THEN
    v_weekday := EXTRACT(DOW FROM p_date);
    IF v_weekday = v_pattern_weekday THEN
      RETURN 'off';
    END IF;
  END IF;

  -- NEW: recurring Day/Night baseline, only reached when no dated
  -- exception applies and today's weekday did not match the recurring
  -- Off pattern (or no Off pattern exists at all).
  SELECT shift_type INTO v_shift_pattern
  FROM roster_shift_patterns
  WHERE employee_id = p_employee_id AND is_active AND effective_from <= p_date
  ORDER BY effective_from DESC
  LIMIT 1;

  IF v_shift_pattern IS NOT NULL THEN
    RETURN v_shift_pattern;
  END IF;

  RETURN 'unassigned';
END;
$$;

-- Unchanged from the foundation migration -- restated for a clean
-- final grant state after this CREATE OR REPLACE.
REVOKE ALL ON FUNCTION roster_resolve_schedule(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_resolve_schedule(UUID, DATE) TO authenticated;

-- ============================================================
-- PART 4B: SHARED BOUNDED-RECONCILIATION HELPERS (Stage C Step 6C)
-- ============================================================
-- Internal-only (no grant to authenticated at all -- these are never
-- meant to be called directly by any client session, only from inside
-- another SECURITY DEFINER function's own body, which executes with
-- that function's already-elevated privileges regardless of these
-- REVOKEs, same reasoning as roster_resolve_schedule/
-- roster_rolling_rest_windows being SECURITY INVOKER in the foundation
-- migration's own header). Used by BOTH roster_assign_recurring_pattern
-- (Part 5 below) and the CREATE OR REPLACE of roster_assign_off_pattern
-- (Part 6 below) -- the whole point of extracting these is that a
-- single reconciliation implementation now backs every recurring-
-- pattern write path, closing the gap where the original
-- roster_assign_off_pattern (foundation migration) had no
-- reconciliation protection at all, confirmed in Step 6A and left open
-- in Step 6B pending this round's explicit instruction to close it.

-- Captures roster_resolve_schedule's result for every date in
-- [p_date_from, p_date_to] (inclusive), as a plain array -- an empty
-- range (p_date_to < p_date_from, i.e. a pure future-dated change with
-- nothing to reconcile) returns an empty array rather than erroring.
CREATE OR REPLACE FUNCTION roster_capture_resolved_window(p_employee_id UUID, p_date_from DATE, p_date_to DATE)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_date_to < p_date_from THEN ARRAY[]::TEXT[] ELSE ARRAY(
    SELECT roster_resolve_schedule(p_employee_id, p_date_from + (gs - 1))
    FROM generate_series(1, (p_date_to - p_date_from) + 1) AS gs
  ) END;
$$;

REVOKE ALL ON FUNCTION roster_capture_resolved_window(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;

-- Re-resolves the same dates `p_before` was captured for (starting at
-- p_date_from, one entry per array position) and, for any date whose
-- resolution actually changed AND which already has an automatic-source
-- attendance row, raises the existing attendance_reconciliation_flags
-- mechanism -- reusing the 'roster_invalidated_auto_entry' reason
-- attendance_flag_roster_change already uses for dated-assignment
-- changes (semantically identical: a roster change invalidated an
-- automatic entry, regardless of whether a dated row or a recurring
-- pattern caused it; the column's own CHECK constraint only allows
-- three fixed values, so reusing this one avoids a schema change).
-- Idempotent: never raises a duplicate flag for a date already flagged
-- and unresolved. Returns how many NEW flags were created.
CREATE OR REPLACE FUNCTION roster_reconcile_resolved_window(
  p_employee_id UUID,
  p_date_from DATE,
  p_before TEXT[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days INTEGER := COALESCE(array_length(p_before, 1), 0);
  v_date DATE;
  v_after TEXT;
  v_automatic_tenant_id UUID;
  v_already_flagged BOOLEAN;
  v_flags_created INTEGER := 0;
  v_i INTEGER;
BEGIN
  FOR v_i IN 1 .. v_days LOOP
    v_date := p_date_from + (v_i - 1);
    v_after := roster_resolve_schedule(p_employee_id, v_date);

    IF v_after IS DISTINCT FROM p_before[v_i] THEN
      SELECT a.tenant_id INTO v_automatic_tenant_id
      FROM attendance a
      WHERE a.employee_id = p_employee_id AND a.date = v_date AND a.source = 'automatic';

      IF v_automatic_tenant_id IS NOT NULL THEN
        SELECT EXISTS(
          SELECT 1 FROM attendance_reconciliation_flags f
          WHERE f.employee_id = p_employee_id AND f.attendance_date = v_date
            AND f.flagged_reason = 'roster_invalidated_auto_entry' AND f.resolved_at IS NULL
        ) INTO v_already_flagged;

        IF NOT v_already_flagged THEN
          INSERT INTO attendance_reconciliation_flags (tenant_id, employee_id, attendance_date, flagged_reason)
          VALUES (v_automatic_tenant_id, p_employee_id, v_date, 'roster_invalidated_auto_entry');
          v_flags_created := v_flags_created + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN v_flags_created;
END;
$$;

REVOKE ALL ON FUNCTION roster_reconcile_resolved_window(UUID, DATE, TEXT[]) FROM PUBLIC, anon, authenticated;

-- Bounded-backdate gate, shared by every recurring-pattern write path.
-- Generous enough for a realistic correction window (about one payroll
-- cycle plus slack); small enough that roster_capture_resolved_window's
-- range (always [effective_from, CURRENT_DATE] in every caller) is
-- always bounded to at most this many days, never unbounded regardless
-- of how old an existing pattern is. Raises (never silently restricts)
-- when exceeded, naming the exact limit so the error is self-explanatory
-- without needing this comment.
CREATE OR REPLACE FUNCTION roster_assert_pattern_backdate_allowed(p_effective_from DATE)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_backdate_limit_days CONSTANT INTEGER := 35;
BEGIN
  IF p_effective_from < (CURRENT_DATE - v_backdate_limit_days) THEN
    RAISE EXCEPTION 'A recurring pattern change cannot be backdated more than % days (requested effective_from %, today %) -- this keeps historical reconciliation bounded and safe; for an older correction, contact support for a manually reviewed administrative correction rather than backdating further',
      v_backdate_limit_days, p_effective_from, CURRENT_DATE USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION roster_assert_pattern_backdate_allowed(DATE) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- PART 5: ATOMIC COMBINED WRITE RPC
-- ============================================================
-- roster_assign_recurring_pattern() replaces two sequential RPC calls
-- (the Step 6A proposal) with one transactional function that can
-- change the recurring Off weekday, the recurring Day/Night baseline,
-- or both together -- "both land or neither does" by construction,
-- since both writes happen inside this same function's implicit
-- transaction and any RAISE EXCEPTION rolls back everything already
-- written earlier in the same call, exactly like the existing
-- roster_reschedule_off_day composite operation.
--
-- p_weekday and p_shift_type are each independently optional (NULL =
-- "do not touch this half") -- at least one of the two is required.
-- This is the ONE way to change either/both recurring patterns from
-- the UI going forward; the original standalone roster_assign_off_pattern
-- RPC is left unmodified and still reachable directly, but the UI no
-- longer calls it (see Roster.tsx changes in this same round).
--
-- BOUNDED RECONCILIATION (Step 6B Task 4): a change whose
-- effective_from is TODAY or in the FUTURE can never invalidate
-- already-written automatic attendance (nothing in the past is
-- touched), so no reconciliation scan runs at all in that case. A
-- BACKDATED effective_from (in the past) is bounded to at most
-- ROSTER_PATTERN_BACKDATE_RECONCILE_LIMIT_DAYS days before today --
-- generous enough for a realistic correction window (about one payroll
-- cycle plus slack), small enough to keep the reconciliation scan
-- genuinely bounded and cheap -- anything older is REJECTED outright
-- with a clear error rather than silently permitting an unbounded or
-- unreconciled change. Within that bound, this function captures each
-- affected date's resolved schedule BEFORE the write(s), performs the
-- write(s), recomputes the SAME dates AFTER, and raises the existing
-- attendance_reconciliation_flags mechanism (reusing the
-- 'roster_invalidated_auto_entry' reason attendance_flag_roster_change
-- already uses for dated-assignment changes -- semantically identical:
-- a roster change invalidated an automatic entry, regardless of
-- whether a dated row or a recurring pattern caused it) for any date
-- whose resolution actually changed AND which already has an
-- automatic-source attendance row. This also closes the gap confirmed
-- in Step 6A: roster_off_day_patterns changes made through THIS RPC are
-- now reconciled the same way roster_date_assignments changes already
-- were; the original standalone roster_assign_off_pattern RPC is
-- unmodified and keeps its pre-existing (undocumented until Step 6A)
-- gap for any caller that still uses it directly.
CREATE OR REPLACE FUNCTION roster_assign_recurring_pattern(
  p_employee_ids UUID[],
  p_weekday INTEGER DEFAULT NULL,
  p_shift_type TEXT DEFAULT NULL,
  p_effective_from DATE DEFAULT NULL,
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
  v_employee_id UUID;
  v_employee_tenant_id UUID;
  v_existing_id UUID;
  v_existing_weekday INTEGER;
  v_existing_shift_type TEXT;
  v_violation RECORD;
  v_next_effective_from DATE;

  v_changed_any_count INTEGER := 0;
  v_noop_count INTEGER := 0;
  v_employee_changed BOOLEAN;

  v_before_resolved TEXT[];
  v_flags_created INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT is_current_user_active() THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only Admin may manage recurring roster patterns' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL OR array_length(p_employee_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one employee id is required' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_employee_ids, 1) > 2000 THEN
    RAISE EXCEPTION 'Bulk roster operations are limited to 2000 target employees per request -- split into multiple calls' USING ERRCODE = '22023';
  END IF;
  IF p_weekday IS NULL AND p_shift_type IS NULL THEN
    RAISE EXCEPTION 'At least one of weekday or shift_type must be supplied' USING ERRCODE = '22023';
  END IF;
  IF p_weekday IS NOT NULL AND (p_weekday < 0 OR p_weekday > 6) THEN
    RAISE EXCEPTION 'weekday must be between 0 (Sunday) and 6 (Saturday)' USING ERRCODE = '22023';
  END IF;
  IF p_shift_type IS NOT NULL AND p_shift_type NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'shift_type must be day or night' USING ERRCODE = '22023';
  END IF;
  IF p_effective_from IS NULL THEN
    RAISE EXCEPTION 'effective_from is required' USING ERRCODE = '22023';
  END IF;
  PERFORM roster_assert_pattern_backdate_allowed(p_effective_from);

  FOR v_employee_id IN SELECT unnest(p_employee_ids) ORDER BY 1 LOOP
    SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = v_employee_id FOR UPDATE;
    IF v_employee_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Employee % not found', v_employee_id USING ERRCODE = '22023';
    END IF;
    IF v_employee_tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'Employee % does not belong to your tenant', v_employee_id USING ERRCODE = '42501';
    END IF;

    v_employee_changed := false;

    -- Capture BEFORE state for the bounded reconciliation window --
    -- empty for a future-only effective_from (nothing to reconcile),
    -- per roster_capture_resolved_window's own guard.
    v_before_resolved := roster_capture_resolved_window(v_employee_id, p_effective_from, CURRENT_DATE);

    -- ---- Off-day pattern half (only when p_weekday was supplied) ----
    IF p_weekday IS NOT NULL THEN
      SELECT id, weekday INTO v_existing_id, v_existing_weekday
      FROM roster_off_day_patterns
      WHERE employee_id = v_employee_id AND is_active AND effective_from = p_effective_from;

      IF v_existing_id IS NOT NULL AND v_existing_weekday = p_weekday THEN
        NULL; -- idempotent no-op for this half
      ELSE
        IF v_existing_id IS NOT NULL THEN
          IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
            RAISE EXCEPTION 'A correction_reason is required to change an existing Off-day pattern for employee %', v_employee_id USING ERRCODE = '22023';
          END IF;
          UPDATE roster_off_day_patterns
          SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
          WHERE id = v_existing_id;
        END IF;

        INSERT INTO roster_off_day_patterns (tenant_id, employee_id, weekday, effective_from, assigned_by, correction_reason)
        VALUES (v_tenant_id, v_employee_id, p_weekday, p_effective_from, v_caller_id, p_correction_reason);
        v_employee_changed := true;

        FOR v_violation IN
          SELECT * FROM roster_rolling_rest_windows(v_employee_id, p_effective_from) WHERE status = 'confirmed_violation'
        LOOP
          RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
            v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
        END LOOP;

        -- Same downstream-boundary re-check as roster_assign_off_pattern
        -- (CONFIRMED DEFECT FIX, foundation migration): a single insert
        -- can only ever affect the one existing pattern boundary
        -- immediately after its own effective_from.
        SELECT MIN(effective_from) INTO v_next_effective_from
        FROM roster_off_day_patterns
        WHERE employee_id = v_employee_id AND is_active AND effective_from > p_effective_from;

        IF v_next_effective_from IS NOT NULL THEN
          FOR v_violation IN
            SELECT * FROM roster_rolling_rest_windows(v_employee_id, v_next_effective_from) WHERE status = 'confirmed_violation'
          LOOP
            RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
              v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
          END LOOP;
        END IF;
      END IF;
    END IF;

    -- ---- Shift-type pattern half (only when p_shift_type was supplied) ----
    -- No rolling-rest-window implication: the rest check only cares
    -- about Off vs. not-Off, which this half never changes.
    IF p_shift_type IS NOT NULL THEN
      SELECT id, shift_type INTO v_existing_id, v_existing_shift_type
      FROM roster_shift_patterns
      WHERE employee_id = v_employee_id AND is_active AND effective_from = p_effective_from;

      IF v_existing_id IS NOT NULL AND v_existing_shift_type = p_shift_type THEN
        NULL; -- idempotent no-op for this half
      ELSE
        IF v_existing_id IS NOT NULL THEN
          IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
            RAISE EXCEPTION 'A correction_reason is required to change an existing recurring shift pattern for employee %', v_employee_id USING ERRCODE = '22023';
          END IF;
          UPDATE roster_shift_patterns
          SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
          WHERE id = v_existing_id;
        END IF;

        INSERT INTO roster_shift_patterns (tenant_id, employee_id, shift_type, effective_from, assigned_by, correction_reason)
        VALUES (v_tenant_id, v_employee_id, p_shift_type, p_effective_from, v_caller_id, p_correction_reason);

        -- Night-into-Day adjacency: ALWAYS hard-blocked, matching the
        -- existing policy enforced for dated assignments
        -- (roster_assign_dates, roster_reschedule_off_day) -- no
        -- override path exists for this anywhere in the system. Checked
        -- via roster_resolve_schedule (not a raw table lookup) so it
        -- correctly catches an adjacent Night shift regardless of
        -- whether the prior date comes from a dated row or another
        -- recurring pattern -- a gap the original architecture's own
        -- adjacency checks don't close, since those only look at
        -- roster_date_assignments directly. Safe to check AFTER this
        -- INSERT: the new row's own effective_from gates it to dates
        -- >= effective_from, so effective_from - 1 still resolves
        -- exactly as it did before this write. Only the Night-then-Day
        -- direction is blocked (matching hasNightToDayConflict's own
        -- asymmetric design) -- a Day shift ending and a Night shift
        -- starting the same evening is a normal, unflagged handoff.
        IF p_shift_type = 'day' AND roster_resolve_schedule(v_employee_id, p_effective_from - 1) = 'night' THEN
          RAISE EXCEPTION 'Employee % has a Night shift resolved on % -- a Day shift cannot start the following morning', v_employee_id, (p_effective_from - 1) USING ERRCODE = '23514';
        END IF;

        v_employee_changed := true;
      END IF;
    END IF;

    IF v_employee_changed THEN
      v_changed_any_count := v_changed_any_count + 1;
    ELSE
      v_noop_count := v_noop_count + 1;
    END IF;

    -- ---- Bounded reconciliation: AFTER comparison ----
    -- Only runs when something actually changed for this employee --
    -- roster_reconcile_resolved_window itself is a no-op for an empty
    -- (future-only) v_before_resolved array.
    IF v_employee_changed THEN
      v_flags_created := v_flags_created + roster_reconcile_resolved_window(v_employee_id, p_effective_from, v_before_resolved);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'assigned_count', v_changed_any_count,
    'already_set_count', v_noop_count,
    'reconciliation_flags_created', v_flags_created
  );
END;
$$;

REVOKE ALL ON FUNCTION roster_assign_recurring_pattern(UUID[], INTEGER, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_assign_recurring_pattern(UUID[], INTEGER, TEXT, DATE, TEXT) TO authenticated;

-- ============================================================
-- PART 6: CLOSE THE LEGACY roster_assign_off_pattern RECONCILIATION
-- GAP (Stage C Step 6C)
-- ============================================================
-- The original roster_assign_off_pattern (foundation migration,
-- 20261008000000) is confirmed, by direct repository search, to have NO
-- legitimate caller anywhere in this codebase -- the frontend's
-- Recurring Schedule tab now calls roster_assign_recurring_pattern
-- exclusively (Stage C Step 6B). It remains reachable only via a direct
-- RPC call bypassing the frontend entirely -- the same class of risk
-- this engagement already closed once for attendance_apply_automatic.
-- Rather than restrict or remove it (which could silently break an
-- undiscovered external/future caller), this CREATE OR REPLACE keeps
-- its signature, permissions, and every existing validation/locking/
-- idempotency/rolling-rest-window rule byte-for-byte identical, and
-- adds ONLY the same bounded-backdate gate and bounded reconciliation
-- scan roster_assign_recurring_pattern already enforces, via the exact
-- same shared helpers (Part 4B above) -- so there is no longer any
-- write path to either recurring-pattern table that can silently
-- invalidate existing automatic attendance without being reconciled.
CREATE OR REPLACE FUNCTION roster_assign_off_pattern(
  p_employee_ids UUID[],
  p_weekday INTEGER,
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
  v_employee_id UUID;
  v_employee_tenant_id UUID;
  v_existing_id UUID;
  v_existing_weekday INTEGER;
  v_assigned_count INTEGER := 0;
  v_noop_count INTEGER := 0;
  v_violation RECORD;
  v_next_effective_from DATE;

  -- NEW (Stage C Step 6C): the only additions to this function's
  -- original body are this bounded-reconciliation bookkeeping and the
  -- two shared-helper calls below -- every other line is unchanged.
  v_before_resolved TEXT[];
  v_changed BOOLEAN;
  v_flags_created INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT is_current_user_active() THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only Admin may manage roster Off-day patterns' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
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
  PERFORM roster_assert_pattern_backdate_allowed(p_effective_from);

  FOR v_employee_id IN SELECT unnest(p_employee_ids) ORDER BY 1 LOOP
    SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = v_employee_id FOR UPDATE;
    IF v_employee_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Employee % not found' , v_employee_id USING ERRCODE = '22023';
    END IF;
    IF v_employee_tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'Employee % does not belong to your tenant', v_employee_id USING ERRCODE = '42501';
    END IF;

    v_changed := false;
    v_before_resolved := roster_capture_resolved_window(v_employee_id, p_effective_from, CURRENT_DATE);

    SELECT id, weekday INTO v_existing_id, v_existing_weekday
    FROM roster_off_day_patterns
    WHERE employee_id = v_employee_id AND is_active AND effective_from = p_effective_from;

    IF v_existing_id IS NOT NULL AND v_existing_weekday = p_weekday THEN
      v_noop_count := v_noop_count + 1;
      CONTINUE; -- idempotent no-op
    END IF;

    IF v_existing_id IS NOT NULL THEN
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
    v_changed := true;

    FOR v_violation IN
      SELECT * FROM roster_rolling_rest_windows(v_employee_id, p_effective_from) WHERE status = 'confirmed_violation'
    LOOP
      RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
        v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
    END LOOP;

    SELECT MIN(effective_from) INTO v_next_effective_from
    FROM roster_off_day_patterns
    WHERE employee_id = v_employee_id AND is_active AND effective_from > p_effective_from;

    IF v_next_effective_from IS NOT NULL THEN
      FOR v_violation IN
        SELECT * FROM roster_rolling_rest_windows(v_employee_id, v_next_effective_from) WHERE status = 'confirmed_violation'
      LOOP
        RAISE EXCEPTION 'This change would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden',
          v_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
      END LOOP;
    END IF;

    IF v_changed THEN
      v_flags_created := v_flags_created + roster_reconcile_resolved_window(v_employee_id, p_effective_from, v_before_resolved);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'assigned_count', v_assigned_count,
    'already_set_count', v_noop_count,
    'reconciliation_flags_created', v_flags_created
  );
END;
$$;

-- Unchanged from the foundation migration -- restated for a clean final
-- grant state after this CREATE OR REPLACE.
REVOKE ALL ON FUNCTION roster_assign_off_pattern(UUID[], INTEGER, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_assign_off_pattern(UUID[], INTEGER, DATE, TEXT) TO authenticated;

-- ============================================================
-- PART 7: CLOSE THE NIGHT-TO-DAY ADJACENCY BYPASS AGAINST RECURRING
-- SHIFT PATTERNS (Stage C Step 6D)
-- ============================================================
-- CONFIRMED BYPASS: roster_assign_dates and roster_reschedule_off_day
-- (20261009000000_roster_reschedule_off_day_option_a.sql) both enforce
-- the Night-to-Day adjacency hard-block by querying
-- roster_date_assignments DIRECTLY for the neighboring date --
--   SELECT assignment_type INTO v_adjacent_type FROM roster_date_assignments
--   WHERE employee_id = ... AND assignment_date = <neighbor> AND is_active;
-- -- which is blind to a neighboring Night/Day that comes from
-- roster_shift_patterns (Step 6B) rather than an explicit dated row. A
-- recurring Night pattern through Monday, followed by an explicit dated
-- Day assignment on Tuesday via roster_assign_dates, was confirmed (by
-- direct inspection of both installed function bodies) to pass through
-- uncaught -- exactly the physical conflict this policy exists to
-- prevent (an employee finishing a Night shift with no rest before a
-- Day shift the same morning), with no override path anywhere else in
-- the system. The symmetric Night-side check (p_assignment_type =
-- 'night' against the FOLLOWING date) and roster_reschedule_off_day's
-- single adjacency check around p_original_off_date have the identical
-- gap.
--
-- FIX: replace each raw roster_date_assignments lookup with a call to
-- roster_resolve_schedule() -- the one authoritative resolver that
-- already composes dated assignments, the recurring Off-day pattern,
-- AND the recurring Shift pattern in the correct precedence order
-- (Step 6B). This is the SAME technique Step 6C already used for the
-- equivalent check inside roster_assign_recurring_pattern's own
-- shift-pattern half, now applied consistently to the two remaining
-- pre-existing call sites that had the gap. No second resolver, no new
-- table, no change to precedence, permissions, tenant checks, locking,
-- or any other business rule -- every other line of both functions
-- below is byte-for-byte identical to the currently installed versions.
-- An explicit Off neighbor is automatically still a valid boundary:
-- roster_resolve_schedule returns the literal string 'off' for it, which
-- never equals 'night' or 'day', so neither check ever fires for an Off
-- neighbor -- exactly like before.
CREATE OR REPLACE FUNCTION roster_assign_dates(
  p_employee_ids UUID[],
  p_date_from DATE,
  p_date_to DATE,
  p_assignment_type TEXT,
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
  v_employee_id UUID;
  v_employee_tenant_id UUID;
  v_date DATE;
  v_total_rows INTEGER;
  v_resolved TEXT;
  v_existing_id UUID;
  v_existing_type TEXT;
  v_assigned_count INTEGER := 0;
  v_noop_count INTEGER := 0;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT is_current_user_active() THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT (is_super_admin() OR is_business_admin()) THEN
    RAISE EXCEPTION 'Only Admin may manage roster assignments' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
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
      IF p_assignment_type <> 'off' THEN
        v_resolved := roster_resolve_schedule(v_employee_id, v_date);
        IF v_resolved = 'off' THEN
          -- Unconditional hard block -- no override parameter exists.
          -- Admin must use roster_reschedule_off_day to move the Off day
          -- first; see this function's header for why.
          RAISE EXCEPTION 'Employee % is scheduled Off on % -- a working assignment cannot be made here; use roster_reschedule_off_day to move the Off day first, which also preserves the rolling seven-day rest check across both dates atomically',
            v_employee_id, v_date USING ERRCODE = '23514';
        END IF;
      END IF;

      -- Night-to-Day adjacency: ALWAYS hard-blocked, no override path.
      -- Stage C Step 6D: checked via roster_resolve_schedule (not a raw
      -- roster_date_assignments lookup) so a recurring-pattern-derived
      -- neighbor is caught exactly the same as a dated one.
      IF p_assignment_type = 'day' THEN
        IF roster_resolve_schedule(v_employee_id, v_date - 1) = 'night' THEN
          RAISE EXCEPTION 'Employee % has a Night shift resolved on % -- a Day shift cannot start the following morning', v_employee_id, (v_date - 1) USING ERRCODE = '23514';
        END IF;
      ELSIF p_assignment_type = 'night' THEN
        IF roster_resolve_schedule(v_employee_id, v_date + 1) = 'day' THEN
          RAISE EXCEPTION 'Employee % already has a Day shift resolved on % -- a Night shift cannot start the night before it', v_employee_id, (v_date + 1) USING ERRCODE = '23514';
        END IF;
      END IF;

      SELECT id, assignment_type INTO v_existing_id, v_existing_type
      FROM roster_date_assignments
      WHERE employee_id = v_employee_id AND assignment_date = v_date AND is_active;

      IF v_existing_id IS NOT NULL AND v_existing_type = p_assignment_type THEN
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

      -- overrides_recurring_off_day is always false for rows written here
      -- -- this function can never create an override (see header); only
      -- roster_reschedule_off_day's own vacated-work-date write may set it.
      INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
      VALUES (v_tenant_id, v_employee_id, v_date, p_assignment_type, false, v_caller_id, p_correction_reason);
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

REVOKE ALL ON FUNCTION roster_assign_dates(UUID[], DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_assign_dates(UUID[], DATE, DATE, TEXT, TEXT) TO authenticated;

-- roster_reschedule_off_day (20261009000000_roster_reschedule_off_day_option_a.sql)
-- has the identical adjacency-check gap, at the single point where it
-- checks the NEW shift being placed on p_original_off_date against its
-- own neighbor. Every other line is byte-for-byte identical to the
-- currently installed Option A version.
CREATE OR REPLACE FUNCTION roster_reschedule_off_day(
  p_employee_id UUID,
  p_original_off_date DATE,
  p_replacement_off_date DATE,
  p_original_date_shift TEXT,
  p_correction_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_employee_tenant_id UUID;
  v_original_resolved TEXT;
  v_replacement_resolved TEXT;
  v_existing_id UUID;
  v_violation RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF is_current_user_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;
  IF (is_super_admin() OR is_business_admin()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only Admin may reschedule roster Off days' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the current user' USING ERRCODE = '42501';
  END IF;

  IF p_original_off_date IS NULL OR p_replacement_off_date IS NULL THEN
    RAISE EXCEPTION 'Both the original Off date and the replacement Off date are required' USING ERRCODE = '22023';
  END IF;
  IF p_original_off_date = p_replacement_off_date THEN
    RAISE EXCEPTION 'The replacement Off date must be different from the original Off date' USING ERRCODE = '22023';
  END IF;
  IF p_original_date_shift IS NULL OR p_original_date_shift NOT IN ('day', 'night') THEN
    RAISE EXCEPTION 'original_date_shift must be day or night' USING ERRCODE = '22023';
  END IF;
  IF p_correction_reason IS NULL OR btrim(p_correction_reason) = '' THEN
    RAISE EXCEPTION 'A correction_reason is required to reschedule an Off day' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id INTO v_employee_tenant_id FROM employees WHERE id = p_employee_id FOR UPDATE;
  IF v_employee_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id USING ERRCODE = '22023';
  END IF;
  IF v_employee_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Employee % does not belong to your tenant', p_employee_id USING ERRCODE = '42501';
  END IF;

  v_original_resolved := roster_resolve_schedule(p_employee_id, p_original_off_date);
  IF v_original_resolved IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'Employee % is not currently scheduled Off on % (it currently resolves to "%") -- rescheduling requires a genuine existing Off date', p_employee_id, p_original_off_date, v_original_resolved USING ERRCODE = '23514';
  END IF;

  v_replacement_resolved := roster_resolve_schedule(p_employee_id, p_replacement_off_date);
  IF v_replacement_resolved IS DISTINCT FROM 'unassigned' THEN
    RAISE EXCEPTION 'Employee % replacement date % already resolves to "%" -- the replacement date must be unassigned, not already Off, Day, or Night', p_employee_id, p_replacement_off_date, v_replacement_resolved USING ERRCODE = '23514';
  END IF;

  -- Night-to-Day adjacency for the NEW shift being placed on the original
  -- date -- the identical hard-block rule roster_assign_dates enforces.
  -- Stage C Step 6D: checked via roster_resolve_schedule (not a raw
  -- roster_date_assignments lookup) so a recurring-pattern-derived
  -- neighbor is caught exactly the same as a dated one; no override
  -- parameter exists for it here either.
  IF p_original_date_shift = 'day' THEN
    IF roster_resolve_schedule(p_employee_id, p_original_off_date - 1) = 'night' THEN
      RAISE EXCEPTION 'Employee % has a Night shift resolved on % -- a Day shift cannot start the following morning', p_employee_id, (p_original_off_date - 1) USING ERRCODE = '23514';
    END IF;
  ELSE
    IF roster_resolve_schedule(p_employee_id, p_original_off_date + 1) = 'day' THEN
      RAISE EXCEPTION 'Employee % already has a Day shift resolved on % -- a Night shift cannot start the night before it', p_employee_id, (p_original_off_date + 1) USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_original_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_original_off_date, p_original_date_shift, true, v_caller_id, p_correction_reason);

  SELECT id INTO v_existing_id FROM roster_date_assignments
  WHERE employee_id = p_employee_id AND assignment_date = p_replacement_off_date AND is_active;
  IF v_existing_id IS NOT NULL THEN
    UPDATE roster_date_assignments
    SET is_active = false, superseded_at = now(), superseded_by = v_caller_id, correction_reason = p_correction_reason
    WHERE id = v_existing_id;
  END IF;
  INSERT INTO roster_date_assignments (tenant_id, employee_id, assignment_date, assignment_type, overrides_recurring_off_day, assigned_by, correction_reason)
  VALUES (v_tenant_id, p_employee_id, p_replacement_off_date, 'off', false, v_caller_id, p_correction_reason);

  FOR v_violation IN
    SELECT * FROM roster_rolling_rest_windows(p_employee_id, p_original_off_date) WHERE status = 'confirmed_violation'
  LOOP
    RAISE EXCEPTION 'This reschedule would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden', p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
  END LOOP;
  FOR v_violation IN
    SELECT * FROM roster_rolling_rest_windows(p_employee_id, p_replacement_off_date) WHERE status = 'confirmed_violation'
  LOOP
    RAISE EXCEPTION 'This reschedule would leave employee % with no Off day between % and % -- rolling seven-day rest violations cannot be overridden', p_employee_id, v_violation.window_start, v_violation.window_end USING ERRCODE = '23514';
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'employee_id', p_employee_id,
    'original_off_date', p_original_off_date,
    'original_date_shift', p_original_date_shift,
    'replacement_off_date', p_replacement_off_date
  );
END;
$$;

REVOKE ALL ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION roster_reschedule_off_day(UUID, DATE, DATE, TEXT, TEXT) TO authenticated;
