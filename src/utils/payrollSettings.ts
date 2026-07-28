import { supabase } from '../lib/supabase';

// Default rates match what calculatePayroll previously hardcoded, so existing
// payroll math doesn't change until an admin actually edits these in Settings.
const DEFAULT_PAYE_RATE = 0.30;
const DEFAULT_PAYE_THRESHOLD = 50000;
const DEFAULT_PENSION_EMPLOYEE_RATE = 0.05;

export interface PayrollRates {
  payeRate: number;
  payeThreshold: number;
  pensionEmployeeRate: number;
}

const KEYS = {
  payeRate: 'paye_rate',
  payeThreshold: 'paye_threshold',
  pensionEmployeeRate: 'pension_employee_rate',
} as const;

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
      .in('key', [KEYS.payeRate, KEYS.payeThreshold, KEYS.pensionEmployeeRate]);

    if (error) {
      console.error('Error fetching payroll rates:', error);
      return {
        payeRate: DEFAULT_PAYE_RATE,
        payeThreshold: DEFAULT_PAYE_THRESHOLD,
        pensionEmployeeRate: DEFAULT_PENSION_EMPLOYEE_RATE,
      };
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
    };
  } catch (err) {
    console.error('Unexpected error in getPayrollRates:', err);
    return {
      payeRate: DEFAULT_PAYE_RATE,
      payeThreshold: DEFAULT_PAYE_THRESHOLD,
      pensionEmployeeRate: DEFAULT_PENSION_EMPLOYEE_RATE,
    };
  }
};

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
  const results = await Promise.all([
    upsertSetting(KEYS.payeRate, String(rates.payeRate), userId),
    upsertSetting(KEYS.payeThreshold, String(rates.payeThreshold), userId),
    upsertSetting(KEYS.pensionEmployeeRate, String(rates.pensionEmployeeRate), userId),
  ]);
  return results.every(Boolean);
};
