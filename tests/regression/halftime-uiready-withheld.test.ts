/**
 * Halftime "ui_ready withheld" scenario. At HALFTIME the client normally sends a
 * ui_ready ack (and the players ban a category). If a client NEVER acks and no ban
 * is placed, finalizeHalftime must NOT hang: it takes the "defer until ready" branch
 * (possession-halftime.ts:254) which rebases the deadline AND sets uiReadyAt to the
 * rebased deadline, so the NEXT timeout finalizes for real (AI fills the missing ban
 * via resolveHalftimeResult). The match must then continue into the 2nd half.
 *
 * The harness bot already withholds ui_ready/ban (the runner emits no halftime
 * events — it only answers questions), so reaching HALFTIME and waiting is exactly
 * this scenario. We use the dev-skip seam to reach HALFTIME deterministically, then
 * assert the match self-heals into half-2 NORMAL_PLAY and completes, invariants intact.
 *
 * Guards against: an infinite defer loop (stuck at HALFTIME forever) if the
 * rebase/uiReady self-heal logic regresses.
 *
 * Local-only: opt in with REGRESSION_DB_URL pointing at the native local DB.
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

describeLocal('regression: halftime ui_ready withheld', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('withheld ui_ready auto-resolves the ban (AI-filled) and the match continues into the 2nd half', async () => {
    const { bootMatch, playMatch, botSkipToPhase } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId, 'match should boot').toBeTruthy();

    await playMatch(run, { maxMs: 6_000 });
    // Deterministically land in HALFTIME (purpose=second_half), then NEVER ack
    // ui_ready / place a ban — just let playMatch wait out the timeout(s).
    await botSkipToPhase(run, 'halftime');
    await playMatch(run, { maxMs: 90_000 });

    const trace = run.trace;
    const stateEvents = trace.byEvent('match:state').map((e) => e.payload as { phase?: string; half?: number });

    // It must have actually passed THROUGH halftime into 2nd-half normal play
    // (not stayed stuck at HALFTIME) — i.e. a half-2 NORMAL_PLAY state appears.
    const reachedSecondHalfPlay = stateEvents.some((s) => s.phase === 'NORMAL_PLAY' && s.half === 2);
    expect(reachedSecondHalfPlay, 'match should self-heal past HALFTIME into 2nd-half NORMAL_PLAY').toBe(true);

    // ...and reached a terminal state.
    expect(
      trace.byEvent('match:final_results').length,
      'match should complete after the withheld-ui_ready halftime',
    ).toBeGreaterThan(0);

    const result = checkInvariants(trace);
    if (!result.ok) console.error('Invariant violations:\n' + result.violations.map(formatViolation).join('\n'));
    expect(result.ok, 'all invariants should hold').toBe(true);
  }, 150_000);
});
