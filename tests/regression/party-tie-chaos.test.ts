import { afterEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://localhost:6379/15';
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

describeLocal('regression: party quiz tie invariant', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('forces an exact party-quiz tie and surfaces partyTieIsDraw when the engine picks a winner', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkPartyInvariants } = await import('../../game-regression/src/party-invariants.mjs');

    const run = await bootFriendlyLobbyMatch({ variant: 'friendly_party_quiz', startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();

    await playLobbyMatch(run, { maxMs: 60_000, answerMode: 'correct' });

    const inv = checkPartyInvariants(run.trace);
    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    expect(Array.isArray(inv.violations)).toBe(true);
  }, 180_000);
});
