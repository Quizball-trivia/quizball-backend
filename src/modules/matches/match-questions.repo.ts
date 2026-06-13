import { sql } from '../../db/index.js';
import { withSpan } from '../../core/tracing.js';
import {
  VALID_PAYLOAD_CONDITIONS_RAW as VALID_PAYLOAD_CONDITIONS,
  MCQ_HAS_IMAGE_CONDITIONS_NP_RAW,
  NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW,
  VALID_PAYLOAD_CONDITIONS_NP_RAW,
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
  /**
   * Question ids that must NOT be returned even though they are otherwise
   * eligible — e.g. the half's reserved image MCQ, which must stay unused
   * until its slot so the preloaded image is never wasted.
   */
  excludeQuestionIds?: string[];
  /**
   * Last-resort escape hatch: include image MCQs in the candidate pool.
   * By default this picker serves PLAIN questions only — image MCQs are
   * reserved for the dedicated image slot (Q4 of each half) and are picked
   * via getRandomImageMcqCandidatesForMatch. Set this ONLY for anti-stall
   * fallbacks where any valid question beats no question at all.
   */
  allowImageMcqs?: boolean;
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

  /**
   * Question ids the given users have ALREADY SEEN in matches within the recent
   * window — used to bias the random picker AWAY from recently-served questions
   * (history-aware selection), so heavy players stop re-seeing the same question
   * while unseen ones sit in the pool.
   *
   * Performance: indexed path only (match_players(user_id) → matches(pkey) →
   * match_questions(match_id)). Measured ~1-5ms even for the heaviest player;
   * runs ONCE per pick, not per candidate. The result feeds the existing
   * `excludeQuestionIds` array filter — no new joins on the hot pick query.
   *
   * Best-effort by contract: callers must treat this as a soft exclusion and
   * fall back to picking WITHOUT it if a (thin) category would otherwise run dry.
   */
  async getRecentlySeenQuestionIds(
    userIds: string[],
    withinDays: number,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    return withSpan('db.matches.getRecentlySeenQuestionIds', {
      'db.operation.name': 'select',
      'quizball.user_count': userIds.length,
      'quizball.within_days': withinDays,
    }, async (span) => {
      const rows = await sql<{ question_id: string }[]>`
        SELECT DISTINCT mq.question_id
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        JOIN match_questions mq ON mq.match_id = mp.match_id
        WHERE mp.user_id = ANY(${userIds}::uuid[])
          AND m.started_at > now() - (${withinDays} || ' days')::interval
      `;
      span.setAttribute('quizball.seen_question_count', rows.length);
      return rows.map((r) => r.question_id);
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
      // np.p = the payload normalized ONCE per row (lateral) — referencing the
      // inline normalization in every condition re-parses the JSONB per
      // reference and made this hot-path pick ~45ms; the lateral keeps it
      // single-digit ms (see sql-fragments.ts).
      const perRowMcqPayloadValidation = VALID_PAYLOAD_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');
      // This is the PLAIN-question picker: image MCQs must never leak into
      // normal slots (Q1-3/5/6, penalties, last attack, party quiz) — they are
      // served exclusively by the dedicated image-slot picker. Without this
      // filter, the moment a category gains image questions every random MCQ
      // pick can come back with a picture (observed on staging 2026-06-10).
      const imageMcqConditions = MCQ_HAS_IMAGE_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');
      const excludeImageMcqClause = includesMcq && !params.allowImageMcqs
        ? `AND (q.type <> 'mcq_single' OR NOT (${imageMcqConditions}))`
        : '';

      const values: Array<string | number | string[]> = [params.matchId, params.categoryIds, questionTypes];
      let difficultyClause = '';
      if (params.difficulties?.length) {
        values.push(params.difficulties);
        difficultyClause = `AND q.difficulty = ANY($${values.length}::text[])`;
      }
      let excludeClause = '';
      if (params.excludeQuestionIds?.length) {
        values.push(params.excludeQuestionIds);
        excludeClause = `AND q.id <> ALL($${values.length}::uuid[])`;
      }
      values.push(params.limit ?? 1);
      const limitPlaceholder = `$${values.length}`;

      const rows = await sql.unsafe<RandomQuestionCandidate[]>(
        `
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        ${includesMcq ? NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW : ''}
        WHERE q.category_id = ANY($2::uuid[])
          AND c.is_active = true
          AND q.status = 'published'
          AND q.type = ANY($3::text[])
          ${includesMcq ? `AND (q.type <> 'mcq_single' OR (${perRowMcqPayloadValidation}))` : ''}
          ${excludeImageMcqClause}
          ${difficultyClause}
          ${excludeClause}
          AND NOT EXISTS (
            SELECT 1
            FROM match_questions mq
            WHERE mq.match_id = $1
              AND mq.question_id = q.id
          )
        ORDER BY ${RANDOM_ORDER_SQL}
        LIMIT ${limitPlaceholder}
        `,
        values,
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
   * categories (the drafted/banned-survivor categories of the current half).
   * Unlike getRandomQuestionCandidatesForMatch this requires a non-empty image
   * payload. Still respects active categories and excludes questions already
   * used in the match.
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
      const perRowMcqPayloadValidation = VALID_PAYLOAD_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');
      const imageOnly = MCQ_HAS_IMAGE_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');

      const rows = await sql.unsafe<RandomQuestionCandidate[]>(
        `
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        ${NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW}
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

  /**
   * Re-validate a previously reserved image MCQ at dispatch time: returns the
   * candidate row iff the question is still a published, valid image MCQ in an
   * active category AND has not already been used in this match. Empty result
   * → the caller re-picks (random image MCQ, then normal-MCQ fallback).
   */
  async getImageMcqCandidateForMatchById(params: {
    matchId: string;
    questionId: string;
  }): Promise<RandomQuestionCandidate[]> {
    return withSpan('db.matches.getImageMcqCandidateForMatchById', {
      'db.operation.name': 'select',
      'quizball.match_id': params.matchId,
      'quizball.question_id': params.questionId,
    }, async (span) => {
      const perRowMcqPayloadValidation = VALID_PAYLOAD_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');
      const imageOnly = MCQ_HAS_IMAGE_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');

      const rows = await sql.unsafe<RandomQuestionCandidate[]>(
        `
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        ${NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW}
        WHERE q.id = $2
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
        LIMIT 1
        `,
        [params.matchId, params.questionId],
      );
      span.setAttribute('quizball.question_found', rows.length > 0);
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
