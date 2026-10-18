import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { calculateAttendanceStatus } from '../utils/attendanceCalculationEngine';

// Safeguard Stage C, Step 3: What-if Simulation.
//
// This directly answers "does the simulation produce the expected
// Present result for ALIM LEMANI on 1 October 2026?" using his REAL
// scan times, independently confirmed read-only against STAGING before
// this feature was built: check-in 2026-10-01T03:57:27Z, checkout
// 2026-10-01T15:17:55Z. It calls calculateAttendanceStatus directly --
// the exact same function the simulation page calls -- with the
// hypothetical Day shift and 'insufficient' coverage the page always
// uses (coverage never needs to be confirmed when both a check-in and
// a checkout are observed; see calculateAttendanceStatus's own first
// branch).
describe('What-if Simulation: ALIM LEMANI, 1 Oct 2026, hypothetical Day shift', () => {
  it('produces Present (confirmed) from his real scan times', () => {
    const result = calculateAttendanceStatus({
      shiftDate: '2026-10-01',
      resolvedShift: 'day',
      events: [
        { timestampIso: '2026-10-01T03:57:27.000Z' },
        { timestampIso: '2026-10-01T15:17:55.000Z' },
      ],
      coverage: { status: 'insufficient' },
    });
    expect(result.status).toBe('present');
    expect(result.basis).toBe('confirmed');
    expect(result.checkInIso).toBe('2026-10-01T03:57:27.000Z');
    expect(result.checkOutIso).toBe('2026-10-01T15:17:55.000Z');
  });

  it('would resolve Late instead if the same check-in arrived after the grace cutoff', () => {
    const result = calculateAttendanceStatus({
      shiftDate: '2026-10-01',
      resolvedShift: 'day',
      events: [
        { timestampIso: '2026-10-01T04:30:00.000Z' }, // after 04:15Z grace cutoff
        { timestampIso: '2026-10-01T15:17:55.000Z' },
      ],
      coverage: { status: 'insufficient' },
    });
    expect(result.status).toBe('late');
  });
});

describe('AttendanceWhatIfSimulation.tsx: structurally read-only, reuses the existing engine', () => {
  const source = fs.readFileSync(path.resolve(__dirname, './AttendanceWhatIfSimulation.tsx'), 'utf-8');

  it('imports and uses the real Stage A engine function, not a reimplementation', () => {
    expect(source).toMatch(/import \{ calculateAttendanceStatus, AttendanceCalculationResult \} from '\.\.\/utils\/attendanceCalculationEngine'/);
    expect(source).toMatch(/calculateAttendanceStatus\(\{/);
  });

  it('never calls any write-shaped Supabase method or RPC', () => {
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(source).not.toMatch(/\.rpc\(/);
  });

  it('never invokes the official write RPCs (mentioning them in explanatory comments is fine; calling them is not)', () => {
    expect(source).not.toMatch(/rpc\(['"](attendance_correct|attendance_bulk_correct|attendance_apply_automatic|attendance_confirm_coverage|attendance_preview_calculate)['"]/);
  });

  it('the hypothetical shift is operator-chosen, never read from roster_resolve_schedule or any roster table', () => {
    expect(source).not.toMatch(/roster_resolve_schedule|resolveScheduleForDate/);
    expect(source).toMatch(/resolvedShift: hypotheticalShift/);
  });

  it('coverage is always insufficient -- never implies a confirmation exists', () => {
    expect(source).toMatch(/coverage: \{ status: 'insufficient' \}/);
  });

  it('clearly labels the result SIMULATION ONLY -- NOT OFFICIAL ATTENDANCE', () => {
    expect(source).toMatch(/SIMULATION ONLY — NOT OFFICIAL ATTENDANCE/);
  });

  it('explicitly disclaims that roster/attendance has been verified', () => {
    expect(source).toMatch(/does NOT confirm.*actual roster or attendance/);
  });

  it('gates visibility on the same permission as the rest of Attendance Review', () => {
    expect(source).toMatch(/PERMISSIONS\.ATTENDANCE_MAP_HIKCENTRAL_PERSONS/);
  });
});

describe('Attendance.tsx: What-if Simulation is folded into the existing Attendance Review tab', () => {
  const attendanceSource = fs.readFileSync(path.resolve(__dirname, './Attendance.tsx'), 'utf-8');

  it('lazy-loads it the same way the other Review sub-sections are loaded', () => {
    expect(attendanceSource).toMatch(/const AttendanceWhatIfSimulationPage = lazy\(\(\) => import\('\.\/AttendanceWhatIfSimulation'\)\);/);
  });

  it('renders it only inside AttendanceReviewTab, behind its own collapsed toggle', () => {
    const reviewTabBody = attendanceSource.slice(
      attendanceSource.indexOf('function AttendanceReviewTab()'),
      attendanceSource.indexOf('type AttendanceTabId')
    );
    expect(reviewTabBody).toMatch(/showWhatIf/);
    expect(reviewTabBody).toMatch(/<AttendanceWhatIfSimulationPage \/>/);
  });

  it('does not add any new sidebar/App.tsx route for it', () => {
    expect(attendanceSource).not.toMatch(/path.*AttendanceWhatIfSimulation/i);
  });
});
