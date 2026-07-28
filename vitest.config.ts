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
      'tests/regression/penalty-shootout.test.ts',
      'tests/regression/halftime-uiready-withheld.test.ts',
      'tests/regression/question-timeout.test.ts',
      'tests/regression/friendly-possession-lobby.test.ts',
      'tests/regression/friendly-party-quiz-lobby.test.ts',
      'tests/regression/auction-full-flow.test.ts',
      // Burn-in DB-integration tests run serially (vitest.burnin.config.ts,
      // `npm run test:burnin`): execute/rollback mutate the SINGLETON one-time
      // marker; the writer parity test drives the heavy production settlement
      // path and times out under full-suite parallel load. The pure-unit burn-in
      // tests (scheduler/manifest/target-guard) stay in the parallel suite.
      'tests/bot-burnin/execute.integration.test.ts',
      'tests/bot-burnin/writer.integration.test.ts',
      'tests/bot-burnin/cli-args.test.ts',
    ],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
