// src/utils/auditHelpers.ts

/**
 * Extract only the relevant fields from an employee object for audit logging.
 * Accepts either the app's camelCase `Employee` shape or a raw snake_case
 * Supabase row -- callers pass both across this codebase -- so this reads
 * via a loosely-typed record rather than a single named interface.
 */
export const getEmployeeAuditData = (employee: Record<string, unknown> | null | undefined) => {
  if (!employee) return null;

  return {
    full_name: employee.fullName || employee.full_name,
    employee_number: employee.employeeNumber || employee.employee_number,
    position: employee.position,
    department: employee.department,
    status: employee.status,
    basic_salary: employee.basicSalary || employee.basic_salary,
    phone: employee.phone,
    email: employee.email,
    company: employee.company,
    workstation: employee.workstation,
    region_id: employee.region_id,
    uniform_deduction: employee.uniform_deduction,
    next_of_kin_name: employee.next_of_kin_name,
    next_of_kin_relationship: employee.next_of_kin_relationship,
    next_of_kin_phone: employee.next_of_kin_phone
  };
};

/**
 * Get changes between old and new data -- a generic shallow-diff over
 * whatever plain object the audit payload actually is (see
 * getEmployeeAuditData above for why this stays loosely typed rather than
 * a single named interface).
 */
export const getChanges = (
  oldData: Record<string, unknown> | null | undefined,
  newData: Record<string, unknown> | null | undefined
): { changed: string[]; old: typeof oldData; new: typeof newData } => {
  const changed: string[] = [];

  if (!oldData || !newData) {
    return { changed: ['Data created or deleted'], old: oldData, new: newData };
  }

  const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);

  allKeys.forEach(key => {
    const oldVal = JSON.stringify(oldData[key]);
    const newVal = JSON.stringify(newData[key]);
    if (oldVal !== newVal) {
      changed.push(key);
    }
  });

  return { changed, old: oldData, new: newData };
};