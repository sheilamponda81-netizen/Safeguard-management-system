// supabase/functions/disable-user/index.ts
//
// Trusted server-side user disabling. Replaces the broken client-side
// deleteUser() in src/components/UserManagement.tsx, which attempted a
// direct `profiles` DELETE (would fail/cascade against every historical
// FK referencing profiles.id -- payroll.approved_by, audit_logs.user_id,
// salary_advances.approved_by, etc.) followed by a client-side call to
// `supabase.auth.admin.deleteUser()` -- an ADMIN API that is never
// reachable from a browser using the anon key in the first place (it
// requires the service-role key), so that branch could only ever fail.
//
// This function performs a SOFT DISABLE ONLY (`profiles.is_active =
// false`) -- see this migration set's standing "disable vs hard delete"
// recommendation (section 32 of the approved spec): a genuine hard delete
// cannot be made safe without either nullifying or reassigning every
// historical FK reference to this profile (breaking audit/financial
// history), so it is NOT implemented here. See the header note at the
// bottom of this file for the full reasoning, reported verbatim in the
// final implementation report's "hard-delete limitation" item.
//
// Disabling is already fully sufficient to revoke access: every RLS
// policy and every SECURITY DEFINER RPC in this schema resolves the
// caller's tenant/role/permissions through get_current_tenant_id() /
// is_super_admin() / current_user_role_level() / is_current_user_active(),
// all of which were redefined in
// 20260817000000_functional_role_permissions_foundation.sql to reject any
// profile with is_active = false -- the instant this function flips that
// flag, the disabled user's EXISTING session token (even if not
// separately revoked) can no longer read or write anything through any
// server-side path. No forced sign-out is required for this to be a
// complete access revocation.
//
// HOTFIX (release-review blocker fix): the actual mutating UPDATE below
// used to go through the SERVICE-ROLE client above, directly. A release
// review found this bypassable two ways: (1) profiles' own UPDATE RLS
// lets any business-admin-class caller update a same-tenant row's
// is_active regardless of that row's is_super_admin flag -- this
// function's own JS checks below were never the real security boundary,
// only a raw `supabase.from('profiles').update({is_active:false})` REST
// call away from being skipped entirely; (2) even with this function's
// own checks intact, a service-role connection has no `sub` JWT claim, so
// auth.uid() is NULL under it -- any is_super_admin-aware database guard
// could never see the REAL caller's identity through this client. Both
// gaps are closed by supabase/migrations/20260915000000's PART 1b: the
// EXISTING prevent_profile_privilege_escalation() trigger now
// unconditionally blocks deactivating a Super Administrator unless the
// REAL caller is genuinely super_admin() and the global
// at-least-one-active-Super-Administrator invariant still holds, and the
// actual mutating call below now goes through a NEW disable_user_profile()
// RPC, invoked via a SEPARATE client scoped to the CALLER's own JWT (never
// the service-role client) -- same pattern update-user/index.ts already
// established for update_functional_user_profile(). The JS checks below
// remain as friendly, non-authoritative pre-checks (unchanged); the RPC
// plus that trigger are the real boundary.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { canDisableTarget } from './validation.ts';

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

    if (!callerProfile.is_active || callerProfile.deleted_at) {
      return json({ error: 'Your account is disabled' }, 403);
    }

    const callerIsBusinessAdmin = callerProfile.role === 'admin' || callerProfile.role_level === 1;
    const callerIsSuperAdmin = callerProfile.is_super_admin === true;

    if (!callerIsBusinessAdmin && !callerIsSuperAdmin) {
      return json({ error: 'Only Admins may disable users' }, 403);
    }

    const body = await req.json().catch(() => null);
    const targetUserId = body && typeof body.user_id === 'string' ? body.user_id : null;
    if (!targetUserId) {
      return json({ error: 'user_id is required' }, 400);
    }

    if (targetUserId === caller.id) {
      return json({ error: 'You cannot disable your own account' }, 400);
    }

    const { data: target, error: targetError } = await supabase
      .from('profiles')
      .select('id, tenant_id, email, role, role_level, is_super_admin, is_active')
      .eq('id', targetUserId)
      .single();

    if (targetError || !target) {
      return json({ error: 'User not found' }, 404);
    }

    if (target.tenant_id !== callerProfile.tenant_id && !callerIsSuperAdmin) {
      return json({ error: 'User not found' }, 404);
    }

    if (!target.is_active) {
      return json({ success: true, message: 'User is already disabled' });
    }

    // HOTFIX: friendly, non-authoritative pre-check for the common case --
    // extracted to ./validation.ts so it has its own unit test. The
    // authoritative version of this check lives in disable_user_profile()
    // and, independently, in prevent_profile_privilege_escalation() (see
    // this file's header).
    const disableCheck = canDisableTarget(callerIsSuperAdmin, target.is_super_admin === true);
    if (!disableCheck.valid) {
      return json({ error: disableCheck.error }, 403);
    }

    // Business-continuity guard, preserved from the prior (broken)
    // deleteUser()'s own "cannot delete the last admin" check, generalized
    // to cover both a legacy Admin (role_level = 1) and a new functional
    // Admin (role = 'admin') account.
    //
    // ALIGNED (this pass): is_super_admin is deliberately NOT part of this
    // definition. Business Admin and Super Admin are separate concepts
    // throughout this schema (is_business_admin() vs is_super_admin(),
    // never folded together) -- a profile that is ONLY is_super_admin=true
    // (no role='admin', no role_level=1) is not this TENANT's local admin,
    // and counting it here would be a false sense of coverage: if that
    // Super Admin is later removed, the tenant could be left with zero
    // real local admins with nothing having caught it. This now matches
    // the authoritative definition enforced at the database level by
    // prevent_profile_privilege_escalation()'s last-Admin invariant
    // (20260822000000_functional_user_edit_rpc.sql) -- THAT trigger is
    // what actually prevents the tenant from reaching zero admins,
    // atomically and for every write path, including this one; the check
    // below is only a friendly, non-authoritative pre-check for a clearer
    // error message in the common (non-racing) case.
    const targetIsAdminClass = target.role === 'admin' || target.role_level === 1;

    if (targetIsAdminClass) {
      const { count, error: countError } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', target.tenant_id)
        .eq('is_active', true)
        .is('deleted_at', null)
        .or('role.eq.admin,role_level.eq.1');

      if (countError) {
        return json({ error: 'Failed to verify remaining admins: ' + countError.message }, 500);
      }
      if ((count ?? 0) <= 1) {
        return json({ error: 'Cannot disable the last remaining active Admin for this tenant' }, 400);
      }
    }

    // ===== THE MUTATING CALL =====
    // A SEPARATE client, scoped to the CALLER's own bearer token (anon key
    // + the same Authorization header this request arrived with) -- so
    // auth.uid() inside Postgres resolves to the real caller for this one
    // call, not NULL. Never the service-role client above. See this file's
    // header for why. disable_user_profile() re-verifies everything this
    // function already checked above (it is not trusted as this RPC's only
    // authorization boundary) plus the new Super-Admin-aware checks, and
    // performs the audit_logs insert itself, atomically with the update.
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const callerScopedSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: disabled, error: rpcError } = await callerScopedSupabase.rpc('disable_user_profile', {
      p_target_id: targetUserId,
    });

    if (rpcError) {
      return json({ error: rpcError.message || 'Failed to disable user' }, 400);
    }
    if (!disabled) {
      return json({ error: 'Update did not apply' }, 400);
    }

    return json({ success: true });
  } catch (error: any) {
    return json({ error: error?.message || 'Unexpected error' }, 500);
  }
});

// ============================================================
// HARD-DELETE LIMITATION (section 32 -- documented, not implemented)
// ============================================================
// A genuine hard delete (removing the auth.users row and the profiles
// row entirely) is NOT exposed by this function, and is not recommended
// to be added casually. Reasons:
//   1. profiles.id is referenced by FK or by plain UUID column (no FK, but
//      semantically load-bearing) from audit_logs.user_id,
//      payroll.approved_by, salary_advances.approved_by,
//      salary_advance_repayment_plans.changed_by,
//      salary_advance_repayment_plan_changes.changed_by, and other
//      historical/audit tables throughout this schema. Deleting the row
//      either cascades (destroying financial/audit history) or requires
//      nullifying every one of those references first (losing "who
//      approved this payroll run" permanently).
//   2. auth.admin.deleteUser() is irreversible -- there is no
//      "undelete" if invoked by mistake, unlike is_active = false which a
//      later UPDATE can trivially reverse.
//   3. The soft-disable implemented above is already a COMPLETE access
//      revocation (see this file's header) -- there is no security gap a
//      hard delete would close that disabling does not already close.
// If a genuine hard-delete requirement emerges later, it needs its own
// dedicated design pass (e.g. anonymizing historical references rather
// than deleting them) -- explicitly out of scope for this implementation
// pass, per instruction.
// ============================================================
