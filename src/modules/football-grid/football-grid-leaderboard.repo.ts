import { sql } from '../../db/index.js';
import { boardFilterSql, GLOBAL_BOARD, type BoardFilter } from '../leaderboards/board-filter.js';
import type {
  FootballGridLeaderboardEntry,
  FootballGridUserRankResult,
} from './football-grid-leaderboard.types.js';

const visibleLeaderboardUsers = sql`
  u.is_ai = false
  AND u.is_guest = false
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
    filter: BoardFilter = GLOBAL_BOARD,
  ): Promise<FootballGridLeaderboardEntry[]> {
    // Treat the schema as the first line of defence, not the only one. Direct
    // service/repository callers and future endpoints cannot create unbounded
    // scans or arbitrary cache-key cardinality.
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isSafeInteger(limit) ? limit : 50)));
    const safeOffset = Math.min(10_000, Math.max(0, Math.trunc(Number.isSafeInteger(offset) ? offset : 0)));
    const countryFilter = boardFilterSql(filter);
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
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `;
  },

  async getUserRank(
    userId: string,
    filter: BoardFilter = GLOBAL_BOARD,
  ): Promise<FootballGridUserRankResult | null> {
    const countryFilter = boardFilterSql(filter);
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

  /** The player directly above `userId` on the board, under the list's ordering. */
  async getNextAbove(
    userId: string,
    filter: BoardFilter = GLOBAL_BOARD,
  ): Promise<{ username: string; points: number } | null> {
    const boardFilter = boardFilterSql(filter);
    const [row] = await sql<{ username: string; points: number }[]>`
      WITH target AS (
        SELECT id, tic_tac_toe_points, tic_tac_toe_points_updated_at FROM users WHERE id = ${userId}
      )
      SELECT COALESCE(u.nickname, 'Player') AS username, u.tic_tac_toe_points AS points
      FROM users u, target
      WHERE ${visibleLeaderboardUsers}
        ${boardFilter}
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
      ORDER BY u.tic_tac_toe_points ASC, u.tic_tac_toe_points_updated_at DESC, u.id DESC
      LIMIT 1
    `;
    return row ?? null;
  },
};
