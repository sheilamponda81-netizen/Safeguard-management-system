-- SAFEGUARD: preserve historic five-absence alerts while enforcing six
-- for every newly-created site absence alert.
--
-- Root cause (verified read-only in production on 2026-11-27):
-- The original 5-absence threshold created 73 alert rows with
-- absent_count_at_creation = 5 (latest created_at = 2026-11-24 UTC).
-- PR #78 raised the threshold to 6 using CHECK (...) NOT VALID.
-- PostgreSQL still checks that NOT VALID constraint on UPDATE of
-- grandfathered rows. attendance_check_site_absence_alert() closes or
-- reopens historical rows when subsequent attendance is processed, so
-- a legitimate UPDATE fails and rolls back the attendance batch.
--
-- Keep historical rows, count, created_at, and closed/open audit state
-- untouched. A fixed historical creation-time cutoff grants precisely
-- the already-existing 5-count alert cohort compatibility on UPDATE.
-- New alerts created after the cutoff still require >=6.
-- No attendance, employee, payroll, or fingerprint changes.
--
-- Precondition: every pre-existing count below 6 must be a historical
-- 5-count alert created before 2026-11-25 UTC. Fail closed if not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.attendance_site_absence_alerts
    WHERE absent_count_at_creation < 6
      AND NOT (
        absent_count_at_creation = 5
        AND created_at < TIMESTAMPTZ '2026-11-25 00:00:00+00'
      )
  ) THEN
    RAISE EXCEPTION
      'Unexpected site-alert rows below new threshold; refusing constraint migration';
  END IF;
END $$;

ALTER TABLE public.attendance_site_absence_alerts
  DROP CONSTRAINT attendance_site_absence_alerts_absent_count_at_creation_check;

ALTER TABLE public.attendance_site_absence_alerts
  ADD CONSTRAINT attendance_site_absence_alerts_absent_count_at_creation_check
  CHECK (
    absent_count_at_creation >= 6
    OR (
      absent_count_at_creation = 5
      AND created_at < TIMESTAMPTZ '2026-11-25 00:00:00+00'
    )
  ) NOT VALID;

-- Validate all existing alerts; the migration fails atomically if any
-- existing row violates the replacement constraint.
ALTER TABLE public.attendance_site_absence_alerts
  VALIDATE CONSTRAINT attendance_site_absence_alerts_absent_count_at_creation_check;
