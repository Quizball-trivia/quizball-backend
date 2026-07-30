/**
 * Read-only access to question_stats + question_stats_backoff for the persistent
 * bot gameplay model (PR8). The refresh job (question-stats-refresh.job.ts)
 * writes these tables; this repo only reads them at question-show time to resolve
 * a question's difficulty/timing via the shared backoff chain.
 *
 * question_stats is UNVERSIONED (latest snapshot only) by design (§1.7): the
 * mid-match immutability guarantee for persistent bots comes from pinning the
 * MODEL PARAMS version into ranked_context at match creation, not from
 * versioning per-question stats.
 */

import { sql } from '../../db/index.js';
import type { ScopeStat } from './calibration/math.js';

/** category_type backoff key = `${categorySlug|'unknown'}:${questionType}`. */
const CATEGORY_TYPE_SEP = ':';

export interface QuestionModelInputs {
  questionType: string;
  categorySlug: string | null;
  perQuestion: ScopeStat | null;
  categoryType: ScopeStat | null;
  type: ScopeStat | null;
  global: ScopeStat;
  /** format_stats jsonb for special-format models (countdown/put-in-order/clue). */
  formatStats: Record<string, unknown> | null;
}

interface StatRow {
  answers_count: number;
  correct_count: number;
  smoothed_accuracy: number | null;
  median_time_ms: number | null;
  log_time_sigma: number | null;
  timing_samples: number | null;
}

function toScope(row: StatRow | undefined | null): ScopeStat | null {
  if (!row) return null;
  return {
    answersCount: row.answers_count,
    correctCount: row.correct_count,
    smoothedAccuracy: row.smoothed_accuracy,
    // Clean-window timing sample count, resolved INDEPENDENTLY of accuracy in the
    // backoff. NULL only for rows written before the timing_samples column
    // existed (migration 20260728120000); those fall back to answers_count until
    // the next refresh repopulates the real count.
    timingSamples: row.timing_samples ?? row.answers_count,
    medianTimeMs: row.median_time_ms,
    logTimeSigma: row.log_time_sigma,
  };
}

const EMPTY_GLOBAL: ScopeStat = {
  answersCount: 0,
  correctCount: 0,
  smoothedAccuracy: null,
  timingSamples: 0,
  medianTimeMs: null,
  logTimeSigma: null,
};

export const questionStatsRepo = {
  /**
   * Fetch everything the model needs for one question in a single round-trip:
   * the question's type + category slug, its per-question stats, and the three
   * backoff scopes (category_type, type, global). Missing rows come back null
   * and the model falls back down the chain to the guaranteed global floor.
   */
  async getModelInputsForQuestion(questionId: string): Promise<QuestionModelInputs | null> {
    const [meta] = await sql<Array<{ type: string; slug: string | null }>>`
      SELECT q.type AS type, c.slug AS slug
      FROM questions q
      LEFT JOIN categories c ON c.id = q.category_id
      WHERE q.id = ${questionId}
      LIMIT 1
    `;
    if (!meta) return null;

    const categoryTypeKey = `${meta.slug ?? 'unknown'}${CATEGORY_TYPE_SEP}${meta.type}`;

    const [perQuestionRows, backoffRows, formatRows] = await Promise.all([
      sql<StatRow[]>`
        SELECT answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma, timing_samples
        FROM question_stats WHERE question_id = ${questionId} LIMIT 1
      `,
      sql<Array<StatRow & { scope: string; scope_key: string }>>`
        SELECT scope, scope_key, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma, timing_samples
        FROM question_stats_backoff
        WHERE (scope = 'category_type' AND scope_key = ${categoryTypeKey})
           OR (scope = 'type' AND scope_key = ${meta.type})
           OR (scope = 'global' AND scope_key = 'global')
      `,
      sql<Array<{ format_stats: Record<string, unknown> | null }>>`
        SELECT format_stats FROM question_stats WHERE question_id = ${questionId} LIMIT 1
      `,
    ]);

    const byScope = new Map(backoffRows.map((r) => [`${r.scope}:${r.scope_key}`, r]));
    const global = toScope(byScope.get('global:global')) ?? EMPTY_GLOBAL;

    return {
      questionType: meta.type,
      categorySlug: meta.slug,
      perQuestion: toScope(perQuestionRows[0]),
      categoryType: toScope(byScope.get(`category_type:${categoryTypeKey}`)),
      type: toScope(byScope.get(`type:${meta.type}`)),
      global,
      formatStats: formatRows[0]?.format_stats ?? null,
    };
  },

  /**
   * All per-question smoothed accuracies (Bernoulli questions with a computed
   * accuracy), for solving the ceiling-derived theta bound at match creation.
   * Returns an empty array when the table is empty (fresh DB) → the caller uses
   * the conservative frozen fallback bound. Read-only, single round-trip.
   */
  async getAllSmoothedAccuracies(): Promise<number[]> {
    const rows = await sql<Array<{ smoothed_accuracy: number }>>`
      SELECT smoothed_accuracy
      FROM question_stats
      WHERE smoothed_accuracy IS NOT NULL
    `;
    return rows.map((r) => r.smoothed_accuracy);
  },
};
