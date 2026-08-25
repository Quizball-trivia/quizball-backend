import { sql } from '../../db/index.js';
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
    country?: string
  ): Promise<AuctionLeaderboardEntry[]> {
    const countryFilter = country ? sql`AND u.country = ${country}` : sql``;
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
      WHERE u.is_ai = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.auction_points > 0
        ${countryFilter}
      ORDER BY u.auction_points DESC, u.updated_at ASC
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
  async getUserRank(userId: string, country?: string): Promise<AuctionUserRankResult | null> {
    const countryFilter = country ? sql`AND u.country = ${country}` : sql``;
    const [result] = await sql<AuctionUserRankResult[]>`
      WITH target AS (
        SELECT u.id, u.auction_points, u.updated_at, u.country,
               CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS tier
        FROM users u
        LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
        WHERE u.id = ${userId}
          AND u.is_ai = false
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
         WHERE u.is_ai = false
           AND u.is_seed = false
           AND u.is_deleted = false
           AND u.deleted_at IS NULL
           AND u.pending_deletion_at IS NULL
           AND u.auction_points > 0
           ${countryFilter}
           AND (
             u.auction_points > target.auction_points
             OR (u.auction_points = target.auction_points AND u.updated_at < target.updated_at)
           )
        ) AS rank,
        (SELECT COUNT(*)::int
         FROM users u
         WHERE u.is_ai = false
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
};
