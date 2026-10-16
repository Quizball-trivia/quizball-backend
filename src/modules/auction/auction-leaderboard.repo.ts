import { sql } from '../../db/index.js';
import { boardFilterSql, GLOBAL_BOARD, type BoardFilter } from '../leaderboards/board-filter.js';
import type {
  AuctionLeaderboardEntry,
  AuctionUserRankResult,
} from './auction-leaderboard.types.js';

export const auctionLeaderboardRepo = {
  /**
   * Top auction players by AP. Mirrors the ranked leaderboard's eligibility
   * filters (no AI, seed, deleted or pending-deletion users) so both boards show
   * the same population, and orders by the same (score DESC, updated_at ASC)
   * tiebreaker — reaching a score earlier ranks you higher.
   *
   * `auction_points > 0` keeps players who never earned AP off the board (and
   * matches the partial index backing this query).
   */
  async listLeaderboard(
    limit: number,
    offset: number,
    filter: BoardFilter = GLOBAL_BOARD
  ): Promise<AuctionLeaderboardEntry[]> {
    const countryFilter = boardFilterSql(filter);
    return sql<AuctionLeaderboardEntry[]>`
      SELECT
        u.id AS "userId",
        COALESCE(u.nickname, 'Player') AS "username",
        u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization",
        u.auction_points AS "auctionPoints",
        u.country,
        CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS "tier"
      FROM users u
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE u.is_ai = false AND u.is_guest = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.auction_points > 0
        ${countryFilter}
      ORDER BY u.auction_points DESC, u.updated_at ASC, u.id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
  },

  /**
   * The requesting user's own position. Returns null when the user isn't
   * eligible for the board (no AP yet, or filtered out) so the caller can render
   * an "unranked" state instead of a bogus rank.
   *
   * Rank counts everyone strictly ahead under the SAME ordering used by
   * listLeaderboard — including the updated_at tiebreaker — so a user's reported
   * rank always matches the row they occupy on the paged list.
   */
  async getUserRank(userId: string, filter: BoardFilter = GLOBAL_BOARD): Promise<AuctionUserRankResult | null> {
    const countryFilter = boardFilterSql(filter);
    const [result] = await sql<AuctionUserRankResult[]>`
      WITH target AS (
        SELECT u.id, u.auction_points, u.updated_at, u.country,
               CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS tier
        FROM users u
        LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
        WHERE u.id = ${userId}
          AND u.is_ai = false AND u.is_guest = false
          AND u.is_seed = false
          AND u.is_deleted = false
          AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL
          AND u.auction_points > 0
          ${countryFilter}
      )
      SELECT
        target.auction_points AS "auctionPoints",
        target.tier AS "tier",
        (SELECT COUNT(*)::int + 1
         FROM users u
         WHERE u.is_ai = false AND u.is_guest = false
           AND u.is_seed = false
           AND u.is_deleted = false
           AND u.deleted_at IS NULL
           AND u.pending_deletion_at IS NULL
           AND u.auction_points > 0
           ${countryFilter}
           AND (
             u.auction_points > target.auction_points
             OR (u.auction_points = target.auction_points AND u.updated_at < target.updated_at)
             OR (u.auction_points = target.auction_points AND u.updated_at = target.updated_at AND u.id < target.id)
           )
        ) AS rank,
        (SELECT COUNT(*)::int
         FROM users u
         WHERE u.is_ai = false AND u.is_guest = false
           AND u.is_seed = false
           AND u.is_deleted = false
           AND u.deleted_at IS NULL
           AND u.pending_deletion_at IS NULL
           AND u.auction_points > 0
           ${countryFilter}
        ) AS total
      FROM target
    `;
    return result ?? null;
  },

  /** The player directly above `userId` on the board, under the list's ordering. */
  async getNextAbove(userId: string, filter: BoardFilter = GLOBAL_BOARD): Promise<{ username: string; points: number } | null> {
    const boardFilter = boardFilterSql(filter);
    const [row] = await sql<{ username: string; points: number }[]>`
      WITH target AS (
        SELECT id, auction_points, updated_at FROM users WHERE id = ${userId}
      )
      SELECT COALESCE(u.nickname, 'Player') AS username, u.auction_points AS points
      FROM users u, target
      WHERE u.is_ai = false AND u.is_guest = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.auction_points > 0
        ${boardFilter}
        AND (
          u.auction_points > target.auction_points
          OR (u.auction_points = target.auction_points AND u.updated_at < target.updated_at)
          OR (u.auction_points = target.auction_points AND u.updated_at = target.updated_at AND u.id < target.id)
        )
      ORDER BY u.auction_points ASC, u.updated_at DESC, u.id DESC
      LIMIT 1
    `;
    return row ?? null;
  },
};
