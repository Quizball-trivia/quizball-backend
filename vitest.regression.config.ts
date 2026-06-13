import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the DB-driven regression scenarios (match-boot,
 * clean-match-invariants, disconnect-scenarios). These boot a REAL ranked-AI
 * match in-process against ONE shared native Postgres + Redis (`quizball_regression`).
 *
 * They MUST run serially. Under the default forks pool with file parallelism on,
 * worker B's seedFixtures() TRUNCATEs match/lobby tables while worker A's match is
 * still live — clearing an in-flight match and producing phantom duplicate-dispatch
 * / boot failures (Codex P1). A per-clear advisory lock cannot fix this: the unsafe
 * window spans the whole match (boot → play → teardown), not just the seed.
 *
 * The fix is to serialize at the file level: `fileParallelism: false` runs these
 * files one-at-a-time, so only one match owns the shared DB/Redis at any moment.
 * We deliberately keep `singleFork: false` (the default) so each file still gets a
 * FRESH fork — running them all in a single process instead leaks engine singletons
 * (DB pool, Redis client, scheduler/matchmaking loop, lingering grace/AI timers from
 * the disconnect scenarios) into the next file and the 2nd+ match fails to boot.
 * Serial + isolated-per-file is the combination that's both safe and clean.
 *
 * Run: REGRESSION_DB_URL=postgresql://...quizball_regression npm run test:regression
 * The scenarios self-skip if REGRESSION_DB_URL is absent (see each file's isLocal gate).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/regression/match-boot.test.ts',
      'tests/regression/clean-match-invariants.test.ts',
      'tests/regression/disconnect-scenarios.test.ts',
      'tests/regression/clues-freeze-backstop.test.ts',
      'tests/regression/safe-leave-opponent-grace.test.ts',
      'tests/regression/orphan-sweeper-attribution.test.ts',
      'tests/regression/penalty-shootout.test.ts',
      'tests/regression/halftime-uiready-withheld.test.ts',
      'tests/regression/question-timeout.test.ts',
      'tests/regression/friendly-possession-lobby.test.ts',
      'tests/regression/friendly-party-quiz-lobby.test.ts',
      'tests/regression/user-recent-categories.test.ts',
    ],
    setupFiles: ['tests/setup.ts'],
    // ── Serialize at the FILE level: one match owns the shared DB/Redis at a
    // time, but each file runs in its own fresh fork (singleFork stays false). ──
    fileParallelism: false,
    pool: 'forks',
    // A full match plays many real (fast-timer) rounds; the per-file default
    // (5s) is far too short for boot + play + invariants.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
