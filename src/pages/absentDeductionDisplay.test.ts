import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Regression pin: the absence-deduction rate is a configured value
// (payrollRates.absentDeduction, from system_settings) and can change without
// a code deploy, but the UI/PDF/help text previously hardcoded it as
// "MK4,200" / "MK 4,200". This repo has no React component-rendering test
// infrastructure (no @testing-library/react dependency), so these tests pin
// the fix at the source level: the literal hardcoded absence string must not
// reappear, and each display must derive its value from the configured rate.
// SAFEGUARD -- October attendance/payroll investigation (Harold Kanada,
// SFG-S-790): the late-arrival rate's hardcoded "MK 4,200" text, previously
// left untouched here as a deliberate scope decision, is now confirmed to be
// simply wrong for a real tenant (its actual configured late_day_deduction is
// MK 0, an explicit, valid configured rate -- see the October payroll
// hotfix's own "explicit 0 is valid" principle), so the three late-arrival
// labels below are now fixed the same way the absence ones already were.
// That round deliberately left the per-employee/per-payslip late rate
// reading the LIVE payrollRates.lateDeduction (Payroll.tsx) or a hardcoded
// "MK4,200" literal (Payslips.tsx) directly, documented as "a known,
// narrower residual gap... closing it fully would mean adding a late-day
// counterpart to getHistoricalSafeAbsentRate".
//
// SAFEGUARD -- Salary Advances + Payroll & Payslip Financial Transparency
// audit: that gap is now closed. getHistoricalSafeLateRate() (mirroring
// getHistoricalSafeAbsentRate exactly -- see its own tests in
// payrollCalculations.test.ts) now backs the per-employee row breakdown in
// Payroll.tsx and the per-record absence/late breakdown in Payslips.tsx, so
// neither can mislabel an already-processed historical month's late
// deduction with today's rate (or a stale literal) if late_day_deduction has
// since changed. The page-level/generic explainers this file's own header
// already exempts for the absence rate (a banner or confirmation modal that
// only ever describes the CURRENT month about to be processed) remain
// exempt here too, and still read payrollRates.lateDeduction directly.
//
// A second regression is pinned here too: a per-employee/per-payslip absence
// display (which can render an already-processed HISTORICAL month) must use
// getHistoricalSafeAbsentRate -- deriving the rate from that record's own
// frozen employee_deductions amount/days -- rather than the live
// payrollRates.absentDeduction directly, which reflects only TODAY's
// system_settings and would relabel a past month's deduction with a rate
// that didn't apply when it was processed. A page-level/generic explainer
// that isn't tied to one employee's stored record (e.g. Payroll.tsx's
// deduction-summary banner, or its "Process Payroll" confirmation modal,
// which only ever describes the CURRENT month about to be processed) is
// exempt -- it may legitimately keep using the live rate directly. (The
// old "Net Pay Formula"/"Gross Pay Formula" reference cards, which used to
// carry one such occurrence, were removed in the Payroll Management page
// redesign -- the calculation functions they described are untouched,
// only that explanatory card is gone.) See getHistoricalSafeAbsentRate's
// own tests in payrollCalculations.test.ts for the historical-vs-live
// derivation itself.
const payrollSource = fs.readFileSync(
  path.resolve(__dirname, './Payroll.tsx'),
  'utf-8'
);
const payslipsSource = fs.readFileSync(
  path.resolve(__dirname, './Payslips.tsx'),
  'utf-8'
);
const userManualSource = fs.readFileSync(
  path.resolve(__dirname, './UserManual.tsx'),
  'utf-8'
);

describe('Absence-deduction display derives from configured payroll rate, not a hardcoded amount', () => {
  it('Payroll.tsx: no remaining "Absenteeism: MK 4,200" hardcoded label', () => {
    expect(payrollSource).not.toMatch(/Absenteeism:\s*MK\s*4,?200/);
  });

  it('Payroll.tsx: no remaining "Absent (MK4,200/day)" hardcoded label', () => {
    expect(payrollSource).not.toMatch(/Absent\s*\(MK4,?200\/day\)/);
  });

  it('Payroll.tsx: no remaining "Absent: {days} × MK4,200" hardcoded label', () => {
    expect(payrollSource).not.toMatch(/Absent:\s*\{attendance!\.absentDays\}\s*×\s*MK4,?200/);
  });

  it('Payroll.tsx: the generic (non-employee-specific) absenteeism labels use formatKwacha(payrollRates.absentDeduction) -- the deduction-summary banner\'s live-month branch and the Process/Reprocess Payroll modal (which only ever describes the current month)', () => {
    const matches = payrollSource.match(/formatKwacha\(payrollRates\.absentDeduction\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Payroll.tsx: the per-employee row breakdown derives its absent-day rate via a verified snapshot\'s own frozen rate when one exists, else getHistoricalSafeAbsentRate, never the live rate directly, since this row can be an already-processed historical month', () => {
    expect(payrollSource).toMatch(
      /Absent:\s*\{snapshot\?\.absenceDays \?\? attendance\?\.absentDays \?\? 0\}\s*×\s*\{formatKwacha\(snapshot\?\.absenceRate \?\? getHistoricalSafeAbsentRate\(\{\s*frozenAbsentDeduction:\s*deduction\?\.absent_deduction,\s*frozenAbsentDays:\s*deduction\?\.absent_days,\s*liveConfiguredRate:\s*payrollRates\.absentDeduction\s*\}\)\)\}/
    );
  });

  it('Payroll.tsx: the deduction-summary banner (which can render for a historical/past month) only shows the live numeric absence rate when the selected month is current/future', () => {
    expect(payrollSource).toMatch(/Absenteeism:\s*\{\(isCurrentMonth \|\| isFutureMonthSelected\)\s*\?\s*`\$\{formatKwacha\(payrollRates\.absentDeduction\)\} per absent day`/);
  });

  it('Payroll.tsx: the deduction-summary banner falls back to non-numeric wording for a historical/past month, instead of relabeling it with today\'s rate', () => {
    expect(payrollSource).toMatch(/rate in effect when each employee.{0,2}s payroll was processed/);
  });

  it('Payroll.tsx: no remaining "Late Arrival: MK 4,200 per late day" hardcoded label', () => {
    expect(payrollSource).not.toMatch(/Late Arrival:\s*MK\s*4,200 per late day/);
  });

  it('Payroll.tsx: no remaining "Late: {days} × MK4,200" hardcoded label', () => {
    expect(payrollSource).not.toMatch(/Late:\s*\{attendance!\.lateDays\}\s*×\s*MK4,?200/);
  });

  it('Payroll.tsx: the generic (non-employee-specific) late-arrival labels use formatKwacha(payrollRates.lateDeduction) directly -- the deduction-summary banner\'s live-month branch and the Process/Reprocess Payroll modal (which only ever describe the current month)', () => {
    const matches = payrollSource.match(/formatKwacha\(payrollRates\.lateDeduction\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Payroll.tsx: the per-employee row breakdown derives its late-day rate via a verified snapshot\'s own frozen rate when one exists, else getHistoricalSafeLateRate, never the live rate directly, since this row can be an already-processed historical month', () => {
    expect(payrollSource).toMatch(
      /Late:\s*\{snapshot\?\.lateDays \?\? attendance\?\.lateDays \?\? 0\}\s*×\s*\{formatKwacha\(snapshot\?\.lateRate \?\? getHistoricalSafeLateRate\(\{\s*frozenLateDeduction:\s*deduction\?\.late_deduction,\s*frozenLateDays:\s*deduction\?\.late_days,\s*liveConfiguredRate:\s*payrollRates\.lateDeduction\s*\}\)\)\}/
    );
  });

  it('Payroll.tsx: the deduction-summary banner falls back to non-numeric wording for Late Arrival too on a historical/past month', () => {
    expect(payrollSource).toMatch(/Late Arrival:\s*\{\(isCurrentMonth \|\| isFutureMonthSelected\)\s*\?\s*`\$\{formatKwacha\(payrollRates\.lateDeduction\)\} per late day`/);
  });

  it('Payslips.tsx: no remaining "Absent (... × MK4,200)" hardcoded label', () => {
    expect(payslipsSource).not.toMatch(/Absent\s*\(\$\{absentDays\}\s*×\s*MK4,?200\)/);
  });

  it('Payslips.tsx: absence breakdown derives its rate via getHistoricalSafeAbsentRate (never the live rate directly), since a payslip can be for an already-processed historical month', () => {
    const matches = payslipsSource.match(
      /formatKwacha\(getHistoricalSafeAbsentRate\(\{\s*frozenAbsentDeduction:\s*p\.absent_deduction,\s*frozenAbsentDays:\s*p\.absent_days,\s*liveConfiguredRate:\s*payrollRates\.absentDeduction\s*\}\)\)/g
    ) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Payslips.tsx: no absence display uses the live payrollRates.absentDeduction directly', () => {
    expect(payslipsSource).not.toMatch(/formatKwacha\(payrollRates\.absentDeduction\)/);
  });

  it('Payslips.tsx: no remaining hardcoded "MK4,200" late-arrival literal', () => {
    expect(payslipsSource).not.toMatch(/MK4,200/);
  });

  it('Payslips.tsx: late breakdown derives its rate via getHistoricalSafeLateRate (never a hardcoded literal or the live rate directly), since a payslip can be for an already-processed historical month', () => {
    const matches = payslipsSource.match(
      /formatKwacha\(getHistoricalSafeLateRate\(\{\s*frozenLateDeduction:\s*p\.late_deduction,\s*frozenLateDays:\s*p\.late_days,\s*liveConfiguredRate:\s*payrollRates\.lateDeduction\s*\}\)\)/g
    ) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('UserManual.tsx: no remaining stale fixed absence rate text', () => {
    expect(userManualSource).not.toMatch(/Absent\s*\(A\)\s*→\s*MK\s*4,200/);
    expect(userManualSource).not.toMatch(/Absent\/Late\s*=\s*MK\s*4,200\/day/);
    expect(userManualSource).not.toMatch(/Automatic calculation:\s*MK\s*4,200 per absent\/late day/);
  });

  it('UserManual.tsx: explains the absence rate is configured in Settings', () => {
    expect(userManualSource).toMatch(/configured in Settings/);
    expect(userManualSource).toMatch(/configured Absent rate/);
  });

  it('UserManual.tsx: the late-arrival rate text is left untouched (still MK 4,200)', () => {
    expect(userManualSource).toMatch(/Late \(L\)\s*→\s*MK\s*4,200/);
  });
});
