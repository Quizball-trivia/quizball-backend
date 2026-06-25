import { logger } from '../../core/logger.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import type { AuctionMatchState } from '../../modules/auction/auction-match-state.js';

// Coin participation rewards, granted once per settled auction match to each
// real human who reaches the finish (a forfeiter's seat is gone by then, so
// they get nothing). Win (1st place) pays more; any other finish still pays.
export const AUCTION_WIN_COINS = 500;
export const AUCTION_FINISH_COINS = 300;

export function auctionCoinsForPlacement(placement: number): number {
  return placement === 1 ? AUCTION_WIN_COINS : AUCTION_FINISH_COINS;
}

/**
 * Persist a FINISHED auction match to Postgres so it appears in Recent Matches
 * and stats — the same `matches` + `match_players` tables ranked/friendly/party
 * use. Auction lived only in Redis before this. Also grants coin rewards to the
 * real humans who finished. Returns the coins granted per userId (empty on a
 * no-op / already-persisted / failure) so the realtime layer can tell each
 * client what they earned.
 *
 * Bot seats aren't real users, so we create synthetic `is_ai` user rows for
 * them (mirroring how ranked/party persist AI opponents); orphaned AI users are
 * swept by the existing cleanup in matchesService.
 *
 * Idempotent: createAuctionMatch is ON CONFLICT DO NOTHING and gates everything
 * after it (coins included), so a retry / double-finish never double-pays.
 */
export async function persistFinishedAuctionMatch(
  state: AuctionMatchState,
): Promise<Record<string, number>> {
  if (state.phase !== 'finished' || !state.rankings) return {};

  try {
    // 1) Create the match row (id = the auction's own match id). The "newly
    // created" result is our once-per-match guard for everything below
    // (stats + coins) — a re-finish hits ON CONFLICT and returns no row.
    const created = await matchesRepo.createAuctionMatch({ id: state.matchId });
    if (!created) {
      // Already persisted (ON CONFLICT DO NOTHING) — nothing to do.
      return {};
    }

    // 2) Resolve a DB user id for every seat (synthetic AI user for bots).
    const seatRows = await Promise.all(
      state.rankings.map(async (ranking, index) => {
        const isBot = ranking.isBot;
        let userId = ranking.userId ?? null;

        if (isBot || !userId) {
          const aiUser = await usersRepo.create({
            nickname: ranking.displayName || `AI ${index + 1}`,
            avatarUrl: ranking.player?.avatarUrl ?? null,
            isAi: true,
          });
          userId = aiUser.id;
        }

        return {
          userId,
          seat: index + 1,
          totalPoints: Math.round(ranking.totalTrueValue),
          placement: ranking.rank,
          isBot,
        };
      })
    );

    // 3) Insert match_players (team value + placement).
    await matchesRepo.insertAuctionMatchPlayers(
      state.matchId,
      seatRows.map(({ userId, seat, totalPoints, placement }) => ({ userId, seat, totalPoints, placement })),
    );

    // 4) Winner = the human/seat at placement 1; null on a tie (no sole 1st).
    const firsts = seatRows.filter((row) => row.placement === 1);
    const winnerId = firsts.length === 1 ? firsts[0].userId : null;

    // completeMatch flips status→completed, writes user_mode_match_stats per
    // player (wins/losses/draws by winnerId), same as every other mode.
    await matchesService.completeMatch(state.matchId, winnerId);

    // 5) Coin rewards — real humans only (bots have synthetic wallets we don't
    // care about). Gated by the `created` guard above, so paid exactly once.
    const coinsByUserId: Record<string, number> = {};
    for (const row of seatRows) {
      if (row.isBot) continue;
      const coins = auctionCoinsForPlacement(row.placement);
      await matchesRepo.addCoins(row.userId, coins);
      coinsByUserId[row.userId] = coins;
    }

    logger.info(
      { matchId: state.matchId, winnerId, seats: seatRows.length, coinsByUserId },
      'Persisted finished auction match'
    );
    return coinsByUserId;
  } catch (error) {
    // Never let persistence failure break the live match flow — the match is
    // already over for players; log and move on.
    logger.error({ error, matchId: state.matchId }, 'Failed to persist auction match');
    return {};
  }
}
