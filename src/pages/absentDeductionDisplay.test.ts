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
// The late-arrival rate is intentionally NOT touched here -- it is a
// separate configured setting that may legitimately still read "MK 4,200".
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

  it('Payroll.tsx: absenteeism labels use formatKwacha(payrollRates.absentDeduction)', () => {
    const matches = payrollSource.match(/formatKwacha\(payrollRates\.absentDeduction\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('Payroll.tsx: the late-arrival rate is left untouched (still MK 4,200)', () => {
    expect(payrollSource).toMatch(/Late Arrival:\s*MK\s*4,200 per late day/);
    expect(payrollSource).toMatch(/Late \(MK4,200\/day\)/);
    expect(payrollSource).toMatch(/Late:\s*\{attendance!\.lateDays\}\s*×\s*MK4,200/);
  });

  it('Payslips.tsx: no remaining "Absent (... × MK4,200)" hardcoded label', () => {
    expect(payslipsSource).not.toMatch(/Absent\s*\(\$\{absentDays\}\s*×\s*MK4,?200\)/);
  });

  it('Payslips.tsx: absence breakdown uses formatKwacha(payrollRates.absentDeduction)', () => {
    const matches = payslipsSource.match(/formatKwacha\(payrollRates\.absentDeduction\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Payslips.tsx: the late-arrival rate is left untouched (still MK4,200)', () => {
    const matches = payslipsSource.match(/Late \(\$\{lateDays\} × MK4,200\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
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
