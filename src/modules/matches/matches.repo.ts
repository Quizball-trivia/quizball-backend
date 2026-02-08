import { sql } from '../../db/index.js';
import { AppError } from '../../core/errors.js';
import type {
  MatchRow,
  MatchPlayerRow,
  MatchQuestionRow,
  MatchAnswerRow,
  MatchQuestionWithCategory,
  MatchQuestionTimingRow,
} from './matches.types.js';

// Reusable SQL fragment for validating question payload structure
const VALID_PAYLOAD_CONDITIONS = `
  AND qp.payload ? 'options'
  AND jsonb_typeof(qp.payload->'options') = 'array'
  AND jsonb_array_length(qp.payload->'options') > 0
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(qp.payload->'options') opt
    WHERE jsonb_typeof(opt) <> 'object'
       OR NOT (opt ? 'text')
       OR jsonb_typeof(opt->'text') <> 'object'
       OR NOT (opt ? 'is_correct')
       OR (opt->>'is_correct') NOT IN ('true', 'false')
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(qp.payload->'options') opt
    WHERE opt->>'is_correct' = 'true'
  )
`;

export interface CreateMatchData {
  lobbyId: string | null;
  mode: 'friendly' | 'ranked';
  categoryAId: string;
  categoryBId: string;
  totalQuestions: number;
}

export const matchesRepo = {
  async createMatch(data: CreateMatchData): Promise<MatchRow> {
    const [row] = await sql<MatchRow[]>`
      INSERT INTO matches (
        id, lobby_id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, started_at
      )
      VALUES (
        gen_random_uuid(), ${data.lobbyId}, ${data.mode}, 'active',
        ${data.categoryAId}, ${data.categoryBId}, 0, ${data.totalQuestions}, NOW()
      )
      RETURNING *
    `;
    return row;
  },

  async insertMatchPlayers(matchId: string, players: Array<{ userId: string; seat: number }>): Promise<MatchPlayerRow[]> {
    if (players.length === 0) return [];
    const rows = players.map((p) => [matchId, p.userId, p.seat]);

    return sql<MatchPlayerRow[]>`
      INSERT INTO match_players (match_id, user_id, seat)
      VALUES ${sql(rows)}
      RETURNING *
    `;
  },

  async listMatchPlayers(matchId: string): Promise<MatchPlayerRow[]> {
    return sql<MatchPlayerRow[]>`
      SELECT * FROM match_players WHERE match_id = ${matchId} ORDER BY seat ASC
    `;
  },

  async getPlayerTotalPoints(matchId: string, userId: string): Promise<number> {
    const [row] = await sql<{ total_points: number }[]>`
      SELECT total_points FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
    return row?.total_points ?? 0;
  },

  async insertMatchQuestions(matchId: string, questions: Array<{ qIndex: number; questionId: string; categoryId: string; correctIndex: number }>): Promise<MatchQuestionRow[]> {
    if (questions.length === 0) return [];
    const rows = questions.map((q) => [matchId, q.qIndex, q.questionId, q.categoryId, q.correctIndex]);

    return sql<MatchQuestionRow[]>`
      INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index)
      VALUES ${sql(rows)}
      RETURNING *
    `;
  },

  async getRandomQuestionsForCategory(
    categoryId: string,
    limit: number
  ): Promise<Array<{
    id: string;
    prompt: Record<string, string>;
    difficulty: string;
    category_id: string;
    payload: unknown;
  }>> {
    const [{ count }] = await sql.unsafe<{ count: number }[]>(`
      SELECT COUNT(*)::int as count
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1 AND q.status = 'published' AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
    `, [categoryId]);

    if (!count) return [];

    const SMALL_SET_THRESHOLD = limit * 5;
    if (count <= SMALL_SET_THRESHOLD) {
      return sql.unsafe<{
        id: string;
        prompt: Record<string, string>;
        difficulty: string;
        category_id: string;
        payload: unknown;
      }[]>(`
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.category_id = $1 AND q.status = 'published' AND q.type = 'mcq_single'
        ${VALID_PAYLOAD_CONDITIONS}
        ORDER BY RANDOM()
        LIMIT $2
      `, [categoryId, limit]);
    }

    const basePercent = Math.ceil((limit * 100) / count);
    const samplePercent = Math.min(10, Math.max(1, basePercent * 2));
    const sampleLimit = limit * 3;

    const sampled = await sql.unsafe<{
      id: string;
      prompt: Record<string, string>;
      difficulty: string;
      category_id: string;
      payload: unknown;
    }[]>(
      `
      SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
      FROM (
        SELECT * FROM questions TABLESAMPLE SYSTEM (${samplePercent})
      ) AS q
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1 AND q.status = 'published' AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
      ORDER BY RANDOM()
      LIMIT $2
      `,
      [categoryId, sampleLimit]
    );

    if (sampled.length >= limit) {
      return sampled.slice(0, limit);
    }

    const remaining = limit - sampled.length;
    const excludeIds = sampled.map((row) => row.id);
    const excludeCondition = excludeIds.length > 0 ? `AND q.id NOT IN (${excludeIds.map((_, i) => `$${i + 3}`).join(',')})` : '';
    const fallback = await sql.unsafe<{
      id: string;
      prompt: Record<string, string>;
      difficulty: string;
      category_id: string;
      payload: unknown;
    }[]>(
      `
      SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1 AND q.status = 'published' AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
      ${excludeCondition}
      ORDER BY RANDOM()
      LIMIT $2
      `,
      [categoryId, remaining, ...excludeIds]
    );

    return [...sampled, ...fallback];
  },

  async getMatchQuestion(matchId: string, qIndex: number): Promise<MatchQuestionWithCategory | null> {
    const [row] = await sql<MatchQuestionWithCategory[]>`
      SELECT mq.question_id, mq.q_index, mq.category_id, mq.correct_index,
             q.prompt, q.difficulty, qp.payload,
             c.name as category_name, c.icon as category_icon
      FROM match_questions mq
      JOIN questions q ON q.id = mq.question_id
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      JOIN categories c ON c.id = mq.category_id
      WHERE mq.match_id = ${matchId} AND mq.q_index = ${qIndex}
    `;
    return row ?? null;
  },

  async getMatchQuestionTiming(matchId: string, qIndex: number): Promise<MatchQuestionTimingRow | null> {
    const [row] = await sql<MatchQuestionTimingRow[]>`
      SELECT shown_at, deadline_at
      FROM match_questions
      WHERE match_id = ${matchId} AND q_index = ${qIndex}
    `;
    return row ?? null;
  },

  async setQuestionTiming(matchId: string, qIndex: number, shownAt: Date, deadlineAt: Date): Promise<void> {
    await sql`
      UPDATE match_questions
      SET shown_at = ${shownAt}, deadline_at = ${deadlineAt}
      WHERE match_id = ${matchId} AND q_index = ${qIndex}
    `;
  },

  async insertMatchAnswer(data: {
    matchId: string;
    qIndex: number;
    userId: string;
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
  }): Promise<MatchAnswerRow> {
    try {
      const [row] = await sql<MatchAnswerRow[]>`
        INSERT INTO match_answers (
          match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned
        )
        VALUES (
          ${data.matchId}, ${data.qIndex}, ${data.userId}, ${data.selectedIndex},
          ${data.isCorrect}, ${data.timeMs}, ${data.pointsEarned}
        )
        RETURNING *
      `;
      return row;
    } catch (err) {
      throw new AppError('Failed to insert match answer', 500, 'INTERNAL_ERROR', err);
    }
  },

  async listAnswersForQuestion(matchId: string, qIndex: number): Promise<MatchAnswerRow[]> {
    return sql<MatchAnswerRow[]>`
      SELECT * FROM match_answers WHERE match_id = ${matchId} AND q_index = ${qIndex}
    `;
  },

  async getAnswerForUser(matchId: string, qIndex: number, userId: string): Promise<MatchAnswerRow | null> {
    const [row] = await sql<MatchAnswerRow[]>`
      SELECT * FROM match_answers WHERE match_id = ${matchId} AND q_index = ${qIndex} AND user_id = ${userId}
    `;
    return row ?? null;
  },

  async updatePlayerTotals(matchId: string, userId: string, points: number, isCorrect: boolean): Promise<MatchPlayerRow | null> {
    const [row] = await sql<MatchPlayerRow[]>`
      UPDATE match_players
      SET
        total_points = total_points + ${points},
        correct_answers = correct_answers + ${isCorrect ? 1 : 0}
      WHERE match_id = ${matchId} AND user_id = ${userId}
      RETURNING *
    `;
    return row ?? null;
  },

  async setMatchCurrentIndex(matchId: string, qIndex: number): Promise<void> {
    await sql`
      UPDATE matches
      SET current_q_index = ${qIndex}
      WHERE id = ${matchId} AND current_q_index < ${qIndex}
    `;
  },

  async completeMatch(matchId: string, winnerId: string | null): Promise<void> {
    await sql`
      UPDATE matches
      SET status = 'completed', winner_user_id = ${winnerId}, ended_at = NOW()
      WHERE id = ${matchId}
    `;
  },

  async updatePlayerAvgTime(matchId: string, userId: string, avgTimeMs: number | null): Promise<void> {
    await sql`
      UPDATE match_players
      SET avg_time_ms = ${avgTimeMs}
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
  },

  async setPlayerForfeitWinTotals(
    matchId: string,
    userId: string,
    totalPoints: number,
    correctAnswers: number
  ): Promise<void> {
    await sql`
      UPDATE match_players
      SET total_points = ${totalPoints},
          correct_answers = ${correctAnswers}
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
  },

  async getAverageTimes(matchId: string): Promise<Array<{ user_id: string; avg_time_ms: number | null }>> {
    return sql<{ user_id: string; avg_time_ms: number | null }[]>`
      SELECT user_id, AVG(time_ms)::int as avg_time_ms
      FROM match_answers
      WHERE match_id = ${matchId}
      GROUP BY user_id
    `;
  },

  async getMatch(matchId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches WHERE id = ${matchId}
    `;
    return row ?? null;
  },

  async getActiveMatchForLobby(lobbyId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches
      WHERE lobby_id = ${lobbyId} AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async getActiveMatchForUser(userId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT m.*
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = ${userId} AND m.status = 'active'
      ORDER BY m.started_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async abandonMatch(matchId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
      UPDATE matches
      SET status = 'abandoned', ended_at = NOW()
      WHERE id = ${matchId} AND status = 'active'
      RETURNING id
    `;
    return rows.length > 0;
  },
};
