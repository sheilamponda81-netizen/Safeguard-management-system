-- ============================================================
-- MIGRATION: Automatic fingerprint terminal resolution -- removes
-- routine per-employee terminal assignment as the normal onboarding
-- step for fingerprint-attendance employees.
-- Date: 2026-12-02
-- ============================================================
--
-- BUSINESS DECISION (confirmed): Person Mapping (confirming a
-- HikCentral Person No. -> employee identity) should remain the ONLY
-- routine manual onboarding action for a fingerprint-attendance
-- employee. In Lilongwe and elsewhere, employees enrolled in
-- iVMS-4200 are expected to use ANY eligible terminal at their site,
-- not one permanently assigned device -- requiring an administrator to
-- separately pick "which terminal(s) does THIS employee use" for every
-- individual (today's employee_hikcentral_terminals workflow) is
-- unnecessary operational work this migration removes for the common
-- case, WITHOUT removing the table, its data, its RPC, or its UI --
-- all three stay fully available as an explicit override (see below).
--
-- READ-ONLY PRODUCTION DISCOVERY THAT SHAPED THIS DESIGN (no row
-- touched by the investigation itself):
--   - Cross-terminal check-in/checkout was ALREADY fully supported
--     before this migration: attendance_resolve_and_calculate's own
--     event query (v_event_times) has NEVER filtered by access_point --
--     it already takes every one of an identified employee's raw
--     events in the shift window, from whichever terminal produced
--     them. employee_hikcentral_terminals has only ever gated the
--     ABSENT-eligibility coverage-completeness check, never which
--     terminal a valid scan may come from. This migration does not
--     change event-matching at all.
--   - One Person No. can never be actively mapped to two employees
--     (uq_hikcentral_person_mappings_active_person, a real unique
--     partial index) -- already structurally guaranteed, unchanged.
--   - Of 18 real workstations with ANY active employee_hikcentral_
--     terminals assignment today, 13 show EXACTLY ONE distinct
--     access_point across every employee assigned there (a clean,
--     already-explicit, already-administrator-declared 1:1 site ->
--     terminal relationship -- e.g. LIMBE -> "AHL - LIMBE_Door_1" for
--     29 employees). The other 5 (BLANTYRE, CHICHIRI, "HEAD OFFICE",
--     "HEADOFFICE", MANDALA) show 2-4 DIFFERENT access points each,
--     with uneven employee counts -- genuinely ambiguous: it cannot be
--     determined from existing data alone whether every employee at
--     e.g. "HEAD OFFICE" is really eligible at all 4 observed doors, or
--     whether that workstation label conflates several real locations.
--     This migration deliberately does NOT invent an answer for those
--     5 -- see this release's own report for the exact candidate
--     terminals and the smallest next step (a human calls
--     set_site_hikcentral_terminals once per resolved site, or keeps
--     assigning individually, exactly as today).
--   - Of 179 actively mapped employees, 64 have NO individual terminal
--     assignment at all today -- permanently stuck unable to ever
--     resolve Absent, not because that is correct, but purely because
--     nobody has done the per-employee assignment step yet. 60 of
--     those 64 have ZERO attendance history of any kind (never
--     processed either way -- a pure onboarding gap, safe to close).
--   - CONCRETE PRODUCTION COUNTEREXAMPLE justifying a safety gate
--     (Part 4): CHITANI K KAPANDA (SFG-S-..., workstation LIMBE, one of
--     the 13 clean sites) is actively mapped, has NO terminal
--     assignment, and has 72 of 72 (100%) existing attendance rows
--     recorded with source = 'manual' -- every single official
--     decision ever made for this person was a deliberate human
--     action. GIFT BERNARD LICHE (YAINNAKIS) similarly has 69 of 69
--     manual rows. Blindly extending automatic Absent-eligibility to
--     every mapped-but-unassigned employee at a clean site would have
--     put these two (and anyone else with an established manual
--     history) at risk of a FUTURE date silently flipping to automatic
--     processing, contradicting a deliberate, already-demonstrated
--     staffing decision -- attendance_write_one's manual-source
--     protection only protects a date that ALREADY has a manual row,
--     never a future one that doesn't exist yet. This is the exact,
--     concrete example the task asked for before justifying a safety
--     gate -- and it is handled below WITHOUT a new attendance_method
--     column: the gate reads an existing fact (has this employee EVER
--     had a manual attendance row?) rather than inventing new
--     configuration or an administration workflow.
--
-- THE MODEL (Part 2 -- smallest reliable replacement):
--   1. employee_hikcentral_terminals remains completely unchanged --
--      schema, data, RLS, set_employee_hikcentral_terminals RPC, and
--      the existing per-employee assignment UI are ALL still fully
--      functional, as an explicit override. An employee who already
--      has their own assignment is completely unaffected by this
--      migration -- same terminals, same coverage logic, same result.
--   2. NEW, additive, SHARED site_hikcentral_terminals table: the same
--      shape as employee_hikcentral_terminals, keyed by a normalized
--      SITE string (employees.workstation, normalized exactly like the
--      existing client-side normalizeWorkstationKey convention:
--      trim + collapse whitespace + uppercase) instead of employee_id.
--      One row per (tenant, site, access_point) -- configure a site
--      ONCE, every employee at that site benefits, including future
--      hires, with zero per-employee action ever required again for
--      that site.
--   3. NEW attendance_employee_eligible_terminals(tenant_id,
--      employee_id) helper -- the ONE place this "what terminal(s) is
--      this employee eligible at" question is answered, reused by
--      every caller that used to read employee_hikcentral_terminals
--      directly (attendance_resolve_and_calculate, attendance_coverage_
--      explain, attendance_process_import_batch). Resolution order:
--        a. the employee's OWN active assignment, if any (unchanged,
--           always wins, never overridden by the shared fallback);
--        b. ELSE the site-level shared set for the employee's own
--           (normalized) workstation, but ONLY when the employee has
--           no own assignment at all AND no pre-existing manual-
--           sourced attendance row has ever been recorded for them
--           (the CHITANI/GIFT safety gate above, read from existing
--           data, never a new column);
--        c. ELSE empty -- identical to today's behavior: coverage can
--           never reach confirmed_complete, Pending is preserved
--           forever until configured, surfaced as a gap exactly as
--           before (never silently fabricated, never a global "all
--           terminals" default).
--   4. Coverage-completeness, confirmation matching, evidence-backing
--      (latest_observed_event_at / exceeds_observed_evidence /
--      independently_verified), the Absent/Pending engine
--      (attendance_engine_calculate), attendance_apply_automatic's
--      write path, manual-correction precedence, approved-payroll
--      protection, duplicate-event protection, and tenant/region
--      isolation are ALL completely unchanged -- this migration only
--      changes WHICH terminal set is checked for completeness, never
--      how completeness, Pending, or Absent are decided once that set
--      is known.
--
-- NOTHING here recalculates, rewrites, or touches any existing
-- attendance, payroll, roster, or audit row. Nothing here changes any
-- employee's mapping or existing terminal assignment. The seed INSERT
-- in PART 5 below is a deterministic, generic rollup of data a human
-- administrator has ALREADY explicitly declared (existing employee_
-- hikcentral_terminals rows) -- computed fresh from whatever rows
-- exist in the database this migration is applied to, never a
-- hardcoded list of site names, so it behaves correctly for any
-- tenant and is exactly as safe to run against a disposable test
-- database as it would be against production (never done in this
-- task -- see its own report for the explicit "not applied to
-- production" statement).
-- ============================================================

-- ------------------------------------------------------------
-- PART 1: site_hikcentral_terminals
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_hikcentral_terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  site TEXT NOT NULL CHECK (btrim(site) <> ''),
  access_point TEXT NOT NULL CHECK (btrim(access_point) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Distinguishes a human's explicit per-site decision from this
  -- migration's own one-time, deterministic rollup of pre-existing
  -- employee-level declarations -- surfaced in the UI (Part 5) so
  -- HR/IT can tell a site that was ever reviewed by a person apart
  -- from one the system derived on their behalf, never hidden.
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'derived_from_employee_assignments')),
  -- NULL only for a system-derived row (PART 5) -- no human actor to
  -- attribute. Every manually-created row still requires a real actor,
  -- enforced below in set_site_hikcentral_terminals, the only write path.
  assigned_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_site_hikcentral_terminals_site ON site_hikcentral_terminals(tenant_id, site) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_site_hikcentral_terminals_access_point ON site_hikcentral_terminals(tenant_id, access_point) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_hikcentral_terminals_unique_active ON site_hikcentral_terminals(tenant_id, site, access_point) WHERE is_active;

ALTER TABLE site_hikcentral_terminals ENABLE ROW LEVEL SECURITY;

-- Same tenant+permission gate as employee_hikcentral_terminals -- no
-- new permission key. No per-employee region check applies here (this
-- table has no employee_id column at all); it is scoped by tenant only,
-- same as every other tenant-wide configuration table in this schema.
DROP POLICY IF EXISTS "Site HikCentral terminals: view within tenant, permitted" ON site_hikcentral_terminals;
CREATE POLICY "Site HikCentral terminals: view within tenant, permitted" ON site_hikcentral_terminals
FOR SELECT USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
);

DROP POLICY IF EXISTS "Site HikCentral terminals: create within tenant, permitted" ON site_hikcentral_terminals;
CREATE POLICY "Site HikCentral terminals: create within tenant, permitted" ON site_hikcentral_terminals
FOR INSERT WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
);

DROP POLICY IF EXISTS "Site HikCentral terminals: revoke within tenant, permitted" ON site_hikcentral_terminals;
CREATE POLICY "Site HikCentral terminals: revoke within tenant, permitted" ON site_hikcentral_terminals
FOR UPDATE USING (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
)
WITH CHECK (
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      tenant_id = get_current_tenant_id()
      AND (current_user_role_level() <= 2 OR has_permission('attendance.map_hikcentral_persons'))
    )
  )
);

REVOKE ALL ON site_hikcentral_terminals FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON site_hikcentral_terminals TO authenticated;

-- ------------------------------------------------------------
-- PART 2: set_site_hikcentral_terminals -- the one human write path,
-- same reconcile-by-full-desired-set shape as
-- set_employee_hikcentral_terminals. The site string is normalized
-- exactly like the client's own normalizeWorkstationKey (trim +
-- collapse internal whitespace + uppercase) so "Limbe " / "limbe" /
-- "LIMBE" are always the same configuration row, never silently
-- fragmented by casing/whitespace.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_site_hikcentral_terminals(p_site TEXT, p_access_points TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_site TEXT;
  v_desired TEXT[];
  v_added INTEGER := 0;
  v_revoked INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  v_site := upper(btrim(regexp_replace(COALESCE(p_site, ''), '\s+', ' ', 'g')));
  IF v_site = '' THEN RAISE EXCEPTION 'p_site is required' USING ERRCODE = '22023'; END IF;
  v_tenant_id := get_current_tenant_id();

  SELECT COALESCE(array_agg(DISTINCT ap), ARRAY[]::TEXT[]) INTO v_desired
  FROM unnest(COALESCE(p_access_points, ARRAY[]::TEXT[])) AS ap
  WHERE btrim(ap) <> '';

  UPDATE site_hikcentral_terminals
  SET is_active = false, revoked_at = NOW(), revoked_by = v_caller_id
  WHERE site = v_site AND tenant_id = v_tenant_id AND is_active
    AND NOT (access_point = ANY(v_desired));
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  INSERT INTO site_hikcentral_terminals (tenant_id, site, access_point, source, assigned_by)
  SELECT v_tenant_id, v_site, ap, 'manual', v_caller_id
  FROM unnest(v_desired) AS ap
  WHERE NOT EXISTS (
    SELECT 1 FROM site_hikcentral_terminals s
    WHERE s.site = v_site AND s.tenant_id = v_tenant_id AND s.access_point = ap AND s.is_active
  );
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN jsonb_build_object('site', v_site, 'added_count', v_added, 'revoked_count', v_revoked, 'access_points', v_desired);
END;
$$;

REVOKE ALL ON FUNCTION set_site_hikcentral_terminals(TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_site_hikcentral_terminals(TEXT, TEXT[]) TO authenticated;

-- ------------------------------------------------------------
-- PART 3: attendance_employee_eligible_terminals -- the single place
-- that answers "which access point(s) is this employee eligible at"
-- for every caller that used to read employee_hikcentral_terminals
-- directly. SECURITY DEFINER so it is usable from any SECURITY
-- DEFINER caller regardless of the caller's own RLS visibility into
-- site_hikcentral_terminals/attendance -- callers are always other
-- SECURITY DEFINER functions in this schema that have already
-- performed their own authorization check; this helper performs no
-- authorization of its own and is not intended to be called directly
-- by ordinary client code.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_employee_eligible_terminals(p_tenant_id UUID, p_employee_id UUID)
RETURNS TABLE (access_point TEXT, provenance TEXT)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- (a) the employee's own explicit assignment, if any -- always wins,
  -- never overridden or supplemented by the shared fallback below.
  SELECT t.access_point, 'employee_assigned'::TEXT
  FROM employee_hikcentral_terminals t
  WHERE t.tenant_id = p_tenant_id AND t.employee_id = p_employee_id AND t.is_active

  UNION ALL

  -- (b) the shared site-level fallback -- ONLY reached when the
  -- employee has NO own assignment at all AND no pre-existing
  -- manual-sourced attendance row has ever been recorded for them
  -- (see this migration's header: the CHITANI K KAPANDA / GIFT
  -- BERNARD LICHE production counterexample -- a mapped employee with
  -- an already-established, deliberate manual history is never swept
  -- into automatic eligibility just because their workstation happens
  -- to match a configured site).
  SELECT s.access_point, 'site_shared'::TEXT
  FROM employees e
  JOIN site_hikcentral_terminals s
    ON s.tenant_id = p_tenant_id
    AND s.is_active
    AND s.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
  WHERE e.id = p_employee_id
    AND e.tenant_id = p_tenant_id
    AND COALESCE(btrim(e.workstation), '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM employee_hikcentral_terminals t2
      WHERE t2.tenant_id = p_tenant_id AND t2.employee_id = p_employee_id AND t2.is_active
    )
    AND NOT EXISTS (
      SELECT 1 FROM attendance a
      WHERE a.employee_id = p_employee_id AND a.source = 'manual'
    );
$$;

REVOKE ALL ON FUNCTION attendance_employee_eligible_terminals(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_employee_eligible_terminals(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------
-- PART 4: attendance_resolve_and_calculate -- same signature, CREATE
-- OR REPLACE is sufficient. ONLY the terminal-set source changes
-- (direct table read -> the new helper); every downstream line
-- (coverage-confirmation matching, evidence-backing, bool_and over
-- the resolved set, attendance_engine_calculate's own call) is
-- byte-for-byte unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_resolve_and_calculate(p_employee_id uuid, p_shift_date date)
RETURNS TABLE(status text, calculation_basis text, check_in_at timestamptz, check_out_at timestamptz, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_resolved_shift TEXT;
  v_has_active_mapping BOOLEAN;
  v_event_times TIMESTAMPTZ[];
  v_checkin_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_coverage_status TEXT := 'insufficient';
  v_coverage_through TIMESTAMPTZ := NULL;
  v_assigned_terminals TEXT[];
  v_all_terminals_covered BOOLEAN;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM employees WHERE id = p_employee_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'attendance_resolve_and_calculate: no such employee %', p_employee_id;
  END IF;

  v_resolved_shift := roster_resolve_schedule(p_employee_id, p_shift_date);

  IF v_resolved_shift IN ('off', 'unassigned') THEN
    RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, NULL, 'insufficient', NULL, clock_timestamp());
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM hikcentral_person_mappings m
    WHERE m.employee_id = p_employee_id AND m.is_active AND m.tenant_id = v_tenant_id
  ) INTO v_has_active_mapping;

  IF v_has_active_mapping THEN
    SELECT ARRAY_AGG(r.event_time) INTO v_event_times
    FROM hikcentral_raw_events r
    JOIN hikcentral_person_mappings m
      ON m.hikcentral_person_no = r.hikcentral_person_no
      AND m.is_active
      AND m.tenant_id = r.tenant_id
    WHERE m.employee_id = p_employee_id
      AND m.tenant_id = v_tenant_id
      AND r.tenant_id = v_tenant_id
      AND r.event_time >= attendance_blantyre_to_utc(p_shift_date, '00:00') - interval '4 hours'
      AND r.event_time <= attendance_blantyre_to_utc(p_shift_date + 2, '00:00');

    SELECT w.check_in_window_start, w.check_out_window_end
      INTO v_checkin_window_start, v_checkout_window_end
    FROM attendance_engine_shift_windows(p_shift_date, v_resolved_shift) w;

    -- Automatic fingerprint terminal resolution: the employee's own
    -- assignment if any, else the shared site-level fallback (never
    -- both, never neither-then-invent) -- see attendance_employee_
    -- eligible_terminals's own header. An employee with an empty
    -- result here simply never reaches 'confirmed_complete' below --
    -- never an error, never a fabricated Absent; attendance_process_
    -- import_batch separately surfaces that as a configuration flag.
    SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_assigned_terminals
    FROM attendance_employee_eligible_terminals(v_tenant_id, p_employee_id);

    IF v_assigned_terminals IS NOT NULL AND array_length(v_assigned_terminals, 1) IS NOT NULL THEN
      SELECT bool_and(x.covered), MIN(x.covers_through) FILTER (WHERE x.covered)
        INTO v_all_terminals_covered, v_coverage_through
      FROM (
        SELECT
          EXISTS (
            SELECT 1 FROM fingerprint_coverage_confirmations c
            WHERE c.tenant_id = v_tenant_id
              AND c.revoked_at IS NULL
              AND c.access_points IS NOT NULL
              AND ap = ANY(c.access_points)
              AND c.covers_from <= v_checkin_window_start
              AND c.covers_through >= v_checkout_window_end
              AND (c.latest_observed_event_at IS NOT NULL OR (c.exceeds_observed_evidence AND c.independently_verified))
          ) AS covered,
          (
            SELECT c2.covers_through FROM fingerprint_coverage_confirmations c2
            WHERE c2.tenant_id = v_tenant_id
              AND c2.revoked_at IS NULL
              AND c2.access_points IS NOT NULL
              AND ap = ANY(c2.access_points)
              AND c2.covers_from <= v_checkin_window_start
              AND c2.covers_through >= v_checkout_window_end
              AND (c2.latest_observed_event_at IS NOT NULL OR (c2.exceeds_observed_evidence AND c2.independently_verified))
            ORDER BY c2.covers_through DESC LIMIT 1
          ) AS covers_through
        FROM unnest(v_assigned_terminals) AS ap
      ) x;

      IF v_all_terminals_covered THEN
        v_coverage_status := 'confirmed_complete';
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM attendance_engine_calculate(p_shift_date, v_resolved_shift, v_event_times, v_coverage_status, v_coverage_through, clock_timestamp());
END;
$$;

-- ------------------------------------------------------------
-- PART 5: seed site_hikcentral_terminals -- a deterministic, generic
-- rollup of EXISTING, already-explicit employee_hikcentral_terminals
-- rows: for every (tenant, normalized workstation) where every active
-- assignment already agrees on exactly ONE access_point, seed that
-- one site->terminal row. Genuinely ambiguous sites (more than one
-- distinct access_point observed) are deliberately left unseeded --
-- see this migration's header for the 5 real sites this currently
-- excludes and why. assigned_by is left NULL (no human actor exists
-- for a system rollup) and source is marked 'derived_from_employee_
-- assignments' so this is never confused with a human's own decision.
-- Computed fresh from whatever this database's own data is at apply
-- time -- never a hardcoded site list, so this is exactly as correct
-- (and exactly as inert on an empty table) on disposable test Postgres
-- as it would be anywhere else.
-- ------------------------------------------------------------
INSERT INTO site_hikcentral_terminals (tenant_id, site, access_point, source, assigned_by)
SELECT
  rollup.tenant_id,
  rollup.site,
  rollup.only_access_point,
  'derived_from_employee_assignments',
  NULL
FROM (
  SELECT
    t.tenant_id,
    upper(btrim(regexp_replace(e.workstation, '\s+', ' ', 'g'))) AS site,
    (array_agg(DISTINCT t.access_point))[1] AS only_access_point,
    count(DISTINCT t.access_point) AS distinct_access_points
  FROM employee_hikcentral_terminals t
  JOIN employees e ON e.id = t.employee_id AND e.tenant_id = t.tenant_id
  WHERE t.is_active AND COALESCE(btrim(e.workstation), '') <> ''
  GROUP BY t.tenant_id, upper(btrim(regexp_replace(e.workstation, '\s+', ' ', 'g')))
) rollup
WHERE rollup.distinct_access_points = 1
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- PART 6: attendance_coverage_explain -- same signature, same
-- purpose (read-only, server-authoritative explanation of one
-- employee-day's coverage), now reading the same shared helper the
-- real engine uses, plus TWO new, more specific provenance values
-- so the Evidence Centre / diagnostics can explain exactly why an
-- employee has no eligible terminal: a genuine configuration gap
-- ('no_assigned_terminal', unchanged meaning, now also covers "no
-- site-level config exists either") versus an employee who is
-- deliberately protected from the new site-level fallback by their
-- own existing manual attendance history ('manual_protected') --
-- never silently indistinguishable from a plain gap.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_coverage_explain(
  p_employee_ids UUID[],
  p_date_from DATE,
  p_date_to DATE
)
RETURNS TABLE(
  employee_id UUID,
  shift_date DATE,
  resolved_shift TEXT,
  assigned_terminal_count INTEGER,
  checkout_window_end TIMESTAMPTZ,
  checkout_window_covered BOOLEAN,
  coverage_provenance TEXT,
  sufficient_evidence BOOLEAN,
  official_engine_trusts_this BOOLEAN,
  confirmed_through TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_employee_id UUID; v_date DATE;
  v_resolved_shift TEXT;
  v_checkin_window_start TIMESTAMPTZ;
  v_checkout_window_end TIMESTAMPTZ;
  v_has_active_mapping BOOLEAN;
  v_terminals TEXT[];
  v_terminal TEXT;
  v_all_covered BOOLEAN;
  v_any_unsupported BOOLEAN;
  v_any_verified_override BOOLEAN;
  v_min_covers_through TIMESTAMPTZ;
  v_m_covers_through TIMESTAMPTZ;
  v_m_latest_observed TIMESTAMPTZ;
  v_m_exceeds BOOLEAN;
  v_m_verified BOOLEAN;
  v_site_config_exists BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'A valid p_date_from <= p_date_to is required' USING ERRCODE = '22023';
  END IF;
  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_employee_ids must not be empty' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.map_hikcentral_persons')) THEN
    RAISE EXCEPTION 'Not authorized to view attendance coverage evidence' USING ERRCODE = '42501';
  END IF;

  FOREACH v_employee_id IN ARRAY p_employee_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = v_employee_id) THEN
      RAISE EXCEPTION 'No such employee: %', v_employee_id;
    END IF;
    IF NOT employee_region_allowed(v_employee_id) THEN
      RAISE EXCEPTION 'Employee % is outside the caller''s authorized tenant/region', v_employee_id USING ERRCODE = '42501';
    END IF;

    v_date := p_date_from;
    WHILE v_date <= p_date_to LOOP
      v_resolved_shift := roster_resolve_schedule(v_employee_id, v_date);

      IF v_resolved_shift IN ('off', 'unassigned') THEN
        employee_id := v_employee_id; shift_date := v_date; resolved_shift := v_resolved_shift;
        assigned_terminal_count := 0; checkout_window_end := NULL; checkout_window_covered := false;
        coverage_provenance := 'not_applicable'; sufficient_evidence := false;
        official_engine_trusts_this := false; confirmed_through := NULL;
        reason := CASE WHEN v_resolved_shift = 'off' THEN 'Scheduled Off day -- coverage is not applicable.'
                       ELSE 'No roster assignment recorded for this date -- coverage is not applicable.' END;
        RETURN NEXT;
        v_date := v_date + 1;
        CONTINUE;
      END IF;

      SELECT w.check_in_window_start, w.check_out_window_end
        INTO v_checkin_window_start, v_checkout_window_end
      FROM attendance_engine_shift_windows(v_date, v_resolved_shift) w;

      employee_id := v_employee_id; shift_date := v_date; resolved_shift := v_resolved_shift;
      checkout_window_end := v_checkout_window_end;

      SELECT EXISTS(
        SELECT 1 FROM hikcentral_person_mappings m
        WHERE m.employee_id = v_employee_id AND m.is_active AND m.tenant_id = v_tenant_id
      ) INTO v_has_active_mapping;

      IF NOT v_has_active_mapping THEN
        assigned_terminal_count := 0; checkout_window_covered := false;
        coverage_provenance := 'no_active_mapping'; sufficient_evidence := false;
        official_engine_trusts_this := false; confirmed_through := NULL;
        reason := 'No active HikCentral person mapping is confirmed for this employee yet -- coverage cannot be established regardless of any terminal assignment.';
        RETURN NEXT;
        v_date := v_date + 1;
        CONTINUE;
      END IF;

      SELECT COALESCE(array_agg(DISTINCT access_point), ARRAY[]::TEXT[]) INTO v_terminals
      FROM attendance_employee_eligible_terminals(v_tenant_id, v_employee_id);

      assigned_terminal_count := COALESCE(array_length(v_terminals, 1), 0);

      IF assigned_terminal_count = 0 THEN
        checkout_window_covered := false;
        -- Distinguish a genuine configuration gap from an employee who
        -- is deliberately protected from the shared site fallback by
        -- their own existing manual attendance history -- both still
        -- correctly report sufficient_evidence = false (never a
        -- fabricated Absent either way), but the REASON a reviewer
        -- sees must never conflate "nobody has configured this yet"
        -- with "this is a deliberate manual-attendance employee".
        SELECT EXISTS (
          SELECT 1 FROM site_hikcentral_terminals s
          JOIN employees e ON e.id = v_employee_id
          WHERE s.tenant_id = v_tenant_id AND s.is_active
            AND s.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
        ) INTO v_site_config_exists;

        IF v_site_config_exists AND EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = v_employee_id AND a.source = 'manual') THEN
          coverage_provenance := 'manual_protected';
          reason := 'This employee has an established manual attendance history, so Safeguard does not apply the shared site-level terminal configuration automatically -- assign a terminal directly if this employee should move to automatic processing.';
        ELSE
          coverage_provenance := 'no_assigned_terminal';
          reason := 'No fingerprint terminal is assigned to this employee, and no shared site-level terminal configuration exists for their workstation yet -- coverage cannot be established.';
        END IF;
        sufficient_evidence := false; official_engine_trusts_this := false; confirmed_through := NULL;
        RETURN NEXT;
        v_date := v_date + 1;
        CONTINUE;
      END IF;

      v_all_covered := true; v_any_unsupported := false; v_any_verified_override := false; v_min_covers_through := NULL;

      FOREACH v_terminal IN ARRAY v_terminals LOOP
        v_m_covers_through := NULL; v_m_latest_observed := NULL; v_m_exceeds := NULL; v_m_verified := NULL;

        SELECT c.covers_through, c.latest_observed_event_at, c.exceeds_observed_evidence, c.independently_verified
          INTO v_m_covers_through, v_m_latest_observed, v_m_exceeds, v_m_verified
        FROM fingerprint_coverage_confirmations c
        WHERE c.tenant_id = v_tenant_id
          AND c.revoked_at IS NULL
          AND c.access_points IS NOT NULL
          AND v_terminal = ANY(c.access_points)
          AND c.covers_from <= v_checkin_window_start
          AND c.covers_through >= v_checkout_window_end
        ORDER BY c.covers_through DESC
        LIMIT 1;

        IF v_m_covers_through IS NULL THEN
          v_all_covered := false;
        ELSE
          IF v_min_covers_through IS NULL OR v_m_covers_through < v_min_covers_through THEN
            v_min_covers_through := v_m_covers_through;
          END IF;
          IF v_m_latest_observed IS NULL AND NOT v_m_exceeds THEN
            v_any_unsupported := true;
          ELSIF v_m_exceeds AND v_m_verified THEN
            v_any_verified_override := true;
          END IF;
        END IF;
      END LOOP;

      checkout_window_covered := v_all_covered;
      official_engine_trusts_this := v_all_covered;

      IF NOT v_all_covered THEN
        coverage_provenance := 'no_coverage'; sufficient_evidence := false; confirmed_through := NULL;
        reason := 'Not every eligible terminal has a confirmed-coverage declaration spanning this shift''s checkout window -- treated as Pending, never a false Absent.';
      ELSIF v_any_unsupported THEN
        coverage_provenance := 'unsupported_historical'; sufficient_evidence := false; confirmed_through := v_min_covers_through;
        reason := 'Coverage is declared, but the declaration predates this tenant''s evidence-validation safeguard and was never checked against observed fingerprint events -- treated as Pending until a freshly evidence-checked confirmation exists, even though the server''s automatic engine currently still accepts it as-is.';
      ELSIF v_any_verified_override THEN
        coverage_provenance := 'independently_verified_override'; sufficient_evidence := true; confirmed_through := v_min_covers_through;
        reason := 'Coverage exceeds the observed fingerprint evidence, but an administrator explicitly, independently verified it was genuinely complete.';
      ELSE
        coverage_provenance := 'evidence_backed'; sufficient_evidence := true; confirmed_through := v_min_covers_through;
        reason := 'Coverage is confirmed and consistent with the observed fingerprint evidence for this period.';
      END IF;

      RETURN NEXT;
      v_date := v_date + 1;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION attendance_coverage_explain(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_coverage_explain(UUID[], DATE, DATE) TO authenticated;

-- ------------------------------------------------------------
-- PART 7: attendance_process_import_batch -- same signature (10
-- params, same order/defaults), so CREATE OR REPLACE alone is
-- sufficient. Only the "who is Absent-eligible" (v_expected_terminal_ids)
-- and "who still needs configuration" (v_needs_configuration) queries
-- change, to use the new shared helper instead of reading employee_
-- hikcentral_terminals directly; everything else (confirmation reuse/
-- evidence-gap gating, OBSERVED scope, the legacy workstation scope,
-- the PART A one-day-backward reconciliation window, attendance_apply_
-- automatic's own call) is byte-for-byte unchanged. One new, additive
-- response field (manual_protected_mapped_employees) reports -- never
-- writes anything for -- employees this batch's scope reached who are
-- deliberately excluded from the shared site fallback by their own
-- existing manual attendance history (Part 4/5 transparency).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_process_import_batch(
  p_import_batch_id UUID,
  p_access_points TEXT[],
  p_covers_from TIMESTAMPTZ,
  p_covers_through TIMESTAMPTZ,
  p_date_from DATE,
  p_date_to DATE,
  p_notes TEXT DEFAULT NULL,
  p_workstations TEXT[] DEFAULT NULL,
  p_override_reason TEXT DEFAULT NULL,
  p_independently_verified BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
  v_batch_tenant_id UUID; v_batch_status TEXT;
  v_sorted_access_points TEXT[];
  v_confirmation_id UUID;
  v_employee_ids UUID[];
  v_observed_ids UUID[];
  v_expected_terminal_ids UUID[];
  v_workstation_ids UUID[];
  v_results JSONB;
  v_applied_count INTEGER := 0;
  v_unchanged_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
  v_needs_configuration JSONB;
  v_manual_protected JSONB;
  v_latest_observed_event_at TIMESTAMPTZ;
  v_exceeds_evidence BOOLEAN;
  v_evidence_gap_threshold INTERVAL := INTERVAL '2 hours';
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.confirm_coverage')) THEN
    RAISE EXCEPTION 'Not authorized to confirm fingerprint coverage' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.auto_apply')) THEN
    RAISE EXCEPTION 'Not authorized to run automatic attendance processing' USING ERRCODE = '42501';
  END IF;

  IF p_import_batch_id IS NULL THEN RAISE EXCEPTION 'No import batch id supplied' USING ERRCODE = '22023'; END IF;
  SELECT tenant_id, status INTO v_batch_tenant_id, v_batch_status
  FROM hikcentral_import_batches WHERE id = p_import_batch_id;
  IF v_batch_tenant_id IS NULL THEN RAISE EXCEPTION 'Import batch not found' USING ERRCODE = '22023'; END IF;
  IF v_batch_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Import batch does not belong to your tenant' USING ERRCODE = '42501';
  END IF;
  IF v_batch_status <> 'completed' THEN
    RAISE EXCEPTION 'Import batch % is not completed (status=%)', p_import_batch_id, v_batch_status USING ERRCODE = '22023';
  END IF;

  IF p_access_points IS NULL OR array_length(p_access_points, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one access point must be declared' USING ERRCODE = '22023';
  END IF;
  IF p_covers_from IS NULL OR p_covers_through IS NULL OR p_covers_through <= p_covers_from THEN
    RAISE EXCEPTION 'p_covers_through must be after p_covers_from' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'A valid p_date_from <= p_date_to is required' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT unnest(p_access_points) ORDER BY 1) INTO v_sorted_access_points;

  SELECT c.id INTO v_confirmation_id
  FROM fingerprint_coverage_confirmations c
  WHERE c.tenant_id = v_tenant_id
    AND c.revoked_at IS NULL
    AND c.covers_from = p_covers_from
    AND c.covers_through = p_covers_through
    AND c.access_points IS NOT NULL
    AND (SELECT ARRAY(SELECT unnest(c.access_points) ORDER BY 1)) = v_sorted_access_points
  LIMIT 1;

  IF v_confirmation_id IS NULL THEN
    SELECT MAX(r.event_time) INTO v_latest_observed_event_at
    FROM hikcentral_raw_events r
    WHERE r.tenant_id = v_tenant_id
      AND r.access_point = ANY(p_access_points)
      AND r.event_time >= p_covers_from
      AND r.event_time <= p_covers_through;

    v_exceeds_evidence := (v_latest_observed_event_at IS NULL)
      OR (p_covers_through - v_latest_observed_event_at > v_evidence_gap_threshold);

    IF v_exceeds_evidence AND (btrim(COALESCE(p_override_reason, '')) = '' OR NOT COALESCE(p_independently_verified, false)) THEN
      RETURN jsonb_build_object(
        'status', 'needs_override_reason',
        'latest_observed_event_at', v_latest_observed_event_at,
        'declared_covers_through', p_covers_through,
        'access_points', p_access_points
      );
    END IF;

    INSERT INTO fingerprint_coverage_confirmations (
      tenant_id, confirmed_by, workstations, access_points, covers_from, covers_through,
      export_time_declared, notes, latest_observed_event_at, exceeds_observed_evidence, override_reason, independently_verified
    ) VALUES (
      v_tenant_id, v_caller_id, COALESCE(p_workstations, ARRAY[]::TEXT[]), p_access_points, p_covers_from, p_covers_through,
      p_covers_through, p_notes, v_latest_observed_event_at, v_exceeds_evidence,
      CASE WHEN btrim(COALESCE(p_override_reason, '')) = '' THEN NULL ELSE btrim(p_override_reason) END,
      COALESCE(p_independently_verified, false)
    )
    RETURNING id INTO v_confirmation_id;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT m.employee_id), ARRAY[]::UUID[]) INTO v_observed_ids
  FROM hikcentral_raw_events r
  JOIN hikcentral_person_mappings m
    ON m.hikcentral_person_no = r.hikcentral_person_no
    AND m.is_active
    AND m.tenant_id = r.tenant_id
  JOIN employees e ON e.id = m.employee_id
  WHERE r.tenant_id = v_tenant_id
    AND m.tenant_id = v_tenant_id
    AND r.access_point = ANY(p_access_points)
    AND r.event_time >= p_covers_from
    AND r.event_time <= p_covers_through
    AND e.tenant_id = v_tenant_id
    AND e.status = 'Active'
    AND e.is_deleted = false;

  -- EXPECTED-TERMINAL: mapped employees whose eligible terminal set
  -- (own assignment, OR the shared site-level fallback -- see
  -- attendance_employee_eligible_terminals) intersects the declared
  -- access points. This is the exact same "expected" concept as
  -- before, now also reaching employees who were never individually
  -- assigned but whose site is configured.
  SELECT COALESCE(array_agg(DISTINCT eid), ARRAY[]::UUID[]) INTO v_expected_terminal_ids
  FROM (
    SELECT m.employee_id AS eid
    FROM hikcentral_person_mappings m
    JOIN employees e ON e.id = m.employee_id
    CROSS JOIN LATERAL attendance_employee_eligible_terminals(v_tenant_id, m.employee_id) elig
    WHERE m.is_active AND m.tenant_id = v_tenant_id
      AND e.tenant_id = v_tenant_id AND e.status = 'Active' AND e.is_deleted = false
      AND elig.access_point = ANY(p_access_points)
  ) x;

  IF p_workstations IS NOT NULL AND array_length(p_workstations, 1) IS NOT NULL THEN
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_workstation_ids
    FROM employees
    WHERE tenant_id = v_tenant_id
      AND workstation = ANY(p_workstations)
      AND status = 'Active'
      AND is_deleted = false;
  ELSE
    v_workstation_ids := ARRAY[]::UUID[];
  END IF;

  SELECT COALESCE(array_agg(DISTINCT eid), ARRAY[]::UUID[]) INTO v_employee_ids
  FROM unnest(v_observed_ids || v_expected_terminal_ids || v_workstation_ids) AS eid;

  IF array_length(v_employee_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'applied',
      'confirmation_id', v_confirmation_id,
      'employee_count', 0,
      'applied_count', 0,
      'unchanged_count', 0,
      'skipped_count', 0,
      'failed_count', 0,
      'rows', '[]'::jsonb,
      'needs_terminal_configuration', '[]'::jsonb,
      'manual_protected_mapped_employees', '[]'::jsonb
    );
  END IF;

  -- PART A fix: p_date_from - 1, not p_date_from -- so a Night shift
  -- starting the day before this declared period, whose checkout
  -- arrives in THIS batch's events, is automatically re-evaluated
  -- rather than staying stuck exactly where the previous batch left it.
  SELECT
    jsonb_agg(to_jsonb(r)),
    count(*) FILTER (WHERE r.outcome = 'written'),
    count(*) FILTER (WHERE r.outcome = 'skipped_no_change'),
    count(*) FILTER (WHERE r.outcome NOT IN ('written', 'skipped_no_change'))
  INTO v_results, v_applied_count, v_unchanged_count, v_skipped_count
  FROM attendance_apply_automatic(v_employee_ids, p_date_from - 1, p_date_to) r;

  -- Mapped, in-scope employees whose workstation DOES have a shared
  -- site-level configuration, but who are deliberately excluded from
  -- it because they already have an established manual attendance
  -- history -- never a configuration gap, a reported safety exclusion
  -- (Part 4/5: never silently reclassified, always explained). Computed
  -- FIRST so the needs_terminal_configuration query right below can
  -- exclude them -- a manually-protected employee is deliberately
  -- working as intended, never also reported as a plain gap.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name) ORDER BY e.full_name), '[]'::jsonb)
    INTO v_manual_protected
  FROM employees e
  WHERE e.id = ANY(v_employee_ids)
    AND NOT EXISTS (SELECT 1 FROM employee_hikcentral_terminals t WHERE t.employee_id = e.id AND t.tenant_id = v_tenant_id AND t.is_active)
    AND EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.source = 'manual')
    AND EXISTS (
      SELECT 1 FROM site_hikcentral_terminals s
      WHERE s.tenant_id = v_tenant_id AND s.is_active
        AND s.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
    );

  -- Mapped, in-scope employees with NO eligible terminal at all (own
  -- assignment nor site-level fallback) -- these can never resolve
  -- Absent, by design. Surfaced so an operator configures them
  -- (individually, or once for their whole site) instead of the gap
  -- going unnoticed. Deliberately EXCLUDES anyone already reported
  -- under manual_protected_mapped_employees just above -- that is a
  -- deliberate safety exclusion working exactly as intended, never a
  -- plain configuration gap, and must never be reported as both.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name) ORDER BY e.full_name), '[]'::jsonb)
    INTO v_needs_configuration
  FROM employees e
  WHERE e.id = ANY(v_employee_ids)
    AND NOT EXISTS (SELECT 1 FROM attendance_employee_eligible_terminals(v_tenant_id, e.id))
    AND NOT (e.id::TEXT IN (SELECT jsonb_array_elements(v_manual_protected) ->> 'employee_id'));

  RETURN jsonb_build_object(
    'status', 'applied',
    'confirmation_id', v_confirmation_id,
    'employee_count', array_length(v_employee_ids, 1),
    'applied_count', COALESCE(v_applied_count, 0),
    'unchanged_count', COALESCE(v_unchanged_count, 0),
    'skipped_count', COALESCE(v_skipped_count, 0),
    'failed_count', 0,
    'rows', COALESCE(v_results, '[]'::jsonb),
    'needs_terminal_configuration', COALESCE(v_needs_configuration, '[]'::jsonb),
    'manual_protected_mapped_employees', COALESCE(v_manual_protected, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[], TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_process_import_batch(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TEXT[], TEXT, BOOLEAN) TO authenticated;

-- ------------------------------------------------------------
-- PART 8: hikcentral_mapped_employees_terminal_status -- bulk, read-
-- only status for the Person Mapping page (Part 5): for every actively
-- mapped employee in the caller's tenant/region, the eligible terminal
-- set and ONE clear provenance label the UI maps directly to the
-- required status text:
--   'employee_assigned' / 'site_shared' -> "Fingerprint identity
--     confirmed. Safeguard automatically recognizes eligible
--     HikCentral terminals."
--   'manual_protected' -> an explicit, non-alarming explanation that
--     this employee is deliberately kept on manual attendance.
--   'unconfigured' -> "Fingerprint identity mapped. Waiting for
--     confirmed terminal coverage."
-- Never claims "fully configured" when eligibility is actually still
-- unresolved -- the whole reason this RPC exists.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION hikcentral_mapped_employees_terminal_status()
RETURNS TABLE (employee_id UUID, access_points TEXT[], provenance TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID; v_is_super_admin BOOLEAN; v_is_active BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT tenant_id, is_super_admin, is_active INTO v_tenant_id, v_is_super_admin, v_is_active FROM profiles WHERE id = v_caller_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No profile found'; END IF;
  IF COALESCE(v_is_active, false) = false THEN RAISE EXCEPTION 'Your account is disabled'; END IF;
  IF NOT (v_is_super_admin OR has_permission('attendance.map_hikcentral_persons')) THEN
    RAISE EXCEPTION 'Not authorized to view attendance' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    m.employee_id,
    COALESCE((SELECT array_agg(DISTINCT elig.access_point) FROM attendance_employee_eligible_terminals(v_tenant_id, m.employee_id) elig), ARRAY[]::TEXT[]),
    CASE
      WHEN EXISTS (SELECT 1 FROM employee_hikcentral_terminals t WHERE t.employee_id = m.employee_id AND t.tenant_id = v_tenant_id AND t.is_active) THEN 'employee_assigned'
      WHEN EXISTS (SELECT 1 FROM attendance_employee_eligible_terminals(v_tenant_id, m.employee_id)) THEN 'site_shared'
      WHEN EXISTS (
        SELECT 1 FROM site_hikcentral_terminals s
        WHERE s.tenant_id = v_tenant_id AND s.is_active
          AND s.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
      ) AND EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = m.employee_id AND a.source = 'manual') THEN 'manual_protected'
      ELSE 'unconfigured'
    END
  FROM hikcentral_person_mappings m
  JOIN employees e ON e.id = m.employee_id AND e.tenant_id = v_tenant_id
  WHERE m.is_active AND m.tenant_id = v_tenant_id
    AND (v_is_super_admin OR employee_region_allowed(m.employee_id));
END;
$$;

REVOKE ALL ON FUNCTION hikcentral_mapped_employees_terminal_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hikcentral_mapped_employees_terminal_status() TO authenticated;
