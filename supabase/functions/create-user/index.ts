// supabase/functions/create-user/index.ts
//
// Trusted server-side user provisioning for the functional-roles model
// (admin / hr_manager / accountant / operations_manager). Replaces the
// prior client-side flow in src/components/UserManagement.tsx, which
// called supabase.auth.signUp() (a self-signup path, not an admin-creates-
// another-user path -- it authenticated as the NEW user, not the admin)
// followed by a direct client-side `profiles` INSERT the caller could
// forge arbitrary role_level/is_super_admin/tenant_id values into (see
// 20260817000001's PART 1 header for the exact vulnerability this
// replaces). This function uses the SERVICE ROLE key -- server-side only,
// never exposed to any client -- and follows the same
// verify-JWT-then-look-up-profile pattern as supabase/functions/backup and
// supabase/functions/rollback.
//
// AUTHORIZATION: only an active, non-deleted caller who is a business admin
// (profiles.role = 'admin' OR profiles.role_level = 1) or a super admin may
// call this function. This is computed here in JS from a directly-queried
// profiles row (NOT via the is_business_admin()/is_super_admin() SQL
// helpers -- a service-role Postgres connection has no auth.uid() session
// context, so those helpers cannot be called meaningfully from here; their
// exact logic is reproduced below instead, deliberately kept identical to
// 20260817000000_functional_role_permissions_foundation.sql's definitions).
//
// WHAT THIS FUNCTION DELIBERATELY NEVER DOES:
//   - Never TRUSTS a client-supplied is_super_admin flag on its own. The
//     request body MAY include `is_super_admin: true` (HOTFIX: formal
//     Super Administrator model -- see UserManagement.tsx's Add User
//     modal), but it is only honored when the CALLER (re-derived from
//     their own verified JWT/profile row, exactly like callerIsSuperAdmin
//     below -- never from anything in the request body) is themselves a
//     genuine super admin. Any other caller sending
//     `is_super_admin: true` is rejected outright (403), not silently
//     downgraded to false -- a silent downgrade could let a caller believe
//     a super-admin account was created when an ordinary one was, which is
//     a worse failure mode than a loud rejection.
//   - Never accepts a client-supplied tenant_id -- the new profile's
//     tenant_id is always the CALLER's own tenant_id, resolved server-side.
//   - Never accepts a client-supplied role_level -- every new account gets
//     role_level = NULL (see 20260817000000's header for why this is the
//     deliberate, structural guarantee that a new functional-role account
//     can never match a legacy role_level <= N check).
//   - Never echoes the password back in any response, log line, or audit
//     row.
//   - Never leaves an orphaned auth.users row: if the profiles INSERT
//     fails after the auth user was created, the auth user is deleted as a
//     compensating action (Postgres transactions cannot span the
//     auth.users/public.profiles boundary here, since auth.admin.createUser
//     is a separate GoTrue API call, not a SQL statement in the same
//     transaction as the profiles INSERT).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AllowedRole, validateCreateUserInput, canGrantSuperAdmin } from './validation.ts';

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

    // Mirrors is_current_user_active(): must be active AND not soft-deleted.
    if (!callerProfile.is_active || callerProfile.deleted_at) {
      return json({ error: 'Your account is disabled' }, 403);
    }

    // Mirrors is_business_admin(): role = 'admin' OR role_level = 1.
    const callerIsBusinessAdmin = callerProfile.role === 'admin' || callerProfile.role_level === 1;
    const callerIsSuperAdmin = callerProfile.is_super_admin === true;

    if (!callerIsBusinessAdmin && !callerIsSuperAdmin) {
      return json({ error: 'Only Admins may create users' }, 403);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json({ error: 'Invalid request body' }, 400);
    }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
    const department = typeof body.department === 'string' && body.department.trim() ? body.department.trim() : null;
    const role = body.role as AllowedRole;
    const regionId = typeof body.region_id === 'string' && body.region_id ? body.region_id : null;
    const requestedSuperAdmin = body.is_super_admin === true;

    // HOTFIX: Super Administrator creation authorization -- extracted to
    // ./validation.ts (canGrantSuperAdmin) so this exact decision has its
    // own ordinary unit test. Rejected loudly (never silently downgraded)
    // so a non-super caller never mistakenly believes this succeeded as
    // requested.
    const superAdminCheck = canGrantSuperAdmin(requestedSuperAdmin, callerIsSuperAdmin, role);
    if (!superAdminCheck.valid) {
      return json({ error: superAdminCheck.error }, requestedSuperAdmin && !callerIsSuperAdmin ? 403 : 400);
    }

    // Extracted to ./validation.ts (pure, dependency-free) so this exact
    // validation sequence has an ordinary unit-test covering it -- see
    // src/utils/createUserValidation.test.ts.
    const validation = validateCreateUserInput({ email, password, full_name: fullName, role, region_id: regionId });
    if (!validation.valid) {
      return json({ error: validation.error }, 400);
    }

    if (regionId) {
      const { data: region, error: regionError } = await supabase
        .from('regions')
        .select('id')
        .eq('id', regionId)
        .eq('tenant_id', callerProfile.tenant_id)
        .maybeSingle();

      if (regionError || !region) {
        return json({ error: 'Region does not belong to your tenant' }, 400);
      }
    }

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (createError || !created?.user) {
      return json({ error: createError?.message || 'Failed to create user' }, 400);
    }

    const newUserId = created.user.id;

    const { error: profileError } = await supabase.from('profiles').insert({
      id: newUserId,
      tenant_id: callerProfile.tenant_id, // server-resolved, never client-supplied
      email,
      full_name: fullName,
      role,
      role_level: null, // deliberate -- see this file's header
      department,
      // Server-verified only -- requestedSuperAdmin was already rejected
      // above (403) unless callerIsSuperAdmin, so ANDing here is defense
      // in depth, not the primary gate.
      is_super_admin: requestedSuperAdmin && callerIsSuperAdmin,
      is_active: true,
      region_id: role === 'admin' ? null : regionId,
    });

    if (profileError) {
      // Compensating action -- do not leave an orphaned auth.users row.
      await supabase.auth.admin.deleteUser(newUserId);
      return json({ error: 'Failed to create profile: ' + profileError.message }, 500);
    }

    await supabase.from('audit_logs').insert({
      tenant_id: callerProfile.tenant_id,
      user_id: caller.id,
      user_email: caller.email,
      user_role: callerIsSuperAdmin ? 'super_admin' : 'admin',
      region_id: null,
      action: 'CREATE',
      entity_type: 'profiles',
      entity_id: newUserId,
      old_data: null,
      new_data: { email, full_name: fullName, role, region_id: role === 'admin' ? null : regionId, department, is_super_admin: requestedSuperAdmin && callerIsSuperAdmin },
    });

    return json({ success: true, id: newUserId });
  } catch (error: any) {
    return json({ error: error?.message || 'Unexpected error' }, 500);
  }
});
