import { supabase } from '../lib/supabase';

const DEFAULT_PAGE_SIZE = 20;
const KEY = 'default_page_size';

// Shared, per-tenant default page size for every paginated list in the app
// (Employees, Attendance, Payroll, Payslips, Payments, Recruitment, Security,
// Terminal Dues) -- stored in `system_settings`, same key/value table and
// upsert pattern as payrollSettings.ts/companySettings.ts. Each page still
// lets a user change the page size for their own session; this only controls
// what it starts at.
export const getDefaultPageSize = async (): Promise<number> => {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', KEY)
      .maybeSingle();

    if (error || !data?.value) return DEFAULT_PAGE_SIZE;
    const parsed = parseInt(data.value, 10);
    return isNaN(parsed) || parsed <= 0 ? DEFAULT_PAGE_SIZE : parsed;
  } catch (err) {
    console.error('Unexpected error in getDefaultPageSize:', err);
    return DEFAULT_PAGE_SIZE;
  }
};

export const setDefaultPageSize = async (pageSize: number, userId: string): Promise<boolean> => {
  const { data: existing, error: checkError } = await supabase
    .from('system_settings')
    .select('id')
    .eq('key', KEY)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking existing default_page_size setting:', checkError);
    return false;
  }

  const value = String(pageSize);
  const result = existing
    ? await supabase
        .from('system_settings')
        .update({ value, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('id', existing.id)
    : await supabase
        .from('system_settings')
        .insert([{ key: KEY, value, updated_by: userId }]);

  if (result.error) {
    console.error('Error saving default_page_size setting:', result.error);
    return false;
  }
  return true;
};
