// src/utils/auditLogger.ts

import { supabase } from '../lib/supabase';

export interface AuditLogEntry {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'EXPORT' | 'VIEW' | 'APPROVE' | 'REJECT';
  entity_type: string;
  entity_id?: string;
  // Audit payloads vary per entity_type (payroll records, employee records,
  // position config, etc.) and are only ever serialized/stored here, never
  // read back -- `unknown` keeps that genuinely-variable shape without
  // falling back to `any` (callers can pass any concrete object; nothing
  // in this file reads through it without narrowing first).
  old_data?: unknown;
  new_data?: unknown;
  region_id?: string | null;
}

export const logAudit = async (entry: AuditLogEntry) => {
  try {
    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.warn('No user found, skipping audit log');
      return;
    }

    // Get user profile for role and region
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role_level, region_id, full_name, is_super_admin')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('Error fetching profile for audit:', profileError);
    }

    // Determine user role
    let userRole = 'user';
    if (profile?.is_super_admin) {
      userRole = 'super_admin';
    } else if (profile?.role_level === 1) {
      userRole = 'admin';
    } else if (profile?.role_level === 2) {
      userRole = 'manager';
    } else if (profile?.role_level === 3) {
      userRole = 'supervisor';
    }

    // Insert audit log
    const { error } = await supabase
      .from('audit_logs')
      .insert([{
        user_id: user.id,
        user_email: user.email,
        user_role: userRole,
        region_id: entry.region_id || profile?.region_id || null,
        action: entry.action,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id || null,
        old_data: entry.old_data || null,
        new_data: entry.new_data || null,
        user_agent: navigator.userAgent,
        created_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('Failed to log audit:', error);
    } else {
      console.log(`✅ Audit logged: ${entry.action} on ${entry.entity_type}`);
    }
  } catch (error) {
    console.error('Audit logging error:', error);
  }
};