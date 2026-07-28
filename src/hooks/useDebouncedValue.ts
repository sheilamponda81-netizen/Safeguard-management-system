import { useEffect, useState } from 'react';

// Returns a copy of `value` that only updates `delay`ms after `value` stops
// changing. Use this to gate an expensive effect (e.g. a Supabase refetch)
// behind a search/filter input without delaying the input's own display.
export function useDebouncedValue<T>(value: T, delay: number = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timeoutId);
  }, [value, delay]);

  return debounced;
}
