// src/lib/supabaseClient.ts

import { createClient } from '@supabase/supabase-js';
import { requestDeduplicator } from '../utils/requestDeduplicator';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Create the supabase client with optimized settings
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: {
    headers: {
      'X-Client-Info': 'safeguard-hr',
    },
  },
  db: {
    schema: 'public',
  },
});

/**
 * Optimized query execution with deduplication
 */
export async function executeQuery<T>(
  table: string,
  queryFn: () => Promise<{ data: T | null; error: any }>,
  cacheKey?: string,
  useCache: boolean = true
): Promise<T> {
  const key = cacheKey || `${table}:${JSON.stringify(queryFn)}`;
  
  return requestDeduplicator.execute(
    key,
    async () => {
      const { data, error } = await queryFn();
      if (error) throw error;
      return data as T;
    },
    useCache
  );
}

/**
 * Invalidate cache for a table
 */
export function invalidateTableCache(table: string): void {
  requestDeduplicator.invalidatePattern(new RegExp(`^${table}:`));
  // Also invalidate in the data cache
  import('./dataCache').then(({ dataCache }) => {
    dataCache.invalidatePattern(new RegExp(`^${table}`));
  });
}