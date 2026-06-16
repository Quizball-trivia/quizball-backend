import { sql } from '../../db/index.js';
import type { StatsOverview, DailyTrendPoint } from './admin-stats.types.js';

// "Real" users everywhere = humans only: not AI, not seed fixtures, not deleted.
// Pending-deletion accounts are still real today, so they are counted in totals
// but excluded from "active" engagement where it would inflate the number.

export const adminStatsRepo = {
  /**
   * Headline totals in a single round-trip. All counts are real-human only.
   * Cheap: these are plain filtered counts over users (3k rows) plus two
   * window-scoped distinct counts over today's matches.
   */
  async getTotals(): Promise<Omit<StatsOverview, 'trend'>> {
    const [row] = await sql<
      {
        total_users: number;
        total_users_excl_pending: number;
        onboarded_users: number;
        signups_today: number;
        signups_yesterday: number;
        dau_today: number;
        dau_yesterday: number;
        matches_today: number;
        matches_yesterday: number;
      }[]
    >`
      WITH today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d),
      user_counts AS (
        SELECT
          count(*) FILTER (WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted)::int AS total_users,
          count(*) FILTER (
            WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted
              AND deleted_at IS NULL AND pending_deletion_at IS NULL
          )::int AS total_users_excl_pending,
          count(*) FILTER (
            WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted
              AND deleted_at IS NULL AND pending_deletion_at IS NULL
              AND onboarding_complete
          )::int AS onboarded_users,
          count(*) FILTER (
            WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted
              AND (created_at AT TIME ZONE 'UTC')::date = (SELECT d FROM today)
          )::int AS signups_today,
          count(*) FILTER (
            WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted
              AND (created_at AT TIME ZONE 'UTC')::date = (SELECT d FROM today) - 1
          )::int AS signups_yesterday
        FROM users
      ),
      match_counts AS (
        SELECT
          count(DISTINCT mp.user_id) FILTER (
            WHERE (m.started_at AT TIME ZONE 'UTC')::date = (SELECT d FROM today)
          )::int AS dau_today,
          count(DISTINCT mp.user_id) FILTER (
            WHERE (m.started_at AT TIME ZONE 'UTC')::date = (SELECT d FROM today) - 1
          )::int AS dau_yesterday,
          count(DISTINCT m.id) FILTER (
            WHERE (m.started_at AT TIME ZONE 'UTC')::date = (SELECT d FROM today)
          )::int AS matches_today,
          count(DISTINCT m.id) FILTER (
            WHERE (m.started_at AT TIME ZONE 'UTC')::date = (SELECT d FROM today) - 1
          )::int AS matches_yesterday
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        JOIN users u ON u.id = mp.user_id
        WHERE u.is_ai = false AND u.is_deleted = false AND u.is_seed = false
          AND m.started_at >= (SELECT d FROM today) - 1
      )
      SELECT * FROM user_counts, match_counts
    `;

    return {
      totalUsers: row.total_users,
      totalUsersExclPending: row.total_users_excl_pending,
      onboardedUsers: row.onboarded_users,
      signupsToday: row.signups_today,
      signupsYesterday: row.signups_yesterday,
      dauToday: row.dau_today,
      dauYesterday: row.dau_yesterday,
      matchesToday: row.matches_today,
      matchesYesterday: row.matches_yesterday,
    };
  },

  /**
   * Last 7 days (incl. today) of signups, DAU (distinct real players who
   * played >=1 match) and match volume — one row per calendar day, UTC.
   *
   * Built from two independently-windowed aggregates joined on a generated
   * day series so days with zero of one metric still render. Each side scans
   * only the 7-day window, not full history.
   */
  async getDailyTrend(days = 7): Promise<DailyTrendPoint[]> {
    const rows = await sql<
      { day: string; signups: number; dau: number; matches: number }[]
    >`
      WITH series AS (
        SELECT generate_series(
          (now() AT TIME ZONE 'UTC')::date - (${days}::int - 1),
          (now() AT TIME ZONE 'UTC')::date,
          interval '1 day'
        )::date AS day
      ),
      signups AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
        FROM users
        WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted
          AND created_at >= (now() AT TIME ZONE 'UTC')::date - (${days}::int - 1)
        GROUP BY 1
      ),
      played AS (
        SELECT (m.started_at AT TIME ZONE 'UTC')::date AS day,
               count(DISTINCT mp.user_id)::int AS dau,
               count(DISTINCT m.id)::int AS matches
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        JOIN users u ON u.id = mp.user_id
        WHERE u.is_ai = false AND u.is_deleted = false AND u.is_seed = false
          AND m.started_at >= (now() AT TIME ZONE 'UTC')::date - (${days}::int - 1)
        GROUP BY 1
      )
      SELECT
        to_char(s.day, 'YYYY-MM-DD') AS day,
        COALESCE(g.n, 0) AS signups,
        COALESCE(p.dau, 0) AS dau,
        COALESCE(p.matches, 0) AS matches
      FROM series s
      LEFT JOIN signups g ON g.day = s.day
      LEFT JOIN played p ON p.day = s.day
      ORDER BY s.day
    `;
    return rows.map((r) => ({
      day: r.day,
      signups: r.signups,
      dau: r.dau,
      matches: r.matches,
    }));
  },
};
