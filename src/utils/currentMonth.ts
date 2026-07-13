import { supabase } from '../lib/supabase';

// ===== CONSTANTS: System start date =====
const SYSTEM_START_YEAR = 2026;
const SYSTEM_START_MONTH = 6; // July (0-indexed: 6 = July)

// ===== HELPER: Get the system start date =====
export const getSystemStartDate = (): Date => {
  return new Date(SYSTEM_START_YEAR, SYSTEM_START_MONTH - 1, 1);
};

// ===== HELPER: Check if a date is before the system start =====
export const isBeforeSystemStart = (date: Date): boolean => {
  const startDate = getSystemStartDate();
  return date < startDate;
};

// Get the current system month from settings or fallback to actual current month
export const getSystemCurrentMonth = async (): Promise<string> => {
  try {
    console.log('🔍 Fetching current month from system_settings...');
    
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'current_payroll_month')
      .single();

    if (error) {
      console.error('❌ Error fetching current month setting:', error);
      // Use July 2026 as fallback instead of actual current month
      const fallback = `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
      console.log(`⚠️ Using fallback month: ${fallback}`);
      return fallback;
    }
    
    if (data?.value) {
      // Validate that the month is not before July 2026
      const [year, month] = data.value.split('-').map(Number);
      const date = new Date(year, month - 1, 1);
      if (isBeforeSystemStart(date)) {
        console.log(`⚠️ Stored month ${data.value} is before system start. Using July 2026.`);
        return `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
      }
      console.log(`✅ Current month found: ${data.value}`);
      return data.value;
    }
    
    // If no setting exists, create it with July 2026
    console.log('📝 No current month setting found. Creating default...');
    const defaultMonth = `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
    
    const { error: insertError } = await supabase
      .from('system_settings')
      .insert([{
        key: 'current_payroll_month',
        value: defaultMonth,
        description: 'Current active payroll month (YYYY-MM)'
      }]);
    
    if (insertError) {
      console.error('❌ Error creating default month setting:', insertError);
      return defaultMonth;
    }
    
    console.log(`✅ Default month created: ${defaultMonth}`);
    return defaultMonth;
  } catch (error) {
    console.error('❌ Unexpected error in getSystemCurrentMonth:', error);
    return `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
  }
};

// Set the system current month (admin only)
export const setSystemCurrentMonth = async (month: string, userId: string): Promise<boolean> => {
  try {
    // Validate month is not before July 2026
    const [year, monthNum] = month.split('-').map(Number);
    const date = new Date(year, monthNum - 1, 1);
    if (isBeforeSystemStart(date)) {
      console.error(`❌ Cannot set month before ${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`);
      return false;
    }
    
    console.log(`🔄 Setting current month to: ${month}`);
    
    const { data: existing, error: checkError } = await supabase
      .from('system_settings')
      .select('id, value')
      .eq('key', 'current_payroll_month')
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking existing setting:', checkError);
      return false;
    }

    let result;
    if (existing) {
      result = await supabase
        .from('system_settings')
        .update({
          value: month,
          updated_at: new Date().toISOString(),
          updated_by: userId
        })
        .eq('id', existing.id);
    } else {
      result = await supabase
        .from('system_settings')
        .insert([{
          key: 'current_payroll_month',
          value: month,
          description: 'Current active payroll month (YYYY-MM)',
          updated_by: userId
        }]);
    }

    if (result.error) {
      console.error('❌ Error saving month setting:', result.error);
      return false;
    }

    console.log(`✅ Month updated successfully to: ${month}`);
    
    // Audit log for month change
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('audit_logs')
          .insert([{
            user_id: user.id,
            user_email: user.email,
            action: 'UPDATE',
            entity_type: 'system_settings',
            entity_id: 'current_payroll_month',
            old_data: existing ? { month: existing.value } : null,
            new_data: { month: month },
            region_id: null,
            created_at: new Date().toISOString()
          }]);
        console.log('✅ Audit log recorded for month change');
      }
    } catch (auditError) {
      console.error('⚠️ Error logging audit (non-critical):', auditError);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Unexpected error in setSystemCurrentMonth:', error);
    return false;
  }
};

// Get the formatted month label (e.g., "July 2026")
export const getMonthLabel = (month: string): string => {
  if (!month) return 'Not Set';
  const parts = month.split('-');
  if (parts.length !== 2) return month;
  const [year, monthNum] = parts;
  const date = new Date(parseInt(year), parseInt(monthNum) - 1, 1);
  return date.toLocaleString('default', { month: 'long', year: 'numeric' });
};

// Get available months (starting from July 2026, going forward)
export const getAvailableMonthsFromSystem = (systemMonth?: string): string[] => {
  const months: string[] = [];
  
  // Start from July 2026
  const startDate = getSystemStartDate();
  
  // Use the system month if provided, otherwise use start date
  let currentDate: Date;
  if (systemMonth) {
    const [year, month] = systemMonth.split('-').map(Number);
    currentDate = new Date(year, month - 1, 1);
    // If the system month is before July 2026, use July 2026
    if (isBeforeSystemStart(currentDate)) {
      currentDate = new Date(SYSTEM_START_YEAR, SYSTEM_START_MONTH - 1, 1);
    }
  } else {
    currentDate = new Date(startDate);
  }
  
  // Generate 48 months (4 years) starting from the current month
  for (let i = 0; i < 48; i++) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() + i, 1);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
  }
  
  return months;
};

// Get past months (from July 2026 to current month)
export const getPastMonths = (systemMonth?: string): string[] => {
  const months: string[] = [];
  
  const startDate = getSystemStartDate();
  
  let currentDate: Date;
  if (systemMonth) {
    const [year, month] = systemMonth.split('-').map(Number);
    currentDate = new Date(year, month - 1, 1);
    if (isBeforeSystemStart(currentDate)) {
      currentDate = new Date(SYSTEM_START_YEAR, SYSTEM_START_MONTH - 1, 1);
    }
  } else {
    currentDate = new Date();
    // If current date is before July 2026, use July 2026
    if (isBeforeSystemStart(currentDate)) {
      currentDate = new Date(SYSTEM_START_YEAR, SYSTEM_START_MONTH - 1, 1);
    }
  }
  
  // Generate months going back from current month to July 2026
  for (let i = 0; i < 48; i++) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    if (isBeforeSystemStart(date)) break;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
  }
  
  return months.reverse();
};

// ===== NEW: Get next 12 months from July 2026 =====
export const getNextMonths = (count: number = 12): string[] => {
  const months: string[] = [];
  const startDate = getSystemStartDate();
  
  for (let i = 0; i < count; i++) {
    const date = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
  }
  
  return months;
};

// ===== NEW: Get months for charts (last 6 months from current) =====
export const getChartMonths = (systemMonth?: string): string[] => {
  const months: string[] = [];
  
  let currentDate: Date;
  if (systemMonth) {
    const [year, month] = systemMonth.split('-').map(Number);
    currentDate = new Date(year, month - 1, 1);
    if (isBeforeSystemStart(currentDate)) {
      currentDate = new Date(SYSTEM_START_YEAR, SYSTEM_START_MONTH - 1, 1);
    }
  } else {
    currentDate = new Date();
    if (isBeforeSystemStart(currentDate)) {
      currentDate = new Date(SYSTEM_START_YEAR, SYSTEM_START_MONTH - 1, 1);
    }
  }
  
  // Get 6 months before current (or from July 2026 if less than 6 months have passed)
  for (let i = 5; i >= 0; i--) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    // If the date is before July 2026, use July 2026 for all earlier months
    if (isBeforeSystemStart(date)) {
      // Fill the remaining months with July 2026
      for (let j = i; j >= 0; j--) {
        months.push(`${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`);
      }
      break;
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
  }
  
  // Ensure we have exactly 6 months
  while (months.length < 6) {
    months.unshift(`${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`);
  }
  
  return months.slice(0, 6);
};

// Check if a month is in the past
export const isPastMonth = (month: string, systemMonth?: string): boolean => {
  if (!systemMonth) {
    const now = new Date();
    systemMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  
  // If month is before July 2026, it's considered "past" but not valid
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  if (isBeforeSystemStart(date)) {
    return true;
  }
  
  return month < systemMonth;
};

// Check if a month is in the future
export const isFutureMonth = (month: string, systemMonth?: string): boolean => {
  if (!systemMonth) {
    const now = new Date();
    systemMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  
  return month > systemMonth;
};

// Get the next month
export const getNextMonth = (month: string): string => {
  if (!month) return `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// Get the previous month
export const getPreviousMonth = (month: string): string => {
  if (!month) return `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() - 1);
  
  // Prevent going before July 2026
  if (isBeforeSystemStart(date)) {
    return `${SYSTEM_START_YEAR}-${String(SYSTEM_START_MONTH).padStart(2, '0')}`;
  }
  
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// ===== NEW: Get the month in a friendly short format for charts =====
export const getShortMonthLabel = (month: string): string => {
  if (!month) return '';
  const parts = month.split('-');
  if (parts.length !== 2) return month;
  const [year, monthNum] = parts;
  const date = new Date(parseInt(year), parseInt(monthNum) - 1, 1);
  return date.toLocaleString('default', { month: 'short', year: '2-digit' });
};