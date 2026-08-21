-- ============================================================
-- MIGRATION: Employee read surfaces -- Design B2, PHASE A (additive only)
-- Date: 2026-08-21
-- ============================================================
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------
-- Accountant has `employees.view` (read-only) but NOT `security_personnel.view`,
-- yet today holds unrestricted direct SELECT on the `employees` BASE TABLE --
-- meaning an Accountant session can retrieve the 8 guard/security-only
-- columns via a raw REST call, even though no page's UI ever displays them
-- for that role. `employees_general` (20260817000005) already null-masks
-- those 8 columns for a caller without `security_personnel.view`, but it is
-- `security_invoker = true`, so it inherits whatever the base table already
-- allows -- it adds a column PROJECTION on top of an already-open door, it
-- does not close the door. Frontend-only fixes (routing pages through the
-- view) do not change what a direct REST call to `/rest/v1/employees` can
-- still retrieve.
--
-- THIS MIGRATION IS PHASE A OF AN EXPAND-CONTRACT ROLLOUT (Design B2):
-- purely additive, creates the two read surfaces below, and does NOT touch
-- `employees`' own base-table SELECT grants at all. Every existing raw
-- `employees` read (including every `select('*')`) keeps working completely
-- unchanged after this migration -- nothing can regress by applying this on
-- its own. The actual lockdown (REVOKE SELECT ON employees FROM
-- authenticated/PUBLIC + column-level re-GRANT) is Phase C, a SEPARATE,
-- LATER migration, applied only after the frontend cutover that accompanies
-- this migration has been deployed and verified on STAGING for every role.
-- Do not fold Phase C into this file, and do not apply it ad hoc against
-- any environment -- the whole point of expand-contract here is that a
-- stale/uncut-over frontend must never be able to hit a locked-down table.
--
-- TWO READ SURFACES (Design B2 -- chosen over a single all-columns
-- `employees_general` after local empirical testing showed the single-view
-- design requires duplicating the ENTIRE tenant/region/employees.view row
-- predicate inside the view, which is exactly the kind of duplicated logic
-- that produced a real bug in an earlier draft of this work -- see the
-- STAGING_VALIDATION_PLAN.md / this migration's own review history):
--
--   employees_general -- ALL 37 non-guard columns, `security_invoker = true`.
--   References ONLY columns every functional role/legacy account already has
--   base-table SELECT on today, so it needs NO predicate of its own -- it
--   inherits the real `employees` RLS automatically, with zero duplicated
--   security logic. This is the general-purpose employee read surface for
--   Payroll/Payments/Payslips/Salary-Advances/Reports/Terminal-Dues/the
--   Employees module's own general list.
--
--   employees_security -- a NARROW surface: the 12 identity/
--   operational columns Security.tsx's own `EmployeeRow` interface actually
--   reads (id, full_name, employee_number, position, status, phone,
--   region_id, company, workstation, next_of_kin_name, next_of_kin_phone,
--   created_at -- confirmed against Security.tsx's own interface comment,
--   "only the columns this file actually reads", not invented for this
--   migration), plus `is_deleted` (Security.tsx's own list query filters on
--   it -- `.eq('is_deleted', false)` -- exactly like every other soft-delete
--   read in this app; it is not part of the file's declared TS interface
--   because it is consumed only as a filter predicate, never rendered, but
--   the view must expose it or that filter breaks with "column does not
--   exist"), plus the 8 guard-sensitive columns. `security_invoker =
--   false` (definer-context) is REQUIRED here, not optional -- once Phase C
--   revokes base-table SELECT on the 8 guard columns from `authenticated`
--   entirely (column grants are role-blind: HR and Accountant are the SAME
--   Postgres role, `authenticated`), an invoker-context view referencing
--   those columns would fail for EVERY caller, including HR/Ops, who are
--   legitimately entitled to see them -- confirmed empirically: an
--   invoker-context view referencing an ungranted column returns
--   "permission denied for table employees" regardless of which CASE/WHERE
--   branch would actually execute, because Postgres checks column
--   privileges statically against every column the view's SQL text
--   references, not against the runtime-resolved branch. Definer-context
--   means the view runs with ITS OWNER's privileges for reading the base
--   table, decoupling "can this view read the column at all" from "what is
--   this specific caller granted on the base table" -- the view's own WHERE
--   clause (below) is what does the actual, correct, per-caller
--   authorization, using the same `has_permission()`/`region_allowed()`
--   helpers as every other policy in this schema.
--
-- LEGACY COMPATIBILITY -- NOT A NEW RULE, REUSING AN ALREADY-APPROVED ONE
-- -----------------------------------------------------------
-- `employees_general`'s own existing guard-column CASE-WHEN (20260817000005)
-- already reads:
--   is_super_admin() OR is_business_admin() OR current_user_role_level()
--     IS NOT NULL OR has_permission('security_personnel.view')
-- i.e. a legacy account (role_level 1-4, `current_user_role_level() IS NOT
-- NULL`) was ALREADY granted guard-column visibility in that prior,
-- reviewed migration -- consistent with this whole rollout's "legacy
-- accounts keep working exactly as they do today" guarantee (pre-rollout,
-- ANY authenticated tenant member could read every `employees` column,
-- guard fields included, with no restriction at all). This migration's
-- `employees_security` predicate reuses that EXACT same condition
-- (`current_user_role_level() IS NOT NULL OR has_permission
-- ('security_personnel.view')`) for its own authorization clause -- not a
-- new decision, the same one already made and applied in 20260817000005,
-- just now enforced as the sole/narrower gate for a dedicated view instead
-- of column-nulling inside a 45-column one. This is NOT ambiguous and is
-- not being invented here.
-- ============================================================

-- ============================================================
-- PART 1: employees_general -- all 37 non-guard columns
-- ============================================================
-- security_invoker = true: this view references ONLY columns that remain
-- fully granted to `authenticated` even after Phase C (see the base-table
-- column list Phase C's own migration will use), so it needs no predicate
-- of its own -- it evaluates the real `employees` RLS as the calling user,
-- automatically, with no duplicated tenant/region/permission logic to keep
-- in sync with the base table's own policy.
-- ============================================================

CREATE OR REPLACE VIEW employees_general AS
SELECT
  e.id, e.tenant_id, e.employee_number, e.full_name, e.gender, e.age, e.phone,
  e.position, e.department, e.basic_salary, e.status, e.email, e.hire_date,
  e.dob, e.national_id, e.address, e.qualification, e.contract_type,
  e.region_id, e.company, e.workstation, e.pay_point, e.account_number,
  e.uniform_deduction, e.next_of_kin_name, e.next_of_kin_relationship,
  e.next_of_kin_phone, e.next_of_kin_address, e.is_deleted, e.deleted_at,
  e.deleted_reason, e.deleted_by, e.assignment_type, e.resident_name,
  e.resident_contact, e.company_id, e.created_at
FROM employees e;

ALTER VIEW employees_general SET (security_invoker = true);

REVOKE ALL ON employees_general FROM PUBLIC;
REVOKE ALL ON employees_general FROM anon;
GRANT SELECT ON employees_general TO authenticated;

COMMENT ON VIEW employees_general IS
  'Non-sensitive employee read surface (37 columns, excludes the 8 guard/security fields). security_invoker=true: inherits the real employees table RLS directly, no duplicated predicate. General-purpose read path for Payroll/Payments/Payslips/Salary Advances/Reports/Terminal Dues/the Employees module''s own general list.';

-- ============================================================
-- PART 2: employees_security -- narrow Security Personnel surface
-- ============================================================
-- Column set is EXACTLY Security.tsx's own `EmployeeRow` interface (the
-- file's own comment: "only the columns this file actually reads") -- 12
-- identity/operational columns plus the 8 guard columns. Deliberately does
-- NOT include any HR/finance/private field (national_id, dob, address,
-- salary, next_of_kin_relationship/address, etc.) that Security.tsx never
-- reads -- narrower than employees_general on purpose, not a superset.
--
-- security_invoker = false (definer-context, the default -- no ALTER VIEW
-- needed) so this view keeps working for HR/Ops after Phase C revokes the
-- 8 guard columns from `authenticated` at the base-table level (see the
-- comment block above). security_barrier = true is added as well: this
-- view's own WHERE clause is the ONLY thing standing between a caller and
-- 8 sensitive columns, and PostgREST allows arbitrary caller-supplied
-- filters on any exposed column (e.g. ?shift=eq.Day) -- security_barrier
-- prevents the planner from pushing a caller-supplied filter/function
-- evaluation ahead of this view's own security-relevant WHERE clause,
-- which is exactly the class of leak this option exists to close. Verified
-- locally (see STAGING_VALIDATION_PLAN.md-style local test notes) that
-- enabling it does not change any of this view's query results, only
-- planner ordering.
-- ============================================================

CREATE OR REPLACE VIEW employees_security AS
SELECT
  e.id, e.full_name, e.employee_number, e.position, e.status, e.phone,
  e.region_id, e.company, e.workstation, e.next_of_kin_name,
  e.next_of_kin_phone, e.created_at, e.is_deleted,
  e.shift, e.supervisor, e.uniform_status, e.uniform_condition,
  e.shoes_status, e.license_status, e.license_expiry, e."guardId"
FROM employees e
WHERE
  is_current_user_active()
  AND (
    is_super_admin()
    OR (
      e.tenant_id = get_current_tenant_id()
      AND region_allowed(e.region_id)
      AND (current_user_role_level() IS NOT NULL OR has_permission('security_personnel.view'))
    )
  );

ALTER VIEW employees_security SET (security_invoker = false, security_barrier = true);

REVOKE ALL ON employees_security FROM PUBLIC;
REVOKE ALL ON employees_security FROM anon;
GRANT SELECT ON employees_security TO authenticated;

COMMENT ON VIEW employees_security IS
  'Sensitive Security Personnel read surface (12 identity/operational columns + is_deleted + the 8 guard-sensitive columns). security_invoker=false (definer-context) + security_barrier=true: this view is the sole gate for a caller without security_personnel.view -- it enforces its own explicit tenant/region/permission predicate rather than inheriting the base table''s RLS, so it keeps working once Phase C revokes direct base-table SELECT on the guard columns from `authenticated`. Legacy accounts (current_user_role_level() IS NOT NULL) are intentionally included in the authorization predicate -- reusing the exact same legacy-compatibility condition already approved for employees_general''s own guard-column CASE-WHEN in 20260817000005, not a new rule introduced here.';

-- ============================================================
-- MIGRATION SAFETY NOTES
-- ============================================================
--
-- RUN ONCE / RUN TWICE: idempotent -- CREATE OR REPLACE VIEW, REVOKE/GRANT
-- (idempotent by nature), COMMENT ON VIEW.
--
-- DEPENDENCIES: requires 20260817000000 (is_current_user_active,
-- is_super_admin, is_business_admin, get_current_tenant_id, region_allowed,
-- current_user_role_level, has_permission) and 20260817000005 (the prior
-- employees_general this migration replaces).
--
-- PHASE BOUNDARY (explicit, do not skip ahead): this migration makes
-- ZERO changes to `employees`' own base-table grants. `authenticated` still
-- has full, unrestricted table-wide SELECT on `employees` after this
-- migration, exactly as before it. Every existing raw `.from('employees')`
-- read anywhere in the app -- including every `select('*')` -- continues to
-- work completely unchanged. The column-level lockdown (REVOKE SELECT ON
-- employees FROM authenticated, PUBLIC; GRANT SELECT (<37 safe columns>) ON
-- employees TO authenticated) is Phase C, a separate, later migration, to be
-- applied ONLY after this migration's accompanying frontend cutover has been
-- deployed and verified against STAGING for every role (Admin, HR,
-- Accountant, Operations, legacy). Do not run Phase C ahead of that
-- verification.
--
-- BEHAVIOR CHANGE FOR EXISTING CALLERS: none from this migration alone.
-- `employees_general`'s column set is unchanged from 20260817000005 minus
-- the 8 guard columns (which that view already NULLed for non-privileged
-- callers -- removing them from the view's own SELECT list rather than
-- NULLing them is not a behavior change for any caller who was already
-- seeing NULL there). `employees_security` is a brand-new object; nothing
-- reads it yet until the accompanying frontend cutover ships.
--
-- PREFLIGHT: none needed -- both views are pure additions/replacements with
-- no base-table changes.
--
-- VERIFICATION SQL (run immediately after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'employees_general' ORDER BY ordinal_position;
--   -- expected: exactly 37 rows, none of the 8 guard column names present
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'employees_security' ORDER BY ordinal_position;
--   -- expected: exactly 21 rows (12 identity/operational + is_deleted + 8 guard)
--   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--     WHERE relname = 'employees';
--   -- expected: unchanged from before this migration (RLS enabled, not forced)
--   SELECT has_table_privilege('authenticated', 'employees', 'SELECT');
--   -- expected: true -- Phase A must NOT have restricted this yet
--   SELECT has_table_privilege('authenticated', 'employees_general', 'SELECT');
--   SELECT has_table_privilege('authenticated', 'employees_security', 'SELECT');
--   -- expected: both true
--   -- Functional check, as an Accountant session: SELECT * FROM
--   -- employees_security -- expected 0 rows (not an error). As an HR or
--   -- Operations session (security_personnel.view): SELECT * FROM
--   -- employees_security -- expected real, region-scoped guard values.
--
-- ROLLBACK SQL:
--   DROP VIEW IF EXISTS employees_security;
--   -- Restore 20260817000005's employees_general definition verbatim
--   -- (all 45 columns, guard columns CASE-WHEN-nulled) if reverting fully.
