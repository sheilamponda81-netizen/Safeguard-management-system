import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate from vite.config.ts deliberately: vite.config.ts is the
// production build config (plugins, chunking, dev server) and has no
// reason to also carry test-runner configuration. Vitest only needs the
// same `@` path alias the app itself uses.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // src/lib/supabase.ts throws at import time if these are unset, and
    // several otherwise-pure utility modules (e.g. payrollSettings.ts,
    // for its DB-backed getPayrollRates()) import it transitively even
    // when the specific export under test doesn't touch the network.
    // These are placeholder values only, matching .env.example's format
    // -- never real credentials -- purely so importing those modules
    // doesn't throw during a test run that exercises none of their
    // actual Supabase calls.
    env: {
      VITE_SUPABASE_URL: 'https://test-placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'test-placeholder-anon-key',
    },
  },
});
