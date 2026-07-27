import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Set them in a local .env file ' +
    '(see .env.example) or in your Vercel project\'s Environment Variables.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Get current user's role
export const getUserRole = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  
  const { data } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  
  return data?.role || 'staff';
};

// Get current user's profile
export const getUserProfile = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  
  return data;
};

// Update user's role (admin only)
export const updateUserRole = async (userId: string, role: string) => {
  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  
  if (error) throw error;
  return true;
};