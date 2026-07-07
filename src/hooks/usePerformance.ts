import { useEffect, useState } from 'react';

export function usePerformance(componentName: string) {
  const [renderTime, setRenderTime] = useState(0);

  useEffect(() => {
    const start = performance.now();
    
    return () => {
      const end = performance.now();
      const time = end - start;
      setRenderTime(time);
      
      if (time > 50) {
        console.warn(`⚠️ ${componentName} rendered slowly: ${Math.round(time)}ms`);
      }
    };
  }, [componentName]);

  return { renderTime };
}