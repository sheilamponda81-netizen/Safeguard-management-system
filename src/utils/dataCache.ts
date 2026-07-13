// src/utils/dataCache.ts

interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  expiresIn: number;
}

class DataCache {
  private cache: Map<string, CacheEntry> = new Map();
  private pendingRequests: Map<string, Promise<any>> = new Map();

  /**
   * Get data from cache or fetch it if not available
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    expiresIn: number = 60000 // Default 1 minute
  ): Promise<T> {
    // Check if there's a pending request for this key
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key) as Promise<T>;
    }

    // Check cache
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < cached.expiresIn) {
      return cached.data as T;
    }

    // Start new request
    const promise = fetcher()
      .then((data) => {
        this.cache.set(key, {
          data,
          timestamp: Date.now(),
          expiresIn,
        });
        this.pendingRequests.delete(key);
        return data;
      })
      .catch((error) => {
        this.pendingRequests.delete(key);
        throw error;
      });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  /**
   * Clear specific cache entry
   */
  clear(key: string): void {
    this.cache.delete(key);
    this.pendingRequests.delete(key);
  }

  /**
   * Clear all cache
   */
  clearAll(): void {
    this.cache.clear();
    this.pendingRequests.clear();
  }

  /**
   * Invalidate cache for a specific key pattern
   */
  invalidatePattern(pattern: RegExp): void {
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
      }
    }
    for (const key of this.pendingRequests.keys()) {
      if (pattern.test(key)) {
        this.pendingRequests.delete(key);
      }
    }
  }
}

export const dataCache = new DataCache();

/**
 * Hook for using cached data in components
 */
export function useCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  expiresIn: number = 60000,
  immediate: boolean = true
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dataCache.getOrFetch(key, fetcher, expiresIn);
      setData(result);
      return result;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [key, fetcher, expiresIn]);

  useEffect(() => {
    if (immediate) {
      fetchData();
    }
  }, [fetchData, immediate]);

  const refetch = useCallback(() => {
    dataCache.clear(key);
    return fetchData();
  }, [key, fetchData]);

  return { data, loading, error, refetch };
}

// Import useState and useCallback
import { useState, useCallback, useEffect } from 'react';