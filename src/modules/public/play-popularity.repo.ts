import { withStatementTimeout } from '../../db/index.js';

/** Well above what the read takes (under half a second on production data), well below a held connection. */
const QUERY_TIMEOUT_MS = 15_000;

export interface PlayPopularityRow { game: string; players_7d: number; players_3d: number }

/**
 * Distinct real players of each Play-page game in the last 7 and 3 days. A player is a member who is not a bot,
 * a seeded account or deleted, or a guest session; "played" is one finished daily challenge, one run of a daily
 * game or one round of a coin game. Distinct people per game is the one unit these tables share: some keep one
 * row per player and day, others a row per round.
 */
export const playPopularityRepo = {
  async load(): Promise<PlayPopularityRow[]> {
    return withStatementTimeout((tx) => tx.unsafe<PlayPopularityRow[]>(`
        WITH plays AS (
          SELECT 'daily:' || challenge_type AS game, user_id, NULL::uuid AS guest_id, completed_at AS at
            FROM daily_challenge_completions WHERE completed_at > now() - interval '7 days'
          UNION ALL SELECT 'daily:' || challenge_type, NULL, guest_id, created_at
            FROM guest_daily_completions WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'minuto', user_id, guest_id, created_at FROM minuto_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'shared-player', user_id, guest_id, created_at FROM shared_player_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'name-chain', user_id, guest_id, created_at FROM name_chain_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'tenable', user_id, guest_id, created_at FROM tenable_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'football-horserace', user_id, guest_id, created_at FROM football_race_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'buscaminas', user_id, guest_id, created_at FROM buscaminas_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'pistas', user_id, guest_id, created_at FROM pistas_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'ultimo', user_id, guest_id, created_at FROM ultimo_runs WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'guess-the-goal', user_id, NULL, created_at FROM guess_the_goal_sessions WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'trivia-mines', user_id, NULL, created_at FROM trivia_mines_rounds WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'free-kicks', user_id, NULL, created_at FROM free_kicks_rounds WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'road-to-goal', user_id, NULL, created_at FROM road_to_goal_rounds WHERE created_at > now() - interval '7 days'
          UNION ALL SELECT 'squad-spin', user_id, NULL, created_at FROM squad_spin_rounds WHERE created_at > now() - interval '7 days'
        ), linked AS (
          -- A guest who later signed in is counted as that member, not as a second player.
          SELECT p.game, COALESCE(p.user_id, g.linked_user_id) AS user_id, p.guest_id, p.at
            FROM plays p
            LEFT JOIN guest_sessions g ON p.user_id IS NULL AND g.id = p.guest_id
        ), real AS (
          SELECT p.game, COALESCE(p.user_id, p.guest_id) AS who, p.at
            FROM linked p
            LEFT JOIN users u ON u.id = p.user_id
           WHERE p.user_id IS NULL OR (u.is_ai = false AND u.is_seed = false AND u.is_deleted = false)
        )
        SELECT game,
               count(DISTINCT who)::int AS players_7d,
               (count(DISTINCT who) FILTER (WHERE at > now() - interval '3 days'))::int AS players_3d
          FROM real
         GROUP BY game`), QUERY_TIMEOUT_MS);
  },
};
