import { statsRepo } from './stats.repo.js';
import { BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { parseStoredAvatarCustomization, type AvatarCustomization } from '../users/avatar-customization.js';
import { tierFromRp } from '../ranked/ranked.service.js';
import { rankedRepo } from '../ranked/ranked.repo.js';
import type { RankedTier } from '../ranked/ranked.types.js';

export interface HeadToHeadSummary {
  userAId: string;
  userBId: string;
  winsA: number;
  winsB: number;
  draws: number;
  total: number;
  lastPlayedAt: string | null;
}

const VALID_WINNER_DECISION_METHODS = ['goals', 'penalty_goals', 'total_points', 'total_points_fallback', 'forfeit'] as const;
export type WinnerDecisionMethod = (typeof VALID_WINNER_DECISION_METHODS)[number];

export interface RecentMatchOpponentSummary {
  id: string | null;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  isAi: boolean;
  /** Finishing place in a multi-player (auction) match. null for 1v1. */
  placement: number | null;
}

export interface RecentMatchSummary {
  matchId: string;
  mode: 'friendly' | 'ranked' | 'auction';
  competition: 'friendly' | 'placement' | 'ranked' | 'auction';
  status: 'completed' | 'abandoned';
  result: 'win' | 'loss' | 'draw';
  endedAt: string | null;
  playerScore: number;
  opponentScore: number;
  playerGoals: number;
  playerPenaltyGoals: number;
  opponentGoals: number;
  opponentPenaltyGoals: number;
  winnerDecisionMethod: WinnerDecisionMethod | null;
  cancelledNoContest: boolean;
  rpDelta: number | null;
  /** Auction: your finishing place (1 = won). null for 1v1 modes. */
  placement: number | null;
  /** Total players in the match (auction = 3). Used for "1st of N". */
  playerCount: number;
  /** Auction: all other players you faced (2 opponents). Empty for 1v1. */
  opponents: RecentMatchOpponentSummary[];
  opponent: {
    id: string | null;
    username: string;
    avatarUrl: string | null;
    avatarCustomization: AvatarCustomization | null;
    isAi: boolean;
    /** Opponent's ranked tier. null when the opponent is AI, unplaced, deleted,
     *  or has no ranked profile yet. */
    tier: RankedTier | null;
  };
}

export interface ModeStatsSummary {
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}

export interface RankedSeasonSplit {
  current: ModeStatsSummary;
  previous: ModeStatsSummary;
  currentSeasonNumber: number;
  previousSeasonNumber: number | null;
}

export interface UserStatsSummary {
  overall: ModeStatsSummary;
  ranked: ModeStatsSummary;
  friendly: ModeStatsSummary;
  rankedSeasons: RankedSeasonSplit;
}

interface SeasonBoundary {
  boundaryIso: string;
  currentSeasonNumber: number;
  previousSeasonNumber: number | null;
}

const SEASON_BOUNDARY_CACHE_TTL_MS = 5 * 60 * 1000;
const FRESH_SEASON_BOUNDARY: SeasonBoundary = {
  boundaryIso: '1970-01-01T00:00:00Z',
  currentSeasonNumber: 1,
  previousSeasonNumber: null,
};

let seasonBoundaryCache: { value: SeasonBoundary; expiresAt: number } | null = null;
let seasonBoundaryLoad: Promise<SeasonBoundary> | null = null;

async function getSeasonBoundary(): Promise<SeasonBoundary> {
  const now = Date.now();
  if (seasonBoundaryCache && seasonBoundaryCache.expiresAt > now) {
    return seasonBoundaryCache.value;
  }

  seasonBoundaryLoad ??= rankedRepo.getLatestCompletedSeasonReset().then((reset) => {
    const value = reset
      ? {
          boundaryIso: reset.completedAt,
          currentSeasonNumber: reset.seasonNumber + 1,
          previousSeasonNumber: reset.seasonNumber,
        }
      : FRESH_SEASON_BOUNDARY;
    seasonBoundaryCache = {
      value,
      expiresAt: Date.now() + SEASON_BOUNDARY_CACHE_TTL_MS,
    };
    return value;
  });

  try {
    return await seasonBoundaryLoad;
  } finally {
    seasonBoundaryLoad = null;
  }
}

export function _resetSeasonBoundaryCacheForTests(): void {
  seasonBoundaryCache = null;
  seasonBoundaryLoad = null;
}

function toWinRate(wins: number, gamesPlayed: number): number {
  if (gamesPlayed <= 0) return 0;
  return Number(((wins / gamesPlayed) * 100).toFixed(2));
}

function emptyModeStats(): ModeStatsSummary {
  return {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: 0,
  };
}

export const statsService = {
  async getHeadToHead(userAId: string, userBId: string): Promise<HeadToHeadSummary> {
    if (userAId === userBId) {
      throw new BadRequestError('userA and userB must be different');
    }

    const row = await statsRepo.getHeadToHead(userAId, userBId);
    return {
      userAId,
      userBId,
      winsA: row.wins_a,
      winsB: row.wins_b,
      draws: row.draws,
      total: row.total,
      lastPlayedAt: row.last_played_at,
    };
  },

  async getRecentMatchesForUser(userId: string, limit: number): Promise<RecentMatchSummary[]> {
    const rows = await statsRepo.listRecentMatchesForUser(userId, limit);
    return rows.map((row) => {
      // Auction has no single winner_user_id semantics for the viewer — derive
      // result from the viewer's placement (1 = win, tie at 1 = draw, else loss).
      const result: RecentMatchSummary['result'] =
        row.mode === 'auction'
          ? row.player_placement === 1
            ? 'win'
            : 'loss'
          : row.winner_user_id === null
            ? 'draw'
            : row.winner_user_id === userId
              ? 'win'
              : 'loss';

      const rawMethod = row.winner_decision_method;
      if (rawMethod && !(VALID_WINNER_DECISION_METHODS as readonly string[]).includes(rawMethod)) {
        logger.warn({ matchId: row.match_id, value: rawMethod }, 'Unexpected winner_decision_method');
      }
      const winnerDecisionMethod: WinnerDecisionMethod | null =
        rawMethod && (VALID_WINNER_DECISION_METHODS as readonly string[]).includes(rawMethod)
          ? (rawMethod as WinnerDecisionMethod)
          : null;
      const competition: RecentMatchSummary['competition'] = row.mode === 'auction'
        ? 'auction'
        : row.mode === 'friendly'
          ? 'friendly'
          : row.ranked_is_placement
            ? 'placement'
            : 'ranked';

      const opponents: RecentMatchOpponentSummary[] = (row.opponents ?? []).map((o) => ({
        id: o.id,
        username: o.username ?? 'Player',
        avatarUrl: o.avatarUrl,
        avatarCustomization: parseStoredAvatarCustomization(o.avatarCustomization),
        isAi: o.isAi ?? false,
        placement: o.placement,
      }));

      return {
        matchId: row.match_id,
        mode: row.mode,
        competition,
        status: row.status,
        result,
        endedAt: row.ended_at,
        playerScore: row.player_score,
        opponentScore: row.opponent_score,
        playerGoals: row.player_goals,
        playerPenaltyGoals: row.player_penalty_goals,
        opponentGoals: row.opponent_goals,
        opponentPenaltyGoals: row.opponent_penalty_goals,
        winnerDecisionMethod,
        cancelledNoContest: row.cancelled_no_contest === true,
        rpDelta: row.mode === 'ranked' ? row.ranked_delta_rp : null,
        placement: row.player_placement,
        playerCount: row.player_count,
        opponents,
        opponent: {
          id: row.opponent_id,
          username: row.opponent_username ?? 'Opponent',
          avatarUrl: row.opponent_avatar_url,
          avatarCustomization: parseStoredAvatarCustomization(row.opponent_avatar_customization),
          isAi: row.opponent_is_ai ?? false,
          // Only show a tier for placed opponents — unplaced/ephemeral-AI/deleted/
          // no-profile map to null so the client renders a neutral frame instead
          // of a wrong one. opponent_is_ai is already public-masked (persistent
          // bots read false), so a placed persistent bot shows its real tier.
          tier:
            !row.opponent_is_ai
            && row.opponent_placement_status === 'placed'
            && row.opponent_rp !== null
              ? tierFromRp(row.opponent_rp)
              : null,
        },
      };
    });
  },

  async getUserStatsSummary(userId: string): Promise<UserStatsSummary> {
    const seasonBoundary = await getSeasonBoundary();
    const [rows, split] = await Promise.all([
      statsRepo.getUserModeStats(userId),
      statsRepo.getRankedStatsSplitAtBoundary(userId, seasonBoundary.boundaryIso),
    ]);

    const ranked = emptyModeStats();
    const friendly = emptyModeStats();

    for (const row of rows) {
      const target = row.mode === 'ranked' ? ranked : friendly;
      target.gamesPlayed = row.games_played;
      target.wins = row.wins;
      target.losses = row.losses;
      target.draws = row.draws;
      target.winRate = toWinRate(row.wins, row.games_played);
    }

    const overallGames = ranked.gamesPlayed + friendly.gamesPlayed;
    const overallWins = ranked.wins + friendly.wins;
    const overallLosses = ranked.losses + friendly.losses;
    const overallDraws = ranked.draws + friendly.draws;

    const currentGames = split.current_wins + split.current_losses + split.current_draws;
    const previousGames = split.previous_wins + split.previous_losses + split.previous_draws;

    return {
      overall: {
        gamesPlayed: overallGames,
        wins: overallWins,
        losses: overallLosses,
        draws: overallDraws,
        winRate: toWinRate(overallWins, overallGames),
      },
      ranked,
      friendly,
      rankedSeasons: {
        current: {
          gamesPlayed: currentGames,
          wins: split.current_wins,
          losses: split.current_losses,
          draws: split.current_draws,
          winRate: toWinRate(split.current_wins, currentGames),
        },
        previous: {
          gamesPlayed: previousGames,
          wins: split.previous_wins,
          losses: split.previous_losses,
          draws: split.previous_draws,
          winRate: toWinRate(split.previous_wins, previousGames),
        },
        currentSeasonNumber: seasonBoundary.currentSeasonNumber,
        previousSeasonNumber: seasonBoundary.previousSeasonNumber,
      },
    };
  },

  /**
   * Returns the user's last `limit` completed match results as 'W' | 'L' | 'D'
   * letters, most recent first. Used by the showdown screen.
   */
  async getRecentFormForUser(userId: string, limit: number): Promise<Array<'W' | 'L' | 'D'>> {
    const rows = await statsRepo.listRecentFormForUser(userId, limit);
    return rows.map((row) =>
      row.winner_user_id === null ? 'D' : row.winner_user_id === userId ? 'W' : 'L',
    );
  },

  async getRecentFormsForUsers(
    userIds: string[],
    limit: number,
  ): Promise<Map<string, Array<'W' | 'L' | 'D'>>> {
    const uniqueUserIds = [...new Set(userIds)];
    const forms = new Map<string, Array<'W' | 'L' | 'D'>>(
      uniqueUserIds.map((userId) => [userId, []]),
    );
    const rows = await statsRepo.listRecentFormsForUsers(uniqueUserIds, limit);
    for (const row of rows) {
      forms.get(row.user_id)?.push(
        row.winner_user_id === null ? 'D' : row.winner_user_id === row.user_id ? 'W' : 'L',
      );
    }
    return forms;
  },
};
