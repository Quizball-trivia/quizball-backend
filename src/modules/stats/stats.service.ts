import { statsRepo } from './stats.repo.js';
import { BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { parseStoredAvatarCustomization, type AvatarCustomization } from '../users/avatar-customization.js';
import { tierFromRp } from '../ranked/ranked.service.js';
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

export interface RecentMatchSummary {
  matchId: string;
  mode: 'friendly' | 'ranked';
  competition: 'friendly' | 'placement' | 'ranked';
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

/** Ranked W/D/L split at the World Cup event START.
 *  `regular` = ranked games before the event began (the normal ranked record);
 *  `event`   = ranked games played during the event. */
export interface RankedSeasonSplit {
  regular: ModeStatsSummary;
  event: ModeStatsSummary;
}

export interface UserStatsSummary {
  overall: ModeStatsSummary;
  ranked: ModeStatsSummary;
  friendly: ModeStatsSummary;
  /** Ranked W/D/L partitioned at the event start (regular vs during-event). */
  rankedSeasons: RankedSeasonSplit;
}

// World Cup event START. Ranked games before this are the regular record; games
// on/after it count toward the World Cup event.
const EVENT_START_ISO = '2026-06-11T00:00:00Z';

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
      const result: RecentMatchSummary['result'] =
        row.winner_user_id === null
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
      const competition: RecentMatchSummary['competition'] = row.mode === 'friendly'
        ? 'friendly'
        : row.ranked_is_placement
          ? 'placement'
          : 'ranked';

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
        opponent: {
          id: row.opponent_id,
          username: row.opponent_username ?? 'Opponent',
          avatarUrl: row.opponent_avatar_url,
          avatarCustomization: parseStoredAvatarCustomization(row.opponent_avatar_customization),
          isAi: row.opponent_is_ai ?? false,
          // Only show a tier for placed opponents — unplaced/AI/deleted/no-profile
          // map to null so the client renders a neutral frame instead of a wrong one.
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
    const [rows, split] = await Promise.all([
      statsRepo.getUserModeStats(userId),
      statsRepo.getRankedStatsByEventWindow(userId, EVENT_START_ISO),
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

    const regularGames = split.regular_wins + split.regular_losses + split.regular_draws;
    const eventGames = split.event_wins + split.event_losses + split.event_draws;

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
        regular: {
          gamesPlayed: regularGames,
          wins: split.regular_wins,
          losses: split.regular_losses,
          draws: split.regular_draws,
          winRate: toWinRate(split.regular_wins, regularGames),
        },
        event: {
          gamesPlayed: eventGames,
          wins: split.event_wins,
          losses: split.event_losses,
          draws: split.event_draws,
          winRate: toWinRate(split.event_wins, eventGames),
        },
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
};
