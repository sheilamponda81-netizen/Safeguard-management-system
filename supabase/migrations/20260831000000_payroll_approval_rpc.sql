-- ============================================================
-- MIGRATION: Atomic payroll approval RPC (production hotfix)
-- Date: 2026-08-31
-- ============================================================
--
-- PRODUCTION BUG: src/pages/Payroll.tsx's approvePayroll() builds
--   supabase.from('payroll').update(...).eq('month', selectedMonth)
--     .in('employee_id', payrollRecords.map(r => r.employee_id))
-- with hundreds of UUIDs in the URL for a full month's payroll run,
-- producing a PostgREST request URL large enough to be rejected with a
-- bare 400 Bad Request (same failure class already fixed for READS via
-- src/utils/employeeBatchFetch.ts; see that file's own header comment,
-- and commit 7599c97 which explicitly deferred fixing this exact write
-- pending "more careful handling" than batching -- naive multi-request
-- batching of a payroll approval risks leaving some employees approved
-- and others not if a later batch fails).
--
-- FIX (Design 2): the client still sends the exact set of payroll row ids
-- already loaded into `payrollRecords` on screen (the same snapshot the
-- old code built its now-oversized `.in('employee_id', ...)` URL from),
-- but as a `uuid[]` in the RPC's POST body instead of as URL query
-- params -- one HTTP request, one transaction, one UPDATE, no size limit
-- of any practical kind, and (unlike a design that re-resolves the whole
-- population server-side) no risk of the update's target set silently
-- drifting from what the admin actually saw on screen when they clicked
-- Approve. The array is never trusted as-is: this SECURITY DEFINER
-- function independently re-authorizes every supplied id against the
-- caller's own tenant/region before it can be touched.
--
-- payroll.id (this table's own PRIMARY KEY) is used, NOT employee_id --
-- payroll has no UNIQUE(employee_id, month) constraint (unlike
-- payment_status/employee_deductions, which do have one), so employee_id
-- is not guaranteed to identify exactly one row for a given month, while
-- payroll.id always does. Approval is fundamentally an operation on
-- payroll rows, not employees, so this is also the more semantically
-- direct identifier.
--
-- ATOMICITY (all-or-nothing, no partial approval ever committed): the
-- UPDATE's WHERE clause only ever matches ids that both exist for the
-- given month AND pass the caller's authorization -- an id that fails
-- either check is simply not touched by the UPDATE, it does not raise an
-- error on its own. That means a naive "return however many rows the
-- UPDATE actually changed" design can silently commit a SUBSET of the
-- requested approval (e.g. 497 of 500 supplied ids updated, 3 silently
-- dropped because they belonged to another region, or no longer existed)
-- -- exactly the partial-approval failure mode this whole hotfix exists
-- to avoid, just moved from "multiple requests, batch 2 fails" to "one
-- request, some rows silently excluded". To close this: the DISTINCT
-- count of supplied ids is computed BEFORE the UPDATE, and compared
-- against the UPDATE's actual ROW_COUNT immediately after it, still
-- inside this same function invocation/transaction. If they don't match,
-- the function RAISEs -- uncaught by any exception handler in this
-- function -- which aborts and rolls back the ENTIRE statement, including
-- the UPDATE that already ran earlier in this same function call. This
-- was verified empirically (not just reasoned about) against a real
-- Postgres 16 instance: a request naming 3 real ids + 1 nonexistent id
-- raises, and the 3 real rows are confirmed to remain completely
-- untouched afterward -- not "3 approved, 1 skipped". A client that
-- supplies duplicate ids for the same real row does NOT cause a false
-- mismatch, since the expected count is COUNT(DISTINCT ...), not the raw
-- array length -- also verified empirically. The SECURITY DEFINER
-- function does not rely on the client having already deduplicated
-- payrollIds for correctness; it always recomputes the distinct count
-- itself.
--
-- SCOPE FIDELITY -- confirmed against the current, unfixed client code
-- before writing this function, deliberately preserved exactly:
--   * The snapshot itself: the caller's payrollRecords, built by
--     fetchData() with employees.status = 'Active' AND
--     employees.is_deleted = false AND (region-scoped for a regular
--     Admin) -- this function does NOT re-check active/deleted status
--     itself. Today's direct PATCH never re-evaluated those either (they
--     were only ever applied once, at load time, to build the snapshot);
--     re-adding them here would be new business-state filtering this
--     hotfix was not asked to introduce, on top of a narrow production
--     fix. Authorization here is scoped to what a SECURITY DEFINER
--     function bypassing RLS actually needs to re-check for safety --
--     tenant/region -- not to second-guess which employees are "still
--     active" at click time. (If an employee WAS deactivated between
--     page load and click, the all-or-nothing behavior above now means
--     that no longer silently drops just that one row -- it aborts the
--     WHOLE approval and asks the admin to refresh, which is the correct,
--     safe outcome for a stale snapshot either way.)
--   * Tenant: a super admin's current approval is NOT restricted to
--     their own tenant -- payroll's RLS UPDATE policy is
--     `tenant_id = get_current_tenant_id() OR is_super_admin() = true`,
--     and Payroll.tsx's own queries add no client-side tenant filter of
--     their own. For a super admin this function trusts the supplied
--     snapshot id list directly (after month + role checks) with no
--     further per-row tenant/region filter -- it does NOT independently
--     rediscover every payroll row for the month across every tenant;
--     it only ever touches the ids the page actually loaded and sent.
--   * Region: a regular (non-super-admin) Admin's payrollRecords is
--     built from employees.region_id = their own profiles.region_id
--     (Payroll.tsx fetchData(), `if (!userProfile?.is_super_admin &&
--     userProfile?.region_id) employeesQuery.eq('region_id', ...)`). This
--     function re-derives that same predicate through the payroll row's
--     linked employee, so a tampered client cannot smuggle in another
--     region's (or tenant's) payroll id -- and thanks to the atomicity
--     fix above, cannot get a "partial" approval of just the ids that DO
--     belong to them either; the whole call fails.
--   * Tenant consistency check on the payroll row itself: for a regular
--     Admin, the WHERE clause below requires BOTH p.tenant_id =
--     v_tenant_id directly AND (through the joined employees row)
--     e.tenant_id = v_tenant_id. This is deliberate belt-and-braces, not
--     redundant -- confirmed by direct schema inspection
--     (20260727000000_reconstructed_base_schema.sql) and an exhaustive
--     grep across every migration for a trigger/CHECK/composite FK tying
--     the two together: payroll.tenant_id and employees.tenant_id are
--     each independent FKs to tenants(id), both DEFAULT
--     get_current_tenant_id() at insert time, but with no database-
--     enforced constraint requiring them to ever match for a given
--     employee_id. Since this function is SECURITY DEFINER and bypasses
--     payroll's RLS entirely, that gap cannot be treated as "effectively
--     enforced by application behavior" -- it must be re-checked
--     explicitly here. A super admin is unaffected: their branch below is
--     unchanged and still trusts the supplied snapshot ids directly (after
--     month + role checks), with no per-row tenant/region filter.
--   * approval_status: NOT filtered on either the read or the write
--     today -- clicking Approve/Reject unconditionally sets EVERY
--     supplied-and-authorized payroll row to the clicked status,
--     regardless of each row's current status (pending/approved/
--     rejected). This function does not add any approval_status
--     condition, to avoid silently changing that existing behavior.
--
-- AUTHORIZATION: current_user_role_level() = 1 OR is_super_admin(),
-- matching src/pages/Payroll.tsx's canApprovePayroll and the existing
-- payroll UPDATE RLS policy's WITH CHECK
-- (20260727000001_security_hardening.sql) exactly. This function is
-- SECURITY DEFINER (it must bypass RLS to run one UPDATE across
-- potentially many rows in a single statement instead of one per row),
-- so RLS provides no protection here at all -- every authorization check
-- RLS would normally provide is re-implemented explicitly below instead,
-- and p_payroll_ids is never trusted without that re-check.
-- ============================================================

DROP FUNCTION IF EXISTS public.approve_payroll_run(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]);

CREATE OR REPLACE FUNCTION public.approve_payroll_run(
  p_month TEXT,
  p_status TEXT,
  p_notes TEXT,
  p_payroll_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_tenant_id UUID;
  v_is_super BOOLEAN;
  v_role_level INTEGER;
  v_region_id UUID;
  v_requested_count INTEGER;
  v_updated_count INTEGER;
BEGIN
  -- Fail closed: no authenticated caller at all.
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Only the values the current UI actually sends -- 'pending' is a
  -- real approval_status value in the payroll CHECK constraint, but
  -- approvePayroll()'s own TypeScript signature is
  -- `status: 'approved' | 'rejected'` only; this function matches that,
  -- not the column's full value set.
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid approval status: %', p_status USING ERRCODE = '22023';
  END IF;

  IF p_payroll_ids IS NULL OR array_length(p_payroll_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No payroll record ids supplied' USING ERRCODE = '22023';
  END IF;

  -- Reject a null element explicitly (Postgres arrays can contain NULLs
  -- even for a UUID[] column type) -- `p.id = ANY(array_with_a_null)`
  -- would not error on its own, it would just never match that element,
  -- which the all-or-nothing count check below would also catch, but a
  -- dedicated check here fails faster with a clearer, specific message.
  IF EXISTS (SELECT 1 FROM unnest(p_payroll_ids) AS t(id) WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Payroll id list contains a null value' USING ERRCODE = '22023';
  END IF;

  v_tenant_id := public.get_current_tenant_id();
  v_is_super := COALESCE(public.is_super_admin(), false);
  v_role_level := public.current_user_role_level();

  -- Fail closed: caller has no resolvable profile at all (get_current_
  -- tenant_id()/current_user_role_level() both return NULL for a missing
  -- profiles row).
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No profile found for the authenticated caller' USING ERRCODE = '42501';
  END IF;

  -- Same rule as canApprovePayroll client-side and the existing payroll
  -- UPDATE RLS policy's WITH CHECK: only role_level = 1 (Admin) or a
  -- super admin may approve/reject payroll.
  IF NOT (v_is_super OR v_role_level = 1) THEN
    RAISE EXCEPTION 'Only managers and admins can approve payroll' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super THEN
    SELECT region_id INTO v_region_id
    FROM public.profiles
    WHERE id = v_caller_id;

    -- Fail closed: a regular (non-super-admin) Admin with no region on
    -- their own profile has no well-defined approval scope -- proceeding
    -- would either silently match zero rows (confusing: looks like
    -- "nothing to approve") or, if this check were skipped entirely,
    -- risk a mis-scoped match. Reject explicitly instead.
    IF v_region_id IS NULL THEN
      RAISE EXCEPTION 'Your account has no region assigned; payroll approval scope cannot be determined' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The DISTINCT count of supplied ids, computed independently of
  -- whatever deduplication the client may or may not have already done
  -- -- this function's correctness never depends on client behavior.
  SELECT COUNT(DISTINCT t.id)
  INTO v_requested_count
  FROM unnest(p_payroll_ids) AS t(id);

  -- One atomic UPDATE. p_month is an additional guard on top of the
  -- supplied ids (belt-and-braces: every id already implies its own
  -- month via the row itself, but this also protects against a stale id
  -- from a different month somehow ending up in the array). A super
  -- admin's ids are trusted directly once role/month match; a regular
  -- Admin's ids are additionally re-authorized both directly against the
  -- payroll row's own tenant_id and through the linked employee's
  -- tenant_id/region_id -- see the "Tenant consistency check on the
  -- payroll row itself" note above for why p.tenant_id = v_tenant_id is
  -- required explicitly rather than assumed from the employees join
  -- alone. Rows that fail any of these checks are simply not matched by
  -- this WHERE clause -- they do not raise an error on their own, which
  -- is exactly why the count comparison below is required for
  -- all-or-nothing correctness.
  UPDATE public.payroll p
  SET approval_status = p_status,
      approved_by = v_caller_id,
      approved_at = NOW(),
      approval_notes = p_notes,
      updated_at = NOW()
  WHERE p.id = ANY(p_payroll_ids)
    AND p.month = p_month
    AND (
      v_is_super
      OR (
        p.tenant_id = v_tenant_id
        AND EXISTS (
          SELECT 1
          FROM public.employees e
          WHERE e.id = p.employee_id
            AND e.tenant_id = p.tenant_id
            AND e.tenant_id = v_tenant_id
            AND e.region_id = v_region_id
        )
      )
    );

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- All-or-nothing: if even one supplied id didn't get updated (wrong
  -- month, doesn't exist, or failed the tenant/region re-check), abort
  -- the entire approval rather than silently committing the subset that
  -- did match. This RAISE is not caught by any exception handler in this
  -- function, so PostgreSQL rolls back the UPDATE above along with
  -- everything else in this statement -- verified empirically against a
  -- real Postgres instance before this migration was written: a request
  -- naming 3 valid ids and 1 invalid one raises here, and all 3 valid
  -- rows are confirmed to remain completely unmodified afterward.
  IF v_updated_count <> v_requested_count THEN
    RAISE EXCEPTION 'Payroll approval scope changed; refresh and retry' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_updated_count;
END;
$$;

-- SECURITY DEFINER functions are PUBLIC-executable by default in
-- Postgres; none of this project's existing SECURITY DEFINER functions
-- (get_current_tenant_id, is_super_admin, current_user_role_level,
-- prevent_profile_privilege_escalation) currently narrow this, so there
-- is no established narrower-than-default convention to follow here --
-- this function is deliberately locked down further than that baseline,
-- since it performs an authenticated-write action, not a read-only
-- context lookup.
REVOKE ALL ON FUNCTION public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(TEXT, TEXT, TEXT, UUID[]) TO authenticated;

-- ============================================================
-- END OF PAYROLL APPROVAL RPC MIGRATION
-- ============================================================
