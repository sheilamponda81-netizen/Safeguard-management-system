import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Final roster/off-day display integrity review (screenshots: UPILE
// MWANYEKONDE, SFG-S-149 -- several November dates showing the same
// grey/blank status made Off, Unassigned and Pending indistinguishable
// in the Monthly Register). Same source-pinning precedent as
// Attendance.monthlyRegisterRpc.test.ts (no @testing-library/react in
// this repo; vitest.config.ts runs in the 'node' environment).
const attendanceSource = fs.readFileSync(path.resolve(__dirname, './Attendance.tsx'), 'utf-8');

describe('Monthly Register: fetches the same roster data Roster Management and the attendance engine already resolve from', () => {
  it('imports the roster fetchers and the pure display-code resolver, never a second/divergent definition of Off', () => {
    expect(attendanceSource).toMatch(/import \{ fetchActiveOffDayPatterns, fetchActiveShiftPatterns, fetchActiveDateAssignments \} from '\.\.\/utils\/rosterService';/);
    expect(attendanceSource).toMatch(/import \{ resolveAttendanceCellDisplayCode \} from '\.\.\/utils\/attendanceCellDisplay';/);
  });

  it('fetches roster patterns/assignments alongside attendance, bounded to the displayed month\'s date range (never an unbounded fetch)', () => {
    const fetchDataBody = attendanceSource.slice(
      attendanceSource.indexOf('const fetchData = useCallback'),
      attendanceSource.indexOf('// ===== INITIALIZATION =====')
    );
    expect(fetchDataBody).toMatch(/fetchActiveOffDayPatterns\(\)/);
    expect(fetchDataBody).toMatch(/fetchActiveShiftPatterns\(\)/);
    expect(fetchDataBody).toMatch(/fetchActiveDateAssignments\(datesArr\[0\], datesArr\[datesArr\.length - 1\]\)/);
  });

  it('clears all three roster datasets alongside attendance when there is nothing to fetch, never leaving stale roster data from a previous month', () => {
    const fetchDataBody = attendanceSource.slice(
      attendanceSource.indexOf('const fetchData = useCallback'),
      attendanceSource.indexOf('// ===== INITIALIZATION =====')
    );
    const elseBranch = fetchDataBody.slice(fetchDataBody.indexOf('} else {'));
    expect(elseBranch).toMatch(/setOffDayPatterns\(\[\]\);/);
    expect(elseBranch).toMatch(/setShiftPatterns\(\[\]\);/);
    expect(elseBranch).toMatch(/setDateAssignments\(\[\]\);/);
  });
});

describe('Monthly Register: a cell with no attendance row is disambiguated by the roster\'s resolved schedule, purely for display', () => {
  it('getCellDisplayCode delegates to the pure resolver, never invents its own Off/Pending logic inline', () => {
    expect(attendanceSource).toMatch(
      /const getCellDisplayCode = useCallback\(\(employeeId: string, date: string\): string => \{\s*const recorded = attendanceByKey\.get\(`\$\{employeeId\}_\$\{date\}`\)\?\.status;\s*return resolveAttendanceCellDisplayCode\(recorded, employeeId, date, dateAssignments, offDayPatterns, shiftPatterns\);/
    );
  });

  it('the grid cell click handler still reads the REAL persisted status/source (getAttendanceStatus/getAttendanceSource), never the display code -- this fix changes what is SHOWN, never what a click writes', () => {
    const cellBody = attendanceSource.slice(
      attendanceSource.indexOf('const status = getAttendanceStatus(emp.id, date);'),
      attendanceSource.indexOf('</TBody>')
    );
    expect(cellBody).toMatch(/getDebouncedUpdate\(updateKey\)\(emp\.id, date, status, source\);/);
    expect(cellBody).toMatch(/const displayCode = getCellDisplayCode\(emp\.id, date\);/);
  });

  it('never writes an attendance or payroll record merely to display a scheduled Off/Pending/Unassigned day -- getCellDisplayCode and its pure helper contain no Supabase write call at all', () => {
    const displayFnBody = attendanceSource.slice(
      attendanceSource.indexOf('const getCellDisplayCode = useCallback'),
      attendanceSource.indexOf('// ===== GET EMPLOYEE STATS =====')
    );
    expect(displayFnBody).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|supabase\.rpc\(/);
  });

  it('UNASSIGNED and PENDING are distinct, labeled display colors -- never styled identically to genuine Off ("-")', () => {
    expect(attendanceSource).toMatch(/UNASSIGNED: '[^']+',\s*\n\s*PENDING: '[^']+',/);
    expect(attendanceSource).toMatch(/UNASSIGNED: 'Unassigned',\s*\n\s*PENDING: 'Pending',/);
  });
});
