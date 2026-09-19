import { defineConfig } from 'vitest/config';
if (!process.env.RELEASE_TEST_DATABASE_URL) throw new Error('Set RELEASE_TEST_DATABASE_URL to the isolated rehearsal database');
export default defineConfig({
  test: {
    environment: 'node', globals: true,
    include: [
      'tests/football-grid/football-grid.runtime.integration.test.ts',
      'tests/road-to-goal/*.integration.test.ts',
      'tests/users/guest-users.repo.integration.test.ts',
      'tests/store/ranked-ticket-concurrency.integration.test.ts',
      'tests/store/store-ledger-minor.integration.test.ts',
    ],
    setupFiles: ['tests/release/network-guard.ts', 'tests/setup.ts'],
    fileParallelism: false, maxWorkers: 1, minWorkers: 1,
    testTimeout: 30000, hookTimeout: 60000,
    reporters: ['default', 'json'],
    outputFile: { json: '../../tmp/september-rehearsal/backend-release-integration.json' },
  },
});
