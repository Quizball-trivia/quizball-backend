import { sql } from '../../db/index.js';

export interface HeadToHeadRow {
  wins_a: number;
  wins_b: number;
  draws: number;
  total: number;
  last_played_at: string | null;
}

export interface RecentMatchRow {
  match_id: string;
  mode: 'friendly' | 'ranked';
  status: 'completed' | 'abandoned';
  winner_user_id: string | null;
  ended_at: string | null;
  started_at: string;
  player_score: number;
  opponent_score: number;
  opponent_id: string | null;
  opponent_username: string | null;
  opponent_avatar_url: string | null;
  opponent_is_ai: boolean;
}

export interface UserModeMatchStatsRow {
  mode: 'friendly' | 'ranked';
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
}

export const statsRepo = {
  async getHeadToHead(userAId: string, userBId: string): Promise<HeadToHeadRow> {
    const [row] = await sql<HeadToHeadRow[]>`
      WITH h2h AS (
        SELECT m.id, m.ended_at, m.winner_user_id
        FROM matches m
        JOIN match_players a ON a.match_id = m.id AND a.user_id = ${userAId}
        JOIN match_players b ON b.match_id = m.id AND b.user_id = ${userBId}
        WHERE m.status = 'completed'
      )
      SELECT
        COUNT(*) FILTER (WHERE winner_user_id = ${userAId})::int AS wins_a,
        COUNT(*) FILTER (WHERE winner_user_id = ${userBId})::int AS wins_b,
        COUNT(*) FILTER (WHERE winner_user_id IS NULL)::int AS draws,
        COUNT(*)::int AS total,
        MAX(ended_at) AS last_played_at
      FROM h2h
    `;

    return (
      row ?? {
        wins_a: 0,
        wins_b: 0,
        draws: 0,
        total: 0,
        last_played_at: null,
      }
    );
  },

  async listRecentMatchesForUser(userId: string, limit: number): Promise<RecentMatchRow[]> {
    return sql<RecentMatchRow[]>`
      SELECT
        m.id AS match_id,
        m.mode,
        m.status,
        m.winner_user_id,
        m.ended_at,
        m.started_at,
        mp_self.total_points AS player_score,
        COALESCE(mp_opp.total_points, 0) AS opponent_score,
        opp.id AS opponent_id,
        opp.nickname AS opponent_username,
        opp.avatar_url AS opponent_avatar_url,
        false AS opponent_is_ai
      FROM matches m
      JOIN match_players mp_self
        ON mp_self.match_id = m.id
       AND mp_self.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT mp2.user_id, mp2.total_points
        FROM match_players mp2
        WHERE mp2.match_id = m.id
          AND mp2.user_id <> ${userId}
        ORDER BY mp2.seat ASC
        LIMIT 1
      ) AS mp_opp ON true
      LEFT JOIN users opp ON opp.id = mp_opp.user_id
      WHERE m.status IN ('completed', 'abandoned')
      ORDER BY COALESCE(m.ended_at, m.started_at) DESC
      LIMIT ${limit}
    `;
  },

  async getUserModeStats(userId: string): Promise<UserModeMatchStatsRow[]> {
    return sql<UserModeMatchStatsRow[]>`
      SELECT mode, games_played, wins, losses, draws
      FROM user_mode_match_stats
      WHERE user_id = ${userId}
    `;
  },
};
