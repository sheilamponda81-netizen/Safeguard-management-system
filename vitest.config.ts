import { defineConfig, configDefaults } from 'vitest/config';
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
    // src/tests/auth.test.ts (a legacy manual smoke-test script with
    // hardcoded live credentials, no describe/it blocks, requiring a real
    // Supabase session) was already removed from this branch's own history
    // -- this exclude is a defensive no-op today, kept so the file can
    // never accidentally get picked up as a test again if it's ever
    // reintroduced by a future merge from main.
    exclude: [...configDefaults.exclude, 'src/tests/auth.test.ts'],
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
