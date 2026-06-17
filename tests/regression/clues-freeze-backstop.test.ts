/**
 * THE prod clue_chain ("Who Am I") freeze scenario — Jun 2026 audit.
 *
 * Real-world chain (e.g. prod match 9ef928fe, Jun 12 10:16–10:18 UTC):
 *   1. q5 (clue_chain, the END-OF-HALF slot with the longest answer window)
 *      is dispatched.
 *   2. A player disconnects inside that window (frozen client → force-quit).
 *   3. The pause used to CANCEL the durable question-timeout timer.
 *   4. The grace resolution was then lost (deploy/restart mid-grace, lock
 *      contention drop) → the round had ZERO resolvers left → the match sat
 *      frozen in status='active' until the 15-minute sweeper settled it on
 *      partial score and the innocent player ate the loss.
 *
 * With the fix, step 3 DEFERS the timer (90s backstop) instead of cancelling
 * it, so even when step 4 happens the round self-resolves and the match plays
 * on to a real terminal state. This test drives that exact chain through the
 * real engine and only fast-forwards the backstop's due time (we don't wait
 * 90 real seconds).
 *
 * Local-only: REGRESSION_DB_URL must point at the native regression DB.
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
process.env.LOG_LEVEL = process.env.HARNESS_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

const TIMER_ZSET_KEY = 'realtime:timers';
/** Slot 5 of each half is the clue_chain question (NORMAL_HALF_SEQUENCE). */
const CLUES_QINDEX = 5;

async function waitFor(pred: () => boolean, ms: number, stepMs = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return pred();
}

describeLocal('regression: clue_chain freeze backstop (whoami)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it(
    'disconnect mid-clues + LOST grace resolution → backstop still resolves the round and the match reaches a real terminal state',
    async () => {
      const { bootMatch, playMatch, botDisconnect } =
        await import('../../game-regression/src/runner.mjs');
      const { checkInvariants, formatViolation } =
        await import('../../game-regression/src/invariants.mjs');
      const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
      const { getRedisClient } = await import('../../src/realtime/redis.js');
      const { cancelRealtimeTimer } = await import('../../src/realtime/realtime-timer-scheduler.js');
      const { matchPauseKey } = await import('../../src/realtime/match-keys.js');

      const run = await bootMatch({ startTimeoutMs: 25_000 });
      expect(run.matchId).toBeTruthy();
      const matchId = run.matchId!;
      const questionMember = `possession_question:${matchId}:${CLUES_QINDEX}`;

      // 1) Play normally up to the clue_chain question, never answering it (or
      //    anything after it). The play loop runs in the background; we pounce
      //    the moment q5 is on screen — inside its answer window.
      const playPromise = playMatch(run, {
        maxMs: 25_000,
        skipQIndices: [5, 6, 7, 8, 9, 10, 11],
      });
      const cluesDispatched = await waitFor(
        () => run.trace
          .byEvent('match:question')
          .some((e) => (e.payload as { qIndex?: number }).qIndex === CLUES_QINDEX),
        20_000,
      );
      expect(cluesDispatched, 'the clue_chain question (q5) must be dispatched').toBe(true);

      // 2) Disconnect INSIDE the clues window (the frozen-client force-quit).
      await botDisconnect(run);
      const redis = getRedisClient();
      expect(redis?.isOpen).toBe(true);
      const paused = await redis!.get(matchPauseKey(matchId));
      expect(paused, 'disconnect must arm the pause').toBeTruthy();

      // 3) THE FIX UNDER TEST: pause must have DEFERRED the round's durable
      //    question timer, not cancelled it. (Pre-fix this zScore is null and
      //    the round has no resolver left — the silent prod freeze.)
      const backstopScore = await redis!.zScore(TIMER_ZSET_KEY, questionMember);
      expect(
        backstopScore,
        'paused round must keep a durable question-timeout backstop armed',
      ).not.toBeNull();
      expect(backstopScore!).toBeGreaterThan(Date.now());

      // 4) Reproduce the prod failure: the grace resolution is LOST (deploy /
      //    restart / lock-contention drop) and the pause key TTLs out with no
      //    resume ever happening. Nothing is left except the backstop.
      await cancelRealtimeTimer('match_disconnect_forfeit', matchId);
      await redis!.del(matchPauseKey(matchId));

      // 5) Fast-forward the backstop (only the WAIT is simulated — the member
      //    and its payload are exactly what the pause wrote): make it due now
      //    and let the real scheduler poll fire it.
      await redis!.zAdd(TIMER_ZSET_KEY, [{ score: Date.now(), value: questionMember }]);

      const roundResolved = await waitFor(
        () => run.trace
          .byEvent('match:round_result')
          .some((e) => (e.payload as { qIndex?: number }).qIndex === CLUES_QINDEX),
        15_000,
      );
      expect(
        roundResolved,
        'the backstop fire must resolve the clues round with timeout zeros (pre-fix: frozen forever)',
      ).toBe(true);

      // 6) With the round unblocked the engine must carry the match all the
      //    way to a REAL terminal state (halftime → 2nd half on question
      //    timeouts → completion) — no sweeper, no human intervention.
      await playPromise;
      const finished = await waitFor(
        () => run.trace.byEvent('match:final_results').length > 0,
        120_000,
        100,
      );
      expect(finished, 'match must reach final_results without any external resolver').toBe(true);

      const match = await matchesRepo.getMatch(matchId);
      expect(['completed', 'abandoned']).toContain(match?.status);

      const result = checkInvariants(run.trace);
      if (!result.ok) console.error(result.violations.map(formatViolation).join('\n'));
      expect(result.ok).toBe(true);
    },
    180_000,
  );
});
