import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';

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
  player_goals: number;
  player_penalty_goals: number;
  opponent_goals: number;
  opponent_penalty_goals: number;
  winner_decision_method: string | null;
  cancelled_no_contest: boolean;
  ranked_delta_rp: number | null;
  ranked_is_placement: boolean | null;
  opponent_id: string | null;
  opponent_username: string | null;
  opponent_avatar_url: string | null;
  opponent_avatar_customization: Json | null;
  opponent_is_ai: boolean;
  opponent_rp: number | null;
  opponent_placement_status: 'unplaced' | 'in_progress' | 'placed' | null;
}

export interface UserModeMatchStatsRow {
  mode: 'friendly' | 'ranked';
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface RankedSplitStatsRow {
  regular_wins: number;
  regular_losses: number;
  regular_draws: number;
  event_wins: number;
  event_losses: number;
  event_draws: number;
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
        CASE
          WHEN m.state_payload->>'variant' = 'friendly_party_quiz' THEN mp_self.total_points
          ELSE (mp_self.goals + mp_self.penalty_goals)
        END AS player_score,
        CASE
          WHEN m.state_payload->>'variant' = 'friendly_party_quiz' THEN COALESCE(mp_opp.total_points, 0)
          ELSE COALESCE(mp_opp.goals + mp_opp.penalty_goals, 0)
        END AS opponent_score,
        mp_self.goals AS player_goals,
        mp_self.penalty_goals AS player_penalty_goals,
        COALESCE(mp_opp.goals, 0) AS opponent_goals,
        COALESCE(mp_opp.penalty_goals, 0) AS opponent_penalty_goals,
        m.state_payload->>'winnerDecisionMethod' AS winner_decision_method,
        COALESCE((m.state_payload->>'cancelledNoContest')::boolean, false) AS cancelled_no_contest,
        rrc.delta_rp AS ranked_delta_rp,
        rrc.is_placement AS ranked_is_placement,
        CASE
          WHEN opp.is_deleted = true OR opp.deleted_at IS NOT NULL OR opp.pending_deletion_at IS NOT NULL THEN NULL
          ELSE opp.id
        END AS opponent_id,
        CASE
          WHEN opp.is_deleted = true OR opp.deleted_at IS NOT NULL OR opp.pending_deletion_at IS NOT NULL THEN 'Deleted Player'
          ELSE opp.nickname
        END AS opponent_username,
        CASE
          WHEN opp.is_deleted = true OR opp.deleted_at IS NOT NULL OR opp.pending_deletion_at IS NOT NULL THEN NULL
          ELSE opp.avatar_url
        END AS opponent_avatar_url,
        CASE
          WHEN opp.is_deleted = true OR opp.deleted_at IS NOT NULL OR opp.pending_deletion_at IS NOT NULL THEN NULL
          ELSE opp.avatar_customization
        END AS opponent_avatar_customization,
        COALESCE(opp.is_ai, false) AS opponent_is_ai,
        CASE
          WHEN opp.is_deleted = true OR opp.deleted_at IS NOT NULL OR opp.pending_deletion_at IS NOT NULL THEN NULL
          ELSE opp_ranked.rp
        END AS opponent_rp,
        CASE
          WHEN opp.is_deleted = true OR opp.deleted_at IS NOT NULL OR opp.pending_deletion_at IS NOT NULL THEN NULL
          ELSE opp_ranked.placement_status
        END AS opponent_placement_status
      FROM matches m
      JOIN match_players mp_self
        ON mp_self.match_id = m.id
       AND mp_self.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT mp2.user_id, mp2.goals, mp2.penalty_goals, mp2.total_points
        FROM match_players mp2
        WHERE mp2.match_id = m.id
          AND mp2.user_id <> ${userId}
        ORDER BY mp2.seat ASC
        LIMIT 1
      ) AS mp_opp ON true
      LEFT JOIN ranked_rp_changes rrc
        ON rrc.match_id = m.id
       AND rrc.user_id = mp_self.user_id
      LEFT JOIN users opp ON opp.id = mp_opp.user_id
      LEFT JOIN ranked_profiles opp_ranked ON opp_ranked.user_id = mp_opp.user_id
      WHERE m.status IN ('completed', 'abandoned')
        AND m.is_dev = false
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

  /**
   * Ranked W/D/L split around the World Cup event / leaderboard-reset boundary.
   * The pre-aggregated `user_mode_match_stats` table has no date dimension, so we
   * count from `matches` directly. Two buckets split at the event START:
   *   regular — matches that ended BEFORE the event started (the normal ranked
   *             record from before the World Cup event)
   *   event   — matches that ended on/after the event start (games played during
   *             the World Cup event window)
   * Only ranked, completed, non-dev matches are counted.
   */
  async getRankedStatsByEventWindow(
    userId: string,
    eventStartIso: string,
  ): Promise<RankedSplitStatsRow> {
    // A no-winner match is only a real DRAW when both players were present and
    // the result was tied. Abandoned / opponent-never-joined matches also have a
    // NULL winner but only one match_players row, and the RP system scores those
    // as losses — so count them as losses here too (via pc.player_count), not as
    // draws, to keep the profile W/L/D consistent with RP.
    const [row] = await sql<RankedSplitStatsRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE m.ended_at < ${eventStartIso}::timestamptz AND m.winner_user_id = ${userId})::int AS regular_wins,
        COUNT(*) FILTER (WHERE m.ended_at < ${eventStartIso}::timestamptz AND ((m.winner_user_id IS NOT NULL AND m.winner_user_id <> ${userId}) OR (m.winner_user_id IS NULL AND pc.player_count < 2)))::int AS regular_losses,
        COUNT(*) FILTER (WHERE m.ended_at < ${eventStartIso}::timestamptz AND m.winner_user_id IS NULL AND pc.player_count >= 2)::int AS regular_draws,
        COUNT(*) FILTER (WHERE m.ended_at >= ${eventStartIso}::timestamptz AND m.winner_user_id = ${userId})::int AS event_wins,
        COUNT(*) FILTER (WHERE m.ended_at >= ${eventStartIso}::timestamptz AND ((m.winner_user_id IS NOT NULL AND m.winner_user_id <> ${userId}) OR (m.winner_user_id IS NULL AND pc.player_count < 2)))::int AS event_losses,
        COUNT(*) FILTER (WHERE m.ended_at >= ${eventStartIso}::timestamptz AND m.winner_user_id IS NULL AND pc.player_count >= 2)::int AS event_draws
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      JOIN (
        SELECT match_id, COUNT(*) AS player_count
        FROM match_players
        GROUP BY match_id
      ) pc ON pc.match_id = m.id
      WHERE mp.user_id = ${userId}
        AND m.mode = 'ranked'
        AND m.status = 'completed'
        AND m.is_dev = false
    `;
    return (
      row ?? {
        regular_wins: 0,
        regular_losses: 0,
        regular_draws: 0,
        event_wins: 0,
        event_losses: 0,
        event_draws: 0,
      }
    );
  },

  /**
   * Lightweight query: just W/L/D for the user's last `limit` finished matches.
   * Used by the showdown screen "recent form" chip strip — much cheaper than
   * `listRecentMatchesForUser` since we skip the opponent/score joins.
   */
  async listRecentFormForUser(
    userId: string,
    limit: number,
  ): Promise<Array<{ winner_user_id: string | null; ended_at: string | null }>> {
    return sql<Array<{ winner_user_id: string | null; ended_at: string | null }>>`
      SELECT m.winner_user_id, m.ended_at
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = ${userId}
        AND m.status = 'completed'
        AND m.is_dev = false
      ORDER BY m.ended_at DESC NULLS LAST, m.started_at DESC
      LIMIT ${limit}
    `;
  },
};
