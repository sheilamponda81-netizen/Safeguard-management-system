// src/utils/performance.ts

export function measurePerformance(name: string) {
  const start = performance.now();
  
  return {
    end: () => {
      const duration = performance.now() - start;
      console.log(`⏱️ ${name}: ${duration.toFixed(2)}ms`);
      
      // Log to analytics if in production
      if (process.env.NODE_ENV === 'production') {
        // Send to analytics service
        // analytics.track('performance', { name, duration });
      }
    }
  };
}

export function measurePageLoad() {
  if (typeof window !== 'undefined') {
    const perfData = performance.getEntriesByType('navigation');
    if (perfData.length > 0) {
      const nav = perfData[0] as PerformanceNavigationTiming;
      return {
        domContentLoaded: nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart,
        load: nav.loadEventEnd - nav.loadEventStart,
        total: nav.loadEventEnd - nav.fetchStart,
      };
    }
  }
  return null;
}