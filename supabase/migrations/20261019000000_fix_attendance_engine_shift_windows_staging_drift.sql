-- ============================================================
-- HOTFIX: Stage C, Step 11H -- restore attendance_engine_shift_windows
-- to its intended two-column shape.
-- Date: 2026-10-19
-- ============================================================
--
-- ROOT CAUSE (confirmed by direct inspection of the STAGING project):
-- attendance_engine_shift_windows(date, text) had drifted back to its
-- ORIGINAL, pre-20261013000000 single-column definition --
-- `RETURNS TABLE(check_out_window_end timestamptz)` only -- even though
-- STAGING's own migration history records
-- 20261013000000_attendance_resolve_tenant_scope_and_coverage_window_fix.sql
-- (installed there, in two split steps, as
-- "attendance_resolve_fix_part1_new_window_fn" and
-- "..._part2_resolve_and_calculate") as already applied. Every version
-- of attendance_resolve_and_calculate since that migration -- including
-- this engagement's own Stage C Step 11 rewrite -- reads BOTH
-- `check_in_window_start` AND `check_out_window_end` from this
-- function's result. On STAGING specifically, the live function only
-- ever returned the latter, so any call through a genuinely mapped,
-- non-off/non-unassigned employee raised
-- "column w.check_in_window_start does not exist" -- exactly the error
-- surfaced by the real browser acceptance test.
--
-- This is a RUNTIME DRIFT ON STAGING, not a defect in the committed
-- migration chain: applying every migration file in this directory, in
-- order, to a clean database reproduces the correct two-column function
-- (verified locally). Step 11 did not introduce this bug -- it reused
-- an already-two-columns-shaped dependency unchanged; it only surfaced
-- now because this was the first real, post-Step-11 browser action that
-- actually reached a mapped employee's coverage-check code path on
-- STAGING.
--
-- THE FIX below is byte-identical, in substance, to
-- 20261013000000's own PART 1 -- it does not change shift windows,
-- lateness thresholds, terminal-coverage safety, or payroll protection
-- in any way; it only re-asserts the exact two-column shape every other
-- environment (including a from-scratch apply of this entire migration
-- chain) already has. A DROP is required first because Postgres cannot
-- change a function's RETURNS TABLE column set via CREATE OR REPLACE
-- alone.
-- ============================================================
DROP FUNCTION IF EXISTS attendance_engine_shift_windows(DATE, TEXT);

CREATE OR REPLACE FUNCTION attendance_engine_shift_windows(p_shift_date DATE, p_resolved_shift TEXT)
RETURNS TABLE (check_in_window_start TIMESTAMPTZ, check_out_window_end TIMESTAMPTZ)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      WHEN p_resolved_shift = 'day' THEN attendance_blantyre_to_utc(p_shift_date, '04:00')
      WHEN p_resolved_shift = 'night' THEN attendance_blantyre_to_utc(p_shift_date, '16:00')
    END,
    CASE
      WHEN p_resolved_shift = 'day' THEN attendance_blantyre_to_utc(p_shift_date, '20:00')
      WHEN p_resolved_shift = 'night' THEN attendance_blantyre_to_utc(p_shift_date + 1, '08:00')
    END;
$$;

REVOKE ALL ON FUNCTION attendance_engine_shift_windows(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION attendance_engine_shift_windows(DATE, TEXT) TO authenticated;
