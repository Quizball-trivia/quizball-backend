import { sql } from '../../db/index.js';
import { withSpan } from '../../core/tracing.js';
import {
  VALID_PAYLOAD_CONDITIONS_RAW as VALID_PAYLOAD_CONDITIONS,
  MCQ_HAS_IMAGE_CONDITIONS_RAW,
} from '../../db/sql-fragments.js';
import type {
  MatchQuestionRow,
  MatchQuestionWithCategory,
  MatchQuestionTimingRow,
  MatchQuestionPhaseKind,
} from './matches.types.js';
import type { QuestionType } from '../questions/questions.schemas.js';

// Regression-harness determinism: when REGRESSION_DETERMINISTIC is set (NEVER in
// prod), the otherwise-random question ordering becomes a stable md5 over the
// row id so a seeded match replays the SAME questions. Prod uses RANDOM().
//
// The salt is interpolated into a sql.unsafe() ORDER BY, so it MUST NOT carry
// any SQL-significant characters. We hard-restrict it to [A-Za-z0-9] (anything
// else is dropped) — alphanumerics can't break out of the quoted literal, so
// the value can never inject regardless of what the env var holds.
const DETERMINISTIC_SALT = (process.env.REGRESSION_DETERMINISTIC_SALT ?? 'reg').replace(/[^A-Za-z0-9]/g, '') || 'reg';
const RANDOM_ORDER_SQL = process.env.REGRESSION_DETERMINISTIC === '1'
  ? `md5(q.id::text || '${DETERMINISTIC_SALT}')`
  : 'RANDOM()';

/**
 * Pure-data repo for the `match_questions` table.
 *
 * Owns inserts, reads, and the question-selection queries that JOIN
 * `questions` / `categories` / `question_payloads`. Those external
 * JOINs are read-only filters — no other repo's methods are called,
 * so this stays a single-table repo by responsibility (the JOINs
 * are an implementation detail of "pick a question for this match").
 */

interface InsertMatchQuestionInput {
  qIndex: number;
  questionId: string;
  categoryId: string;
  correctIndex: number;
  phaseKind?: MatchQuestionPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: number | null;
  attackerSeat?: number | null;
}

interface InsertMatchQuestionIfMissingInput extends InsertMatchQuestionInput {
  matchId: string;
}

export interface RandomQuestionCandidate {
  id: string;
  prompt: Record<string, string>;
  difficulty: string;
  category_id: string;
  payload: unknown;
}

export interface RandomQuestionForMatchParams {
  matchId: string;
  categoryIds: string[];
  difficulties?: Array<'easy' | 'medium' | 'hard'>;
  questionTypes?: QuestionType[];
}

export const matchQuestionsRepo = {
  async insertMatchQuestions(
    matchId: string,
    questions: InsertMatchQuestionInput[],
  ): Promise<MatchQuestionRow[]> {
    if (questions.length === 0) return [];
    const rows = questions.map((q) => [
      matchId,
      q.qIndex,
      q.questionId,
      q.categoryId,
      q.correctIndex,
      q.phaseKind ?? 'normal',
      q.phaseRound ?? null,
      q.shooterSeat ?? null,
      q.attackerSeat ?? null,
    ] as (string | number)[]);

    return sql<MatchQuestionRow[]>`
      INSERT INTO match_questions (
        match_id, q_index, question_id, category_id, correct_index, phase_kind, phase_round, shooter_seat, attacker_seat
      )
      VALUES ${sql(rows)}
      RETURNING *
    `;
  },

  async insertMatchQuestionIfMissing(question: InsertMatchQuestionIfMissingInput): Promise<MatchQuestionRow | null> {
    return withSpan('db.matches.insert_question_if_missing', {
      'db.operation.name': 'insert',
      'quizball.match_id': question.matchId,
      'quizball.q_index': question.qIndex,
      'quizball.phase_kind': question.phaseKind ?? 'normal',
    }, async (span) => {
      const [row] = await sql<MatchQuestionRow[]>`
        INSERT INTO match_questions (
          match_id, q_index, question_id, category_id, correct_index, phase_kind, phase_round, shooter_seat, attacker_seat
        )
        VALUES (
          ${question.matchId},
          ${question.qIndex},
          ${question.questionId},
          ${question.categoryId},
          ${question.correctIndex},
          ${question.phaseKind ?? 'normal'},
          ${question.phaseRound ?? null},
          ${question.shooterSeat ?? null},
          ${question.attackerSeat ?? null}
        )
        ON CONFLICT (match_id, q_index) DO NOTHING
        RETURNING *
      `;
      span.setAttribute('quizball.question_inserted', Boolean(row));
      return row ?? null;
    });
  },

  async getRandomQuestionsForCategory(
    categoryId: string,
    limit: number,
  ): Promise<RandomQuestionCandidate[]> {
    const [{ count }] = await sql.unsafe<{ count: number }[]>(`
      SELECT COUNT(*)::int as count
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1
        AND c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
    `, [categoryId]);

    if (!count) return [];

    const SMALL_SET_THRESHOLD = limit * 5;
    if (count <= SMALL_SET_THRESHOLD) {
      return sql.unsafe<RandomQuestionCandidate[]>(`
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.category_id = $1
          AND c.is_active = true
          AND q.status = 'published'
          AND q.type = 'mcq_single'
        ${VALID_PAYLOAD_CONDITIONS}
        ORDER BY ${RANDOM_ORDER_SQL}
        LIMIT $2
      `, [categoryId, limit]);
    }

    const basePercent = Math.ceil((limit * 100) / count);
    const samplePercent = Math.min(10, Math.max(1, basePercent * 2));
    const sampleLimit = limit * 3;

    const sampled = await sql.unsafe<RandomQuestionCandidate[]>(
      `
      SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
      FROM (
        SELECT * FROM questions TABLESAMPLE SYSTEM (${samplePercent})
      ) AS q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1
        AND c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
      ORDER BY ${RANDOM_ORDER_SQL}
      LIMIT $2
      `,
      [categoryId, sampleLimit],
    );

    if (sampled.length >= limit) {
      return sampled.slice(0, limit);
    }

    const remaining = limit - sampled.length;
    const excludeIds = sampled.map((row) => row.id);
    const excludeCondition = excludeIds.length > 0 ? `AND q.id NOT IN (${excludeIds.map((_, i) => `$${i + 3}`).join(',')})` : '';
    const fallback = await sql.unsafe<RandomQuestionCandidate[]>(
      `
      SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1
        AND c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
      ${excludeCondition}
      ORDER BY ${RANDOM_ORDER_SQL}
      LIMIT $2
      `,
      [categoryId, remaining, ...excludeIds],
    );

    return [...sampled, ...fallback];
  },

  async getRandomQuestionCandidatesForMatch(params: RandomQuestionForMatchParams & {
    limit?: number;
  }): Promise<RandomQuestionCandidate[]> {
    return withSpan('db.matches.getRandomQuestionCandidatesForMatch', {
      'db.operation.name': 'select',
      'quizball.match_id': params.matchId,
      'quizball.category_count': params.categoryIds.length,
      'quizball.difficulty_count': params.difficulties?.length ?? 0,
    }, async (span) => {
      const questionTypes = params.questionTypes?.length
        ? params.questionTypes
        : ['mcq_single'];
      const includesMcq = questionTypes.includes('mcq_single');
      const perRowMcqPayloadValidation = VALID_PAYLOAD_CONDITIONS.replace(/^\s*AND\s*/u, '');

      const rows = await sql.unsafe<RandomQuestionCandidate[]>(
        `
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.category_id = ANY($2::uuid[])
          AND c.is_active = true
          AND q.status = 'published'
          AND q.type = ANY($3::text[])
          ${includesMcq ? `AND (q.type <> 'mcq_single' OR (${perRowMcqPayloadValidation}))` : ''}
          ${params.difficulties?.length ? 'AND q.difficulty = ANY($4::text[])' : ''}
          AND NOT EXISTS (
            SELECT 1
            FROM match_questions mq
            WHERE mq.match_id = $1
              AND mq.question_id = q.id
          )
        ORDER BY ${RANDOM_ORDER_SQL}
        LIMIT $${params.difficulties?.length ? 5 : 4}
        `,
        [
          params.matchId,
          params.categoryIds,
          questionTypes,
          ...(params.difficulties?.length ? [params.difficulties] : []),
          params.limit ?? 1,
        ],
      );
      span.setAttribute('quizball.question_found', rows.length > 0);
      span.setAttribute('quizball.question_candidate_count', rows.length);
      return rows;
    });
  },

  async getRandomQuestionForMatch(params: RandomQuestionForMatchParams): Promise<RandomQuestionCandidate | null> {
    const rows = await this.getRandomQuestionCandidatesForMatch({ ...params, limit: 1 });
    return rows[0] ?? null;
  },

  /**
   * Pick random published image-MCQ candidates for a match from the given
   * categories. Unlike getRandomQuestionCandidatesForMatch this requires a
   * non-empty image payload. Still respects active categories and excludes
   * questions already used in the match.
   *
   * NOTE (TEST): the caller currently pins `categoryIds` to a single hardcoded
   * category. When this becomes the real flow, pass categories that actually
   * contain image questions.
   */
  async getRandomImageMcqCandidatesForMatch(params: {
    matchId: string;
    categoryIds: string[];
    limit?: number;
  }): Promise<RandomQuestionCandidate[]> {
    return withSpan('db.matches.getRandomImageMcqCandidatesForMatch', {
      'db.operation.name': 'select',
      'quizball.match_id': params.matchId,
      'quizball.category_count': params.categoryIds.length,
    }, async (span) => {
      const perRowMcqPayloadValidation = VALID_PAYLOAD_CONDITIONS.replace(/^\s*AND\s*/u, '');
      const imageOnly = MCQ_HAS_IMAGE_CONDITIONS_RAW.replace(/^\s*AND\s*/u, '');

      const rows = await sql.unsafe<RandomQuestionCandidate[]>(
        `
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.category_id = ANY($2::uuid[])
          AND c.is_active = true
          AND q.status = 'published'
          AND q.type = 'mcq_single'
          AND (${perRowMcqPayloadValidation})
          AND (${imageOnly})
          AND NOT EXISTS (
            SELECT 1
            FROM match_questions mq
            WHERE mq.match_id = $1
              AND mq.question_id = q.id
          )
        ORDER BY ${RANDOM_ORDER_SQL}
        LIMIT $3
        `,
        [
          params.matchId,
          params.categoryIds,
          params.limit ?? 1,
        ],
      );
      span.setAttribute('quizball.question_found', rows.length > 0);
      span.setAttribute('quizball.question_candidate_count', rows.length);
      return rows;
    });
  },

  async getMatchQuestion(matchId: string, qIndex: number): Promise<MatchQuestionWithCategory | null> {
    return withSpan('db.matches.get_question', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex,
    }, async (span) => {
      const [row] = await sql<MatchQuestionWithCategory[]>`
        SELECT mq.question_id, mq.q_index, mq.category_id, mq.correct_index,
               mq.phase_kind, mq.phase_round, mq.shooter_seat, mq.attacker_seat,
               q.prompt, q.difficulty, qp.payload,
               c.name as category_name, c.icon as category_icon
        FROM match_questions mq
        JOIN questions q ON q.id = mq.question_id
        LEFT JOIN question_payloads qp ON qp.question_id = q.id
        JOIN categories c ON c.id = mq.category_id
        WHERE mq.match_id = ${matchId} AND mq.q_index = ${qIndex}
      `;
      span.setAttribute('quizball.question_found', Boolean(row));
      return row ?? null;
    });
  },

  async getMatchQuestionTiming(matchId: string, qIndex: number): Promise<MatchQuestionTimingRow | null> {
    return withSpan('db.matches.get_question_timing', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex,
    }, async (span) => {
      const [row] = await sql<MatchQuestionTimingRow[]>`
        SELECT shown_at, deadline_at
        FROM match_questions
        WHERE match_id = ${matchId} AND q_index = ${qIndex}
      `;
      span.setAttribute('quizball.question_timing_found', Boolean(row));
      return row ?? null;
    });
  },

  async setQuestionTiming(matchId: string, qIndex: number, shownAt: Date, deadlineAt: Date): Promise<void> {
    await sql`
      UPDATE match_questions
      SET shown_at = ${shownAt}, deadline_at = ${deadlineAt}
      WHERE match_id = ${matchId} AND q_index = ${qIndex}
    `;
  },
};
