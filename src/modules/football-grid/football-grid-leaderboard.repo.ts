import { sql } from '../../db/index.js';
import type {
  FootballGridLeaderboardEntry,
  FootballGridUserRankResult,
} from './football-grid-leaderboard.types.js';

const visibleLeaderboardUsers = sql`
  u.is_ai = false
  AND u.is_seed = false
  AND u.is_deleted = false
  AND u.deleted_at IS NULL
  AND u.pending_deletion_at IS NULL
  AND u.tic_tac_toe_points > 0
`;

export const footballGridLeaderboardRepo = {
  async listLeaderboard(
    limit: number,
    offset: number,
    country?: string,
  ): Promise<FootballGridLeaderboardEntry[]> {
    const countryFilter = country ? sql`AND u.country = ${country}` : sql``;
    return sql<FootballGridLeaderboardEntry[]>`
      SELECT
        u.id AS "userId",
        COALESCE(u.nickname, 'Player') AS "username",
        u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization",
        u.tic_tac_toe_points AS "ticTacToePoints",
        u.country,
        CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS "tier"
      FROM users u
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE ${visibleLeaderboardUsers}
        ${countryFilter}
      ORDER BY u.tic_tac_toe_points DESC,
               u.tic_tac_toe_points_updated_at ASC,
               u.id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
  },

  async getUserRank(
    userId: string,
    country?: string,
  ): Promise<FootballGridUserRankResult | null> {
    const countryFilter = country ? sql`AND u.country = ${country}` : sql``;
    const [result] = await sql<FootballGridUserRankResult[]>`
      WITH target AS (
        SELECT u.id, u.tic_tac_toe_points, u.tic_tac_toe_points_updated_at,
               u.country,
               CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS tier
        FROM users u
        LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
        WHERE u.id = ${userId}
          AND ${visibleLeaderboardUsers}
          ${countryFilter}
      )
      SELECT
        target.tic_tac_toe_points AS "ticTacToePoints",
        target.tier AS "tier",
        (SELECT COUNT(*)::int + 1
         FROM users u
         WHERE ${visibleLeaderboardUsers}
           ${countryFilter}
           AND (
             u.tic_tac_toe_points > target.tic_tac_toe_points
             OR (
               u.tic_tac_toe_points = target.tic_tac_toe_points
               AND u.tic_tac_toe_points_updated_at < target.tic_tac_toe_points_updated_at
             )
             OR (
               u.tic_tac_toe_points = target.tic_tac_toe_points
               AND u.tic_tac_toe_points_updated_at = target.tic_tac_toe_points_updated_at
               AND u.id < target.id
             )
           )
        ) AS rank,
        (SELECT COUNT(*)::int
         FROM users u
         WHERE ${visibleLeaderboardUsers}
           ${countryFilter}
        ) AS total
      FROM target
    `;
    return result ?? null;
  },
};
