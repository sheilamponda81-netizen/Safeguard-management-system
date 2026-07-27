import { supabase } from '../lib/supabase';

let cache: { userId: string; profile: any } | null = null;
let inFlight: Promise<any> | null = null;

// Fetches the current user's `profiles` row (joined with their region),
// cached per session. Nearly every page independently re-fetched this on
// mount; this shares one cached result across all of them instead of each
// issuing its own redundant network request for data that rarely changes.
export async function getCurrentProfile(forceRefresh = false): Promise<any> {
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
