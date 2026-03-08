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

interface MatchOutcomeRow {
  winner_user_id: string | null;
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
      SELECT
        (
          SELECT COUNT(*)::int
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id
          WHERE mp.user_id = ${userId}
            AND m.status = 'completed'
        ) AS completed_matches,
        (
          SELECT COUNT(*)::int
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id
          WHERE mp.user_id = ${userId}
            AND m.status = 'completed'
            AND m.winner_user_id = ${userId}
        ) AS total_wins,
        (
          SELECT COUNT(*)::int
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id
          WHERE mp.user_id = ${userId}
            AND m.status = 'completed'
            AND m.winner_user_id = ${userId}
            AND COALESCE(m.state_payload->>'variant', '') = 'friendly_party_quiz'
        ) AS party_quiz_wins,
        EXISTS (
          SELECT 1
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id
          WHERE mp.user_id = ${userId}
            AND m.status = 'completed'
            AND mp.correct_answers >= m.total_questions
        ) AS has_perfect_match,
        EXISTS (
          SELECT 1
          FROM match_answers ma
          WHERE ma.user_id = ${userId}
            AND ma.is_correct = true
            AND ma.time_ms <= 2000
        ) AS has_lightning_counter,
        EXISTS (
          SELECT 1
          FROM matches m
          JOIN match_players mp_self
            ON mp_self.match_id = m.id
           AND mp_self.user_id = ${userId}
          WHERE m.status = 'completed'
            AND m.winner_user_id = ${userId}
            AND COALESCE(m.state_payload->>'variant', 'friendly_possession') <> 'friendly_party_quiz'
            AND NOT EXISTS (
              SELECT 1
              FROM match_players mp_opp
              WHERE mp_opp.match_id = m.id
                AND mp_opp.user_id <> ${userId}
                AND (mp_opp.goals > 0 OR mp_opp.penalty_goals > 0)
            )
        ) AS has_clean_sheet
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
    const rows = await sql<MatchOutcomeRow[]>`
      SELECT m.winner_user_id
      FROM matches m
      JOIN match_players mp
        ON mp.match_id = m.id
       AND mp.user_id = ${userId}
      WHERE m.status = 'completed'
      ORDER BY COALESCE(m.ended_at, m.started_at) ASC, m.id ASC
    `;

    let current = 0;
    let best = 0;
    for (const row of rows) {
      if (row.winner_user_id === userId) {
        current += 1;
        if (current > best) best = current;
      } else {
        current = 0;
      }
    }

    return best;
  },
};
