import { supabase } from '../lib/supabase';

// Get the current system month from settings or fallback to actual current month
export const getSystemCurrentMonth = async (): Promise<string> => {
  try {
    console.log('🔍 Fetching current month from system_settings...');
    
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'current_payroll_month')
      .maybeSingle();

    if (error) {
      console.error('❌ Error fetching current month setting:', error);
      const now = new Date();
      const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      console.log(`⚠️ Using fallback month: ${fallback}`);
      return fallback;
    }
    
    if (data?.value) {
      console.log(`✅ Current month found: ${data.value}`);
      return data.value;
    }
    
    // If no setting exists, create it with the current month
    console.log('📝 No current month setting found. Creating default...');
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
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
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
};

// Set the system current month (admin only)
export const setSystemCurrentMonth = async (month: string, userId: string): Promise<boolean> => {
  try {
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

// Get the formatted month label (e.g., "January 2025")
export const getMonthLabel = (month: string): string => {
  if (!month) return 'Not Set';
  const parts = month.split('-');
  if (parts.length !== 2) return month;
  const [year, monthNum] = parts;
  const date = new Date(parseInt(year), parseInt(monthNum) - 1, 1);
  return date.toLocaleString('default', { month: 'long', year: 'numeric' });
};

// src/utils/currentMonth.ts - Update the available months function

// Get available months (current and future) - starting from 2026
export const getAvailableMonthsFromSystem = (systemMonth?: string): string[] => {
  const months: string[] = [];
  
  // Start from May 2026 (the beginning of the system)
  const startDate = new Date(2026, 4, 1); // May 2026 (month is 0-indexed, so 4 = May)
  
  // Use the system month if provided, otherwise use start date
  let currentDate: Date;
  if (systemMonth) {
    const [year, month] = systemMonth.split('-').map(Number);
    currentDate = new Date(year, month - 1, 1);
    // If the system month is before May 2026, use May 2026
    if (currentDate < startDate) {
      currentDate = new Date(2026, 4, 1);
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

// Get past months for dropdown (only from May 2026 onwards)
export const getPastMonths = (systemMonth?: string): string[] => {
  const months: string[] = [];
  
  const startDate = new Date(2026, 4, 1); // May 2026
  
  let currentDate: Date;
  if (systemMonth) {
    const [year, month] = systemMonth.split('-').map(Number);
    currentDate = new Date(year, month - 1, 1);
    if (currentDate < startDate) {
      currentDate = new Date(2026, 4, 1);
    }
  } else {
    currentDate = new Date();
  }
  
  // Generate months going back from current month to May 2026
  for (let i = 0; i < 48; i++) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    if (date < startDate) break;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
  }
  
  return months.reverse();
};

// ===== NEW: Check if a month is in the past =====
export const isPastMonth = (month: string, systemMonth?: string): boolean => {
  if (!systemMonth) {
    const now = new Date();
    systemMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  
  return month < systemMonth;
};

// ===== NEW: Check if a month is in the future =====
export const isFutureMonth = (month: string, systemMonth?: string): boolean => {
  if (!systemMonth) {
    const now = new Date();
    systemMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  
  return month > systemMonth;
};

// Get the next month
export const getNextMonth = (month: string): string => {
  if (!month) return '';
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// Get the previous month
export const getPreviousMonth = (month: string): string => {
  if (!month) return '';
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};