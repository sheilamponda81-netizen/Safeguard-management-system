import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // src/tests/auth.test.ts is a legacy manual smoke-test script (contains
    // hardcoded live credentials and requires a real Supabase session) that
    // predates any automated test runner in this project -- it has no
    // describe/it blocks and is not a unit test. Excluded here rather than
    // modified or deleted, since it is unrelated to this hotfix.
    exclude: [...configDefaults.exclude, 'src/tests/auth.test.ts'],
  },
});
