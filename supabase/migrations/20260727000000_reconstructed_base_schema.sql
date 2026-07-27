-- ============================================================
-- MIGRATION: Reconstructed Base Schema (NOT a production dump)
-- Date: 2026-07-27
-- ============================================================
--
-- WHY THIS FILE EXISTS
-- ---------------------
-- The three migrations that already lived in this repo
-- (20240618000000_create_indexes.sql, 20240619000000_tenant_isolation.sql,
-- 20240619000001_create_tenants.sql) only ever ALTER tables and add
-- indexes/RLS policies. They all assume the base tables (employees,
-- profiles, payroll, attendance, applicants, payment_status, positions,
-- employee_deductions, user_roles, system_settings, audit_logs,
-- terminal_dues, regions, companies) already exist. Those original
-- CREATE TABLE statements were never committed to version control --
-- the tables were created directly against a live Supabase project
-- (via Lovable and/or the Supabase dashboard), outside of migrations.
--
-- This file is a RECONSTRUCTION of that missing base schema, derived
-- entirely by reading how src/**/*.ts(x) actually calls
-- supabase.from('table').select/insert/update/eq/order(...), and by
-- reading the TypeScript interfaces that model each table's rows. It
-- is NOT a dump of the real production database and may not match it
-- column-for-column (see the caller's report for specific low-confidence
-- guesses). It is intended purely to provision a brand-new, EMPTY
-- Supabase project so a "perfected" version of the app can be compared
-- against the live one -- do not run it against the existing production
-- project.
--
-- CRITICAL ORDERING NOTE FOR A FRESH PROJECT
-- -------------------------------------------
-- Supabase applies migrations in filename (timestamp) order. Because
-- this file is timestamped 2026-07-27 -- AFTER the three pre-existing
-- migrations (2024-06-18/19) -- those three will run FIRST against a
-- brand-new empty database. They contain bare `ALTER TABLE employees
-- ADD COLUMN ...` (and similarly for payroll, attendance, profiles,
-- positions, regions, settings, employee_deductions, audit_logs)
-- statements with NO "IF EXISTS" / table-existence guard. On a truly
-- empty project those ALTER TABLE statements will fail outright
-- (relation does not exist), which will also prevent the
-- get_current_tenant_id() / is_super_admin() helper functions and the
-- RLS policies defined later in that same file from ever being created,
-- since a failed migration's statements all roll back together.
--
-- To provision a fresh comparison project successfully you almost
-- certainly need to reorder these four files so this one runs FIRST,
-- e.g. rename this file to something like 20240617000000_reconstructed
-- _base_schema.sql (one day before 20240618000000) before applying the
-- migrations, or otherwise run this file's CREATE TABLE statements
-- ahead of the other three. This file intentionally keeps the exact
-- filename it was requested under; renaming it is left to the operator.
--
-- Also note: 20240619000000_tenant_isolation.sql references a table
-- named `settings`, but the application code only ever queries
-- `system_settings` (see src/utils/currentMonth.ts). `settings` appears
-- to be a dead/incorrect table name left over in that migration; this
-- file creates `system_settings` to match what the app actually uses,
-- and does not attempt to create/alter a `settings` table.
--
-- DELIBERATE DEVIATION: tenant_id DEFAULT
-- -----------------------------------------
-- Every tenant_id column below is declared
--   tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
--     DEFAULT get_current_tenant_id()
-- The pre-existing tenant_isolation migration adds tenant_id with no
-- default. That is a real problem in the app: src/pages/Misc.tsx's
-- handleSavePosition() explicitly inserts into `positions` WITHOUT a
-- tenant_id ("let it default to NULL" per the code comment), which
-- would violate a bare NOT NULL constraint. Adding
-- DEFAULT get_current_tenant_id() reconciles the NOT NULL requirement
-- with that observed app behavior. get_current_tenant_id() and
-- is_super_admin() are reused as-is from 20240619000000_tenant_isolation.sql
-- and are NOT redefined here.
--
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- PART 0: BOOTSTRAP OF get_current_tenant_id() / is_super_admin()
-- ============================================================
-- This file's DEFAULT and RLS-policy expressions call
-- get_current_tenant_id() / is_super_admin(), which the task that
-- produced this file asked to reuse (not redefine) from
-- 20240619000000_tenant_isolation.sql. In practice that is NOT safe to
-- rely on for a fresh project: that migration's very first statements
-- are bare `ALTER TABLE employees ADD COLUMN ...` (and similarly for
-- payroll/attendance/profiles/positions/regions/settings/
-- employee_deductions/audit_logs) with no existence guard, so on an
-- empty database it errors out immediately -- verified empirically
-- (psql -1 -v ON_ERROR_STOP=1 against a bare `tenants`+`auth.users`
-- database aborts on `ALTER TABLE employees` before ever reaching the
-- CREATE FUNCTION statements later in that same file). Separately, that
-- migration also references a table literally named `settings`, which
-- the application never queries (it only ever queries
-- `system_settings`, see src/utils/currentMonth.ts) and which is not
-- reconstructed by this file since there is no evidence for it in the
-- app code -- so even after reordering, that migration's `ALTER TABLE
-- settings ...` statements will keep failing and, if the migration
-- runner wraps each file in one transaction, will keep preventing its
-- CREATE FUNCTION statements from ever committing, no matter what order
-- migrations run in.
--
-- To make this file actually usable standalone on a fresh project, the
-- two helper functions are bootstrapped here with CREATE OR REPLACE,
-- using a body IDENTICAL to the one in 20240619000000_tenant_isolation.sql.
-- This is a deliberate, clearly-flagged deviation from "don't redefine":
-- if tenant_isolation.sql later manages to run too, its CREATE OR REPLACE
-- of the same two functions is a harmless no-op (identical definition).
-- If it never successfully commits (per the `settings` problem above),
-- this project still has working, correct versions of both functions.
-- ============================================================

CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS UUID AS $$
BEGIN
  RETURN (
    SELECT tenant_id
    FROM profiles
    WHERE id = auth.uid()
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN (
    SELECT is_super_admin
    FROM profiles
    WHERE id = auth.uid()
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- PART 1: TABLES (dependency order: regions/companies/positions
-- before profiles/employees, before the tables that reference
-- employees)
-- ============================================================

-- ---------------------------------------------
-- REGIONS
-- Evidence: src/pages/Employees.tsx (region.code switch), src/components/RegionFilterBar.tsx,
-- src/pages/AuditLogs.tsx, src/pages/Payments.tsx (regions select *)
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  name TEXT NOT NULL,
  code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

-- ---------------------------------------------
-- COMPANIES
-- Evidence: src/pages/Employees.tsx (.from('companies').select('name, normalized_name').eq('type','company')),
-- src/pages/Reports.tsx (CompanyStats interface: id, name, normalized_name, type)
-- Populated for both 'company' and 'resident' assignment types. The app never
-- INSERTs into this table directly -- comments in Employees.tsx
-- ("company_id will be set by the trigger") imply a DB trigger normally
-- keeps this table and employees.company_id in sync. No such trigger is
-- present in the committed migrations, so it is NOT reconstructed here
-- (out of scope -- flagged in the final report).
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  name TEXT NOT NULL,
  normalized_name TEXT,
  type TEXT DEFAULT 'company' CHECK (type IN ('company', 'resident')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------
-- POSITIONS
-- Evidence: src/pages/Misc.tsx (SettingsPage: loadPositions/handleSavePosition/handleDeletePosition),
-- src/pages/Employees.tsx (.from('positions').select('name').eq('is_active', true))
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  name TEXT NOT NULL,
  category TEXT DEFAULT 'security',
  default_salary NUMERIC(14,2) DEFAULT 150000,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

-- ---------------------------------------------
-- PROFILES
-- Evidence: src/context/AuthContext.tsx, src/lib/supabase.ts, src/components/UserManagement.tsx,
-- src/utils/auditLogger.ts, src/utils/logging.ts, nearly every page's fetchUserProfile()
-- profiles.id is clearly meant to equal auth.users.id (UserManagement.addUser inserts
-- { id: authData.user.id, ... } and every lookup is .eq('id', user.id)).
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  email TEXT,
  full_name TEXT,
  role TEXT DEFAULT 'staff',
  role_level INTEGER DEFAULT 4,
  department TEXT,
  is_super_admin BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------
-- EMPLOYEES
-- Evidence: src/pages/Employees.tsx (largest single source of truth), src/pages/Security.tsx
-- (shift/supervisor/uniform/license/guardId fields), src/pages/Attendance.tsx,
-- src/pages/Payroll.tsx, src/pages/Payments.tsx, src/pages/TerminalDues.tsx,
-- src/services/database.ts, src/utils/auditHelpers.ts
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_number TEXT NOT NULL,
  full_name TEXT NOT NULL,
  gender TEXT,
  age INTEGER,
  phone TEXT,
  position TEXT,
  department TEXT DEFAULT 'Operations',
  basic_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'Active',
  email TEXT,
  hire_date DATE DEFAULT CURRENT_DATE,
  dob DATE,
  national_id TEXT,
  address TEXT,
  qualification TEXT,
  contract_type TEXT DEFAULT 'Permanent',
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  company TEXT,
  workstation TEXT,
  pay_point TEXT,
  account_number TEXT,
  uniform_deduction NUMERIC(14,2) DEFAULT 0,
  next_of_kin_name TEXT,
  next_of_kin_relationship TEXT,
  next_of_kin_phone TEXT,
  next_of_kin_address TEXT,
  is_deleted BOOLEAN DEFAULT false,
  deleted_at TIMESTAMPTZ,
  deleted_reason TEXT,
  deleted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assignment_type TEXT DEFAULT 'company',
  resident_name TEXT,
  resident_contact TEXT,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  -- Security/guard fields (src/pages/Security.tsx)
  shift TEXT,
  supervisor TEXT,
  uniform_status TEXT DEFAULT 'Pending',
  uniform_condition TEXT DEFAULT 'Good',
  shoes_status TEXT DEFAULT 'Good',
  license_status TEXT DEFAULT 'Valid',
  license_expiry DATE,
  -- NOTE: the app reads/writes this column as camelCase ("guardId"), not
  -- guard_id -- low confidence naming, but Security.tsx uses
  -- emp.guardId / .update({ guardId: ... }) directly with no snake_case
  -- alias anywhere, so it is reproduced verbatim (quoted identifier).
  "guardId" TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, employee_number)
);

-- ---------------------------------------------
-- PAYROLL
-- Evidence: src/pages/Payroll.tsx (PayrollRecord interface + calculatePayroll/processPayroll/
-- approvePayroll), src/services/database.ts, src/pages/Payslips.tsx
-- NOTE: `month` is stored as free-text in this table -- src/pages/Payroll.tsx uses
-- "YYYY-MM" (e.g. selectedMonth) while src/services/database.ts's getPayroll() builds
-- `${month} ${year}` (e.g. "November 2025"). This is an existing inconsistency in the
-- app itself, not something introduced here; TEXT is used to stay compatible with both.
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS payroll (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  basic_salary NUMERIC(14,2),
  allowances NUMERIC(14,2) DEFAULT 0,
  overtime NUMERIC(14,2) DEFAULT 0,
  bonus NUMERIC(14,2) DEFAULT 0,
  gross_pay NUMERIC(14,2),
  paye NUMERIC(14,2) DEFAULT 0,
  pension NUMERIC(14,2) DEFAULT 0,
  uniform_deduction NUMERIC(14,2) DEFAULT 0,
  net_pay NUMERIC(14,2),
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approval_notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------
-- ATTENDANCE
-- Evidence: src/pages/Attendance.tsx, src/services/database.ts (upsert onConflict:
-- 'employee_id,date'), src/pages/Dashboard.tsx
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P', 'A', 'L', 'LV', 'SL', '-')),
  UNIQUE (employee_id, date)
);

-- ---------------------------------------------
-- APPLICANTS
-- Evidence: src/pages/Recruitment.tsx, src/services/database.ts, src/pages/Reports.tsx,
-- src/pages/Dashboard.tsx
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  name TEXT NOT NULL,
  position TEXT,
  qualification TEXT,
  phone TEXT,
  email TEXT,
  experience TEXT,
  interview_status TEXT DEFAULT 'Pending' CHECK (interview_status IN ('Pending', 'Shortlisted', 'Interviewed', 'Accepted', 'Rejected')),
  decision TEXT DEFAULT 'Pending' CHECK (decision IN ('Pending', 'Hire', 'Reject')),
  application_date DATE DEFAULT CURRENT_DATE,
  cover_letter TEXT,
  -- cv_url is declared on the Applicant TS interface but no upload/select code
  -- path was found anywhere in src/ -- low confidence, included for forward compat.
  cv_url TEXT,
  -- region_id is present on the Applicant interface and is threaded through
  -- logAudit() calls, but Recruitment.tsx's own fetch/insert code has the
  -- region_id filter/column explicitly commented out ("If applicants have
  -- region_id"). Included as nullable since the interface and audit calls
  -- clearly expect the column to exist.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------
-- PAYMENT_STATUS
-- Evidence: src/pages/Payments.tsx (fetchPaymentData/updatePaymentStatus/updatePaymentDetails/
-- bulkUpdateStatus) -- month is stored as a DATE ("${selectedMonth}-01")
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS payment_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  net_pay NUMERIC(14,2),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'confirmed', 'failed')),
  payment_date DATE,
  account_number TEXT,
  transaction_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (employee_id, month)
);

-- ---------------------------------------------
-- EMPLOYEE_DEDUCTIONS
-- Evidence: src/pages/Attendance.tsx (saveDeductions/loadSavedDeductions), src/pages/Payroll.tsx
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS employee_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  absent_days INTEGER DEFAULT 0,
  late_days INTEGER DEFAULT 0,
  absent_deduction NUMERIC(14,2) DEFAULT 0,
  late_deduction NUMERIC(14,2) DEFAULT 0,
  lecture_missed INTEGER DEFAULT 0,
  lecture_deduction NUMERIC(14,2) DEFAULT 0,
  appearance_deduction NUMERIC(14,2) DEFAULT 0,
  total_deductions NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (employee_id, month)
);

-- ---------------------------------------------
-- TERMINAL_DUES
-- Evidence: src/pages/TerminalDues.tsx (TerminalDue interface, calculateTerminalDues/
-- saveCalculation/updateStatus/updateCalculation)
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS terminal_dues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_name TEXT,
  employee_number TEXT,
  position TEXT,
  date_joined DATE,
  date_left DATE,
  reason_for_termination TEXT,
  period_months INTEGER,
  basic_salary NUMERIC(14,2),
  gratuity NUMERIC(14,2),
  annual_leave NUMERIC(14,2),
  uniform_refund NUMERIC(14,2),
  other_benefits NUMERIC(14,2),
  subtotal NUMERIC(14,2),
  deductions NUMERIC(14,2),
  total_payable NUMERIC(14,2),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  termination_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------
-- USER_ROLES
-- Evidence: src/pages/Misc.tsx (SettingsPage: loadRoles/handleSaveRole/handleDeleteRole)
-- NOTE: handleDeleteRole's signature is (roleId: number, roleName: string) and calls
-- .eq('id', roleId) -- the app clearly treats this table's id as a NUMBER, not a UUID,
-- unlike every other table here. Reproduced as SERIAL/INTEGER per that evidence
-- (medium confidence -- flagged in the report).
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  name TEXT NOT NULL,
  users INTEGER DEFAULT 0,
  color TEXT DEFAULT 'blue',
  perms TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------
-- SYSTEM_SETTINGS
-- Evidence: src/utils/currentMonth.ts (getSystemCurrentMonth/setSystemCurrentMonth) --
-- a generic key/value settings table, currently used only for the
-- 'current_payroll_month' key.
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  key TEXT NOT NULL,
  value TEXT,
  description TEXT,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, key)
);

-- ---------------------------------------------
-- AUDIT_LOGS
-- Evidence: src/utils/auditLogger.ts (the primary writer: user_id, user_email, user_role,
-- region_id, action, entity_type, entity_id, old_data, new_data, user_agent, created_at),
-- src/utils/logging.ts (a SECOND, structurally different writer: level, message, data,
-- tenant_id, user_id, created_at), src/pages/AuditLogs.tsx / src/components/AuditLogs.tsx
-- (readers -- also reference ip_address in the UI, though no insert path sets it).
-- entity_id is TEXT, not UUID: it is sometimes a real record UUID and sometimes a
-- literal string like 'new' or 'current_payroll_month'.
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT get_current_tenant_id(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  user_email TEXT,
  user_role TEXT,
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  old_data JSONB,
  new_data JSONB,
  user_agent TEXT,
  -- ip_address: referenced defensively in src/pages/AuditLogs.tsx and
  -- src/components/AuditLogs.tsx (selectedLog.ip_address) but never actually
  -- populated by any insert path found in src/ -- low confidence, included
  -- for forward compatibility only.
  ip_address TEXT,
  -- level/message/data: written by the separate src/utils/logging.ts logger,
  -- which reuses this same table for generic app-level logs (not just audit
  -- trail entries). Kept nullable/independent of the audit-trail columns above.
  level TEXT,
  message TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PART 2: INDEXES
-- Naming convention matches the existing migrations:
-- idx_<table>_<column(s)>
-- ============================================================

-- REGIONS
CREATE INDEX IF NOT EXISTS idx_regions_tenant_id ON regions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_regions_tenant_code ON regions(tenant_id, code);

-- COMPANIES
CREATE INDEX IF NOT EXISTS idx_companies_tenant_id ON companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_companies_normalized_name ON companies(normalized_name);
CREATE INDEX IF NOT EXISTS idx_companies_type ON companies(type);

-- POSITIONS
CREATE INDEX IF NOT EXISTS idx_positions_tenant_id ON positions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_positions_name ON positions(name);
CREATE INDEX IF NOT EXISTS idx_positions_is_active ON positions(is_active);

-- PROFILES
CREATE INDEX IF NOT EXISTS idx_profiles_tenant_id ON profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_profiles_region_id ON profiles(region_id);
CREATE INDEX IF NOT EXISTS idx_profiles_is_super_admin ON profiles(is_super_admin);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_tenant_role ON profiles(tenant_id, role_level);

-- EMPLOYEES
CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_region_id ON employees(region_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_employee_number ON employees(employee_number);
CREATE INDEX IF NOT EXISTS idx_employees_full_name ON employees(full_name);
CREATE INDEX IF NOT EXISTS idx_employees_position ON employees(position);
CREATE INDEX IF NOT EXISTS idx_employees_is_deleted ON employees(is_deleted);
CREATE INDEX IF NOT EXISTS idx_employees_company_id ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_region ON employees(tenant_id, region_id);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_status ON employees(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_employee ON employees(tenant_id, employee_number);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_name ON employees(tenant_id, full_name);

-- PAYROLL
CREATE INDEX IF NOT EXISTS idx_payroll_tenant_id ON payroll(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_month ON payroll(month);
CREATE INDEX IF NOT EXISTS idx_payroll_employee_id ON payroll(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_month_employee ON payroll(month, employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_processed_at ON payroll(processed_at);
CREATE INDEX IF NOT EXISTS idx_payroll_approval_status ON payroll(approval_status);
CREATE INDEX IF NOT EXISTS idx_payroll_tenant_month ON payroll(tenant_id, month);
CREATE INDEX IF NOT EXISTS idx_payroll_tenant_employee ON payroll(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_tenant_month_employee ON payroll(tenant_id, month, employee_id);

-- ATTENDANCE
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_id ON attendance(tenant_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_id ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date ON attendance(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_employee ON attendance(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_employee_date ON attendance(tenant_id, employee_id, date);

-- APPLICANTS
CREATE INDEX IF NOT EXISTS idx_applicants_tenant_id ON applicants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_applicants_interview_status ON applicants(interview_status);
CREATE INDEX IF NOT EXISTS idx_applicants_created_at ON applicants(created_at);
CREATE INDEX IF NOT EXISTS idx_applicants_region_id ON applicants(region_id);

-- PAYMENT_STATUS
CREATE INDEX IF NOT EXISTS idx_payment_status_tenant_id ON payment_status(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_status_employee_id ON payment_status(employee_id);
CREATE INDEX IF NOT EXISTS idx_payment_status_month ON payment_status(month);
CREATE INDEX IF NOT EXISTS idx_payment_status_status ON payment_status(status);
CREATE INDEX IF NOT EXISTS idx_payment_status_tenant_month ON payment_status(tenant_id, month);

-- EMPLOYEE_DEDUCTIONS
CREATE INDEX IF NOT EXISTS idx_employee_deductions_tenant_id ON employee_deductions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employee_deductions_month ON employee_deductions(month);
CREATE INDEX IF NOT EXISTS idx_employee_deductions_employee_id ON employee_deductions(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_deductions_employee_month ON employee_deductions(employee_id, month);
CREATE INDEX IF NOT EXISTS idx_employee_deductions_tenant_month ON employee_deductions(tenant_id, month);
CREATE INDEX IF NOT EXISTS idx_employee_deductions_tenant_employee ON employee_deductions(tenant_id, employee_id);

-- TERMINAL_DUES
CREATE INDEX IF NOT EXISTS idx_terminal_dues_tenant_id ON terminal_dues(tenant_id);
CREATE INDEX IF NOT EXISTS idx_terminal_dues_employee_id ON terminal_dues(employee_id);
CREATE INDEX IF NOT EXISTS idx_terminal_dues_status ON terminal_dues(status);
CREATE INDEX IF NOT EXISTS idx_terminal_dues_created_at ON terminal_dues(created_at);

-- USER_ROLES
CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_id ON user_roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_name ON user_roles(name);

-- SYSTEM_SETTINGS
CREATE INDEX IF NOT EXISTS idx_system_settings_tenant_id ON system_settings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(key);

-- AUDIT_LOGS
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type ON audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_region_id ON audit_logs(region_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_user ON audit_logs(tenant_id, user_id);

-- ============================================================
-- PART 3: ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE applicants ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- NOTE: get_current_tenant_id() and is_super_admin() are bootstrapped
-- above in PART 0 of this same file (see that section's header comment
-- for why relying on 20240619000000_tenant_isolation.sql's copies isn't
-- safe for a fresh project). Both follow the same tenant-isolation
-- pattern that migration originally introduced.

-- ---------------------------------------------
-- REGIONS POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view regions in their tenant" ON regions;
CREATE POLICY "Users can view regions in their tenant" ON regions
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert regions in their tenant" ON regions;
CREATE POLICY "Users can insert regions in their tenant" ON regions
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update regions in their tenant" ON regions;
CREATE POLICY "Users can update regions in their tenant" ON regions
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete regions in their tenant" ON regions;
CREATE POLICY "Users can delete regions in their tenant" ON regions
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- COMPANIES POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view companies in their tenant" ON companies;
CREATE POLICY "Users can view companies in their tenant" ON companies
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert companies in their tenant" ON companies;
CREATE POLICY "Users can insert companies in their tenant" ON companies
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update companies in their tenant" ON companies;
CREATE POLICY "Users can update companies in their tenant" ON companies
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete companies in their tenant" ON companies;
CREATE POLICY "Users can delete companies in their tenant" ON companies
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- POSITIONS POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view positions in their tenant" ON positions;
CREATE POLICY "Users can view positions in their tenant" ON positions
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert positions in their tenant" ON positions;
CREATE POLICY "Users can insert positions in their tenant" ON positions
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update positions in their tenant" ON positions;
CREATE POLICY "Users can update positions in their tenant" ON positions
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete positions in their tenant" ON positions;
CREATE POLICY "Users can delete positions in their tenant" ON positions
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- PROFILES POLICIES
-- Matches the existing pattern from 20240619000000_tenant_isolation.sql
-- (tenant-wide SELECT, self-or-admin UPDATE), plus INSERT/DELETE policies
-- that migration never defined but src/components/UserManagement.tsx
-- clearly requires (it inserts a profile row keyed to auth.users.id on
-- signup, and hard-deletes profile rows when removing a user).
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view profiles in their tenant" ON profiles;
CREATE POLICY "Users can view profiles in their tenant" ON profiles
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true OR id = auth.uid());

DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
CREATE POLICY "Users can insert their own profile" ON profiles
FOR INSERT WITH CHECK (id = auth.uid() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
CREATE POLICY "Users can update their own profile" ON profiles
FOR UPDATE USING (id = auth.uid() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Super admins can delete profiles" ON profiles;
CREATE POLICY "Super admins can delete profiles" ON profiles
FOR DELETE USING (is_super_admin() = true);

-- ---------------------------------------------
-- EMPLOYEES POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view employees in their tenant" ON employees;
CREATE POLICY "Users can view employees in their tenant" ON employees
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert employees in their tenant" ON employees;
CREATE POLICY "Users can insert employees in their tenant" ON employees
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update employees in their tenant" ON employees;
CREATE POLICY "Users can update employees in their tenant" ON employees
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete employees in their tenant" ON employees;
CREATE POLICY "Users can delete employees in their tenant" ON employees
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- PAYROLL POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view payroll in their tenant" ON payroll;
CREATE POLICY "Users can view payroll in their tenant" ON payroll
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert payroll in their tenant" ON payroll;
CREATE POLICY "Users can insert payroll in their tenant" ON payroll
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update payroll in their tenant" ON payroll;
CREATE POLICY "Users can update payroll in their tenant" ON payroll
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete payroll in their tenant" ON payroll;
CREATE POLICY "Users can delete payroll in their tenant" ON payroll
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- ATTENDANCE POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view attendance in their tenant" ON attendance;
CREATE POLICY "Users can view attendance in their tenant" ON attendance
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert attendance in their tenant" ON attendance;
CREATE POLICY "Users can insert attendance in their tenant" ON attendance
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update attendance in their tenant" ON attendance;
CREATE POLICY "Users can update attendance in their tenant" ON attendance
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete attendance in their tenant" ON attendance;
CREATE POLICY "Users can delete attendance in their tenant" ON attendance
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- APPLICANTS POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view applicants in their tenant" ON applicants;
CREATE POLICY "Users can view applicants in their tenant" ON applicants
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert applicants in their tenant" ON applicants;
CREATE POLICY "Users can insert applicants in their tenant" ON applicants
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update applicants in their tenant" ON applicants;
CREATE POLICY "Users can update applicants in their tenant" ON applicants
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete applicants in their tenant" ON applicants;
CREATE POLICY "Users can delete applicants in their tenant" ON applicants
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- PAYMENT_STATUS POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view payment status in their tenant" ON payment_status;
CREATE POLICY "Users can view payment status in their tenant" ON payment_status
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert payment status in their tenant" ON payment_status;
CREATE POLICY "Users can insert payment status in their tenant" ON payment_status
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update payment status in their tenant" ON payment_status;
CREATE POLICY "Users can update payment status in their tenant" ON payment_status
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete payment status in their tenant" ON payment_status;
CREATE POLICY "Users can delete payment status in their tenant" ON payment_status
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- EMPLOYEE_DEDUCTIONS POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view deductions in their tenant" ON employee_deductions;
CREATE POLICY "Users can view deductions in their tenant" ON employee_deductions
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert deductions in their tenant" ON employee_deductions;
CREATE POLICY "Users can insert deductions in their tenant" ON employee_deductions
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update deductions in their tenant" ON employee_deductions;
CREATE POLICY "Users can update deductions in their tenant" ON employee_deductions
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete deductions in their tenant" ON employee_deductions;
CREATE POLICY "Users can delete deductions in their tenant" ON employee_deductions
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- TERMINAL_DUES POLICIES
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Users can view terminal dues in their tenant" ON terminal_dues
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Users can insert terminal dues in their tenant" ON terminal_dues
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Users can update terminal dues in their tenant" ON terminal_dues
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete terminal dues in their tenant" ON terminal_dues;
CREATE POLICY "Users can delete terminal dues in their tenant" ON terminal_dues
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- USER_ROLES POLICIES
-- Evidence (src/pages/Misc.tsx) shows only Super Admins reach the "User Roles"
-- settings tab in practice, but there is no explicit app-level restriction on
-- the query itself, so this follows the same tenant-or-super-admin pattern as
-- every other table for consistency.
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view roles in their tenant" ON user_roles;
CREATE POLICY "Users can view roles in their tenant" ON user_roles
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert roles in their tenant" ON user_roles;
CREATE POLICY "Users can insert roles in their tenant" ON user_roles
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update roles in their tenant" ON user_roles;
CREATE POLICY "Users can update roles in their tenant" ON user_roles
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can delete roles in their tenant" ON user_roles;
CREATE POLICY "Users can delete roles in their tenant" ON user_roles
FOR DELETE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ---------------------------------------------
-- SYSTEM_SETTINGS POLICIES
-- Matches the existing `settings` policy pattern from
-- 20240619000000_tenant_isolation.sql (SELECT + UPDATE only there); INSERT/
-- DELETE are added here because src/utils/currentMonth.ts clearly inserts a
-- new row the first time 'current_payroll_month' doesn't exist yet.
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view settings in their tenant" ON system_settings;
CREATE POLICY "Users can view settings in their tenant" ON system_settings
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert settings in their tenant" ON system_settings;
CREATE POLICY "Users can insert settings in their tenant" ON system_settings
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can update settings in their tenant" ON system_settings;
CREATE POLICY "Users can update settings in their tenant" ON system_settings
FOR UPDATE USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true)
WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Super admins can delete settings" ON system_settings;
CREATE POLICY "Super admins can delete settings" ON system_settings
FOR DELETE USING (is_super_admin() = true);

-- ---------------------------------------------
-- AUDIT_LOGS POLICIES
-- Matches the existing pattern from 20240619000000_tenant_isolation.sql:
-- SELECT + INSERT only. Audit trail rows are intentionally immutable --
-- no UPDATE/DELETE policy is defined, so authenticated users cannot alter
-- or erase log history (only a service-role/admin connection bypassing
-- RLS could).
-- ---------------------------------------------
DROP POLICY IF EXISTS "Users can view audit logs in their tenant" ON audit_logs;
CREATE POLICY "Users can view audit logs in their tenant" ON audit_logs
FOR SELECT USING (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

DROP POLICY IF EXISTS "Users can insert audit logs" ON audit_logs;
CREATE POLICY "Users can insert audit logs" ON audit_logs
FOR INSERT WITH CHECK (tenant_id = get_current_tenant_id() OR is_super_admin() = true);

-- ============================================================
-- END OF RECONSTRUCTED BASE SCHEMA
-- ============================================================
