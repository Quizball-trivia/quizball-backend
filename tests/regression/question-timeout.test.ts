/**
 * Question timeout-expire scenario. If a player never answers, the round must NOT
 * stall — the engine's question-timeout (the durable possession_question timer)
 * resolves the round (fromTimeout) and the match advances. We drive this by having
 * the bot deliberately SKIP answering one mid-game question (skipQIndices); the AI
 * may or may not answer, but either way the round must resolve on the deadline and
 * the match must continue to completion.
 *
 * Asserts: the skipped qIndex still produces a match:round_result (round resolved
 * despite no bot answer), the match progresses past it, reaches terminal, and all
 * invariants hold. Guards against a withheld answer wedging the round.
 *
 * Local-only: opt in with REGRESSION_DB_URL pointing at the native local DB.
 */
import { afterEach, describe, expect, it } from 'vitest';

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

// A mid-game normal-play question the bot will refuse to answer.
const SKIP_QINDEX = 3;

describeLocal('regression: question timeout expire', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('an unanswered question resolves on timeout and the match continues to completion', async () => {
    const { bootMatch, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId, 'match should boot').toBeTruthy();

    // Play the whole match but never answer SKIP_QINDEX — the engine must
    // time that round out rather than hang.
    await playMatch(run, { maxMs: 120_000, skipQIndices: [SKIP_QINDEX] });

    const trace = run.trace;

    // The skipped question WAS dispatched (so the skip was meaningful)...
    const skippedDispatched = trace.byEvent('match:question').some(
      (e) => (e.payload as { qIndex?: number }).qIndex === SKIP_QINDEX,
    );
    expect(skippedDispatched, `qIndex ${SKIP_QINDEX} should have been dispatched`).toBe(true);

    // ...and it still RESOLVED (round_result for it) despite no bot answer — i.e.
    // the timeout path fired rather than the round stalling.
    const skippedResolved = trace.byEvent('match:round_result').some(
      (e) => (e.payload as { qIndex?: number }).qIndex === SKIP_QINDEX,
    );
    expect(skippedResolved, `qIndex ${SKIP_QINDEX} must resolve on timeout (no stall)`).toBe(true);

    // ...and the match progressed past it to a terminal state.
    expect(
      trace.byEvent('match:final_results').length,
      'match should complete after a timed-out round',
    ).toBeGreaterThan(0);

    const result = checkInvariants(trace);
    if (!result.ok) console.error('Invariant violations:\n' + result.violations.map(formatViolation).join('\n'));
    expect(result.ok, 'all invariants should hold').toBe(true);
  }, 180_000);
});
