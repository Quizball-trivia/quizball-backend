/**
 * Local-only Auction regression harness: seed published Auction clue cards,
 * start a real Auction AI match, and drive it to completion through durable
 * timers, bot actions, and human bid/fold/solo-pick handlers.
 *
 * Requires the local native regression DB + Redis:
 *   REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
 *     npx vitest run --config vitest.regression.config.ts tests/regression/auction-full-flow.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: auction full AI match harness', () => {
  afterAll(async () => {
    const { teardownAuctionRun } = await import('../../game-regression/src/auction-runner.mjs');
    await teardownAuctionRun();
  });

  it('plays a seeded Auction AI match to completion and satisfies Auction invariants', async () => {
    const { runFullAuctionMatch } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      checkAuctionInvariants,
      formatAuctionViolation,
    } = await import('../../game-regression/src/auction-invariants.mjs');

    const run = await runFullAuctionMatch({ startTimeoutMs: 20_000 });
    expect(run.matchId, 'auction match should boot').toBeTruthy();

    expect(
      run.trace.byEvent('auction:match_finished').length,
      'auction match should finish',
    ).toBe(1);

    const result = checkAuctionInvariants(run.trace);
    if (!result.ok) {
      console.error('Auction invariant violations:\n' + result.violations.map(formatAuctionViolation).join('\n'));
      console.info('Auction facts:', JSON.stringify(result.facts));
    }
    expect(result.ok, 'auction full-flow invariants should pass').toBe(true);
  }, 150_000);
});
