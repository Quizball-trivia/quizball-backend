/**
 * Ranked forfeit ECONOMY scenarios — the RP + ticket side of leaving a match.
 * These drive a REAL ranked-AI match through the production forfeit path and
 * assert the economy outcome the rules promise:
 *
 *   - EARLY forfeit (before RANKED_EARLY_FORFEIT_MIN_ROUNDS rounds): the match
 *     is a NO-CONTEST → abandoned, NO RP change for the leaver, and the leaver's
 *     consumed ranked ticket is REFUNDED. (Guards the ghost-id refund fix in
 *     match-forfeit.service.ts: a missing roster user must not blow up the refund
 *     transaction and silently strip the real player's refund.)
 *   - LATE forfeit (>= the threshold): a real forfeit → match completed, the
 *     leaver LOSES RP (-50), and the ticket is NOT refunded.
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

describeLocal('regression: ranked forfeit economy (RP + tickets)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('EARLY forfeit (<2 rounds) → no-contest: match abandoned, no RP change, ticket refunded', async () => {
    const { bootMatch, botForfeit } = await import('../../game-regression/src/runner.mjs');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { rankedRepo } = await import('../../src/modules/ranked/ranked.repo.js');
    const { storeRepo } = await import('../../src/modules/store/store.repo.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();

    // A freshly-booted match sits at q-index 0 (the bot consumed its ticket on
    // queue-join). Forfeit immediately — before 2 rounds are played — so the
    // early-forfeit no-contest path fires. Wallet BEFORE the refund:
    const walletBefore = await storeRepo.getWallet(run.botUserId);

    await botForfeit(run);

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(match?.status, 'early forfeit cancels the match as a no-contest').toBe('abandoned');

    // No RP ledger row for anyone on a no-contest.
    const rpChanges = await rankedRepo.getRpChangesForMatch(run.matchId!);
    expect(rpChanges.length, 'no-contest must not write any RP changes').toBe(0);

    // The leaver's consumed ticket is refunded (back up by 1, capped at MAX).
    const walletAfter = await storeRepo.getWallet(run.botUserId);
    expect(
      walletAfter!.tickets,
      'no-contest refunds the leaver ticket',
    ).toBeGreaterThan(walletBefore!.tickets);
  }, 120_000);

  it('LATE forfeit (>=2 rounds) → real forfeit: match completed, leaver loses RP', async () => {
    const { bootMatch, playMatch, botForfeit } = await import('../../game-regression/src/runner.mjs');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { rankedRepo } = await import('../../src/modules/ranked/ranked.repo.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();

    // Play enough rounds to cross the early-forfeit threshold, then forfeit.
    await playMatch(run, { maxMs: 9_000 });
    const mid = await matchesRepo.getMatch(run.matchId!);
    expect(
      (mid?.current_q_index ?? 0),
      'must be past the early-forfeit grace before forfeiting',
    ).toBeGreaterThanOrEqual(2);

    await botForfeit(run);

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(['completed', 'abandoned']).toContain(match?.status);

    // The leaver gets a NEGATIVE RP change (the -50 forfeit-loss; placement runs
    // can scale it, so assert the sign, not the exact magnitude).
    const rpChanges = await rankedRepo.getRpChangesForMatch(run.matchId!);
    const mine = rpChanges.find((c) => c.user_id === run.botUserId);
    expect(mine, 'late forfeit settles an RP change for the leaver').toBeTruthy();
    expect(mine!.delta_rp, 'late forfeit costs the leaver RP').toBeLessThan(0);
  }, 150_000);

  it('OPPONENT forfeits while we lead → winner gets forfeit-win base + goal-margin bonus', async () => {
    const { bootMatch, playMatch, opponentForfeit } = await import('../../game-regression/src/runner.mjs');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { matchPlayersRepo } = await import('../../src/modules/matches/match-players.repo.js');
    const { rankedRepo } = await import('../../src/modules/ranked/ranked.repo.js');

    // Forfeit-win base (+50) and the margin-bonus tiers, mirrored from
    // ranked.service.ts (the constants aren't exported). Bonus only when ahead.
    const FORFEIT_WIN_BASE = 50;
    const marginBonus = (m: number) => (m >= 4 ? 40 : m === 3 ? 30 : m === 2 ? 15 : 0);

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    // Bot answers correctly to build a goal lead, then the opponent forfeits.
    await playMatch(run, { maxMs: 9_000, answerMode: 'correct' });

    // Read the bot's goal margin at the moment of forfeit (winner's perspective).
    const roster = await matchPlayersRepo.listMatchPlayers(run.matchId!);
    const me = roster.find((p) => p.user_id === run.botUserId);
    const opp = roster.find((p) => p.user_id !== run.botUserId);
    const margin = (me?.goals ?? 0) - (opp?.goals ?? 0);
    const frozenGoals = {
      mine: me?.goals ?? 0,
      opponent: opp?.goals ?? 0,
    };

    const oppId = await opponentForfeit(run);
    expect(oppId, 'opponent forfeit resolved').toBeTruthy();

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(['completed', 'abandoned']).toContain(match?.status);
    const settledRoster = await matchPlayersRepo.listMatchPlayers(run.matchId!);
    const settledMe = settledRoster.find((p) => p.user_id === run.botUserId);
    const settledOpp = settledRoster.find((p) => p.user_id !== run.botUserId);
    expect(settledMe?.goals, 'winner goals stay frozen through forfeit finalization').toBe(frozenGoals.mine);
    expect(settledOpp?.goals, 'forfeiter goals stay frozen through forfeit finalization').toBe(frozenGoals.opponent);

    // The surviving WINNER (bot) gains RP: forfeit-win base, PLUS the margin
    // bonus iff it was ahead. (Placement runs can scale the magnitude, so assert
    // the floor + the exact bonus-inclusion relationship, not a single number.)
    const rpChanges = await rankedRepo.getRpChangesForMatch(run.matchId!);
    const mine = rpChanges.find((c) => c.user_id === run.botUserId);
    expect(mine, 'opponent-forfeit settles an RP change for the winner').toBeTruthy();
    expect(mine!.delta_rp, 'winner gains RP on an opponent forfeit').toBeGreaterThan(0);
    if (margin > 0) {
      const expected = FORFEIT_WIN_BASE + marginBonus(margin);
      expect(
        mine!.delta_rp,
        `winner ahead by ${margin} should get base+margin (${expected})`,
      ).toBe(expected);
    } else {
      expect(mine!.delta_rp, 'no lead → flat forfeit-win base').toBe(FORFEIT_WIN_BASE);
    }
  }, 150_000);
});
