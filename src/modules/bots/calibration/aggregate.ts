/**
 * Shared question_stats aggregation. Both the offline calibration script and the
 * (disabled) refresh job call these functions so the exclusion rules — AI/seed/
 * deleted users, dev matches, timeout backfills, timing clean-window — are
 * defined ONCE and can never drift between the two.
 *
 * All functions take a postgres `sql` instance so the same code runs against the
 * test DB, a read-only staging/prod connection, or the app DB.
 */

import type { Sql } from 'postgres';
import type { MatchQuestionKind } from '../../../realtime/socket.types.js';
import { questionKindForType } from '../../../realtime/possession-payload-mappers.js';
import type { QuestionType } from '../../../modules/questions/questions.schemas.js';
import {
  BACKOFF_MIN_SAMPLE,
  FULL_DURATION_MS,
  SMOOTHING_PRIOR_N0,
  TIMING_CLEAN_WINDOW_START,
} from './constants.js';
import { bayesianSmooth, logNormalTimeStats, type ScopeStat } from './math.js';

/**
 * One eligible answer, already joined to its question and stripped of excluded
 * rows (AI/seed/deleted users, dev matches, non-ranked/non-completed matches).
 * `isTimeoutBackfill` is computed IN SQL from the persisted signature so the
 * predicate is identical to the pure `isTimeoutBackfill` helper.
 */
export interface EligibleAnswerRow {
  questionId: string;
  questionType: string;
  categorySlug: string | null;
  isCorrect: boolean;
  timeMs: number;
  answeredAt: string;
  isTimeoutBackfill: boolean;
  inTimingWindow: boolean;
}

/**
 * The reusable exclusion + backfill-detection SQL. Emits one row per eligible
 * match_answer joined to its question metadata. The timeout-backfill flag mirrors
 * possession-round-resolver.ts exactly: a backfilled row has selected_index NULL,
 * is_correct false, points_earned 0, and time_ms equal to the FULL duration for
 * that question's kind. Because real answers are clamped to [0, duration], a real
 * last-instant answer can share time_ms=duration — so all four fields are ANDed.
 *
 * The full-duration lookup is expressed as a CASE over the question kind derived
 * from questions.type, using the same numeric constants as FULL_DURATION_MS.
 */
export function eligibleAnswersQuery(
  sql: Sql,
  opts: { limit?: number } = {},
): Promise<EligibleAnswerRow[]> {
  const limitClause = opts.limit && opts.limit > 0 ? sql`LIMIT ${opts.limit}` : sql``;
  return sql<EligibleAnswerRow[]>`
    SELECT
      q.id                                            AS "questionId",
      q.type                                          AS "questionType",
      c.slug                                          AS "categorySlug",
      ma.is_correct                                   AS "isCorrect",
      ma.time_ms                                      AS "timeMs",
      ma.answered_at                                  AS "answeredAt",
      (
        ma.selected_index IS NULL
        AND ma.is_correct = false
        AND ma.points_earned = 0
        AND ma.time_ms = CASE
          WHEN q.type = 'put_in_order'   THEN ${FULL_DURATION_MS.putInOrder}
          WHEN q.type = 'countdown_list' THEN ${FULL_DURATION_MS.countdown}
          WHEN q.type = 'clue_chain'     THEN ${FULL_DURATION_MS.clues}
          ELSE ${FULL_DURATION_MS.multipleChoice}
        END
      )                                               AS "isTimeoutBackfill",
      (ma.answered_at >= ${TIMING_CLEAN_WINDOW_START}::timestamptz) AS "inTimingWindow"
    FROM match_answers ma
    JOIN matches m           ON m.id = ma.match_id
    JOIN match_questions mq  ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
    JOIN questions q         ON q.id = mq.question_id
    LEFT JOIN categories c   ON c.id = q.category_id
    JOIN users u             ON u.id = ma.user_id
    WHERE m.mode = 'ranked'
      AND m.status = 'completed'
      AND m.is_dev = false
      AND u.is_ai = false
      AND u.is_seed = false
      AND u.is_deleted = false
      AND u.deleted_at IS NULL
    ${limitClause}
  `;
}

export interface QuestionStatRow {
  questionId: string;
  answersCount: number;
  correctCount: number;
  smoothedAccuracy: number;
  medianTimeMs: number | null;
  logTimeSigma: number | null;
  formatStats: Record<string, unknown>;
}

export interface BackoffStatRow {
  scope: 'category_type' | 'type' | 'global';
  scopeKey: string;
  answersCount: number;
  correctCount: number;
  smoothedAccuracy: number | null;
  medianTimeMs: number | null;
  logTimeSigma: number | null;
}

export interface AggregateResult {
  questionStats: QuestionStatRow[];
  backoffStats: BackoffStatRow[];
  globalMean: number;
  exclusions: {
    totalRows: number;
    timeoutBackfills: number;
    outsideTimingWindow: number;
  };
}

const CATEGORY_TYPE_SEP = ':';

/**
 * Compute per-question smoothed accuracy + timing and the three backoff scopes
 * from a set of eligible answer rows. Timeout backfills are excluded from BOTH
 * accuracy and timing (a backfill is a non-interaction, not a wrong answer).
 * Timing stats additionally use only clean-window rows.
 */
export function computeQuestionStats(rows: readonly EligibleAnswerRow[]): AggregateResult {
  const usable = rows.filter((r) => !r.isTimeoutBackfill);
  const timeoutBackfills = rows.length - usable.length;
  let outsideTimingWindow = 0;

  const globalCorrect = usable.reduce((s, r) => s + (r.isCorrect ? 1 : 0), 0);
  const globalMean = usable.length > 0 ? globalCorrect / usable.length : 0.5;

  // Accumulators keyed by question and by backoff scope.
  const perQuestion = new Map<string, { type: string; slug: string | null; correct: number; total: number; times: number[] }>();
  const perCategoryType = new Map<string, { correct: number; total: number; times: number[] }>();
  const perType = new Map<string, { correct: number; total: number; times: number[] }>();
  const globalTimes: number[] = [];

  for (const r of usable) {
    const cleanTiming = r.inTimingWindow && r.timeMs > 0;
    if (!r.inTimingWindow) outsideTimingWindow += 1;

    let pq = perQuestion.get(r.questionId);
    if (!pq) {
      pq = { type: r.questionType, slug: r.categorySlug, correct: 0, total: 0, times: [] };
      perQuestion.set(r.questionId, pq);
    }
    pq.correct += r.isCorrect ? 1 : 0;
    pq.total += 1;
    if (cleanTiming) pq.times.push(r.timeMs);

    const catTypeKey = `${r.categorySlug ?? 'unknown'}${CATEGORY_TYPE_SEP}${r.questionType}`;
    let ct = perCategoryType.get(catTypeKey);
    if (!ct) {
      ct = { correct: 0, total: 0, times: [] };
      perCategoryType.set(catTypeKey, ct);
    }
    ct.correct += r.isCorrect ? 1 : 0;
    ct.total += 1;
    if (cleanTiming) ct.times.push(r.timeMs);

    let ty = perType.get(r.questionType);
    if (!ty) {
      ty = { correct: 0, total: 0, times: [] };
      perType.set(r.questionType, ty);
    }
    ty.correct += r.isCorrect ? 1 : 0;
    ty.total += 1;
    if (cleanTiming) ty.times.push(r.timeMs);

    if (cleanTiming) globalTimes.push(r.timeMs);
  }

  const questionStats: QuestionStatRow[] = [];
  for (const [questionId, agg] of perQuestion) {
    const timing = logNormalTimeStats(agg.times);
    questionStats.push({
      questionId,
      answersCount: agg.total,
      correctCount: agg.correct,
      smoothedAccuracy: bayesianSmooth(agg.correct, agg.total, globalMean, SMOOTHING_PRIOR_N0),
      medianTimeMs: timing.medianTimeMs,
      logTimeSigma: timing.logTimeSigma,
      formatStats: {
        kind: questionKindForType(agg.type as QuestionType),
        cleanTimingSamples: timing.count,
      },
    });
  }

  const backoffStats: BackoffStatRow[] = [];
  for (const [scopeKey, agg] of perCategoryType) {
    const timing = logNormalTimeStats(agg.times);
    backoffStats.push({
      scope: 'category_type',
      scopeKey,
      answersCount: agg.total,
      correctCount: agg.correct,
      smoothedAccuracy: bayesianSmooth(agg.correct, agg.total, globalMean, SMOOTHING_PRIOR_N0),
      medianTimeMs: timing.medianTimeMs,
      logTimeSigma: timing.logTimeSigma,
    });
  }
  for (const [scopeKey, agg] of perType) {
    const timing = logNormalTimeStats(agg.times);
    backoffStats.push({
      scope: 'type',
      scopeKey,
      answersCount: agg.total,
      correctCount: agg.correct,
      smoothedAccuracy: bayesianSmooth(agg.correct, agg.total, globalMean, SMOOTHING_PRIOR_N0),
      medianTimeMs: timing.medianTimeMs,
      logTimeSigma: timing.logTimeSigma,
    });
  }
  const globalTiming = logNormalTimeStats(globalTimes);
  backoffStats.push({
    scope: 'global',
    scopeKey: 'global',
    answersCount: usable.length,
    correctCount: globalCorrect,
    smoothedAccuracy: usable.length > 0 ? globalMean : null,
    medianTimeMs: globalTiming.medianTimeMs,
    logTimeSigma: globalTiming.logTimeSigma,
  });

  return {
    questionStats,
    backoffStats,
    globalMean,
    exclusions: { totalRows: rows.length, timeoutBackfills, outsideTimingWindow },
  };
}

/** Convenience: run the query and aggregate in one call. */
export async function aggregateQuestionStats(
  sql: Sql,
  opts: { limit?: number } = {},
): Promise<AggregateResult> {
  const rows = await eligibleAnswersQuery(sql, opts);
  return computeQuestionStats(rows);
}

/** Shape a per-question/backoff stat for the resolver's ScopeStat contract. */
export function toScopeStat(row: QuestionStatRow | BackoffStatRow): ScopeStat {
  return {
    answersCount: row.answersCount,
    correctCount: row.correctCount,
    smoothedAccuracy: row.smoothedAccuracy,
    medianTimeMs: row.medianTimeMs,
    logTimeSigma: row.logTimeSigma,
  };
}

export const BACKOFF_MIN_SAMPLE_DEFAULT = BACKOFF_MIN_SAMPLE;
export type { MatchQuestionKind };
