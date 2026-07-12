/**
 * Early forfeit must still ANSWER the client: the no-contest cancellation is
 * bookkeeping-complete server-side (abandon + refund + counter), but the
 * forfeiting client sits on "Updating rank…" until match:final_results lands.
 * Live staging repro 2026-07-12 (match 1b4e8629): round-1 forfeit → abandoned,
 * refund written, NO final results delivered → client stuck.
 */
import { afterEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: early forfeit delivers final results', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('no-contest early forfeit emits match:final_results with cancelledNoContest', async () => {
    const { bootMatch, botForfeit } = await import('../../game-regression/src/runner.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();

    await botForfeit(run);

    const finals = run.trace.byEvent('match:final_results');
    expect(finals.length, 'forfeiting client must receive final results').toBeGreaterThan(0);
    const payload = finals[finals.length - 1]?.payload as {
      matchId?: string;
      cancelledNoContest?: boolean;
      winnerId?: string | null;
    };
    expect(payload?.matchId).toBe(run.matchId);
    expect(payload?.cancelledNoContest, 'payload marks the no-contest').toBe(true);
  }, 120_000);
});
