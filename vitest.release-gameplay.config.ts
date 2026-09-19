import { defineConfig } from 'vitest/config';
import base from './vitest.regression.config.js';

const expected = 'postgres://rehearsal@127.0.0.1:55519/rehearsal_game_regression';
if (process.env.REGRESSION_DB_URL !== expected || process.env.REGRESSION_DB_NAME !== 'rehearsal_game_regression') {
  throw new Error('Gameplay rehearsal requires the dedicated disposable database');
}
if (process.env.REGRESSION_REDIS_URL !== 'redis://127.0.0.1:55520/3') {
  throw new Error('Gameplay rehearsal requires its isolated Redis database');
}
process.env.REGRESSION_FEATURED_FIXTURES = 'false';
export default defineConfig({ test: {
  ...base.test,
  setupFiles: ['tests/release/network-guard.ts', 'tests/setup.ts'],
  reporters: ['verbose', 'json'],
  outputFile: { json: '../../tmp/september-rehearsal/backend-gameplay-regression.json' },
  maxWorkers: 1, minWorkers: 1,
} });
