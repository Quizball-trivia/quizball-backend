import { sql } from '../../db/index.js';
import { AppError } from '../../core/errors.js';
import { withSpan } from '../../core/tracing.js';

/**
 * Append-only repo for `clue_guess_evaluations`.
 *
 * Instrumentation for the "correct clue answers marked WRONG" investigation:
 * it records what the player actually typed alongside the answer set and the
 * rule the matcher applied. Writes are never on the answer's critical path —
 * callers wrap them in `fireAndForget` so a logging failure can never change a
 * verdict or fail a player's answer.
 */

export type ClueGuessCaptureMode = 'full' | 'sampled';

export interface ClueGuessEvaluationInput {
  matchId: string;
  userId: string;
  qIndex: number;
  questionId: string | null;
  rawGuess: string;
  normalizedGuess: string;
  acceptedAnswers: string[];
  normalizedAcceptedAnswers: string[];
  isCorrect: boolean;
  giveUp: boolean;
  matchRule: string | null;
  matchDistance: number | null;
  rejectReason: string | null;
  candidateDetail: unknown;
  timeMs: number | null;
  clueIndex: number | null;
  isAi: boolean;
  captureMode: ClueGuessCaptureMode;
}

export interface ClueGuessEvaluationRow {
  id: string;
  created_at: string;
  match_id: string;
  user_id: string;
  q_index: number;
  question_id: string | null;
  raw_guess: string;
  normalized_guess: string;
  accepted_answers: string[];
  normalized_accepted_answers: string[];
  accepted_answers_count: number;
  is_correct: boolean;
  give_up: boolean;
  match_rule: string | null;
  match_distance: number | null;
  reject_reason: string | null;
  candidate_detail: unknown;
  time_ms: number | null;
  clue_index: number | null;
  is_ai: boolean;
  capture_mode: string;
}

export interface RecentClueGuessQuery {
  questionId?: string;
  userId?: string;
  matchId?: string;
  /** Default true: the investigation cares about rejects. */
  rejectsOnly?: boolean;
  /** Default true: exclude harness/bot traffic, which guesses junk by design. */
  excludeAi?: boolean;
  limit: number;
}

export const clueGuessEvaluationsRepo = {
  async insert(data: ClueGuessEvaluationInput): Promise<void> {
    return withSpan('db.matches.insert_clue_guess_evaluation', {
      'db.operation.name': 'insert',
      'quizball.match_id': data.matchId,
      'quizball.q_index': data.qIndex,
    }, async () => {
      try {
        await sql`
          INSERT INTO clue_guess_evaluations (
            match_id, user_id, q_index, question_id,
            raw_guess, normalized_guess,
            accepted_answers, normalized_accepted_answers, accepted_answers_count,
            is_correct, give_up, match_rule, match_distance, reject_reason, candidate_detail,
            time_ms, clue_index, is_ai, capture_mode
          )
          VALUES (
            ${data.matchId}, ${data.userId}, ${data.qIndex}, ${data.questionId},
            ${data.rawGuess}, ${data.normalizedGuess},
            ${sql.json(data.acceptedAnswers)}, ${sql.json(data.normalizedAcceptedAnswers)}, ${data.acceptedAnswers.length},
            ${data.isCorrect}, ${data.giveUp}, ${data.matchRule}, ${data.matchDistance}, ${data.rejectReason},
            ${sql.json(data.candidateDetail as never)},
            ${data.timeMs}, ${data.clueIndex}, ${data.isAi}, ${data.captureMode}
          )
        `;
      } catch (err) {
        throw new AppError('Failed to insert clue guess evaluation', 500, 'INTERNAL_ERROR', err);
      }
    });
  },

  async listRecent(query: RecentClueGuessQuery): Promise<ClueGuessEvaluationRow[]> {
    const rejectsOnly = query.rejectsOnly !== false;
    const excludeAi = query.excludeAi !== false;
    try {
      return await sql<ClueGuessEvaluationRow[]>`
        SELECT *
        FROM clue_guess_evaluations
        WHERE TRUE
          ${query.questionId ? sql`AND question_id = ${query.questionId}` : sql``}
          ${query.userId ? sql`AND user_id = ${query.userId}` : sql``}
          ${query.matchId ? sql`AND match_id = ${query.matchId}` : sql``}
          ${rejectsOnly ? sql`AND is_correct = FALSE` : sql``}
          ${excludeAi ? sql`AND is_ai = FALSE` : sql``}
        ORDER BY created_at DESC
        LIMIT ${query.limit}
      `;
    } catch (err) {
      throw new AppError('Failed to read clue guess evaluations', 500, 'INTERNAL_ERROR', err);
    }
  },
};
