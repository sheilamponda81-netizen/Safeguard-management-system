import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Safeguard Stage C, Step 3: the Apply-to-Monthly-Register control on the
// new Server Calculation Preview section must be unconditionally
// disabled -- never wired to attendance_apply_automatic, never enabled
// by any permission check alone -- until the tenant-scoping/coverage-
// window fix and a controlled STAGING test are separately approved.
const previewSource = fs.readFileSync(path.resolve(__dirname, './AttendanceServerCalculationPreview.tsx'), 'utf-8');

describe('AttendanceServerCalculationPreview: the Apply action is hard-disabled', () => {
  it('the Apply button is unconditionally disabled, not gated on a permission or state flag', () => {
    expect(previewSource).toMatch(/<Button className="mt-3" disabled title="[^"]+">\s*Apply to Monthly Register/);
  });

  it('never calls attendance_apply_automatic from this page (mentioning it in explanatory copy is fine; invoking it is not)', () => {
    expect(previewSource).not.toMatch(/rpc\(['"]attendance_apply_automatic['"]/);
  });

  it('the preview itself never calls a write-shaped Supabase method', () => {
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
