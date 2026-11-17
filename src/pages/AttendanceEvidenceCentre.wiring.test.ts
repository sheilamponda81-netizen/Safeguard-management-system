import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Attendance Evidence Centre, read-only v1: source-pinning regression
// coverage for the tab wiring in Attendance.tsx, following this
// codebase's established precedent (see Attendance.monthlyRegisterRpc.test.ts)
// for UI logic with no component-render test harness (no
// @testing-library/react; vitest.config.ts runs in the 'node' environment).
const attendanceSource = fs.readFileSync(path.resolve(__dirname, './Attendance.tsx'), 'utf-8');
const evidenceCentreSource = fs.readFileSync(path.resolve(__dirname, './AttendanceEvidenceCentre.tsx'), 'utf-8');

describe('Attendance.tsx: Evidence Centre tab wiring', () => {
  it('lazy-loads AttendanceEvidenceCentre, never a static top-level import (same no-preloading discipline as the other preview sub-pages)', () => {
    expect(attendanceSource).toMatch(/const AttendanceEvidenceCentrePage = lazy\(\(\) => import\('\.\/AttendanceEvidenceCentre'\)\);/);
  });

  it('gates the Evidence Centre tab behind the SAME permission check as the Review tab -- never a separate, narrower or wider permission', () => {
    const permissionCheckBody = attendanceSource.slice(
      attendanceSource.indexOf('export default function AttendancePage()'),
      attendanceSource.indexOf('const effectiveTab:')
    );
    expect(permissionCheckBody).toMatch(/setCanReview\(await hasPermission\(PERMISSIONS\.ATTENDANCE_MAP_HIKCENTRAL_PERSONS\)\);/);
    // Only ONE permission check exists for both tabs -- confirms no second,
    // independent gate was introduced for Evidence Centre specifically.
    expect((attendanceSource.match(/hasPermission\(/g) || []).length).toBe(1);
  });

  it('never renders the Evidence Centre tab content when canReview is false, even if activeTab were somehow already "evidence"', () => {
    expect(attendanceSource).toMatch(/const effectiveTab: AttendanceTabId = canReview \? activeTab : 'register';/);
  });

  it('the Evidence Centre tab button is declared inside the canReview-gated <Tabs> block, alongside Monthly Register/Review', () => {
    expect(attendanceSource).toMatch(
      /\{ id: 'register', label: 'Monthly Register'.*\n.*\{ id: 'review', label: 'Attendance Review'.*\n.*\{ id: 'evidence', label: 'Evidence Centre'/
    );
  });

  it('wraps the lazy-loaded page in Suspense, matching the other preview sub-pages', () => {
    expect(attendanceSource).toMatch(
      /\{effectiveTab === 'evidence' && \(\s*<Suspense fallback={<PreviewLoadingFallback \/>}>\s*<AttendanceEvidenceCentrePage \/>\s*<\/Suspense>\s*\)\}/
    );
  });
});

describe('AttendanceEvidenceCentre.tsx: strictly read-only, no new permission, no new write path', () => {
  it('contains no write call of any kind -- no .insert(/.update(/.upsert(/.delete(/.rpc( that is not the existing read-only attendance_preview_calculate/fetchServerCalculationPreview path', () => {
    expect(evidenceCentreSource).not.toMatch(/\.insert\(/);
    expect(evidenceCentreSource).not.toMatch(/\.update\(/);
    expect(evidenceCentreSource).not.toMatch(/\.upsert\(/);
    expect(evidenceCentreSource).not.toMatch(/\.delete\(/);
    expect(evidenceCentreSource).not.toMatch(/supabase\.rpc\(/); // any RPC call goes through the existing fetchServerCalculationPreview wrapper, never a raw .rpc() here
  });

  it('gates on the same ATTENDANCE_MAP_HIKCENTRAL_PERSONS permission as the rest of the Review surface -- no new permission introduced', () => {
    expect(evidenceCentreSource).toMatch(/hasPermission\(PERMISSIONS\.ATTENDANCE_MAP_HIKCENTRAL_PERSONS\)/);
  });

  it('reuses the existing calculation engine via buildAttendanceCalculationPreviewRows -- never a second, parallel roster/calculation algorithm', () => {
    expect(evidenceCentreSource).toMatch(/buildAttendanceCalculationPreviewRows/);
    expect(evidenceCentreSource).toMatch(/collectEmployeeIdsWithRosterEvidence/);
    expect(evidenceCentreSource).not.toMatch(/function resolveScheduleForDate/); // never redefined locally
  });

  it('reuses the existing server-authoritative recalculation RPC wrapper for the "calculated result" comparison, never a client-only approximation standing in for it', () => {
    expect(evidenceCentreSource).toMatch(/fetchAttendanceEvidenceDetail/);
  });

  it('Phase 3 safety review: displays WHO confirmed coverage -- durable attribution in the database must also be visible to a reviewing administrator', () => {
    expect(evidenceCentreSource).toMatch(/by \{c\.confirmedBy\}/);
  });
});
