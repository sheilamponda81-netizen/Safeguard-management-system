// The employee statuses that remain eligible for payroll. A deliberate
// WHITELIST (not "everyone who isn't soft-deleted") so that payroll
// correctly includes someone on APPROVED LEAVE (a real, intentional
// business rule -- being on leave must never exclude an employee from
// payroll) while still excluding any other current or future non-active,
// non-payable status (e.g. "Suspended") without that status having to be
// explicitly reasoned about every time payroll code is touched.
export const PAYABLE_EMPLOYEE_STATUSES = ['Active', 'On Leave'] as const;
