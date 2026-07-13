// src/utils/requestDeduplicator.ts

interface RequestQueueItem {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timestamp: number;
}

class RequestDeduplicator {
  private pendingRequests: Map<string, RequestQueueItem[]> = new Map();
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30000; // 30 seconds

  /**
   * Execute a request with deduplication
   */
  async execute<T>(
    key: string,
    fetcher: () => Promise<T>,
    useCache: boolean = true
  ): Promise<T> {
    // Check cache first
    if (useCache) {
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data as T;
      }
    }

    // Check if there's already a pending request
    if (this.pendingRequests.has(key)) {
      return new Promise((resolve, reject) => {
        this.pendingRequests.get(key)!.push({ resolve, reject, timestamp: Date.now() });
      });
    }

    // Create new request
    const queue: RequestQueueItem[] = [];
    this.pendingRequests.set(key, queue);

    try {
      const result = await fetcher();
      
      // Cache the result
      if (useCache) {
        this.cache.set(key, { data: result, timestamp: Date.now() });
      }

      // Resolve all queued requests
      for (const item of queue) {
        item.resolve(result);
      }
      
      return result;
    } catch (error) {
      // Reject all queued requests
      for (const item of queue) {
        item.reject(error);
      }
      throw error;
    } finally {
      this.pendingRequests.delete(key);
    }
  }

  /**
   * Clear cache for a specific key
   */
  clearCache(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cache
   */
  clearAllCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache matching a pattern
   */
  invalidatePattern(pattern: RegExp): void {
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
      }
    }
  }
}

export const requestDeduplicator = new RequestDeduplicator();