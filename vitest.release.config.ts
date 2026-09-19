import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
if (!process.env.RELEASE_TEST_DATABASE_URL) throw new Error('Set RELEASE_TEST_DATABASE_URL to the isolated rehearsal database');
export default defineConfig({
  test: {
    ...base.test,
    include: [
      'tests/auction/**/*.test.ts', 'tests/auth/**/*.test.ts', 'tests/daily-challenges/**/*.test.ts',
      'tests/football-grid/**/*.test.ts', 'tests/free-kicks/**/*.test.ts', 'tests/guest/**/*.test.ts',
      'tests/road-to-goal/**/*.test.ts', 'tests/squad-spin/**/*.test.ts', 'tests/trivia-mines/**/*.test.ts',
      'tests/store/**/*.test.ts', 'tests/users/capabilities.test.ts',
      'tests/realtime/guest-entry-gating.test.ts', 'tests/realtime/lobby-commands-guests.test.ts',
      'tests/realtime/lobby-guest-rules.test.ts', 'tests/realtime/socket-auth-guest.test.ts',
      'tests/ranked/ranked-guest-profile.test.ts',
    ],
    exclude: [...(base.test?.exclude ?? []), '**/*.integration.test.ts', 'tests/football-grid/football-grid-content-cli.test.ts'],
    setupFiles: ['tests/release/network-guard.ts', 'tests/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ['default', 'json'],
    outputFile: {json: '../../tmp/september-rehearsal/backend-release-tests.json'},
  },
});
