import { sql } from '../../db/index.js';

export interface HeadToHeadRow {
  wins_a: number;
  wins_b: number;
  draws: number;
  total: number;
  last_played_at: string | null;
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
};
