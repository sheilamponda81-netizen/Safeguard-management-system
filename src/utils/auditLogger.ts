// src/utils/auditLogger.ts

import { supabase } from '../lib/supabase';

export interface AuditLogEntry {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'EXPORT' | 'VIEW' | 'APPROVE' | 'REJECT';
  entity_type: string;
  entity_id?: string;
  old_data?: any;
  new_data?: any;
  region_id?: string;
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