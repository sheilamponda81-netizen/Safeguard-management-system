import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Safeguard Stage C, Step 2: Monthly Register's individual manual
// attendance edit (the grid's click-to-cycle cell) must go through the
// protected attendance_correct RPC instead of a direct
// `.from('attendance').insert()/.update()` call. This codebase has no
// component-test harness (no @testing-library/react; vitest.config.ts runs
// in the 'node' environment) -- see Roster.employeeSearch.test.ts's header
// for the established precedent of pinning hard-to-runtime-test UI wiring
// at the source level instead of rendering the component.
const attendanceSource = fs.readFileSync(path.resolve(__dirname, './Attendance.tsx'), 'utf-8');

describe('Monthly Register: the edit-permission gate comes from the real calendar date, never the payroll-processing cursor', () => {
  // Month Consistency fix: Attendance's INITIAL displayed month now
  // defaults to Settings -> Month Settings (current_payroll_month, via
  // getSystemCurrentMonth()), matching every other month-dependent screen
  // (Payroll, Terminal Dues Allocations, Salary Advances, Payments,
  // Payslips, Reports, Dashboard). But `systemMonth` -- the one thing that
  // gates whether an edit is even allowed, and the "Jump to Current"/
  // "Switch to <month>" targets -- must stay anchored to the real
  // calendar date (getActualCurrentMonth()) and must NEVER be reassigned
  // from the payroll cursor. Collapsing these two into one variable is
  // exactly what caused a real bug once already (see getActualCurrentMonth's
  // own comment in currentMonth.ts): a manual edit on 12 Oct 2026 silently
  // saved against 1 July 2026 because the page treated the stale cursor as
  // "current." These assertions pin that `systemMonth` specifically still
  // comes from getActualCurrentMonth() only.
  it('still assigns systemMonth from getActualCurrentMonth(), never from getSystemCurrentMonth()', () => {
    expect(attendanceSource).toMatch(/const month = getActualCurrentMonth\(\);\s*\n\s*setSystemMonth\(month\);/);
  });

  it('imports both getActualCurrentMonth and getSystemCurrentMonth from currentMonth.ts', () => {
    expect(attendanceSource).toMatch(/import \{[^}]*getActualCurrentMonth[^}]*\} from '\.\.\/utils\/currentMonth'/);
    expect(attendanceSource).toMatch(/import \{[^}]*getSystemCurrentMonth[^}]*\} from '\.\.\/utils\/currentMonth'/);
  });

  it('availableMonths (and therefore historical-month navigation range) is still derived from the real calendar month, not the payroll cursor', () => {
    expect(attendanceSource).toMatch(/const months = getAvailableMonthsFromSystem\(month\);/);
  });
});

describe('Monthly Register: the INITIAL selected month defaults to current_payroll_month (Settings -> Month Settings)', () => {
  it('fetches the payroll-cursor month via getSystemCurrentMonth() and sets selectedMonth from it, only after that await resolves', () => {
    const initBody = attendanceSource.slice(
      attendanceSource.indexOf('const init = async () => {'),
      attendanceSource.indexOf('init();')
    );
    // Order matters: systemMonth/availableMonths must already be set
    // (synchronously, from the real calendar month) BEFORE this await, so
    // the edit gate is correct from the first render -- and selectedMonth
    // must be set only AFTER the await, never before it and then
    // overwritten, so there is no intermediate render where selectedMonth
    // briefly equals the real calendar month instead of the payroll
    // cursor (which would risk a flash of the wrong default, or -- worse
    // -- a write race, before settling).
    const setSystemMonthIdx = initBody.indexOf('setSystemMonth(month)');
    const awaitIdx = initBody.indexOf('await getSystemCurrentMonth()');
    const setSelectedMonthIdx = initBody.indexOf('setSelectedMonth(payrollMonth)');
    expect(setSystemMonthIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(setSelectedMonthIdx).toBeGreaterThan(-1);
    expect(setSystemMonthIdx).toBeLessThan(awaitIdx);
    expect(awaitIdx).toBeLessThan(setSelectedMonthIdx);
  });

  it('never synchronously initializes selectedMonth to the real calendar month before the payroll-cursor fetch resolves', () => {
    const initBody = attendanceSource.slice(
      attendanceSource.indexOf('const init = async () => {'),
      attendanceSource.indexOf('init();')
    );
    expect(initBody).not.toMatch(/setSelectedMonth\(month\)/);
  });

  it('selectedMonth starts empty (not pre-seeded to any month), so no data fetch or edit can race ahead of the resolved payroll-cursor default', () => {
    expect(attendanceSource).toMatch(/const \[selectedMonth, setSelectedMonth\] = useState\(''\);/);
  });

  it('navigating within Attendance (Previous/Next/dropdown/Jump to Current) only ever calls setSelectedMonth -- never invokes setSystemCurrentMonth() -- so browsing never silently rewrites the Admin global month setting', () => {
    // Matches an actual call (open paren immediately after the name), not
    // this file's own explanatory comment mentioning the function by name.
    expect(attendanceSource).not.toMatch(/setSystemCurrentMonth\(/);
    expect(attendanceSource).not.toMatch(/import \{[^}]*setSystemCurrentMonth/);
  });

  it('REGRESSION: the per-cell attendance write still targets the real calendar date of that cell, never selectedMonth/systemMonth -- confirms this fix changed only which month initially DISPLAYS, not what a write is keyed to, so no October record can be rewritten into July', () => {
    expect(attendanceSource).toMatch(
      /supabase\.rpc\('attendance_correct', \{\s*p_employee_id: employeeId,\s*p_date: date,\s*p_status: nextStatus,\s*p_reason: reason,\s*\}\)/
    );
    expect(attendanceSource).not.toMatch(/p_date:\s*selectedMonth/);
    expect(attendanceSource).not.toMatch(/p_date:\s*systemMonth/);
    // getDatesForMonth (the only thing standing between "which month is
    // selected" and "which dates get rendered/written") is untouched by
    // this fix -- it still derives every date in a month purely from the
    // month string itself, with no dependency on current_payroll_month.
    expect(attendanceSource).toMatch(/const getDatesForMonth = useCallback\(\(monthYear: string\) => \{/);
  });
});

describe('Monthly Register: individual manual edits are routed through attendance_correct', () => {
  it('processSingleUpdate calls supabase.rpc(\'attendance_correct\', ...) with employee/date/status/reason only -- never a source or basis', () => {
    expect(attendanceSource).toMatch(
      /supabase\.rpc\('attendance_correct', \{\s*p_employee_id: employeeId,\s*p_date: date,\s*p_status: nextStatus,\s*p_reason: reason,\s*\}\)/
    );
    // Manual-priority protection depends on the client NEVER being able to
    // claim source='automatic' -- attendance_correct hardcodes 'manual'
    // server-side precisely because no source/basis parameter exists on
    // its signature, so the client cannot pass one even if it tried.
    expect(attendanceSource).not.toMatch(/p_source\s*:/);
    expect(attendanceSource).not.toMatch(/p_new_basis\s*:/);
  });

  it('Restore fast manual entry: updateAttendance opens the AttendanceReasonModal ONLY when the cell\'s current persisted source is \'automatic\' -- every other case (blank or existing manual) commits immediately with no dialog at all', () => {
    const updateAttendanceBody = attendanceSource.slice(
      attendanceSource.indexOf('const updateAttendance = useCallback'),
      attendanceSource.indexOf('const confirmReasonAndUpdate = useCallback')
    );
    expect(updateAttendanceBody).not.toMatch(/window\.prompt/);
    expect(updateAttendanceBody).toMatch(/if \(currentSource === 'automatic'\) \{\s*setReasonPrompt\(\{/);
    // The fast path: falls through to a direct commit with no reason once
    // the automatic-override branch above has already `return`ed.
    expect(updateAttendanceBody).toMatch(/commitAttendanceUpdate\(employeeId, date, currentStatus, currentSource, nextStatus, null\);/);
    // updateAttendance itself still never touches attendance/UI state
    // directly -- both branches delegate to commitAttendanceUpdate.
    expect(updateAttendanceBody).not.toMatch(/setAttendance\(/);
    expect(updateAttendanceBody).not.toMatch(/updateQueue\.current\.set/);
  });

  it('commitAttendanceUpdate is the single shared path for both the fast no-reason commit and the reason-modal confirm commit -- the optimistic update, queueing and audit logging exist in exactly one place, not duplicated per branch', () => {
    const commitBody = attendanceSource.slice(
      attendanceSource.indexOf('const commitAttendanceUpdate = useCallback'),
      attendanceSource.indexOf('const updateAttendance = useCallback')
    );
    expect(commitBody).toMatch(/setAttendance\(/);
    expect(commitBody).toMatch(/updateQueue\.current\.set\(updateKey, \{ employeeId, date, status: nextStatus, previousStatus: currentStatus, previousSource: currentSource, reason \}\)/);
    // The optimistic guess is always source: 'manual' -- the only value a
    // successful write (through either branch) can ever actually produce.
    expect(commitBody).toMatch(/status: nextStatus, source: 'manual'/);
  });

  it('AttendanceReasonModal is rendered gated on reasonPrompt, and a cancelled dialog (onClose) never reaches confirmReasonAndUpdate/commitAttendanceUpdate -- Cancel leaves attendance unchanged', () => {
    expect(attendanceSource).toMatch(/import \{ AttendanceReasonModal \} from '\.\.\/components\/AttendanceReasonModal';/);
    expect(attendanceSource).toMatch(/<AttendanceReasonModal\s*\n\s*open=\{reasonPrompt !== null\}\s*\n\s*onClose=\{\(\) => setReasonPrompt\(null\)\}\s*\n\s*onConfirm=\{confirmReasonAndUpdate\}/);
  });

  it('confirmReasonAndUpdate commits via commitAttendanceUpdate only after a reasonPrompt exists, and clears it immediately so a second confirm cannot double-fire', () => {
    const confirmBody = attendanceSource.slice(
      attendanceSource.indexOf('const confirmReasonAndUpdate = useCallback'),
      attendanceSource.indexOf('}, [reasonPrompt, commitAttendanceUpdate]);')
    );
    expect(confirmBody).toMatch(/if \(!reasonPrompt\) return;/);
    expect(confirmBody).toMatch(/setReasonPrompt\(null\);/);
    expect(confirmBody).toMatch(/commitAttendanceUpdate\(employeeId, date, currentStatus, 'automatic', nextStatus, reason\);/);
    expect(confirmBody.indexOf('setReasonPrompt(null);')).toBeLessThan(confirmBody.indexOf('commitAttendanceUpdate('));
  });

  it('no longer writes directly to the attendance table from the grid edit path', () => {
    const processSingleUpdateBody = attendanceSource.slice(
      attendanceSource.indexOf('const processSingleUpdate ='),
      attendanceSource.indexOf('// ===== PROCESS UPDATE QUEUE =====')
    );
    expect(processSingleUpdateBody).not.toMatch(/\.from\('attendance'\)/);
  });

  it('surfaces errors through getErrorMessage, never the raw RPC error', () => {
    expect(attendanceSource).toMatch(/Failed to save attendance: \$\{getErrorMessage\(err\)\}/);
  });

  it('reverts the optimistic UI status AND source back to their previous values when the RPC call fails -- a reverted automatic-sourced cell must not wrongly skip the reason dialog on the very next click', () => {
    const processSingleUpdateBody = attendanceSource.slice(
      attendanceSource.indexOf('const processSingleUpdate ='),
      attendanceSource.indexOf('// ===== PROCESS UPDATE QUEUE =====')
    );
    expect(processSingleUpdateBody).toMatch(/reverted\[existingIndex\] = \{ \.\.\.reverted\[existingIndex\], status: previousStatus, source: previousSource \}/);
  });

  it('threads previousStatus, previousSource AND the (possibly null) reason from commitAttendanceUpdate through the queue into processSingleUpdate', () => {
    expect(attendanceSource).toMatch(
      /updateQueue\.current\.set\(updateKey, \{ employeeId, date, status: nextStatus, previousStatus: currentStatus, previousSource: currentSource, reason \}\)/
    );
    expect(attendanceSource).toMatch(
      /await processSingleUpdate\(update\.employeeId, update\.date, update\.status, update\.previousStatus, update\.previousSource, update\.reason\)/
    );
  });

  it('surfaces a distinct reconciliation notice for an approved vs. already-processed payroll month', () => {
    expect(attendanceSource).toMatch(/already approved -- flagged for reconciliation review/);
    expect(attendanceSource).toMatch(/already been processed -- flagged for reconciliation review/);
  });

  it('getAttendanceSource reads the same per-cell lookup index as getAttendanceStatus, and the grid cell click passes it through to the debounced update', () => {
    expect(attendanceSource).toMatch(/const getAttendanceSource = useCallback\(\(employeeId: string, date: string\): string \| null => \{\s*return attendanceByKey\.get\(`\$\{employeeId\}_\$\{date\}`\)\?\.source \?\? null;/);
    expect(attendanceSource).toMatch(/const source = getAttendanceSource\(emp\.id, date\);/);
    expect(attendanceSource).toMatch(/getDebouncedUpdate\(updateKey\)\(emp\.id, date, status, source\);/);
  });
});

describe('Monthly Register: "Copy from previous month" is routed through attendance_correct, not a direct bulk insert', () => {
  const copyFromPreviousMonthBody = attendanceSource.slice(
    attendanceSource.indexOf('const copyFromPreviousMonth ='),
    attendanceSource.indexOf('// ===== RENDER =====')
  );

  it('no longer bulk-inserts directly into the attendance table', () => {
    expect(copyFromPreviousMonthBody).not.toMatch(/\.from\('attendance'\)\s*\.insert/);
  });

  it('calls attendance_correct once per copied record, preserving each day\'s own source status', () => {
    expect(copyFromPreviousMonthBody).toMatch(
      /supabase\.rpc\('attendance_correct', \{\s*p_employee_id: record\.employee_id,\s*p_date: record\.date,\s*p_status: record\.status,/
    );
  });

  it('counts successes and failures independently instead of treating the batch as all-or-nothing', () => {
    expect(copyFromPreviousMonthBody).toMatch(/let succeeded = 0;/);
    expect(copyFromPreviousMonthBody).toMatch(/const failures:/);
    expect(copyFromPreviousMonthBody).toMatch(/succeeded\+\+;/);
    expect(copyFromPreviousMonthBody).toMatch(/failures\.push\(/);
  });

  it('reports a partial-failure outcome distinctly from full success and full failure', () => {
    expect(copyFromPreviousMonthBody).toMatch(/if \(failures\.length === 0\)/);
    expect(copyFromPreviousMonthBody).toMatch(/else if \(succeeded > 0\)/);
    expect(copyFromPreviousMonthBody).toMatch(/Copied \$\{succeeded\} of \$\{newRecords\.length\} records/);
  });

  it('never claims automatic source for a copied record (manual precedence is preserved -- attendance_correct has no source parameter at all)', () => {
    expect(copyFromPreviousMonthBody).not.toMatch(/p_source\s*:/);
  });

  it('PR #69 final safety review: a TARGET date that already holds an existing AUTOMATIC decision is SKIPPED entirely (no RPC call, no write) rather than overridden with a fabricated "Copied from <month>" reason -- a generic auto-generated string is never accepted as the genuine human justification attendance_correct requires for an automatic override', () => {
    expect(copyFromPreviousMonthBody).toMatch(/const existingTarget = attendanceByKey\.get\(`\$\{record\.employee_id\}_\$\{record\.date\}`\);/);
    expect(copyFromPreviousMonthBody).toMatch(/if \(existingTarget\?\.source === 'automatic'\) \{\s*skippedProtected\.push\(\{ employee_id: record\.employee_id, date: record\.date \}\);\s*continue;\s*\}/);
    // The only p_reason ever sent from this loop is null -- there is no
    // remaining code path that invents or forwards any other reason text.
    expect(copyFromPreviousMonthBody).toMatch(/p_reason: null,/);
    expect(copyFromPreviousMonthBody).not.toMatch(/p_reason: `Copied from/);
  });

  it('every copied record not skipped as protected needs no reason at all -- ordinary blank/manual targets stay fast', () => {
    expect(copyFromPreviousMonthBody).toMatch(/\/\/ Every other target \(blank, or already manual\) needs no\s*\n\s*\/\/ reason at all/);
  });

  it('skipped-protected records are counted and reported distinctly from both success and failure -- never a blanket "success" when some records were left unchanged', () => {
    expect(copyFromPreviousMonthBody).toMatch(/const skippedProtected: \{ employee_id: string; date: string \}\[\] = \[\];/);
    expect(copyFromPreviousMonthBody).toMatch(/if \(failures\.length === 0 && skippedProtected\.length === 0\)/);
    expect(copyFromPreviousMonthBody).toMatch(/already has a fingerprint-based \(automatic\) result and was left unchanged/);
  });
});
