// supabase/functions/update-user/index.ts
//
// Trusted server-side edit of a functional-role user's full_name/
// department/role/region_id. Companion to create-user/disable-user --
// same verify-JWT-then-look-up-profile pattern -- but the actual mutating
// write is NOT performed by this function's own service-role client.
//
// WHY: prevent_profile_privilege_escalation() (the profiles BEFORE UPDATE
// trigger) resolves the caller exclusively via auth.uid(), which reads the
// `sub` claim out of the current Postgres session's JWT. A service-role
// client's JWT has no `sub` claim (it identifies a role, not a user), so
// auth.uid() is NULL under that connection -- verified empirically during
// design review: an UPDATE to someone else's row issued this way is
// SILENTLY reverted back to OLD for role/region_id/role_level/tenant_id by
// that trigger, with no error -- a false-positive success. This function
// therefore performs the actual mutation via update_functional_user_profile()
// (see 20260822000000_functional_user_edit_rpc.sql), a SECURITY DEFINER RPC
// invoked using a SEPARATE client scoped to the CALLER's own forwarded JWT
// (not the service-role key), so auth.uid() resolves correctly inside
// Postgres for that call -- both for the RPC's own independent
// authorization checks (it does not trust this Edge Function as its only
// boundary -- see the RPC's own header) and for the trigger it runs under.
//
// The service-role client below is used ONLY for trusted reads (looking up
// the caller's and target's profile rows for early, friendly validation)
// and is never used to perform the mutating call.
//
// WHAT THIS FUNCTION DELIBERATELY NEVER DOES:
//   - Never accepts tenant_id/role_level/is_super_admin/email/password in
//     the request body -- any of these present as a key is rejected
//     outright (400), not silently ignored.
//   - Never invokes update_functional_user_profile() with the service-role
//     client -- always the caller-JWT-scoped one.
//   - Never edits a legacy account (role_level IS NOT NULL) -- that stays
//     on the separate legacy role-level editor.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { findProtectedField, validateUpdateUserInput } from './validation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Trusted-read client -- service role, used only for validation lookups
    // below, never for the mutating RPC call.
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace('Bearer ', '');
    const { data: { user: caller }, error: callerError } = await supabase.auth.getUser(token);

    if (callerError || !caller) {
      return json({ error: 'Invalid token' }, 401);
    }

    const { data: callerProfile, error: callerProfileError } = await supabase
      .from('profiles')
      .select('tenant_id, role, role_level, is_super_admin, is_active, deleted_at')
      .eq('id', caller.id)
      .single();

    if (callerProfileError || !callerProfile) {
      return json({ error: 'No profile found for the caller' }, 403);
    }

    if (!callerProfile.is_active || callerProfile.deleted_at) {
      return json({ error: 'Your account is disabled' }, 403);
    }

    const callerIsBusinessAdmin = callerProfile.role === 'admin' || callerProfile.role_level === 1;
    const callerIsSuperAdmin = callerProfile.is_super_admin === true;

    if (!callerIsBusinessAdmin && !callerIsSuperAdmin) {
      return json({ error: 'Only Admins may edit users' }, 403);
    }

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== 'object') {
      return json({ error: 'Invalid request body' }, 400);
    }

    const protectedField = findProtectedField(rawBody as Record<string, unknown>);
    if (protectedField) {
      return json({ error: `Field '${protectedField}' cannot be set through this endpoint` }, 400);
    }

    const userId = typeof rawBody.user_id === 'string' ? rawBody.user_id : '';
    const fullName = typeof rawBody.full_name === 'string' ? rawBody.full_name.trim() : '';
    const department = typeof rawBody.department === 'string' && rawBody.department.trim() ? rawBody.department.trim() : null;
    const role = typeof rawBody.role === 'string' ? rawBody.role : '';
    const regionId = typeof rawBody.region_id === 'string' && rawBody.region_id ? rawBody.region_id : null;

    const validation = validateUpdateUserInput({ user_id: userId, full_name: fullName, department, role, region_id: regionId });
    if (!validation.valid) {
      return json({ error: validation.error }, 400);
    }

    // Friendly, non-authoritative pre-checks -- the RPC re-verifies every
    // one of these independently and is the real authorization boundary.
    // This block only exists to return a clearer error in the common case
    // instead of a raw Postgres exception message.
    if (userId === caller.id) {
      return json({ error: 'You cannot change your own role or region through this action' }, 400);
    }

    const { data: targetProfile, error: targetError } = await supabase
      .from('profiles')
      .select('id, tenant_id, role_level')
      .eq('id', userId)
      .maybeSingle();

    if (targetError || !targetProfile) {
      return json({ error: 'User not found' }, 404);
    }

    if (!callerIsSuperAdmin && targetProfile.tenant_id !== callerProfile.tenant_id) {
      return json({ error: 'User not found' }, 404);
    }

    if (targetProfile.role_level !== null) {
      return json({ error: 'This account uses the legacy access-level editor' }, 400);
    }

    // ===== THE MUTATING CALL =====
    // A SEPARATE client, scoped to the CALLER's own bearer token (anon key
    // + the same Authorization header this request arrived with) -- so
    // auth.uid() inside Postgres resolves to the real caller for this one
    // call, not NULL. Never the service-role client above.
    const callerScopedSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: updated, error: rpcError } = await callerScopedSupabase.rpc('update_functional_user_profile', {
      p_target_id: userId,
      p_full_name: fullName,
      p_department: department,
      p_role: role,
      p_region_id: regionId,
    });

    if (rpcError) {
      return json({ error: rpcError.message || 'Failed to update user' }, 400);
    }
    if (!updated) {
      return json({ error: 'Update did not apply' }, 400);
    }

    return json({ success: true, id: userId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return json({ error: message }, 500);
  }
});
