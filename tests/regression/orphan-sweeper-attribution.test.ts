/**
 * Orphan-sweeper forfeit-attribution regression (the BJ / David bug).
 *
 * THE BUG (prod, 2026-06-09): the on-connect session-guard orphan sweeper
 * (`cleanupStaleOrphanActiveMatch`) force-forfeited a ranked match gated only on
 * match AGE, and charged the loss to *whichever user just connected* — crediting
 * the win to the other seat regardless of who actually disconnected or who was
 * winning. A present, reconnecting, even *leading* player got the defeat (and the
 * opponent's stats were fabricated to a perfect score). It fired ~14x / 3h in prod.
 *
 * THE FIX (Batch 1A — this is its acceptance test): for ranked active matches the
 * orphan path no longer finalizes a forfeit. It logs audit-only and returns,
 * leaving the match active for the presence-aware background sweeper. So a present
 * user who connects to an old/stale ranked match must NOT be forfeited.
 *
 * This test reproduces the trigger deterministically: boot a real ranked match,
 * back-date `started_at` so it is "stale by age" (exactly like a real match that
 * has reached penalties >5 min in), then run the production connect path
 * (`prepareForConnect`) for the still-present bot — the exact code path that
 * mis-forfeited BJ. It asserts the bot is not recorded as a forfeit loser.
 *
 * Pre-1A this assertion FAILS (the bot is forfeited on connect). Post-1A it passes.
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
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: orphan-sweeper forfeit attribution (BJ bug)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('present user connecting to a STALE ranked match is NOT forfeited by the orphan sweeper', async () => {
    const { bootMatch, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { userSessionGuardService } = await import(
      '../../src/realtime/services/user-session-guard.service.js'
    );
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { matchPlayersRepo } = await import('../../src/modules/matches/match-players.repo.js');
    const { sql } = await import('../../src/db/index.js');

    // 1. Boot a real ranked match and play partway (the bot is the present human seat).
    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    const matchId = run.matchId!;
    await playMatch(run, { maxMs: 6_000 });

    // The match must still be live before we exercise the sweeper.
    const before = await matchesRepo.getMatch(matchId);
    expect(before?.status, 'precondition: match active before sweeper').toBe('active');

    // 2. Make it "stale by age" — back-date started_at past STALE_ACTIVE_MATCH_MS
    //    (5 min). This is the real condition: any ranked match that reaches
    //    penalties has existed > 5 min, so the on-connect sweeper trips on it.
    await sql`UPDATE matches SET started_at = NOW() - INTERVAL '10 minutes' WHERE id = ${matchId}`;

    // 3. Run the EXACT production connect path that mis-forfeited BJ: the present
    //    bot user "connects", firing prepareForConnect -> cleanupStaleOrphanActiveMatch.
    await userSessionGuardService.prepareForConnect(run.io as never, run.botUserId);

    // 4. ASSERTIONS — the 1A contract.
    const after = await matchesRepo.getMatch(matchId);

    //  (a) The present bot must NOT have been forfeited as the loser. Pre-1A the
    //      sweeper set winner_user_id to the OTHER seat (the AI) and completed it.
    expect(
      after?.winner_user_id,
      'present connecting user must NOT be made the forfeit loser',
    ).not.toBe(otherSeatOf(run.botUserId, await matchPlayersRepo.listMatchPlayers(matchId)));

    //  (b) 1A leaves the stale ranked match ACTIVE for the background sweeper —
    //      it must not be force-completed/abandoned on the present user's connect.
    expect(
      after?.status,
      '1A: stale ranked match stays active on connect (handed to background sweeper)',
    ).toBe('active');
  }, 150_000);
});

/** The opponent seat's user id (used to assert the connecting user wasn't made loser→other won). */
function otherSeatOf(
  selfUserId: string,
  players: ReadonlyArray<{ user_id: string }>,
): string | null {
  return players.find((p) => p.user_id !== selfUserId)?.user_id ?? null;
}
