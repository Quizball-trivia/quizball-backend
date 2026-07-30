import { defineConfig } from 'vitest/config';

/**
 * The persistent-bot burn-in integration tests mutate the SINGLETON one-time run
 * marker row (bot_model_params note='persistent-bot-burnin:complete'), so the
 * marker-mutating files must run serially against each other. This config runs
 * them in a single worker with file parallelism OFF.
 *
 *   npm run test:burnin
 *
 * The main `vitest run` EXCLUDES these files (see vitest.config.ts) so the
 * default parallel suite never races on the marker.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/bot-burnin/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
