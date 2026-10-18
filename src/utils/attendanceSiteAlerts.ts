// Safeguard HikCentral Attendance MVP -- Phase 2C, Stage A: pure
// site-level attendance alert aggregator.
//
// Consumes a batch of already-calculated per-employee attendance results
// (attendanceCalculationEngine.ts's output) and raises an alert for a
// workstation/shift/date group only when 5 or more DISTINCT employees
// scheduled there are confirmed Absent for a fingerprint-data reason.
// Pending, Late, Off, Unassigned, and (not produced by this engine at
// all, so naturally excluded by the type) Leave results never count
// toward the threshold and never raise an alert on their own.
//
// "No successful fingerprint records" is deliberately never worded as
// "no attempts" or "no one tried" -- HikCentral denied/failed scans are
// not currently persisted per-person/date/site anywhere (only an
// unverified aggregate count per import batch), so this module has no
// basis to claim attempts never happened, only that no successful,
// authorized scan was recorded.
import { AttendanceCalculationResult } from './attendanceCalculationEngine';

export const SITE_ALERT_THRESHOLD = 5;

export interface SiteAlertCase {
  employeeId: string;
  workstation: string;
  shift: 'day' | 'night';
  /** The shift's own starting calendar date, matching AttendanceCalculationInput.shiftDate. */
  shiftDate: string;
  result: AttendanceCalculationResult;
}

export interface SiteAlertBreakdown {
  noFingerprintRecords: number;
  checkInOnly: number;
  checkoutOnly: number;
}

export interface SiteAlert {
  workstation: string;
  shift: 'day' | 'night';
  shiftDate: string;
  affectedEmployeeIds: string[];
  totalCount: number;
  breakdown: SiteAlertBreakdown;
  message: string;
}

type GroupKey = string;

function groupKeyOf(workstation: string, shift: 'day' | 'night', shiftDate: string): GroupKey {
  return `${workstation}\u0000${shift}\u0000${shiftDate}`;
}

function classify(result: AttendanceCalculationResult): keyof SiteAlertBreakdown | null {
  if (result.status !== 'absent') return null;
  if (result.checkInIso && !result.checkOutIso) return 'checkInOnly';
  if (!result.checkInIso && result.checkOutIso) return 'checkoutOnly';
  return 'noFingerprintRecords';
}

function buildMessage(workstation: string, shift: 'day' | 'night', shiftDate: string, breakdown: SiteAlertBreakdown, totalCount: number): string {
  const nonZeroCategories = (['noFingerprintRecords', 'checkInOnly', 'checkoutOnly'] as const).filter((k) => breakdown[k] > 0);
  const shiftLabel = shift === 'day' ? 'Day' : 'Night';
  const prefix = `${workstation} (${shiftLabel} shift, ${shiftDate}): ${totalCount} employees confirmed absent`;

  if (nonZeroCategories.length === 1) {
    const only = nonZeroCategories[0];
    if (only === 'noFingerprintRecords') return `${prefix} -- no successful fingerprint records for any of them.`;
    if (only === 'checkInOnly') return `${prefix} -- all have a successful check-in but no valid checkout.`;
    return `${prefix} -- all have a successful checkout but no valid check-in.`;
  }

  const parts: string[] = [];
  if (breakdown.noFingerprintRecords > 0) parts.push(`${breakdown.noFingerprintRecords} with no successful fingerprint records`);
  if (breakdown.checkInOnly > 0) parts.push(`${breakdown.checkInOnly} with check-in only`);
  if (breakdown.checkoutOnly > 0) parts.push(`${breakdown.checkoutOnly} with checkout only`);
  return `${prefix} -- mixed causes: ${parts.join(', ')}.`;
}

/**
 * Pure, stateless aggregation: groups by (workstation, shift,
 * shiftDate), counts only confirmed-Absent, fingerprint-related cases
 * (deduplicated by employeeId within a group), and emits an alert for
 * each group reaching SITE_ALERT_THRESHOLD or more distinct employees.
 * Never suppresses an alert because OTHER employees in the same group
 * are Pending/Late/Off/Unassigned -- those are simply excluded from the
 * count, not a reason to withhold an alert about the confirmed subset.
 */
export function aggregateSiteAlerts(cases: SiteAlertCase[]): SiteAlert[] {
  const groups = new Map<GroupKey, { workstation: string; shift: 'day' | 'night'; shiftDate: string; byEmployee: Map<string, keyof SiteAlertBreakdown> }>();

  for (const c of cases) {
    const category = classify(c.result);
    if (category === null) continue;
    const key = groupKeyOf(c.workstation, c.shift, c.shiftDate);
    let group = groups.get(key);
    if (!group) {
      group = { workstation: c.workstation, shift: c.shift, shiftDate: c.shiftDate, byEmployee: new Map() };
      groups.set(key, group);
    }
    // One confirmed-absent result per employee per group is expected; if
    // duplicates ever arrive, keep the first classification seen rather
    // than double counting.
    if (!group.byEmployee.has(c.employeeId)) group.byEmployee.set(c.employeeId, category);
  }

  const alerts: SiteAlert[] = [];
  for (const group of groups.values()) {
    const affectedEmployeeIds = Array.from(group.byEmployee.keys());
    if (affectedEmployeeIds.length < SITE_ALERT_THRESHOLD) continue;

    const breakdown: SiteAlertBreakdown = { noFingerprintRecords: 0, checkInOnly: 0, checkoutOnly: 0 };
    for (const category of group.byEmployee.values()) breakdown[category]++;

    alerts.push({
      workstation: group.workstation,
      shift: group.shift,
      shiftDate: group.shiftDate,
      affectedEmployeeIds,
      totalCount: affectedEmployeeIds.length,
      breakdown,
      message: buildMessage(group.workstation, group.shift, group.shiftDate, breakdown, affectedEmployeeIds.length),
    });
  }
  return alerts;
}
