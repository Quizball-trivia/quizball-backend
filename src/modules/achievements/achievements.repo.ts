import { sql } from '../../db/index.js';
import type {
  UserAchievementMetrics,
  UserAchievementRow,
} from './achievements.types.js';

interface AchievementMetricsRow {
  completed_matches: number;
  total_wins: number;
  party_quiz_wins: number;
  has_perfect_match: boolean;
  has_lightning_counter: boolean;
  has_clean_sheet: boolean;
}

export const achievementsRepo = {
  async listForUser(userId: string): Promise<UserAchievementRow[]> {
    return sql<UserAchievementRow[]>`
      SELECT *
      FROM user_achievements
      WHERE user_id = ${userId}
      ORDER BY achievement_id ASC
    `;
  },

  async listUnlockedForMatch(matchId: string): Promise<UserAchievementRow[]> {
    return sql<UserAchievementRow[]>`
      SELECT *
      FROM user_achievements
      WHERE source_match_id = ${matchId}
      ORDER BY user_id ASC, achievement_id ASC
    `;
  },

  async upsertProgress(params: {
    userId: string;
    achievementId: string;
    progress: number;
    unlockedAt: string | null;
    sourceMatchId: string | null;
  }): Promise<UserAchievementRow> {
    const [row] = await sql<UserAchievementRow[]>`
      INSERT INTO user_achievements (
        user_id,
        achievement_id,
        progress,
        unlocked_at,
        source_match_id
      )
      VALUES (
        ${params.userId},
        ${params.achievementId},
        ${params.progress},
        ${params.unlockedAt},
        ${params.sourceMatchId}
      )
      ON CONFLICT (user_id, achievement_id)
      DO UPDATE SET
        progress = EXCLUDED.progress,
        unlocked_at = COALESCE(user_achievements.unlocked_at, EXCLUDED.unlocked_at),
        source_match_id = COALESCE(user_achievements.source_match_id, EXCLUDED.source_match_id),
        updated_at = NOW()
      RETURNING *
    `;

    return row;
  },

  async getMetricsForUser(userId: string): Promise<UserAchievementMetrics> {
    const [row] = await sql<AchievementMetricsRow[]>`
      WITH user_matches AS (
        SELECT
          m.id,
          m.winner_user_id,
          m.total_questions,
          COALESCE(m.state_payload->>'variant', '') AS variant,
          mp.correct_answers,
          mp.goals AS self_goals,
          mp.penalty_goals AS self_penalty_goals
        FROM matches m
        JOIN match_players mp ON mp.match_id = m.id AND mp.user_id = ${userId}
        WHERE m.status = 'completed'
      )
      SELECT
        COUNT(*)::int AS completed_matches,
        COUNT(*) FILTER (WHERE winner_user_id = ${userId})::int AS total_wins,
        COUNT(*) FILTER (
          WHERE winner_user_id = ${userId}
            AND variant = 'friendly_party_quiz'
        )::int AS party_quiz_wins,
        bool_or(correct_answers >= total_questions) AS has_perfect_match,
        EXISTS (
          SELECT 1
          FROM match_answers ma
          WHERE ma.user_id = ${userId}
            AND ma.is_correct = true
            AND ma.time_ms <= 2000
        ) AS has_lightning_counter,
        bool_or(
          winner_user_id = ${userId}
          AND variant <> 'friendly_party_quiz'
          AND NOT EXISTS (
            SELECT 1
            FROM match_players mp_opp
            WHERE mp_opp.match_id = user_matches.id
              AND mp_opp.user_id <> ${userId}
              AND (mp_opp.goals > 0 OR mp_opp.penalty_goals > 0)
          )
        ) AS has_clean_sheet
      FROM user_matches
    `;

    const bestWinStreak = await this.getBestWinStreak(userId);

    return {
      completedMatches: row?.completed_matches ?? 0,
      totalWins: row?.total_wins ?? 0,
      partyQuizWins: row?.party_quiz_wins ?? 0,
      hasPerfectMatch: row?.has_perfect_match ?? false,
      hasLightningCounter: row?.has_lightning_counter ?? false,
      hasCleanSheet: row?.has_clean_sheet ?? false,
      bestWinStreak,
    };
  },

  async getBestWinStreak(userId: string): Promise<number> {
    const [row] = await sql<{ best_win_streak: number }[]>`
      SELECT COALESCE(MAX(streak_len), 0)::int AS best_win_streak
      FROM (
        SELECT COUNT(*) AS streak_len
        FROM (
          SELECT
            m.winner_user_id,
            SUM(CASE WHEN m.winner_user_id <> ${userId} OR m.winner_user_id IS NULL THEN 1 ELSE 0 END)
              OVER (ORDER BY COALESCE(m.ended_at, m.started_at) ASC, m.id ASC) AS grp
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id AND mp.user_id = ${userId}
          WHERE m.status = 'completed'
        ) sub
        WHERE winner_user_id = ${userId}
        GROUP BY grp
      ) streaks
    `;
    return row?.best_win_streak ?? 0;
  },
};
