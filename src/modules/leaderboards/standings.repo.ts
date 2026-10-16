import { sql } from '../../db/index.js';

export type StandingsMode = 'ranked' | 'auction' | 'ticTacToe';
export type StandingsKind = 'country' | 'club';

/** Players whose points count toward their group's score: real players only, under each board's own eligibility. */
function eligiblePlayers(mode: StandingsMode) {
  const people = sql`
    u.is_ai = false AND u.is_guest = false
    AND u.is_seed = false
    AND u.is_deleted = false
    AND u.deleted_at IS NULL
    AND u.pending_deletion_at IS NULL
  `;
  if (mode === 'ranked') {
    return sql`
      SELECT u.id AS user_id, rp.rp AS points, rp.updated_at AS tie_at,
             COALESCE(u.nickname, 'Player') AS username, u.country, u.favorite_club
      FROM ranked_profiles rp
      JOIN users u ON u.id = rp.user_id
      WHERE ${people} AND rp.placement_status = 'placed'
    `;
  }
  if (mode === 'auction') {
    return sql`
      SELECT u.id AS user_id, u.auction_points AS points, u.updated_at AS tie_at,
             COALESCE(u.nickname, 'Player') AS username, u.country, u.favorite_club
      FROM users u
      WHERE ${people} AND u.auction_points > 0
    `;
  }
  return sql`
    SELECT u.id AS user_id, u.tic_tac_toe_points AS points, u.tic_tac_toe_points_updated_at AS tie_at,
           COALESCE(u.nickname, 'Player') AS username, u.country, u.favorite_club
    FROM users u
    WHERE ${people} AND u.tic_tac_toe_points > 0
  `;
}

/** Each player tagged with the country or club they score for, numbered inside it by the board's ordering. */
function positioned(mode: StandingsMode, kind: StandingsKind) {
  const grouped = kind === 'country'
    ? sql`SELECT e.*, e.country AS board_key FROM (${eligiblePlayers(mode)}) e WHERE e.country IS NOT NULL`
    : sql`
        SELECT e.*, a.club_id AS board_key
        FROM (${eligiblePlayers(mode)}) e
        JOIN leaderboard_club_aliases a ON a.alias = lower(btrim(e.favorite_club))
      `;
  return sql`
    SELECT g.*, ROW_NUMBER() OVER (
      PARTITION BY g.board_key ORDER BY g.points DESC, g.tie_at ASC, g.user_id ASC
    ) AS pos
    FROM (${grouped}) g
  `;
}

export interface StandingRow {
  key: string;
  players: number;
  score: number;
  topUsername: string | null;
  topPoints: number | null;
}

export const standingsRepo = {
  /** Every group with at least one scoring player; score = its top 10 players' points added together. */
  async list(mode: StandingsMode, kind: StandingsKind): Promise<StandingRow[]> {
    return sql<StandingRow[]>`
      SELECT
        p.board_key AS key,
        COUNT(*)::int AS players,
        COALESCE(SUM(p.points) FILTER (WHERE p.pos <= 10), 0)::int AS score,
        MAX(p.username) FILTER (WHERE p.pos = 1) AS "topUsername",
        MAX(p.points) FILTER (WHERE p.pos = 1)::int AS "topPoints"
      FROM (${positioned(mode, kind)}) p
      GROUP BY p.board_key
      ORDER BY score DESC, players DESC, key ASC
    `;
  },

  /** The group's ten scoring players plus the viewer's own row (when they score at all). */
  async topTenAndViewer(
    mode: StandingsMode,
    kind: StandingsKind,
    key: string,
    userId: string,
  ): Promise<Array<{ userId: string; points: number; pos: number }>> {
    return sql<Array<{ userId: string; points: number; pos: number }>>`
      SELECT p.user_id AS "userId", p.points::int AS points, p.pos::int AS pos
      FROM (${positioned(mode, kind)}) p
      WHERE p.board_key = ${key} AND (p.pos <= 10 OR p.user_id = ${userId})
      ORDER BY p.pos
    `;
  },
};
