import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Safeguard Stage C, Step 4: the Apply-to-Monthly-Register control is now
// a REAL, permission-protected workflow -- but it must only ever be
// enabled for rows classified 'eligible' (confirmed Present/Late, backed
// by a genuine check-in AND checkout scan, not manually protected, not
// payroll-approved-protected), and only after the operator has explicitly
// confirmed via the checkbox. It must never call attendance_apply_
// automatic over a date range wider than a single day, since that RPC
// would otherwise also write Absent/Pending/Off/Unassigned results this
// round deliberately never applies automatically.
const previewSource = fs.readFileSync(path.resolve(__dirname, './AttendanceServerCalculationPreview.tsx'), 'utf-8');

describe('AttendanceServerCalculationPreview: Apply is permission-protected and confirmation-gated, not unconditional', () => {
  it('the Apply button is disabled unless the operator has checked the confirmation box', () => {
    expect(previewSource).toMatch(/disabled=\{!operatorConfirmed \|\| applying\}/);
  });

  it('the Apply control section is only shown when the caller holds attendance.auto_apply (canApply)', () => {
    expect(previewSource).toMatch(/!canApply \? \(/);
  });

  it('only calls attendance_apply_automatic (via applyEligibleAutomaticResults) for rows classified eligible, never the whole range', () => {
    expect(previewSource).toMatch(/applyEligibleAutomaticResults\(\s*eligibleRows\.map/);
  });

  it('the eligibility classifier used here restricts to confirmed Present/Late, excluding Absent/Pending/Off/Unassigned and provisional basis', () => {
    expect(previewSource).toMatch(/classifyAutomaticEligibility\(/);
  });

  it('shows a clear explanation instead of an enabled control when nothing is eligible', () => {
    expect(previewSource).toMatch(/No eligible day in this range -- there is nothing to apply/);
  });

  it('the confirmation checkbox explicitly distinguishes a real shift from a What-if Simulation', () => {
    expect(previewSource).toMatch(/not a What-if Simulation/);
  });

  it('shows actual outcomes after applying, not just an assumed success', () => {
    expect(previewSource).toMatch(/applyOutcomes/);
    expect(previewSource).toMatch(/Actual outcomes/);
  });

  it('the preview/apply flow never calls a write-shaped Supabase method directly (writes only ever go through attendance_apply_automatic)', () => {
    expect(previewSource).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });

  it('gates the whole section on the same permission that already gates the Attendance Review tab', () => {
    expect(previewSource).toMatch(/PERMISSIONS\.ATTENDANCE_MAP_HIKCENTRAL_PERSONS/);
  });

  it('reports the live readiness check rather than asserting data exists unconditionally', () => {
    expect(previewSource).toMatch(/checkAutomaticAttendanceReadiness/);
    expect(previewSource).toMatch(/overlapEmployeeCount === 0/);
  });
});

describe('attendanceAutomaticApplyService: Apply never touches a date range wider than one day per call', () => {
  const serviceSource = fs.readFileSync(path.resolve(__dirname, '../utils/attendanceAutomaticApplyService.ts'), 'utf-8');

  it('calls attendance_apply_automatic with p_date_from and p_date_to both equal to the single pair date', () => {
    expect(serviceSource).toMatch(/p_date_from: pair\.date,\s*p_date_to: pair\.date,/);
  });

  it('never writes directly to the attendance or payroll tables -- only reads them', () => {
    const readOnlyFns = serviceSource.slice(0, serviceSource.indexOf('export interface ApplyOutcome'));
    expect(readOnlyFns).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });

  it('excludes Absent from eligibility even when confirmed, per this round\'s explicit restriction', () => {
    expect(serviceSource).toMatch(/row\.status === 'present' \|\| row\.status === 'late'/);
    expect(serviceSource).not.toMatch(/row\.status === 'absent'/);
  });
});

describe('What-if Simulation is never wired into the Apply workflow', () => {
  it('AttendanceServerCalculationPreview.tsx never imports from AttendanceWhatIfSimulation (mentioning it in explanatory copy is fine; importing it is not)', () => {
    expect(previewSource).not.toMatch(/from ['"].*AttendanceWhatIfSimulation['"]/);
  });
});

describe('Attendance.tsx: the server preview is folded into the existing Attendance Review tab, not a new page', () => {
  const attendanceSource = fs.readFileSync(path.resolve(__dirname, './Attendance.tsx'), 'utf-8');

  it('lazy-loads AttendanceServerCalculationPreview the same way the two existing Review sub-pages are loaded', () => {
    expect(attendanceSource).toMatch(/const AttendanceServerCalculationPreviewPage = lazy\(\(\) => import\('\.\/AttendanceServerCalculationPreview'\)\);/);
  });

  it('renders it only inside AttendanceReviewTab, behind its own collapsed toggle', () => {
    const reviewTabBody = attendanceSource.slice(
      attendanceSource.indexOf('function AttendanceReviewTab()'),
      attendanceSource.indexOf('type AttendanceTabId')
    );
    expect(reviewTabBody).toMatch(/showServerPreview/);
    expect(reviewTabBody).toMatch(/<AttendanceServerCalculationPreviewPage \/>/);
  });

  it('does not add any new sidebar/App.tsx route for it', () => {
    expect(attendanceSource).not.toMatch(/path.*AttendanceServerCalculationPreview/i);
  });
});
