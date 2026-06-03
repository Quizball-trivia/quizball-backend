/**
 * Baseline scenario: a CLEAN full match (bot answers normally, no chaos) must
 * play to completion AND satisfy every invariant. This is the foundation the
 * fuzzer builds on — if a clean match can't pass the referee, nothing can.
 *
 * Local-only: opt in with REGRESSION_DB_URL pointing at the native local DB.
 *   REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
 *     npx vitest run tests/regression/clean-match-invariants.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: clean full match passes all invariants', () => {
  afterAll(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('plays to completion and satisfies every invariant', async () => {
    const { bootMatch, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId, 'match should boot').toBeTruthy();
    await playMatch(run, { maxMs: 90_000 });

    // The match must complete (reach a terminal state).
    expect(
      run.trace.byEvent('match:final_results').length,
      'match should reach final_results',
    ).toBeGreaterThan(0);

    const result = checkInvariants(run.trace);
    if (!result.ok) {
      console.error('Invariant violations:\n' + result.violations.map(formatViolation).join('\n'));
    }
    expect(result.ok, 'all invariants should pass on a clean match').toBe(true);
  }, 120_000);
});
