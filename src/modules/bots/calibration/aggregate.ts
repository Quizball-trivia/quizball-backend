/**
 * Shared question_stats aggregation. Both the offline calibration script and the
 * (disabled) refresh job call these functions so the exclusion rules — AI/seed/
 * deleted users, dev matches, Bernoulli backfill detection, timing clean-window,
 * Bernoulli-vs-special separation — are defined ONCE and can never drift.
 *
 * Bernoulli vs special formats
 * ----------------------------
 * smoothed_accuracy, the global prior, and the accuracy backoffs come ONLY from
 * Bernoulli kinds (mcq_single / true_false / input_text — engine kind
 * `multipleChoice`). For those, a genuine answer always persists a non-null
 * selected_index, so a NULL index is the exact backfill marker.
 *
 * Countdown / put-in-order / clue answers are NOT answerability signals
 * (countdown is opponent-relative; the others are partial credit), and their
 * backfills cannot be reliably distinguished from real answers (the resolver
 * fires a zero-valued backfill BEFORE reading the real result, ON CONFLICT DO
 * NOTHING). They are therefore kept OUT of accuracy/timing entirely and modelled
 * via payload-aware format_stats distributions.
 *
 * All functions take a postgres `sql` instance so the same code runs against the
 * test DB, a read-only staging/prod connection, or the app DB.
 */

import type { Sql } from 'postgres';
import type { MatchQuestionKind } from '../../../realtime/socket.types.js';
import { questionKindForType } from '../../../realtime/possession-payload-mappers.js';
import type { QuestionType } from '../../../modules/questions/questions.schemas.js';
import { BACKOFF_MIN_SAMPLE, SMOOTHING_PRIOR_N0, TIMING_CLEAN_WINDOW_START, BERNOULLI_TYPES } from './constants.js';
import { bayesianSmooth, logNormalTimeStats, type ScopeStat } from './math.js';

const BERNOULLI_SET = new Set<string>(BERNOULLI_TYPES);

export interface EligibleAnswerRow {
  questionId: string;
  questionType: string;
  categorySlug: string | null;
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  answeredAt: string;
  answerPayload: Record<string, unknown> | null;
  isBernoulli: boolean;
  isBackfill: boolean; // Bernoulli-only: selected_index IS NULL
  inTimingWindow: boolean;
}

/**
 * The reusable exclusion SQL. Emits one row per eligible match_answer joined to
 * its question metadata, flagging Bernoulli-ness, the (Bernoulli) backfill
 * marker, and the timing window. Aggregation logic then decides inclusion.
 */
export function eligibleAnswersQuery(sql: Sql, opts: { limit?: number } = {}): Promise<EligibleAnswerRow[]> {
  const types = BERNOULLI_TYPES as unknown as string[];
  const limitClause = opts.limit && opts.limit > 0 ? sql`LIMIT ${opts.limit}` : sql``;
  return sql<EligibleAnswerRow[]>`
    SELECT
      q.id                                            AS "questionId",
      q.type                                          AS "questionType",
      c.slug                                          AS "categorySlug",
      ma.selected_index                               AS "selectedIndex",
      ma.is_correct                                   AS "isCorrect",
      ma.time_ms                                      AS "timeMs",
      ma.answered_at                                  AS "answeredAt",
      ma.answer_payload                               AS "answerPayload",
      (q.type = ANY(${types}))                        AS "isBernoulli",
      (q.type = ANY(${types}) AND ma.selected_index IS NULL) AS "isBackfill",
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
  smoothedAccuracy: number | null;
  timingSamples: number;
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
  timingSamples: number;
  medianTimeMs: number | null;
  logTimeSigma: number | null;
}

export interface AggregateResult {
  questionStats: QuestionStatRow[];
  backoffStats: BackoffStatRow[];
  globalMean: number;
  exclusions: {
    totalRows: number;
    bernoulliRows: number;
    bernoulliBackfills: number;
    specialRows: number;
    bernoulliOutsideTimingWindow: number;
  };
  formatDistribution: Record<string, number>;
}

const CATEGORY_TYPE_SEP = ':';

interface AccTimeAgg {
  correct: number;
  total: number;
  times: number[];
}

/**
 * Per-format payload accumulators. Distributions are stored as index->count
 * histograms (compact and jsonb-friendly).
 */
interface FormatAgg {
  countdownFoundCounts: Map<number, number>;
  putInOrderCorrectCounts: Map<number, number>; // partial-credit "how many placed right" proxy via points bucket
  cluesRevealIndex: Map<number, number>;
  samples: number;
}

function emptyFormatAgg(): FormatAgg {
  return { countdownFoundCounts: new Map(), putInOrderCorrectCounts: new Map(), cluesRevealIndex: new Map(), samples: 0 };
}

function bump(m: Map<number, number>, key: number): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function histToObject(m: Map<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of [...m.entries()].sort((a, b) => a[0] - b[0])) out[String(k)] = v;
  return out;
}

function accumulateFormatStats(agg: FormatAgg, type: string, payload: Record<string, unknown> | null): void {
  if (!payload) return;
  agg.samples += 1;
  if (type === 'countdown_list') {
    const fc = payload.foundCount;
    if (typeof fc === 'number') bump(agg.countdownFoundCounts, fc);
    else if (Array.isArray(payload.foundAnswerIds)) bump(agg.countdownFoundCounts, payload.foundAnswerIds.length);
  } else if (type === 'put_in_order') {
    // foundCount is the partial-credit count; submittedOrderIds.length is just
    // how many items were submitted (usually all), kept only for older rows.
    if (typeof payload.foundCount === 'number') bump(agg.putInOrderCorrectCounts, payload.foundCount);
    else if (Array.isArray(payload.submittedOrderIds)) bump(agg.putInOrderCorrectCounts, payload.submittedOrderIds.length);
  } else if (type === 'clue_chain') {
    const ci = payload.clueIndex;
    if (typeof ci === 'number') bump(agg.cluesRevealIndex, ci);
  }
}

function formatStatsObject(kind: MatchQuestionKind, timingSamples: number, fmt: FormatAgg): Record<string, unknown> {
  const base: Record<string, unknown> = { kind, cleanTimingSamples: timingSamples, specialSamples: fmt.samples };
  if (fmt.countdownFoundCounts.size > 0) base.countdownFoundCountDistribution = histToObject(fmt.countdownFoundCounts);
  if (fmt.putInOrderCorrectCounts.size > 0) base.putInOrderCorrectCountDistribution = histToObject(fmt.putInOrderCorrectCounts);
  if (fmt.cluesRevealIndex.size > 0) base.clueRevealIndexDistribution = histToObject(fmt.cluesRevealIndex);
  return base;
}

/**
 * Compute per-question smoothed accuracy (Bernoulli only) + independent timing
 * (Bernoulli clean-window only) + payload-aware format_stats, plus the three
 * backoff scopes. Accuracy/timing sample counts are tracked separately so a
 * downstream resolver can back off each field independently.
 */
export function computeQuestionStats(rows: readonly EligibleAnswerRow[]): AggregateResult {
  let bernoulliRows = 0;
  let bernoulliBackfills = 0;
  let specialRows = 0;
  let bernoulliOutsideTimingWindow = 0;
  const formatDistribution: Record<string, number> = {};

  // Global prior from Bernoulli non-backfill rows only.
  let globalCorrect = 0;
  let globalTotal = 0;
  for (const r of rows) {
    formatDistribution[r.questionType] = (formatDistribution[r.questionType] ?? 0) + 1;
    if (r.isBernoulli) {
      bernoulliRows += 1;
      if (r.isBackfill) { bernoulliBackfills += 1; continue; }
      globalCorrect += r.isCorrect ? 1 : 0;
      globalTotal += 1;
    } else {
      specialRows += 1;
    }
  }
  const globalMean = globalTotal > 0 ? globalCorrect / globalTotal : 0.5;

  const perQuestion = new Map<string, { type: string; slug: string | null; acc: AccTimeAgg; fmt: FormatAgg }>();
  const perCategoryType = new Map<string, AccTimeAgg>();
  const perType = new Map<string, AccTimeAgg>();
  const globalTimes: number[] = [];

  const ensureQ = (r: EligibleAnswerRow): { type: string; slug: string | null; acc: AccTimeAgg; fmt: FormatAgg } => {
    let pq = perQuestion.get(r.questionId);
    if (!pq) {
      pq = { type: r.questionType, slug: r.categorySlug, acc: { correct: 0, total: 0, times: [] }, fmt: emptyFormatAgg() };
      perQuestion.set(r.questionId, pq);
    }
    return pq;
  };
  const ensure = (m: Map<string, AccTimeAgg>, key: string): AccTimeAgg => {
    let a = m.get(key);
    if (!a) { a = { correct: 0, total: 0, times: [] }; m.set(key, a); }
    return a;
  };

  for (const r of rows) {
    const pq = ensureQ(r);
    const catTypeKey = `${r.categorySlug ?? 'unknown'}${CATEGORY_TYPE_SEP}${r.questionType}`;

    if (r.isBernoulli) {
      if (r.isBackfill) continue; // excluded from accuracy AND timing
      const cleanTiming = r.inTimingWindow && r.timeMs > 0;
      if (!r.inTimingWindow) bernoulliOutsideTimingWindow += 1;

      pq.acc.correct += r.isCorrect ? 1 : 0;
      pq.acc.total += 1;
      if (cleanTiming) pq.acc.times.push(r.timeMs);

      const ct = ensure(perCategoryType, catTypeKey);
      ct.correct += r.isCorrect ? 1 : 0;
      ct.total += 1;
      if (cleanTiming) ct.times.push(r.timeMs);

      const ty = ensure(perType, r.questionType);
      ty.correct += r.isCorrect ? 1 : 0;
      ty.total += 1;
      if (cleanTiming) ty.times.push(r.timeMs);

      if (cleanTiming) globalTimes.push(r.timeMs);
    } else {
      // Special format: payload distributions only (no accuracy/timing).
      accumulateFormatStats(pq.fmt, r.questionType, r.answerPayload);
    }
  }

  const questionStats: QuestionStatRow[] = [];
  for (const [questionId, q] of perQuestion) {
    const timing = logNormalTimeStats(q.acc.times);
    const isBern = BERNOULLI_SET.has(q.type);
    questionStats.push({
      questionId,
      answersCount: q.acc.total,
      correctCount: q.acc.correct,
      smoothedAccuracy: isBern && q.acc.total > 0 ? bayesianSmooth(q.acc.correct, q.acc.total, globalMean, SMOOTHING_PRIOR_N0) : null,
      timingSamples: timing.count,
      medianTimeMs: timing.medianTimeMs,
      logTimeSigma: timing.logTimeSigma,
      formatStats: formatStatsObject(questionKindForType(q.type as QuestionType), timing.count, q.fmt),
    });
  }

  const backoffStats: BackoffStatRow[] = [];
  const pushBackoff = (scope: 'category_type' | 'type', key: string, a: AccTimeAgg): void => {
    const timing = logNormalTimeStats(a.times);
    backoffStats.push({
      scope,
      scopeKey: key,
      answersCount: a.total,
      correctCount: a.correct,
      smoothedAccuracy: a.total > 0 ? bayesianSmooth(a.correct, a.total, globalMean, SMOOTHING_PRIOR_N0) : null,
      timingSamples: timing.count,
      medianTimeMs: timing.medianTimeMs,
      logTimeSigma: timing.logTimeSigma,
    });
  };
  for (const [key, a] of perCategoryType) pushBackoff('category_type', key, a);
  for (const [key, a] of perType) pushBackoff('type', key, a);

  const globalTiming = logNormalTimeStats(globalTimes);
  backoffStats.push({
    scope: 'global',
    scopeKey: 'global',
    answersCount: globalTotal,
    correctCount: globalCorrect,
    smoothedAccuracy: globalTotal > 0 ? globalMean : null,
    timingSamples: globalTiming.count,
    medianTimeMs: globalTiming.medianTimeMs,
    logTimeSigma: globalTiming.logTimeSigma,
  });

  return {
    questionStats,
    backoffStats,
    globalMean,
    exclusions: {
      totalRows: rows.length,
      bernoulliRows,
      bernoulliBackfills,
      specialRows,
      bernoulliOutsideTimingWindow,
    },
    formatDistribution,
  };
}

/** Convenience: run the query and aggregate in one call. */
export async function aggregateQuestionStats(sql: Sql, opts: { limit?: number } = {}): Promise<AggregateResult> {
  const rows = await eligibleAnswersQuery(sql, opts);
  return computeQuestionStats(rows);
}

/** Shape a per-question/backoff stat for the resolver's ScopeStat contract. */
export function toScopeStat(row: QuestionStatRow | BackoffStatRow): ScopeStat {
  return {
    answersCount: row.answersCount,
    correctCount: row.correctCount,
    smoothedAccuracy: row.smoothedAccuracy,
    timingSamples: row.timingSamples,
    medianTimeMs: row.medianTimeMs,
    logTimeSigma: row.logTimeSigma,
  };
}

export const BACKOFF_MIN_SAMPLE_DEFAULT = BACKOFF_MIN_SAMPLE;
export type { MatchQuestionKind };
