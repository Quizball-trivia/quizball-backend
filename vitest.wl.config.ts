import { defineConfig } from 'vitest/config';

/**
 * WL DB-integration tier — SERIAL by design. These files drive the global
 * "current tournament" resolution and a shared local DB/Redis, so parallel
 * workers shadow each other's tournaments and contend on the file lock
 * (observed as flaky skips/failures). Same convention as the regression
 * tier: excluded from the parallel default suite, run with `npm run test:wl`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/weekend-league/*.integration.test.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    setupFiles: ['tests/setup.ts'],
  },
});
