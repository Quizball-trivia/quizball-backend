import { sql, type TransactionSql } from '../../db/index.js';
import { AppError } from '../../core/errors.js';
import { withSpan } from '../../core/tracing.js';
import type { Json } from '../../db/types.js';
import type { MatchAnswerRow, MatchQuestionPhaseKind } from './matches.types.js';

/**
 * Pure-data repo for the `match_answers` table.
 *
 * Owns inserts and reads of per-question answers. Holds a tx-aware
 * `insertIfMissingInTx` variant used by
 * `matchesService.recordPartyQuizAnswerIfMissing` to compose an
 * answer insert with a player-total update inside a single
 * `sql.begin` transaction.
 */

interface AnswerWriteInput {
  matchId: string;
  qIndex: number;
  userId: string;
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  answerPayload?: Json | null;
  phaseKind?: MatchQuestionPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: number | null;
}

export const matchAnswersRepo = {
  async insertMatchAnswer(data: AnswerWriteInput): Promise<MatchAnswerRow> {
    try {
      const [row] = await sql<MatchAnswerRow[]>`
        INSERT INTO match_answers (
          match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answer_payload, phase_kind, phase_round, shooter_seat
        )
        VALUES (
          ${data.matchId}, ${data.qIndex}, ${data.userId}, ${data.selectedIndex},
          ${data.isCorrect}, ${data.timeMs}, ${data.pointsEarned}, ${sql.json(data.answerPayload ?? {})}, ${data.phaseKind ?? 'normal'}, ${data.phaseRound ?? null}, ${data.shooterSeat ?? null}
        )
        RETURNING *
      `;
      return row;
    } catch (err) {
      throw new AppError('Failed to insert match answer', 500, 'INTERNAL_ERROR', err);
    }
  },

  async insertMatchAnswerIfMissing(data: AnswerWriteInput): Promise<MatchAnswerRow | null> {
    return withSpan('db.matches.insert_answer_if_missing', {
      'db.operation.name': 'insert',
      'quizball.match_id': data.matchId,
      'quizball.q_index': data.qIndex,
      'quizball.user_id': data.userId,
      'quizball.phase_kind': data.phaseKind ?? 'normal',
    }, async (span) => {
      try {
        const [row] = await sql<MatchAnswerRow[]>`
          INSERT INTO match_answers (
            match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answer_payload, phase_kind, phase_round, shooter_seat
          )
          VALUES (
            ${data.matchId}, ${data.qIndex}, ${data.userId}, ${data.selectedIndex},
            ${data.isCorrect}, ${data.timeMs}, ${data.pointsEarned}, ${sql.json(data.answerPayload ?? {})}, ${data.phaseKind ?? 'normal'}, ${data.phaseRound ?? null}, ${data.shooterSeat ?? null}
          )
          ON CONFLICT (match_id, q_index, user_id) DO NOTHING
          RETURNING *
        `;
        span.setAttribute('quizball.answer_inserted', Boolean(row));
        return row ?? null;
      } catch (err) {
        throw new AppError('Failed to insert match answer', 500, 'INTERNAL_ERROR', err);
      }
    });
  },

  /**
   * Tx-aware idempotent insert. Used by
   * matchesService.recordPartyQuizAnswerIfMissing to compose with a
   * match_players update in one transaction. Returns the inserted row
   * (or null on ON CONFLICT) without throwing on duplicate.
   */
  async insertMatchAnswerIfMissingInTx(
    tx: TransactionSql,
    data: AnswerWriteInput,
  ): Promise<MatchAnswerRow | null> {
    const rows = await tx.unsafe<MatchAnswerRow[]>(
      `
      INSERT INTO match_answers (
        match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answer_payload, phase_kind, phase_round, shooter_seat
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
      ON CONFLICT (match_id, q_index, user_id) DO NOTHING
      RETURNING *
      `,
      [
        data.matchId,
        data.qIndex,
        data.userId,
        data.selectedIndex,
        data.isCorrect,
        data.timeMs,
        data.pointsEarned,
        JSON.stringify(data.answerPayload ?? {}),
        data.phaseKind ?? 'normal',
        data.phaseRound ?? null,
        data.shooterSeat ?? null,
      ],
    );
    return rows[0] ?? null;
  },

  /**
   * Tx-aware read for the existing-answer case in
   * matchesService.recordPartyQuizAnswerIfMissing (returns whatever's
   * already in the table after a duplicate ON CONFLICT skip).
   */
  async getAnswerForUserInTx(
    tx: TransactionSql,
    matchId: string,
    qIndex: number,
    userId: string,
  ): Promise<MatchAnswerRow | null> {
    const rows = await tx.unsafe<MatchAnswerRow[]>(
      `SELECT * FROM match_answers WHERE match_id = $1 AND q_index = $2 AND user_id = $3`,
      [matchId, qIndex, userId],
    );
    return rows[0] ?? null;
  },

  async listAnswersForQuestion(matchId: string, qIndex: number): Promise<MatchAnswerRow[]> {
    return withSpan('db.matches.list_answers_for_question', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex,
    }, async (span) => {
      const rows = await sql<MatchAnswerRow[]>`
        SELECT * FROM match_answers WHERE match_id = ${matchId} AND q_index = ${qIndex}
      `;
      span.setAttribute('quizball.answer_count', rows.length);
      return rows;
    });
  },

  async listAnswersForMatch(matchId: string): Promise<MatchAnswerRow[]> {
    return withSpan('db.matches.list_answers_for_match', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
    }, async (span) => {
      const rows = await sql<MatchAnswerRow[]>`
        SELECT * FROM match_answers
        WHERE match_id = ${matchId}
        ORDER BY q_index ASC
      `;
      span.setAttribute('quizball.answer_count', rows.length);
      return rows;
    });
  },

  async getAnswerForUser(matchId: string, qIndex: number, userId: string): Promise<MatchAnswerRow | null> {
    const [row] = await sql<MatchAnswerRow[]>`
      SELECT * FROM match_answers WHERE match_id = ${matchId} AND q_index = ${qIndex} AND user_id = ${userId}
    `;
    return row ?? null;
  },

  async getAverageTimes(matchId: string): Promise<Array<{ user_id: string; avg_time_ms: number | null }>> {
    return sql<{ user_id: string; avg_time_ms: number | null }[]>`
      SELECT user_id, AVG(time_ms)::int as avg_time_ms
      FROM match_answers
      WHERE match_id = ${matchId}
      GROUP BY user_id
    `;
  },
};
