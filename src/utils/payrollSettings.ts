import { supabase } from '../lib/supabase';

// Default rates match what calculatePayroll previously hardcoded, so existing
// payroll math doesn't change until an admin actually edits these in Settings.
const DEFAULT_PAYE_RATE = 0.30;
const DEFAULT_PAYE_THRESHOLD = 50000;
const DEFAULT_PENSION_EMPLOYEE_RATE = 0.05;
const DEFAULT_UNIFORM_DEDUCTION = 10000;
const DEFAULT_ABSENT_DEDUCTION = 4200;
const DEFAULT_LATE_DEDUCTION = 4200;
const DEFAULT_LECTURE_DEDUCTION = 3000;
const DEFAULT_LECTURE_FULL_MONTH_DEDUCTION = 15000;
const DEFAULT_APPEARANCE_DEDUCTION = 2000;

export interface PayrollRates {
  payeRate: number;
  payeThreshold: number;
  pensionEmployeeRate: number;
  uniformDeduction: number;
  absentDeduction: number;
  lateDeduction: number;
  lectureDeduction: number;
  lectureFullMonthDeduction: number;
  appearanceDeduction: number;
}

const KEYS = {
  payeRate: 'paye_rate',
  payeThreshold: 'paye_threshold',
  pensionEmployeeRate: 'pension_employee_rate',
  uniformDeduction: 'uniform_deduction_default',
  absentDeduction: 'absent_day_deduction',
  lateDeduction: 'late_day_deduction',
  lectureDeduction: 'lecture_absence_deduction',
  lectureFullMonthDeduction: 'lecture_full_month_deduction',
  appearanceDeduction: 'appearance_deduction',
} as const;

export const DEFAULT_RATES: PayrollRates = {
  payeRate: DEFAULT_PAYE_RATE,
  payeThreshold: DEFAULT_PAYE_THRESHOLD,
  pensionEmployeeRate: DEFAULT_PENSION_EMPLOYEE_RATE,
  uniformDeduction: DEFAULT_UNIFORM_DEDUCTION,
  absentDeduction: DEFAULT_ABSENT_DEDUCTION,
  lateDeduction: DEFAULT_LATE_DEDUCTION,
  lectureDeduction: DEFAULT_LECTURE_DEDUCTION,
  lectureFullMonthDeduction: DEFAULT_LECTURE_FULL_MONTH_DEDUCTION,
  appearanceDeduction: DEFAULT_APPEARANCE_DEDUCTION,
};

// Shared, per-tenant payroll rates -- stored in `system_settings` (the same table
// and upsert pattern already proven by getSystemCurrentMonth/setSystemCurrentMonth
// in currentMonth.ts) so every admin's browser sees the same configured rates,
// instead of the Settings page's previous localStorage-only values that Payroll
// never actually read.
export const getPayrollRates = async (): Promise<PayrollRates> => {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', Object.values(KEYS));

    if (error) {
      console.error('Error fetching payroll rates:', error);
      return { ...DEFAULT_RATES };
    }

    const byKey = new Map((data || []).map(row => [row.key, row.value]));
    const parsedOrDefault = (key: string, fallback: number) => {
      const raw = byKey.get(key);
      const parsed = raw !== undefined ? parseFloat(raw) : NaN;
      return isNaN(parsed) ? fallback : parsed;
    };

    return {
      payeRate: parsedOrDefault(KEYS.payeRate, DEFAULT_PAYE_RATE),
      payeThreshold: parsedOrDefault(KEYS.payeThreshold, DEFAULT_PAYE_THRESHOLD),
      pensionEmployeeRate: parsedOrDefault(KEYS.pensionEmployeeRate, DEFAULT_PENSION_EMPLOYEE_RATE),
      uniformDeduction: parsedOrDefault(KEYS.uniformDeduction, DEFAULT_UNIFORM_DEDUCTION),
      absentDeduction: parsedOrDefault(KEYS.absentDeduction, DEFAULT_ABSENT_DEDUCTION),
      lateDeduction: parsedOrDefault(KEYS.lateDeduction, DEFAULT_LATE_DEDUCTION),
      lectureDeduction: parsedOrDefault(KEYS.lectureDeduction, DEFAULT_LECTURE_DEDUCTION),
      lectureFullMonthDeduction: parsedOrDefault(KEYS.lectureFullMonthDeduction, DEFAULT_LECTURE_FULL_MONTH_DEDUCTION),
      appearanceDeduction: parsedOrDefault(KEYS.appearanceDeduction, DEFAULT_APPEARANCE_DEDUCTION),
    };
  } catch (err) {
    console.error('Unexpected error in getPayrollRates:', err);
    return { ...DEFAULT_RATES };
  }
};

// SAFEGUARD -- October 2026 payroll hotfix, fail-closed payroll-settings
// patch. `getPayrollRates()` above is left completely UNCHANGED (same
// name, same lenient DEFAULT_RATES-on-any-failure behavior) specifically
// for the small number of existing, already-reviewed, non-critical
// display-only consumers that are proven to depend on it never rejecting
// (Attendance.tsx's own lecture-deduction preview label, Payslips.tsx's
// printed "PAYE Tax (X%)" rate label) -- changing that function's
// contract would require giving both of those call sites their own new
// failure-handling UI for no safety benefit, since neither commits a
// financial record or writes back to system_settings.
//
// Every call site that actually PREVIEWS, APPROVES, PROCESSES, or WRITES
// BACK payroll-affecting figures (Payroll.tsx, Payments.tsx, Dashboard.tsx,
// Reports.tsx, and critically Misc.tsx's Settings-page save/cancel
// handlers, which re-fetch current rates and spread them into a PARTIAL
// update -- a silently-defaulted fetch there would SILENTLY OVERWRITE an
// unrelated, already-correctly-configured rate, e.g. resetting pension
// back to 5% while an admin was only saving a change to PAYE) must use
// THIS function instead.
//
// Classification, matching the business requirement that explicit
// configuration -- including an explicit 0 -- must never be silently
// replaced by a hardcoded default, while continuing to support a tenant
// that has never touched Settings at all:
//   - A setting with NO ROW in system_settings at all -> uses the
//     documented historical DEFAULT_* constant for that one field. This
//     is long-standing, intentional, pre-existing behavior (see this
//     file's own top-of-file comment: "Default rates match what
//     calculatePayroll previously hardcoded, so existing payroll math
//     doesn't change until an admin actually edits these") -- NOT the bug
//     this patch fixes, and changing it would break every tenant that has
//     never opened the Payroll Settings tab.
//   - A setting whose row EXISTS but whose value is not a valid number
//     (corrupted/malformed) -> the WHOLE result is `unavailable`. This is
//     NOT the same as "never configured" -- someone explicitly set this
//     field and it is now unreadable, which must never be silently
//     papered over with a guessed value.
//   - The query itself errors (network/database failure) -> the WHOLE
//     result is `unavailable`. Zero fields were read successfully, so
//     there is nothing to selectively default.
//   - A setting whose row exists and parses successfully, INCLUDING
//     EXACTLY 0 -- `parseFloat('0') === 0`, never NaN -- is returned
//     verbatim. This already worked correctly before this patch; it is
//     restated here only to make the contract explicit.
export interface PayrollRatesUnavailable {
  status: 'unavailable';
  /** Human-readable reason, safe to show directly in an error banner. */
  reason: string;
}
export interface PayrollRatesOk {
  status: 'ok';
  rates: PayrollRates;
}
export type PayrollRatesResult = PayrollRatesOk | PayrollRatesUnavailable;

export async function getPayrollRatesStrict(): Promise<PayrollRatesResult> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', Object.values(KEYS));

    if (error) {
      console.error('getPayrollRatesStrict: fetch error, reporting unavailable rather than defaulting:', error);
      return { status: 'unavailable', reason: 'Could not reach the server to load payroll rate settings. Nothing was defaulted or assumed.' };
    }

    const byKey = new Map((data || []).map(row => [row.key, row.value]));
    let malformedKey: string | null = null;
    const parsedOrDefault = (key: string, fallback: number): number => {
      const raw = byKey.get(key);
      if (raw === undefined) return fallback; // genuinely never configured -- the documented historical default
      const parsed = parseFloat(raw);
      if (isNaN(parsed)) {
        malformedKey = key; // configured, but corrupted -- never silently defaulted
        return fallback; // discarded below once malformedKey is set; keeps this helper's return type a plain number
      }
      return parsed;
    };

    const rates: PayrollRates = {
      payeRate: parsedOrDefault(KEYS.payeRate, DEFAULT_PAYE_RATE),
      payeThreshold: parsedOrDefault(KEYS.payeThreshold, DEFAULT_PAYE_THRESHOLD),
      pensionEmployeeRate: parsedOrDefault(KEYS.pensionEmployeeRate, DEFAULT_PENSION_EMPLOYEE_RATE),
      uniformDeduction: parsedOrDefault(KEYS.uniformDeduction, DEFAULT_UNIFORM_DEDUCTION),
      absentDeduction: parsedOrDefault(KEYS.absentDeduction, DEFAULT_ABSENT_DEDUCTION),
      lateDeduction: parsedOrDefault(KEYS.lateDeduction, DEFAULT_LATE_DEDUCTION),
      lectureDeduction: parsedOrDefault(KEYS.lectureDeduction, DEFAULT_LECTURE_DEDUCTION),
      lectureFullMonthDeduction: parsedOrDefault(KEYS.lectureFullMonthDeduction, DEFAULT_LECTURE_FULL_MONTH_DEDUCTION),
      appearanceDeduction: parsedOrDefault(KEYS.appearanceDeduction, DEFAULT_APPEARANCE_DEDUCTION),
    };

    if (malformedKey) {
      console.error(`getPayrollRatesStrict: setting "${malformedKey}" exists but is not a valid number -- reporting unavailable rather than defaulting.`);
      return { status: 'unavailable', reason: `A payroll setting ("${malformedKey}") is configured but is not a valid number. Fix it in Settings before continuing.` };
    }

    return { status: 'ok', rates };
  } catch (err) {
    console.error('getPayrollRatesStrict: unexpected error, reporting unavailable rather than defaulting:', err);
    return { status: 'unavailable', reason: 'Unexpected error loading payroll rate settings. Nothing was defaulted or assumed.' };
  }
}

const upsertSetting = async (key: string, value: string, userId: string): Promise<boolean> => {
  const { data: existing, error: checkError } = await supabase
    .from('system_settings')
    .select('id')
    .eq('key', key)
    .maybeSingle();

  if (checkError) {
    console.error(`Error checking existing setting ${key}:`, checkError);
    return false;
  }

  const result = existing
    ? await supabase
        .from('system_settings')
        .update({ value, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('id', existing.id)
    : await supabase
        .from('system_settings')
        .insert([{ key, value, updated_by: userId }]);

  if (result.error) {
    console.error(`Error saving setting ${key}:`, result.error);
    return false;
  }
  return true;
};

export const setPayrollRates = async (rates: PayrollRates, userId: string): Promise<boolean> => {
  const results = await Promise.all(
    (Object.keys(KEYS) as (keyof typeof KEYS)[]).map(field =>
      upsertSetting(KEYS[field], String(rates[field]), userId)
    )
  );
  return results.every(Boolean);
};
