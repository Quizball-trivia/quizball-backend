/**
 * Penalty-shootout scenario. A 2nd-half draw routes into PENALTY_SHOOTOUT through
 * the HALFTIME-style ban interlude (possession-resolution.ts:148). This exercises
 * a whole phase the other scenarios never reach.
 *
 * Forcing a draw by PLAY is not viable: the harness AI is non-deterministic (its
 * correctness draws from Math.random() because the durable-timer callback runs
 * outside any withSeed scope), and the scoring gap is large — the bot answering
 * all-correct wins big, all-wrong loses 0-4 (measured), so a tie is a narrow target
 * between two runaway outcomes (0/6 draws in a probe). Instead we use the SAME
 * production dev-skip seam the /dev/penalties route uses — `devSkipToPossessionPhase
 * (matchId, 'penalty_ban')` — which sets goals 1-1 and lands in the penalty ban
 * (HALFTIME, purpose='penalty'); the ban auto-resolves and finalizes into
 * PENALTY_SHOOTOUT. This deterministically reaches penalties via real engine code.
 *
 * Asserts: PENALTY_SHOOTOUT is entered LEGALLY from HALFTIME (legalPhaseOrder), the
 * shootout plays to a terminal state, and every invariant holds across the phase.
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

describeLocal('regression: penalty shootout (deterministic via dev-skip)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('penalty ban routes HALFTIME -> PENALTY_SHOOTOUT, plays to terminal, all invariants hold', async () => {
    const { bootMatch, playMatch, botSkipToPhase } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId, 'match should boot').toBeTruthy();

    // Play a couple of normal rounds first so the trace has real history, then
    // deterministically jump to the penalty ban (goals 1-1, HALFTIME ban interlude).
    await playMatch(run, { maxMs: 6_000 });
    await botSkipToPhase(run, 'penalty_ban');

    // The ban auto-resolves (AI ban + timeout) and finalizes into PENALTY_SHOOTOUT;
    // then the shootout plays out. Keep answering to drive it to a terminal state.
    await playMatch(run, { maxMs: 90_000 });

    const trace = run.trace;
    const phaseSeq = trace.byEvent('match:state')
      .map((e) => (e.payload as { phase?: string }).phase)
      .filter((p): p is string => !!p);

    // Must have actually reached the shootout.
    expect(phaseSeq, 'should reach PENALTY_SHOOTOUT').toContain('PENALTY_SHOOTOUT');

    // ...and entered it LEGALLY from HALFTIME (never directly from NORMAL_PLAY/LAST_ATTACK).
    const penaltyIdx = phaseSeq.indexOf('PENALTY_SHOOTOUT');
    const prevPhase = phaseSeq.slice(0, penaltyIdx).reverse().find((p) => p !== 'PENALTY_SHOOTOUT');
    expect(prevPhase, 'PENALTY_SHOOTOUT must be entered from HALFTIME').toBe('HALFTIME');

    // ...and reached a terminal state.
    expect(
      trace.byEvent('match:final_results').length,
      'penalty shootout should play to a terminal state',
    ).toBeGreaterThan(0);

    const result = checkInvariants(trace);
    if (!result.ok) console.error('Invariant violations:\n' + result.violations.map(formatViolation).join('\n'));
    expect(result.ok, 'all invariants should hold across the penalty phase').toBe(true);
  }, 150_000);
});
