import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The DB-driven regression scenarios boot a real match against ONE shared
    // native DB/Redis and MUST run serially — they have their own config
    // (vitest.regression.config.ts, `npm run test:regression`). Excluded here so
    // the default parallel unit run never executes them concurrently against the
    // shared DB. The pure-unit regression tests (adapter, clock) stay in.
    exclude: [
      ...configDefaults.exclude,
      'tests/regression/match-boot.test.ts',
      'tests/regression/clean-match-invariants.test.ts',
      'tests/regression/disconnect-scenarios.test.ts',
    ],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
