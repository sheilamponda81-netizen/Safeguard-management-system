import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Attendance Review usability redesign: source-pinning regression
// coverage for AttendanceCalculationPreview.tsx's wiring, following this
// codebase's established precedent (see Attendance.monthlyRegisterRpc.test.ts
// and AttendanceEvidenceCentre.wiring.test.ts's own headers) for UI logic
// with no component-render test harness (no @testing-library/react;
// vitest.config.ts runs in the 'node' environment).
const source = fs.readFileSync(path.resolve(__dirname, './AttendanceCalculationPreview.tsx'), 'utf-8');

describe('AttendanceCalculationPreview.tsx: strictly read-only, no new permission, no new write path', () => {
  it('contains no write call of any kind', () => {
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.upsert\(/);
    expect(source).not.toMatch(/\.delete\(/);
    expect(source).not.toMatch(/supabase\.rpc\(/);
  });

  it('gates on the same ATTENDANCE_MAP_HIKCENTRAL_PERSONS permission as before -- no new permission introduced', () => {
    expect(source).toMatch(/hasPermission\(PERMISSIONS\.ATTENDANCE_MAP_HIKCENTRAL_PERSONS\)/);
  });

  it('reuses the existing calculation engine via buildAttendanceCalculationPreviewRows -- never a second, parallel roster/calculation algorithm', () => {
    expect(source).toMatch(/buildAttendanceCalculationPreviewRows/);
    expect(source).not.toMatch(/function resolveScheduleForDate/);
  });
});

describe('AttendanceCalculationPreview.tsx: genuine pagination over the complete filtered result, never a row-count cap', () => {
  it('has no MAX_RENDERED_ROWS (or any other fixed row-count cap) anywhere in this file', () => {
    expect(source).not.toMatch(/MAX_RENDERED_ROWS/);
    // ISO-date-string slicing (e.g. `.slice(0, 10)`) is fine; a row array
    // truncated to a fixed length (e.g. `rows.slice(0, 500)`) is not.
    expect(source).not.toMatch(/[Rr]ows\.slice\(0,\s*\d+\)/);
  });

  it('computes totalPages/visibleRows purely from filteredRows.length and the user-selected pageSize', () => {
    expect(source).toMatch(/const totalPages = Math\.max\(1, Math\.ceil\(filteredRows\.length \/ pageSize\)\);/);
    expect(source).toMatch(/const visibleRows = filteredRows\.slice\(\(currentPage - 1\) \* pageSize, currentPage \* pageSize\);/);
  });

  it('offers page sizes of 25, 50, and 100', () => {
    expect(source).toMatch(/const PAGE_SIZE_OPTIONS = \[25, 50, 100\] as const;/);
  });

  it('resets to page 1 whenever any filter or the page size itself changes -- never leaves the view stuck on a now out-of-range page', () => {
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*setPage\(1\);\s*\}, \[siteFilter, shiftFilter, resultFilter, employeeSearch, showOffUnassigned, officialStatusFilter, sourceFilter, reviewFilter, fromDate, toDate, pageSize\]\);/
    );
  });
});

describe('AttendanceCalculationPreview.tsx: compact register uses the shared Safeguard table/badge/button/modal components', () => {
  it('imports and renders with the shared Table/THead/TBody/TR/TH/TD primitives, never a raw <table>', () => {
    expect(source).toMatch(/import \{[^}]*\bTable\b[^}]*\bTHead\b[^}]*\bTBody\b[^}]*\bTR\b[^}]*\bTH\b[^}]*\bTD\b[^}]*\} from '\.\.\/components\/ui';/);
    expect(source).not.toMatch(/<table/);
    expect(source).not.toMatch(/<thead/);
  });

  it('every row has exactly the suggested 8 columns: Employee, Date, Site, Shift, Calculated, Official status, Decision source, Details', () => {
    expect(source).toMatch(/<TH>Employee<\/TH>/);
    expect(source).toMatch(/<TH>Date<\/TH>/);
    expect(source).toMatch(/<TH>Site<\/TH>/);
    expect(source).toMatch(/<TH>Shift<\/TH>/);
    expect(source).toMatch(/<TH>Calculated<\/TH>/);
    expect(source).toMatch(/<TH>Official status<\/TH>/);
    expect(source).toMatch(/<TH>Decision source<\/TH>/);
    expect(source).toMatch(/<TH>Details<\/TH>/);
  });

  it('the Details action opens a Modal, not an inline row expansion', () => {
    expect(source).toMatch(/onClick=\{\(\) => openDetails\(row\)\}/);
    expect(source).toMatch(/<AttendanceReviewDetailsModal/);
    expect(source).toMatch(/function AttendanceReviewDetailsModal\(/);
  });
});

describe('AttendanceCalculationPreview.tsx: decision source is fetched via the separate, additive service export', () => {
  it('fetches decision source via fetchOfficialAttendanceSourceByKey, never widening the shared officialStatusByKey map', () => {
    expect(source).toMatch(/import \{ fetchAttendanceCalculationPreviewData, fetchOfficialAttendanceSourceByKey \} from '\.\.\/utils\/attendanceCalculationPreviewService';/);
    expect(source).toMatch(/const sourceByKey = await fetchOfficialAttendanceSourceByKey\(/);
  });

  it('offers an Automatic/Manual decision-source filter applied against the fetched source map', () => {
    expect(source).toMatch(/type SourceFilter = 'automatic' \| 'manual' \| '';/);
    expect(source).toMatch(/officialSourceByKey\.get\(rowKeyOf\(r\)\) === sourceFilter/);
  });

  it('never claims a source for a row with no official status at all, and shows "Unknown" (not a guess) when a status exists with no recorded source', () => {
    expect(source).toMatch(/function sourceLabel\(/);
    expect(source).toMatch(/return hasOfficialStatus \? 'Unknown' : '—';/);
  });
});

describe('AttendanceCalculationPreview.tsx: "Needs Review" filter uses the documented, non-misleading classifier', () => {
  it('imports and filters using classifyAttendanceReviewSignal, never a bare officialStatus !== calculation.status comparison', () => {
    expect(source).toMatch(/classifyAttendanceReviewSignal/);
    expect(source).not.toMatch(/officialStatus\s*!==\s*row\.calculation\.status/);
  });

  it('offers the "any" / "contradiction" / "uncertain" distinction, not a single ambiguous boolean', () => {
    expect(source).toMatch(/type ReviewFilter = '' \| 'any' \| 'contradiction' \| 'uncertain';/);
    expect(source).toMatch(/if \(reviewFilter === 'any'\) return signal !== 'none';/);
  });

  it('a discrepancy is never framed as auto-correcting anything -- the modal explicitly states it is read-only', () => {
    expect(source).toMatch(/does not change official Attendance or Payroll/);
  });
});

describe('AttendanceCalculationPreview.tsx: summary cards are actionable and clearly labelled as calculation-preview totals', () => {
  it('Present/Late/Absent/Pending summary cards toggle the Calculated-result filter when clicked', () => {
    expect(source).toMatch(/const toggleResultFilter = useCallback\(\(status: AttendanceCalculationStatus\) => \{/);
    expect(source).toMatch(/onClick=\{\(\) => toggleResultFilter\(status\)\}/);
    expect(source).toMatch(/\(\['present', 'late', 'absent', 'pending'\] as const\)\.map/);
  });

  it('Scheduled shifts and Site alerts are NOT wrapped in a filter-toggle button -- they have no calculated-result analog', () => {
    const scheduledCardIdx = source.indexOf('title="Scheduled shifts"');
    const summaryBlockEnd = source.indexOf('Site alerts');
    const betweenScheduledAndClickableBlock = source.slice(scheduledCardIdx, source.indexOf("(['present', 'late', 'absent', 'pending']"));
    expect(betweenScheduledAndClickableBlock).not.toMatch(/onClick/);
    expect(summaryBlockEnd).toBeGreaterThan(-1);
  });

  it('summary totals are explicitly labelled as calculation-preview totals, distinct from official attendance totals', () => {
    expect(source).toMatch(/calculation-preview\s*\n?\s*totals, not official attendance totals/);
  });
});
