-- ============================================================
-- MIGRATION: Shared fingerprint terminal networks -- replaces the
-- workstation-to-terminal assumption behind PR #80's site-level
-- fallback with a smaller, more accurate model for how Lilongwe
-- fingerprint attendance actually works.
-- Date: 2026-12-03
-- ============================================================
--
-- BUSINESS CLARIFICATION (confirmed): PR #80's "configure a site's
-- terminal(s) once" model assumed a site (an employee's HR
-- workstation) maps to its OWN terminal(s). In Lilongwe this is
-- wrong: there are a small number of PHYSICAL fingerprint terminal
-- LOCATIONS (KANENGO, MASM, OCEAN, and a fourth not yet confirmed --
-- see the READ-ONLY DISCOVERY section below) that employees from MANY
-- different, unrelated HR workstations travel to and scan at
-- interchangeably, via credentials iVMS-4200 already distributed to
-- multiple devices. Requiring an administrator to separately declare
-- the SAME 3-4 door list once per distinct workstation string (today,
-- a dozen-plus different Lilongwe-area workstation names) is exactly
-- the "repetitive administrative confirmation" this migration removes
-- -- a NETWORK is a single, named, reusable terminal list; many sites
-- can join it, and adding a terminal later is ONE edit to the
-- network, not one edit per site.
--
-- READ-ONLY PRODUCTION DISCOVERY THAT SHAPED THIS DESIGN (no row
-- touched by the investigation itself; see this release's own report
-- for the full breakdown):
--   - Of the 4 expected Lilongwe terminal locations, exactly 3 have
--     ANY HikCentral access_point identifier ever observed in
--     imported raw events: KANENGO -> "AHL - KANENGO_Door_1" (242
--     events, 52 distinct Person Nos.), OCEAN -> "LL - OCEAN_Door_1"
--     (58 events, 9 persons), MASM (Lilongwe) -> "LL- MASM_Door_1"
--     (62 events, 8 persons -- note the inconsistent spacing vs
--     "LL - OCEAN", and this is a DIFFERENT physical door from the
--     unrelated, already-known Blantyre "BT - MASM_Door_1" /
--     "MASM - BT_Door_1" pair). OFFICE WORLD has NO access_point
--     identifier anywhere in hikcentral_raw_events -- confirmed by
--     also checking the two employees whose own workstation is
--     literally "OFFICE WORLD" / "MTL OFFICEWORLD BATA": neither has
--     ever been through Person Mapping, and neither has a single raw
--     event under any access point. This migration does NOT guess an
--     identifier for it -- see PART 1 below, which registers only the
--     3 confirmed terminals; a human adds the 4th once a fresh
--     HikCentral export actually contains it.
--   - employees.region_id ("Central region" for Lilongwe-area
--     employees) is a STRONG but NOT CLEAN signal for network
--     membership: of the mapped employees who have actually scanned
--     at the 3 confirmed Lilongwe terminals, the overwhelming majority
--     (59 of 66 employee-site pairings) are tagged "Central region",
--     but a real minority are NOT -- e.g. one employee whose
--     workstation is "MANDALA" (a known Blantyre neighborhood, one of
--     PR #80's own 5 "ambiguous site" list, region = "Southern
--     region") has 3 observed events at the KANENGO door; one at
--     "NAPERI" (Southern region) likewise. This migration therefore
--     NEVER auto-derives network membership from region_id or
--     workstation name alone (exactly as instructed) -- see PART 2:
--     site-to-network membership is only ever created through an
--     explicit, reviewable administrator action, never inferred or
--     backfilled by this migration.
--   - All Blantyre-area access points (AHL - LIMBE_Door_1,
--     BT - MASM_Door_1, HEADOFFICE - NAPERI_Door_1 in both its
--     spacing variants, MASM - BT_Door_1, MTL - CHICHIRI_Door_1) are
--     100% "Southern region" in the observed data -- Blantyre
--     processing is already cleanly isolated from Lilongwe in
--     practice, and nothing in this migration touches those sites'
--     existing PR #80 configuration at all.
--   - Every one of the 58 actively-mapped "Central region" employees
--     today has NO individual employee_hikcentral_terminals
--     assignment and fingerprint_attendance_enabled = false -- i.e.
--     the entire Lilongwe-area mapped population is currently part of
--     PR #80's conservatively-disabled "64 legacy mappings" group,
--     permanently Pending. This migration changes NONE of their
--     flags -- see PART 5.
--
-- THE MODEL (Part 2 -- smallest reliable extension of PR #80, not a
-- rebuild):
--   1. employee_hikcentral_terminals and site_hikcentral_terminals
--      are completely unchanged -- every existing individual
--      assignment and every existing per-site configuration (the 13
--      clean Blantyre-area sites) keeps working exactly as before,
--      with the same priority (individual always wins; a site's own
--      DIRECT configuration, if any, wins over network membership).
--   2. NEW, additive hikcentral_terminal_network_members: the SAME
--      shape as site_hikcentral_terminals, but keyed by a normalized
--      NETWORK NAME instead of a site -- one row per (tenant, network,
--      access_point). A network's terminal list is configured ONCE,
--      through the existing reconcile-by-full-desired-set RPC shape
--      (set_terminal_network_members), exactly like
--      set_site_hikcentral_terminals already works for a site.
--   3. NEW, additive hikcentral_site_network_membership: maps a
--      normalized SITE to AT MOST ONE active NETWORK (a site belongs
--      to zero or one network at a time -- the smallest relationship
--      that satisfies "many sites, one shared terminal list", with no
--      per-employee action). set_site_network_membership lets an
--      administrator assign many site names to one network, or move
--      them, or clear them, in a single call.
--   4. attendance_employee_eligible_terminals (the SAME single choke
--      point every caller already goes through) gains ONE additional
--      resolution branch: when an employee has no own assignment AND
--      their own site has no DIRECT site_hikcentral_terminals
--      configuration, but their site belongs to an active network
--      that itself has registered terminals, AND their mapping has
--      fingerprint_attendance_enabled = true, resolve via the
--      network's terminal list (provenance 'network_shared'). Because
--      attendance_resolve_and_calculate, attendance_coverage_explain,
--      attendance_process_import_batch, and
--      hikcentral_mapped_employees_terminal_status all ALREADY call
--      this one helper and nothing else, NONE of those four functions
--      need to change at all -- this is the entire functional change.
--   5. fingerprint_attendance_enabled (PR #80) remains the ONLY gate
--      on the shared fallback, in both its direct-site and
--      network-shared forms -- still never inferred from attendance
--      history, still defaulting true for new Person Mapping
--      confirmations, still requiring an explicit, audited,
--      reviewable human action (set_fingerprint_attendance_enabled,
--      unchanged) to turn on for any of today's 64 legacy mappings.
--
-- NOTHING here recalculates, rewrites, or touches any existing
-- attendance, payroll, roster, person mapping, or audit row, and
-- NEITHER new table is seeded with any row by this migration -- both
-- start completely empty, so applying this migration changes NO
-- employee's resolved eligibility and NO absence decision by itself.
-- The network only starts doing anything once a human explicitly
-- configures its terminal list, assigns sites to it, AND enables the
-- relevant employees -- three separate, auditable actions, none of
-- them automatic, none of them performed by this migration (see this
-- release's own report for the exact recommended rollout commands,
-- never executed here -- not applied to production in this task).
-- ============================================================

-- ------------------------------------------------------------
-- PART 1: hikcentral_terminal_network_members -- a named, reusable
-- terminal list. Same shape and RLS pattern as site_hikcentral_
-- terminals (PR #80), deliberately kept structurally identical so the
-- same reconcile-by-full-desired-set RPC shape applies unchanged.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hikcentral_terminal_network_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  network TEXT NOT NULL CHECK (btrim(network) <> ''),
  access_point TEXT NOT NULL CHECK (btrim(access_point) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_hikcentral_terminal_network_members_network ON hikcentral_terminal_network_members(tenant_id, network) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hikcentral_terminal_network_members_unique_active ON hikcentral_terminal_network_members(tenant_id, network, access_point) WHERE is_active;

ALTER TABLE hikcentral_terminal_network_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Terminal network members: view within tenant, permitted" ON hikcentral_terminal_network_members;
CREATE POLICY "Terminal network members: view within tenant, permitted" ON hikcentral_terminal_network_members
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

DROP POLICY IF EXISTS "Terminal network members: create within tenant, permitted" ON hikcentral_terminal_network_members;
CREATE POLICY "Terminal network members: create within tenant, permitted" ON hikcentral_terminal_network_members
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

DROP POLICY IF EXISTS "Terminal network members: revoke within tenant, permitted" ON hikcentral_terminal_network_members;
CREATE POLICY "Terminal network members: revoke within tenant, permitted" ON hikcentral_terminal_network_members
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

REVOKE ALL ON hikcentral_terminal_network_members FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON hikcentral_terminal_network_members TO authenticated;

-- ------------------------------------------------------------
-- PART 2: hikcentral_site_network_membership -- which site(s) belong
-- to which network. A site belongs to AT MOST ONE active network (the
-- unique partial index below) -- the smallest relationship that
-- satisfies "many surrounding workstations share one terminal list",
-- never a many-to-many model this task did not ask for.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hikcentral_site_network_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  site TEXT NOT NULL CHECK (btrim(site) <> ''),
  network TEXT NOT NULL CHECK (btrim(network) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL REFERENCES profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_hikcentral_site_network_membership_network ON hikcentral_site_network_membership(tenant_id, network) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hikcentral_site_network_membership_unique_active_site ON hikcentral_site_network_membership(tenant_id, site) WHERE is_active;

ALTER TABLE hikcentral_site_network_membership ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Site network membership: view within tenant, permitted" ON hikcentral_site_network_membership;
CREATE POLICY "Site network membership: view within tenant, permitted" ON hikcentral_site_network_membership
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

DROP POLICY IF EXISTS "Site network membership: create within tenant, permitted" ON hikcentral_site_network_membership;
CREATE POLICY "Site network membership: create within tenant, permitted" ON hikcentral_site_network_membership
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

DROP POLICY IF EXISTS "Site network membership: revoke within tenant, permitted" ON hikcentral_site_network_membership;
CREATE POLICY "Site network membership: revoke within tenant, permitted" ON hikcentral_site_network_membership
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

REVOKE ALL ON hikcentral_site_network_membership FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON hikcentral_site_network_membership TO authenticated;

-- ------------------------------------------------------------
-- PART 3: set_terminal_network_members -- the one human write path
-- for a network's own terminal list, same reconcile-by-full-desired-
-- set shape as set_site_hikcentral_terminals (PR #80). Audit-logged
-- exactly like set_fingerprint_attendance_enabled -- a network's
-- terminal list can change future Absent eligibility for every site
-- and employee that joins it, so every real add/remove is recorded.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_terminal_network_members(p_network TEXT, p_access_points TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_email TEXT;
  v_tenant_id UUID;
  v_network TEXT;
  v_desired TEXT[];
  v_added INTEGER := 0;
  v_revoked INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  v_network := upper(btrim(regexp_replace(COALESCE(p_network, ''), '\s+', ' ', 'g')));
  IF v_network = '' THEN RAISE EXCEPTION 'p_network is required' USING ERRCODE = '22023'; END IF;
  v_tenant_id := get_current_tenant_id();
  v_caller_email := auth.email();

  SELECT COALESCE(array_agg(DISTINCT ap), ARRAY[]::TEXT[]) INTO v_desired
  FROM unnest(COALESCE(p_access_points, ARRAY[]::TEXT[])) AS ap
  WHERE btrim(ap) <> '';

  WITH revoked AS (
    UPDATE hikcentral_terminal_network_members
    SET is_active = false, revoked_at = NOW(), revoked_by = v_caller_id
    WHERE network = v_network AND tenant_id = v_tenant_id AND is_active
      AND NOT (access_point = ANY(v_desired))
    RETURNING access_point
  ),
  revoked_audit AS (
    INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, old_data, new_data)
    SELECT v_tenant_id, v_caller_id, v_caller_email, 'REVOKE_TERMINAL_NETWORK_MEMBER', 'hikcentral_terminal_network', v_network,
           jsonb_build_object('access_point', r.access_point), jsonb_build_object('network', v_network)
    FROM revoked r
    RETURNING 1
  )
  SELECT count(*) FROM revoked_audit INTO v_revoked;

  WITH added AS (
    INSERT INTO hikcentral_terminal_network_members (tenant_id, network, access_point, assigned_by)
    SELECT v_tenant_id, v_network, ap, v_caller_id
    FROM unnest(v_desired) AS ap
    WHERE NOT EXISTS (
      SELECT 1 FROM hikcentral_terminal_network_members s
      WHERE s.network = v_network AND s.tenant_id = v_tenant_id AND s.access_point = ap AND s.is_active
    )
    RETURNING access_point
  ),
  added_audit AS (
    INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, old_data, new_data)
    SELECT v_tenant_id, v_caller_id, v_caller_email, 'ADD_TERMINAL_NETWORK_MEMBER', 'hikcentral_terminal_network', v_network,
           '{}'::jsonb, jsonb_build_object('network', v_network, 'access_point', a.access_point)
    FROM added a
    RETURNING 1
  )
  SELECT count(*) FROM added_audit INTO v_added;

  RETURN jsonb_build_object('network', v_network, 'added_count', v_added, 'revoked_count', v_revoked, 'access_points', v_desired);
END;
$$;

REVOKE ALL ON FUNCTION set_terminal_network_members(TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_terminal_network_members(TEXT, TEXT[]) TO authenticated;

-- ------------------------------------------------------------
-- PART 4: set_site_network_membership -- assigns one or more sites to
-- one network in a single administrator action (p_network = NULL or
-- empty clears the given sites' membership instead, e.g. to correct a
-- mistake). This is deliberately NOT a full reconcile-the-whole-
-- network's-site-list operation like PART 3 -- it only ever touches
-- the sites named in p_sites, so assigning a new site to a network
-- never disturbs any other site already in it. Audit-logged per site.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_site_network_membership(p_sites TEXT[], p_network TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_email TEXT;
  v_tenant_id UUID;
  v_network TEXT;
  v_sites TEXT[];
  v_changed INTEGER := 0;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_sites IS NULL OR array_length(p_sites, 1) IS NULL THEN
    RAISE EXCEPTION 'p_sites must not be empty' USING ERRCODE = '22023';
  END IF;
  v_tenant_id := get_current_tenant_id();
  v_caller_email := auth.email();
  v_network := upper(btrim(regexp_replace(COALESCE(p_network, ''), '\s+', ' ', 'g')));

  SELECT COALESCE(array_agg(DISTINCT upper(btrim(regexp_replace(s, '\s+', ' ', 'g')))), ARRAY[]::TEXT[]) INTO v_sites
  FROM unnest(p_sites) AS s
  WHERE btrim(s) <> '';

  IF v_network = '' THEN
    -- Clear: revoke any active membership for these sites. A plain
    -- UPDATE is safe here -- there is no corresponding INSERT in this
    -- branch, so no risk of two writes racing the same partial unique
    -- index (tenant_id, site) WHERE is_active.
    WITH before AS (
      SELECT site, network AS old_network
      FROM hikcentral_site_network_membership
      WHERE tenant_id = v_tenant_id AND site = ANY(v_sites) AND is_active
    ),
    revoked AS (
      UPDATE hikcentral_site_network_membership m
      SET is_active = false, revoked_at = NOW(), revoked_by = v_caller_id
      WHERE m.tenant_id = v_tenant_id AND m.site = ANY(v_sites) AND m.is_active
      RETURNING m.site
    ),
    audited AS (
      INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, old_data, new_data)
      SELECT v_tenant_id, v_caller_id, v_caller_email, 'CLEAR_SITE_NETWORK_MEMBERSHIP', 'hikcentral_site_network_membership', b.site,
             jsonb_build_object('network', b.old_network), jsonb_build_object('network', NULL, 'batch_site_count', array_length(v_sites, 1))
      FROM before b
      JOIN revoked r ON r.site = b.site
      RETURNING 1
    )
    SELECT count(*) FROM audited INTO v_changed;
  ELSE
    -- Set/reassign: an atomic UPSERT on the exact same partial unique
    -- index (tenant_id, site) WHERE is_active -- either updates the
    -- site's existing active row in place (reassigning its network)
    -- or inserts a fresh one, in ONE statement per site, with no
    -- separate revoke-then-insert step that could otherwise race
    -- against that same index within one call.
    WITH before AS (
      SELECT site, network AS old_network
      FROM hikcentral_site_network_membership
      WHERE tenant_id = v_tenant_id AND site = ANY(v_sites) AND is_active
    ),
    upserted AS (
      INSERT INTO hikcentral_site_network_membership (tenant_id, site, network, assigned_by)
      SELECT v_tenant_id, s, v_network, v_caller_id
      FROM unnest(v_sites) AS s
      ON CONFLICT (tenant_id, site) WHERE is_active
      DO UPDATE SET network = EXCLUDED.network, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()
      RETURNING site, network
    ),
    audited AS (
      INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, old_data, new_data)
      SELECT v_tenant_id, v_caller_id, v_caller_email, 'SET_SITE_NETWORK_MEMBERSHIP', 'hikcentral_site_network_membership', u.site,
             jsonb_build_object('network', b.old_network), jsonb_build_object('network', u.network, 'batch_site_count', array_length(v_sites, 1))
      FROM upserted u
      LEFT JOIN before b ON b.site = u.site
      WHERE b.old_network IS DISTINCT FROM u.network
      RETURNING 1
    )
    SELECT count(*) FROM audited INTO v_changed;
  END IF;

  RETURN jsonb_build_object('network', CASE WHEN v_network = '' THEN NULL ELSE v_network END, 'sites', v_sites, 'changed_count', v_changed);
END;
$$;

REVOKE ALL ON FUNCTION set_site_network_membership(TEXT[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_site_network_membership(TEXT[], TEXT) TO authenticated;

-- ------------------------------------------------------------
-- PART 5: attendance_employee_eligible_terminals -- same signature,
-- SAME SECURITY DEFINER / no-authenticated-grant model as PR #80
-- (unchanged, re-declared here only because CREATE OR REPLACE
-- requires the full body).
--
-- PRECEDENCE CORRECTION (post-review, same PR, before merge): the
-- FIRST version of this function resolved direct-site (PR #80) before
-- network membership, so a site that already had a seeded direct
-- configuration (e.g. AHL KANENGO, one of the clean sites PR #80's
-- own seed step derived from existing employee_hikcentral_terminals
-- rows) would silently keep using that direct configuration even
-- after an administrator explicitly assigned it to a network --
-- making the network assignment appear to do nothing. Corrected
-- precedence, in order:
--   1. the employee's own individual employee_hikcentral_terminals
--      assignment -- always wins, never gated by the enabled flag
--      (legacy overrides are completely unaffected either way).
--   2. an explicit, active network membership -- ONLY when the
--      employee is fingerprint_attendance_enabled AND the network it
--      resolves to has at least one registered terminal. A network
--      assignment with zero registered terminals is treated as not
--      yet real, and falls through to (3), rather than silently
--      producing zero eligibility for a site that still has a
--      perfectly good legacy direct configuration.
--   3. the legacy direct per-site configuration (PR #80) -- reached
--      only when (2) did not apply (no network membership at all, or
--      a network membership whose network has no terminals yet).
--      Still gated by fingerprint_attendance_enabled, exactly as
--      before -- a disabled employee is never activated by this
--      fallback either.
--   4. empty -- identical to today.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_employee_eligible_terminals(p_tenant_id UUID, p_employee_id UUID)
RETURNS TABLE (access_point TEXT, provenance TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- (1) the employee's own explicit assignment, if any -- always wins,
  -- never overridden or supplemented by anything below, and never
  -- gated by fingerprint_attendance_enabled either.
  SELECT t.access_point, 'employee_assigned'::TEXT
  FROM employee_hikcentral_terminals t
  WHERE t.tenant_id = p_tenant_id AND t.employee_id = p_employee_id AND t.is_active

  UNION ALL

  -- (2) an explicit, active NETWORK's terminal list -- reached only
  -- when the employee has no own assignment, their site belongs to an
  -- active network that itself has at least one registered terminal,
  -- and their mapping is explicitly enabled. Wins over the legacy
  -- direct-site fallback (3) for the SAME site -- an administrator
  -- who explicitly joins a site to a network expects that to actually
  -- take effect, even if that site also has an old direct
  -- configuration from before the network existed.
  SELECT nm.access_point, 'network_shared'::TEXT
  FROM employees e
  JOIN hikcentral_site_network_membership snm
    ON snm.tenant_id = p_tenant_id
    AND snm.is_active
    AND snm.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
  JOIN hikcentral_terminal_network_members nm
    ON nm.tenant_id = p_tenant_id
    AND nm.is_active
    AND nm.network = snm.network
  WHERE e.id = p_employee_id
    AND e.tenant_id = p_tenant_id
    AND COALESCE(btrim(e.workstation), '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM employee_hikcentral_terminals t2
      WHERE t2.tenant_id = p_tenant_id AND t2.employee_id = p_employee_id AND t2.is_active
    )
    AND EXISTS (
      SELECT 1 FROM hikcentral_person_mappings m
      WHERE m.tenant_id = p_tenant_id AND m.employee_id = p_employee_id AND m.is_active
        AND m.fingerprint_attendance_enabled
    )

  UNION ALL

  -- (3) the legacy DIRECT per-site configuration (PR #80) -- reached
  -- only when the employee has no own assignment AND (2) did not
  -- apply: either their site has no active network membership at
  -- all, or it does but that network currently has zero registered
  -- terminals (not yet real). Still gated by fingerprint_attendance_
  -- enabled, exactly as before -- this fallback never activates a
  -- disabled employee either.
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
      SELECT 1 FROM employee_hikcentral_terminals t3
      WHERE t3.tenant_id = p_tenant_id AND t3.employee_id = p_employee_id AND t3.is_active
    )
    AND NOT EXISTS (
      SELECT 1 FROM hikcentral_site_network_membership snm2
      JOIN hikcentral_terminal_network_members nm2
        ON nm2.tenant_id = p_tenant_id AND nm2.is_active AND nm2.network = snm2.network
      WHERE snm2.tenant_id = p_tenant_id AND snm2.is_active
        AND snm2.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
    )
    AND EXISTS (
      SELECT 1 FROM hikcentral_person_mappings m2
      WHERE m2.tenant_id = p_tenant_id AND m2.employee_id = p_employee_id AND m2.is_active
        AND m2.fingerprint_attendance_enabled
    );
$$;

-- Genuinely internal-only, unchanged from PR #80 -- no grant to
-- `authenticated` at all; its SECURITY DEFINER callers (attendance_
-- resolve_and_calculate, attendance_coverage_explain, attendance_
-- process_import_batch, hikcentral_mapped_employees_terminal_status)
-- are unaffected and need NO changes of their own, since all four
-- already call only this one helper for "which terminals is this
-- employee eligible at" and nothing else.
REVOKE ALL ON FUNCTION attendance_employee_eligible_terminals(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- PART 6 (safety, not a migration of data): deliberately NO seed/
-- backfill of any kind. Both new tables start completely empty.
-- Applying this migration therefore changes NO employee's resolved
-- eligibility and NO absence decision by itself -- the network only
-- takes effect once a human explicitly (1) registers its terminal
-- list via set_terminal_network_members, (2) assigns site(s) to it
-- via set_site_network_membership, and (3) enables the relevant
-- employees via set_fingerprint_attendance_enabled (PR #80, already
-- audited) -- three separate, reviewable, auditable actions, none of
-- them performed here. See this release's own report for the exact
-- recommended rollout commands for the Lilongwe network specifically.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- PART 7: hikcentral_mapped_employees_terminal_status -- STATUS
-- ACCURACY CORRECTION (post-review, same PR, before merge). Same
-- signature, same auth/permission pattern as PR #80. The FIRST
-- version of this function collapsed BOTH the legacy direct-site
-- fallback and the new network-based fallback into one generic
-- 'site_shared' label, so the Person Mapping page could not tell an
-- HR user whether an employee's automatic recognition came from a
-- shared network (e.g. Lilongwe) or a plain per-site configuration.
-- Now distinguishes 'network_shared' from 'site_shared' explicitly,
-- by reading the SAME helper's own per-row provenance column instead
-- of only checking whether it returned anything at all. The
-- 'fingerprint_not_enabled' detection is likewise extended to also
-- recognize an active network membership whose network has
-- registered terminals (not just a direct site_hikcentral_terminals
-- row) -- otherwise a not-yet-enabled employee at a network-joined
-- site would have been misreported as a plain 'unconfigured' gap
-- instead of "already has coverage waiting, just needs activating".
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
      WHEN EXISTS (SELECT 1 FROM attendance_employee_eligible_terminals(v_tenant_id, m.employee_id) elig2 WHERE elig2.provenance = 'network_shared') THEN 'network_shared'
      WHEN EXISTS (SELECT 1 FROM attendance_employee_eligible_terminals(v_tenant_id, m.employee_id) elig3 WHERE elig3.provenance = 'site_shared') THEN 'site_shared'
      WHEN (
        EXISTS (
          SELECT 1 FROM site_hikcentral_terminals s
          WHERE s.tenant_id = v_tenant_id AND s.is_active
            AND s.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
        )
        OR EXISTS (
          SELECT 1 FROM hikcentral_site_network_membership snm
          JOIN hikcentral_terminal_network_members nm ON nm.tenant_id = v_tenant_id AND nm.is_active AND nm.network = snm.network
          WHERE snm.tenant_id = v_tenant_id AND snm.is_active
            AND snm.site = upper(btrim(regexp_replace(COALESCE(e.workstation, ''), '\s+', ' ', 'g')))
        )
      ) AND NOT m.fingerprint_attendance_enabled THEN 'fingerprint_not_enabled'
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
