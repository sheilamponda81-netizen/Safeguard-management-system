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

describe('Monthly Register: individual manual edits are routed through attendance_correct', () => {
  it('processSingleUpdate calls supabase.rpc(\'attendance_correct\', ...) with employee/date/status only -- never a source or basis', () => {
    expect(attendanceSource).toMatch(
      /supabase\.rpc\('attendance_correct', \{\s*p_employee_id: employeeId,\s*p_date: date,\s*p_status: nextStatus,\s*\}\)/
    );
    // Manual-priority protection depends on the client NEVER being able to
    // claim source='automatic' -- attendance_correct hardcodes 'manual'
    // server-side precisely because no source/basis parameter exists on
    // its signature, so the client cannot pass one even if it tried.
    expect(attendanceSource).not.toMatch(/p_source\s*:/);
    expect(attendanceSource).not.toMatch(/p_new_basis\s*:/);
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

  it('reverts the optimistic UI status back to previousStatus when the RPC call fails', () => {
    const processSingleUpdateBody = attendanceSource.slice(
      attendanceSource.indexOf('const processSingleUpdate ='),
      attendanceSource.indexOf('// ===== PROCESS UPDATE QUEUE =====')
    );
    expect(processSingleUpdateBody).toMatch(/reverted\[existingIndex\] = \{ \.\.\.reverted\[existingIndex\], status: previousStatus \}/);
  });

  it('threads previousStatus from the click handler through the queue into processSingleUpdate', () => {
    expect(attendanceSource).toMatch(
      /updateQueue\.current\.set\(updateKey, \{ employeeId, date, status: nextStatus, previousStatus: currentStatus \}\)/
    );
    expect(attendanceSource).toMatch(
      /await processSingleUpdate\(update\.employeeId, update\.date, update\.status, update\.previousStatus\)/
    );
  });

  it('surfaces a distinct reconciliation notice for an approved vs. already-processed payroll month', () => {
    expect(attendanceSource).toMatch(/already approved -- flagged for reconciliation review/);
    expect(attendanceSource).toMatch(/already been processed -- flagged for reconciliation review/);
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
});
