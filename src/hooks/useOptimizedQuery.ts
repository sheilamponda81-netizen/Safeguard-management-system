// src/hooks/useOptimizedQuery.ts

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, executeQuery, invalidateTableCache } from '../lib/supabaseClient';
import { dataCache } from '../utils/dataCache';

interface UseOptimizedQueryOptions {
  cacheKey?: string;
  useCache?: boolean;
  cacheTTL?: number;
  enabled?: boolean;
  deduplicate?: boolean;
}

export function useOptimizedQuery<T>(
  table: string,
  queryBuilder: (query: any) => any,
  options: UseOptimizedQueryOptions = {}
) {
  const {
    cacheKey,
    useCache = true,
    cacheTTL = 60000,
    enabled = true,
    deduplicate = true,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const isMounted = useRef(true);
  const fetchCount = useRef(0);

  const fetchData = useCallback(async () => {
    if (!enabled) return;

    const currentFetch = ++fetchCount.current;
    setLoading(true);
    setError(null);

    try {
      const cacheKeyValue = cacheKey || `${table}:${Date.now()}`;

      const result = await dataCache.getOrFetch(
        cacheKeyValue,
        async () => {
          const query = queryBuilder(supabase.from(table));
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          return data as T;
        },
        cacheTTL
      );

      if (isMounted.current && currentFetch === fetchCount.current) {
        setData(result);
      }
    } catch (err) {
      if (isMounted.current && currentFetch === fetchCount.current) {
        setError(err as Error);
      }
    } finally {
      if (isMounted.current && currentFetch === fetchCount.current) {
        setLoading(false);
      }
    }
  }, [table, queryBuilder, cacheKey, cacheTTL, enabled, useCache]);

  useEffect(() => {
    fetchData();
    return () => {
      isMounted.current = false;
    };
  }, [fetchData]);

  const refetch = useCallback(() => {
    if (cacheKey) {
      dataCache.clear(cacheKey);
    }
    fetchData();
  }, [cacheKey, fetchData]);

  const invalidate = useCallback(() => {
    if (cacheKey) {
      dataCache.clear(cacheKey);
    }
    invalidateTableCache(table);
  }, [table, cacheKey]);

  return { data, loading, error, refetch, invalidate };
}