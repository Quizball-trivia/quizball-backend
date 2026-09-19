import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

if (!process.env.RELEASE_TEST_DATABASE_URL) throw new Error('Set the dedicated release rehearsal database');
export default defineConfig({
  test: {
    ...base.test,
    // All ordinary suites, including existing ranked/WL/progression behavior.
    // Database integration and fault-injection scenarios have separate runners.
    exclude: [...(base.test?.exclude ?? []), '**/*.integration.test.ts', 'tests/chaos/**'],
    setupFiles: ['tests/release/network-guard.ts', 'tests/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ['default', 'json'],
    outputFile: { json: '../../tmp/september-rehearsal/backend-release-all.json' },
  },
});
