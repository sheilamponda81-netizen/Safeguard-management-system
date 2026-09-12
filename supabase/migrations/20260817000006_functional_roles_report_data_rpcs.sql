-- ============================================================
-- MIGRATION: Report-specific data RPCs (correction round 2)
-- Date: 2026-08-20
-- ============================================================
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- Reports.tsx reads directly from `applicants` and `attendance` (client-
-- side SELECT, subject to their normal RLS). Accountant is granted FULL
-- Reports access (all categories, per the approved matrix) despite having
-- NEITHER recruitment.view NOR attendance.view -- the module-level
-- permissions that gate direct SELECT on those two tables. Simply adding
-- `OR has_permission('reports...')` to `applicants`/`attendance`'s own
-- base-table RLS was explicitly rejected: that would let Accountant issue
-- an ARBITRARY raw SELECT against those tables outside Reports.tsx too
-- (e.g. browse every applicant's full record, or the whole attendance
-- grid), which is a real over-grant the approved model does not intend.
--
-- Instead, two report-scoped SECURITY DEFINER RPCs gate access by the
-- REPORT permission instead of the MODULE permission, returning only the
-- specific columns Reports.tsx's own report tabs actually render (verified
-- against the current component -- see each RPC's own comment) -- narrower
-- than a full table SELECT even for a caller who WOULD pass the check.
-- Both remain region-scoped exactly like the base tables' own RLS.
--
-- REPORT TAB CLASSIFICATION (corrects the "everything but payroll is
-- operational" mistake from the first pass -- Recruitment does NOT belong
-- in the "operational" bucket Operations Manager already has via
-- reports.operational.view, since Operations Manager is explicitly denied
-- Recruitment everywhere else in the app):
--   payroll                                  -> reports.financial.*
--   recruitment                              -> reports.recruitment.*  (NEW)
--   employee, company, workstation,
--     attendance, department                 -> reports.operational.*
-- Target visibility, all achieved by this classification with NO change to
-- is_business_admin()'s existing "sees everything" bypass:
--   Admin:               all reports (via is_business_admin() bypass)
--   Accountant:           all reports (financial + recruitment + operational,
--                          all 3 explicitly seeded below)
--   Operations Manager:  operational only -- NOT payroll, NOT recruitment
--                          (no financial.* or recruitment.* rows seeded)
--   HR Manager:           Reports denied entirely (no NAV_PERMISSIONS
--                          entry for 'reports' -- unchanged from the first
--                          pass, still correct)
-- ============================================================

-- ============================================================
-- PART 1: new reports.recruitment.view / reports.recruitment.export
-- permission keys, seeded ONLY for accountant.
-- ============================================================

INSERT INTO role_permissions (role, permission) VALUES
  ('accountant', 'reports.recruitment.view'),
  ('accountant', 'reports.recruitment.export')
ON CONFLICT (role, permission) DO NOTHING;

-- ============================================================
-- PART 2: get_report_recruitment_data()
-- ============================================================
-- Returns exactly the 6 columns Reports.tsx's `Applicant` interface /
-- recruitment report table actually uses (id, name, position,
-- qualification, interview_status, application_date) -- verified against
-- the component, not a full `SELECT *`. Gated by reports.recruitment.view
-- (or legacy role_level 1/2 [Admin/Manager] -- the only legacy role_levels
-- with Reports access per App.tsx's rolePages route guard, confirmed
-- 2026-09-10 -- or business-admin/super-admin), region-scoped via
-- region_allowed(region_id) for the same non-business-admin callers every
-- other region-scoped policy in this rollout applies to. This does NOT
-- grant recruitment.view -- a caller authorized only via
-- reports.recruitment.view cannot use this function to reach any OTHER
-- applicant field (e.g. phone/email/cover_letter/decision), and cannot
-- write to `applicants` at all (this function is SELECT-only, no
-- corresponding write RPC).
--
-- RELEASE-BLOCKING FIX (2026-09-10, production preflight): the legacy
-- bypass below was originally `current_user_role_level() IS NOT NULL`,
-- which authorized EVERY legacy account (role_level 1-4), including
-- Supervisor (3) and Staff (4) -- neither of which has ever had Reports
-- access in the frontend (App.tsx's rolePages[3]/[4] omit "reports"; only
-- rolePages[1]/[2] include it, matched by Sidebar's own roleMenuItems).
-- A direct RPC/REST call from either account (bypassing the UI, which
-- never renders a reachable Reports nav item for them) could therefore
-- retrieve region-scoped recruitment report data despite having no
-- legitimate Reports visibility at all. Narrowed to
-- `current_user_role_level() <= 2` to match the real legacy rule exactly.
-- ============================================================

CREATE OR REPLACE FUNCTION get_report_recruitment_data()
RETURNS TABLE (
  id UUID,
  name TEXT,
  "position" TEXT,
  qualification TEXT,
  interview_status TEXT,
  application_date DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    is_super_admin()
    OR is_business_admin()
    OR COALESCE(current_user_role_level() <= 2, false)
    OR has_permission('reports.recruitment.view')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to view the recruitment report';
  END IF;

  RETURN QUERY
  SELECT a.id, a.name, a.position, a.qualification, a.interview_status, a.application_date
  FROM applicants a
  WHERE (a.tenant_id = v_tenant_id OR is_super_admin())
    AND (
      is_super_admin() OR is_business_admin()
      OR a.region_id IS NOT DISTINCT FROM current_user_region_id()
    )
  ORDER BY a.application_date DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION get_report_recruitment_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_report_recruitment_data() FROM anon;
GRANT EXECUTE ON FUNCTION get_report_recruitment_data() TO authenticated;

-- ============================================================
-- PART 3: get_report_attendance_summary(p_employee_ids, p_month)
-- ============================================================
-- Returns exactly the 2 columns (employee_id, status) Reports.tsx's
-- attendance-report aggregation reads, for a caller-supplied month and
-- employee-id list -- the SAME shape as the direct `.from('attendance')`
-- call it replaces. `p_employee_ids` is NOT trusted as an access grant by
-- itself: even though the frontend derives it from an already-region-
-- scoped `employees` fetch, this function independently re-checks
-- region_allowed() per row server-side, so a caller who tampered with the
-- array to include out-of-region employee ids simply gets no rows back for
-- those ids -- it cannot be used to fish for attendance data outside the
-- caller's own region. Gated by reports.operational.view (or legacy
-- role_level 1/2 [Admin/Manager] -- the only legacy role_levels with
-- Reports access, see PART 2's RELEASE-BLOCKING FIX note -- or
-- business-admin/super-admin) -- NOT attendance.view, so this does not
-- grant Accountant (or anyone else with only reports.operational.view) any
-- ability to browse the live Attendance module/grid.
-- ============================================================

CREATE OR REPLACE FUNCTION get_report_attendance_summary(
  p_employee_ids UUID[],
  p_month TEXT
)
RETURNS TABLE (
  employee_id UUID,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_month_start DATE;
  v_month_end DATE;
BEGIN
  v_tenant_id := get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    is_super_admin()
    OR is_business_admin()
    OR COALESCE(current_user_role_level() <= 2, false)
    OR has_permission('reports.operational.view')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to view the attendance report';
  END IF;

  IF p_month IS NULL OR p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Month must be in YYYY-MM format';
  END IF;

  v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 day')::date;

  RETURN QUERY
  SELECT att.employee_id, att.status
  FROM attendance att
  JOIN employees e ON e.id = att.employee_id
  WHERE att.tenant_id = v_tenant_id
    AND att.employee_id = ANY(p_employee_ids)
    AND att.date BETWEEN v_month_start AND v_month_end
    AND (
      is_super_admin() OR is_business_admin()
      OR region_allowed(e.region_id)
    );
END;
$$;

REVOKE ALL ON FUNCTION get_report_attendance_summary(UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_report_attendance_summary(UUID[], TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION get_report_attendance_summary(UUID[], TEXT) TO authenticated;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- ON CONFLICT DO NOTHING seed insert,
-- CREATE OR REPLACE FUNCTION, same REVOKE/GRANT pairs throughout.
--
-- DEPENDENCIES: requires 20260817000000 (has_permission, is_business_admin,
-- region_allowed, current_user_region_id, current_user_role_level) and the
-- `applicants`/`attendance`/`employees` tables. No dependency on
-- 20260817000005.
--
-- PREFLIGHT: none needed -- pure addition (new permission rows via ON
-- CONFLICT DO NOTHING, new functions).
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: none for any account that already
-- had recruitment.view/attendance.view (legacy accounts, HR Manager) --
-- they continue reading `applicants`/`attendance` directly through their
-- own existing RLS, unaffected by these new functions. The only NEW
-- capability is Accountant gaining read access to recruitment/attendance
-- report data it did not have before, exactly as the approved "Accountant:
-- all reports" requirement specifies. RELEASE-BLOCKING FIX (2026-09-10):
-- a legacy Supervisor (role_level 3) or Staff (role_level 4) account,
-- which never had a reachable Reports page (App.tsx's rolePages[3]/[4]
-- omit "reports"), can no longer call either RPC directly (previously
-- could, via the too-broad `current_user_role_level() IS NOT NULL`
-- bypass) -- no legitimate caller loses anything, since neither role_level
-- ever had a real Reports use case for these functions.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT role, permission FROM role_permissions WHERE permission LIKE 'reports.recruitment%';
--   -- expected: 2 rows, both role = 'accountant'
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--     ('get_report_recruitment_data','get_report_attendance_summary');
--   -- expected: 2 rows, both prosecdef = true
--   SELECT has_function_privilege('anon', 'get_report_recruitment_data()', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'get_report_attendance_summary(uuid[],text)', 'EXECUTE');
--   -- expected: both false
--   -- Functional check: as an Accountant session, call both RPCs -- confirm
--   -- rows returned only for the caller's own region (or full tenant if
--   -- somehow business admin). As an Operations Manager session, call
--   -- get_report_recruitment_data() -- confirm it RAISES (no
--   -- reports.recruitment.view), and get_report_attendance_summary()
--   -- succeeds (has reports.operational.view). As an HR Manager session,
--   -- confirm both RAISE (HR Manager never reaches Reports.tsx via nav
--   -- anyway, but the RPC itself should also independently refuse). As a
--   -- legacy Admin (role_level 1) or Manager (role_level 2) session,
--   -- confirm both RPCs succeed (region-scoped), unchanged from before
--   -- this fix. As a legacy Supervisor (role_level 3) or Staff
--   -- (role_level 4) session with no reports.* permission, confirm both
--   -- RPCs now RAISE (previously succeeded before this fix).
--
-- ROLLBACK SQL:
--   DELETE FROM role_permissions WHERE permission IN ('reports.recruitment.view', 'reports.recruitment.export');
--   DROP FUNCTION IF EXISTS get_report_recruitment_data();
--   DROP FUNCTION IF EXISTS get_report_attendance_summary(UUID[], TEXT);
-- ============================================================
