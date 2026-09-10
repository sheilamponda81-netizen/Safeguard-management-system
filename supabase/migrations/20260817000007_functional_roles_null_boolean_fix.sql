-- ============================================================
-- MIGRATION: Fix is_business_admin() NULL-propagation (found via local SQL validation)
-- Date: 2026-08-20
-- SECURITY-RECONCILED (2026-09-08, production preflight): this file's own
-- CREATE OR REPLACE FUNCTION is_business_admin() runs AFTER
-- 20260817000000's, so it is the version that actually ends up live --
-- silently dropping 20260817000000's explicit
-- `IF NOT is_current_user_active() THEN RETURN false; END IF;` fail-closed
-- guard if this file were left unchanged. Confirmed NOT an active
-- security bypass either way (current_user_role()/current_user_role_level()
-- are themselves gated, and COALESCE(..., false) below already reduces
-- their NULL result to a real `false` for an inactive caller -- verified
-- empirically), but the explicit guard is restored here too so this
-- function is self-evidently fail-closed on its own, consistent with
-- is_current_user_active()/region_allowed()/has_permission() elsewhere,
-- rather than depending on a reader tracing through two other functions'
-- NULL-propagation to confirm safety.
-- ============================================================
--
-- WHAT WAS FOUND
-- -----------------------------------------------------------
-- is_business_admin() (20260817000000) is:
--   RETURN current_user_role() = 'admin' OR current_user_role_level() = 1;
-- For any caller whose role_level is NULL (every new functional-role
-- account, by design) and whose role is not exactly 'admin', this
-- evaluates as `false OR (NULL = 1)` = `false OR NULL` = NULL in
-- Postgres's three-valued logic -- NOT `false`, even though the function
-- is declared RETURNS BOOLEAN and every caller treats it as a clean
-- true/false. Confirmed empirically during local SQL validation: an
-- Accountant session (role_level = NULL) calling
-- `region_allowed('some-other-region')` returned NULL instead of the
-- expected `false`.
--
-- IMPACT ASSESSMENT (CORRECTED 2026-09-10, production preflight -- the
-- original assessment below was WRONG for one call-site shape and is kept
-- struck through for the record, not because it is still believed true):
-- ~~NOT a security bypass. Every call site either wraps this in `... =
-- true` ... or as a plpgsql `IF` condition -- Postgres treats NULL as NOT
-- true in both a WHERE/USING clause and a plpgsql IF statement (same
-- practical effect as false ...). No account has ever been incorrectly
-- authorized by this.~~
--
-- That is correct for a positive `IF is_business_admin() THEN ...` guard
-- and for `... = true` in a WHERE/USING clause (NULL behaves like false
-- in both). It is FALSE for the negative rejection-gate shape used
-- throughout this schema's SECURITY DEFINER functions and triggers:
--   IF NOT (is_super_admin() OR is_business_admin() OR ...) THEN
--     RAISE EXCEPTION ...
--   END IF;
-- When is_business_admin() returns NULL and every other disjunct is
-- false, the whole `(... OR NULL OR ...)` expression is NULL, not false --
-- and PL/pgSQL treats a NULL `IF` condition exactly like false, so
-- `IF NOT (NULL)` = `IF NULL` silently SKIPS the RAISE EXCEPTION instead
-- of rejecting the caller. A 2026-09-10 audit confirmed this is a REAL,
-- currently-live bypass in already-applied migrations, not a theoretical
-- one: guard_employee_region_reassignment() (20260817000001) lets a
-- functional-role caller reassign an employee's region without being an
-- Admin; process_payroll_batch(), create_salary_advance(),
-- approve_salary_advance(), and adjust_combined_repayment_plan()
-- (20260817000003) each skip their region-boundary check entirely for a
-- functional-role caller who otherwise passed their top-level
-- authorization gate; get_applicant_dashboard_counts() (20260817000003)
-- returns real region-scoped recruitment counts instead of the intended
-- 0/0/0 refusal for a functional-role caller without recruitment.view.
-- This fix closes all of those, for every current and future caller of
-- is_business_admin(), by guaranteeing it can never return anything but a
-- real true/false.
-- ============================================================

CREATE OR REPLACE FUNCTION is_business_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_current_user_active() THEN
    RETURN false;
  END IF;
  RETURN COALESCE(current_user_role() = 'admin', false) OR COALESCE(current_user_role_level() = 1, false);
END;
$$;

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE FUNCTION, same
-- signature, no grants change (REVOKE/GRANT from 20260817000000 already
-- cover this function and are untouched).
--
-- DEPENDENCIES: requires 20260817000000 (defines current_user_role()/
-- current_user_role_level(), and the original is_business_admin() this
-- replaces).
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS (CORRECTED 2026-09-10): real and
-- security-relevant for the negative rejection-gate call sites named in
-- the IMPACT ASSESSMENT above -- each of those functions/triggers now
-- correctly REJECTS or REGION-RESTRICTS a functional-role caller it was
-- previously letting through unchecked when is_business_admin() returned
-- NULL. No change for any legacy account (role_level is never NULL, so
-- is_business_admin() never returned NULL for them) and no change for any
-- caller for whom another disjunct in the same OR-chain was already true
-- (e.g. is_super_admin(), or a caller who legitimately holds the relevant
-- has_permission() grant). For every other call site (RLS USING/WITH
-- CHECK clauses, and positive `IF is_business_admin() THEN` guards), this
-- purely makes the function's own return value match its declared
-- BOOLEAN type honestly, with no behavior change, as originally stated.
--
-- VERIFICATION SQL (run immediately after applying, as a non-admin
-- functional-role session, e.g. an Accountant with role_level = NULL):
--   SELECT is_business_admin();
--   -- expected: false (not NULL)
--   SELECT region_allowed('<some-region-not-the-callers-own>');
--   -- expected: false (not NULL)
--
-- ROLLBACK SQL (restores the pre-fix body -- NOT recommended, reintroduces
-- the NULL-propagation gap):
--   CREATE OR REPLACE FUNCTION is_business_admin() RETURNS BOOLEAN
--   LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
--   BEGIN
--     RETURN current_user_role() = 'admin' OR current_user_role_level() = 1;
--   END;
--   $$;
-- ============================================================
