import { supabase } from '../lib/supabase';

export interface UserProfileRegion {
  id: string;
  tenant_id: string;
  name: string;
  code: string | null;
  created_at: string;
}

// Shape of a `profiles` row joined with its `regions` row (see the
// `.select('*, regions(*)')` query below). Shared across every page that
// reads the logged-in user's role/region instead of each declaring its own
// `userProfile: any` state.
export interface UserProfile {
  id: string;
  tenant_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  // NULL for every new functional-role account (admin / hr_manager /
  // accountant / operations_manager) -- deliberate, structural, see
  // supabase/migrations/20260817000000_functional_role_permissions_foundation.sql's
  // header. Every legacy numeric-comparison call site MUST treat null as
  // "no legacy access" (e.g. `role_level || 4`, never a raw `<=` compare
  // against a possibly-null value) and layer a has_permission()-based check
  // on top for the new roles -- see src/utils/permissions.ts.
  role_level: number | null;
  department: string | null;
  is_super_admin: boolean;
  is_active: boolean;
  region_id: string | null;
  deleted_at: string | null;
  created_at: string;
  regions: UserProfileRegion | null;
}

let cache: { userId: string; profile: UserProfile | null } | null = null;
let inFlight: Promise<UserProfile | null> | null = null;

// Fetches the current user's `profiles` row (joined with their region),
// cached per session. Nearly every page independently re-fetched this on
// mount; this shares one cached result across all of them instead of each
// issuing its own redundant network request for data that rarely changes.
export async function getCurrentProfile(forceRefresh = false): Promise<UserProfile | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    cache = null;
    return null;
  }
  if (!forceRefresh && cache && cache.userId === user.id) {
    return cache.profile;
  }
  if (!forceRefresh && inFlight) {
    return inFlight;
  }

  const fetchAndCache = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*, regions(*)')
        .eq('id', user.id)
        .maybeSingle();
      if (error) throw error;
      cache = { userId: user.id, profile: data };
      return data;
    } finally {
      inFlight = null;
    }
  };

  inFlight = fetchAndCache();
  return inFlight;
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    cache = null;
  }
});
