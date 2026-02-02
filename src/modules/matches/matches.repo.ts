import { sql } from '../../db/index.js';
import type {
  MatchRow,
  MatchPlayerRow,
  MatchQuestionRow,
  MatchAnswerRow,
  MatchQuestionWithCategory,
} from './matches.types.js';

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

  async insertMatchQuestions(matchId: string, questions: Array<{ qIndex: number; questionId: string; categoryId: string; correctIndex: number }>): Promise<MatchQuestionRow[]> {
    if (questions.length === 0) return [];
    const rows = questions.map((q) => [matchId, q.qIndex, q.questionId, q.categoryId, q.correctIndex]);

    return sql<MatchQuestionRow[]>`
      INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index)
      VALUES ${sql(rows)}
      RETURNING *
    `;
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

  async setQuestionTiming(matchId: string, qIndex: number, shownAt: Date, deadlineAt: Date): Promise<void> {
    await sql`
      UPDATE match_questions
      SET shown_at = ${shownAt.toISOString()}, deadline_at = ${deadlineAt.toISOString()}
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
      SET current_q_index = ${qIndex}, updated_at = NOW()
      WHERE id = ${matchId}
    `;
  },

  async completeMatch(matchId: string, winnerId: string | null): Promise<void> {
    await sql`
      UPDATE matches
      SET status = 'completed', winner_user_id = ${winnerId}, ended_at = NOW(), updated_at = NOW()
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

  async getMatch(matchId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches WHERE id = ${matchId}
    `;
    return row ?? null;
  },
};
