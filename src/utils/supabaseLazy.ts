// ============================================
// LAZY LOAD SUPABASE MODULES
// ============================================

let supabaseClient: any = null;
let authModule: any = null;
let storageModule: any = null;
let functionsModule: any = null;

// Lazy load the main supabase client
export const getSupabaseClient = async () => {
  if (!supabaseClient) {
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  }
  return supabaseClient;
};

// Lazy load auth module
export const getAuthModule = async () => {
  if (!authModule) {
    const auth = await import('@supabase/auth-js');
    authModule = auth;
  }
  return authModule;
};

// Lazy load storage module
export const getStorageModule = async () => {
  if (!storageModule) {
    const storage = await import('@supabase/storage-js');
    storageModule = storage;
  }
  return storageModule;
};

// Lazy load functions module
export const getFunctionsModule = async () => {
  if (!functionsModule) {
    const functions = await import('@supabase/functions-js');
    functionsModule = functions;
  }
  return functionsModule;
};

// Prefetch Supabase modules after initial load
export const prefetchSupabase = () => {
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      getSupabaseClient().catch(() => {});
    }, 2000);
  }
};