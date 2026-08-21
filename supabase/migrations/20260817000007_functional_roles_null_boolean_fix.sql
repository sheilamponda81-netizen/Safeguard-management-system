-- ============================================================
-- MIGRATION: Fix is_business_admin() NULL-propagation (found via local SQL validation)
-- Date: 2026-08-20
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
-- IMPACT ASSESSMENT: NOT a security bypass. Every call site either wraps
-- this in `... = true` (used throughout the RLS policies in this
-- rollout) or as a plpgsql `IF` condition -- Postgres treats NULL as NOT
-- true in both a WHERE/USING clause and a plpgsql IF statement (same
-- practical effect as false: the row is excluded / the branch is
-- skipped). No account has ever been incorrectly authorized by this. It
-- is, however, a real correctness/robustness gap: a boolean-typed
-- function that can silently return NULL contradicts the NULL-safety
-- discipline this whole rollout otherwise follows (e.g. region_allowed()
-- deliberately using IS NOT DISTINCT FROM to avoid exactly this class of
-- footgun), and would bite any FUTURE caller that compares the result
-- directly (e.g. `is_business_admin() = false`, which does NOT match
-- NULL) instead of wrapping it in `= true` or an IF.
-- ============================================================

CREATE OR REPLACE FUNCTION is_business_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: none observable -- every existing
-- call site already treats NULL and false identically (see IMPACT
-- ASSESSMENT above). This purely makes the function's own return value
-- match its declared BOOLEAN type honestly.
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
