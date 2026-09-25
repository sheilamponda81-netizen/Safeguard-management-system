// Extracted from Employees.tsx's validateEmployeeForm() so the pure
// decision logic (given a form's current values, what's the first missing
// or invalid field, if any) is unit-testable without importing the page
// component itself -- same pattern as employeeNumberGeneration.ts /
// employeeConflicts.ts / employeeBatchFetch.ts.
//
// Only the fields this function actually reads -- not the full `Employee`
// (persisted row) or `EmployeeFormData` (form state) shapes defined in
// Employees.tsx, which stay local to that file.
export interface EmployeeFormValidationFields {
  employeeNumber?: string | null;
  fullName?: string | null;
  dob?: string | null;
  gender?: string | null;
  phone?: string | null;
  address?: string | null;
  position?: string | null;
  department?: string | null;
  qualification?: string | null;
  dateHired?: string | null;
  contractType?: string | null;
  pay_point?: string | null;
  account_number?: string | null;
  next_of_kin_name?: string | null;
  next_of_kin_relationship?: string | null;
  next_of_kin_phone?: string | null;
  region_id?: string | null;
  assignment_type?: string | null;
  company?: string | null;
  resident_name?: string | null;
  nationalId?: string | null;
}

// ===== Shared Add/Edit employee form validation =====
// Every textbox on the form is mandatory -- this is the single place that
// list lives, so the Add and Edit forms (which duplicate the same fields)
// never drift out of sync on what's required. Returns the label of the first
// missing/invalid field so the caller can show a notification naming it, or
// null when the form is valid.
export const REQUIRED_EMPLOYEE_FIELDS: { key: keyof EmployeeFormValidationFields; label: string }[] = [
  { key: 'fullName', label: 'Full Name' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'gender', label: 'Gender' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'address', label: 'Residential Address' },
  { key: 'position', label: 'Position' },
  { key: 'department', label: 'Department' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'dateHired', label: 'Date Hired' },
  { key: 'contractType', label: 'Contract Type' },
  { key: 'pay_point', label: 'Pay Point' },
  { key: 'account_number', label: 'Bank Account / Mobile Money Number' },
  { key: 'next_of_kin_name', label: 'Next of Kin Full Name' },
  { key: 'next_of_kin_relationship', label: 'Next of Kin Relationship' },
  { key: 'next_of_kin_phone', label: 'Next of Kin Phone Number' },
];

// HOTFIX (STAGING blocker 2): second param renamed from "isSuperAdmin" to
// "canChooseAnyRegion" -- AddEmployeeForm now passes canChooseAnyRegion
// (src/utils/permissions.ts's canChooseAnyRegion() helper: Super Admin OR
// Business Admin) here instead of isSuperAdmin alone, since a Business
// Admin also gets a free-choice region <select> now (Employees.tsx's
// render gate uses the same flag), so "must have actually picked a Region"
// needs to apply to that broader caller too. EditEmployeeForm still passes
// its own isSuperAdmin unchanged -- it has no region <select> at all, so
// this param has no effect there either way.
export const validateEmployeeForm = (form: EmployeeFormValidationFields, canChooseAnyRegion?: boolean): string | null => {
  if (!form.employeeNumber || String(form.employeeNumber).trim() === '') {
    // Deliberately not "select a Region first" -- a non-super-admin's
    // region is pre-assigned, not manually selected, so that phrasing
    // describes an action they can't take. Covers both: a region not yet
    // resolved at all, and generation still in flight or having failed.
    return 'Employee Number (still generating -- wait for it to complete, or select/confirm a Region)';
  }

  for (const { key, label } of REQUIRED_EMPLOYEE_FIELDS) {
    if (!form[key] || String(form[key]).trim() === '') {
      return label;
    }
  }

  if (canChooseAnyRegion && !form.region_id) return 'Region';
  if (form.assignment_type === 'company' && !form.company) return 'Company Name';
  if (form.assignment_type === 'resident') {
    if (!form.resident_name) return 'Resident Name';
  }

  // National ID and Next of Kin Address are optional -- not every employee
  // has one on file yet -- but if a National ID is entered it still needs
  // to be a real one, not a partial/typo'd value.
  if (form.nationalId && String(form.nationalId).trim() !== '' && String(form.nationalId).trim().length !== 8) {
    return 'National ID (must be exactly 8 characters)';
  }
  if (String(form.phone).trim().length !== 10) {
    return 'Phone Number (must be exactly 10 digits)';
  }
  if (String(form.next_of_kin_phone).trim().length !== 10) {
    return 'Next of Kin Phone Number (must be exactly 10 digits)';
  }

  return null;
};
