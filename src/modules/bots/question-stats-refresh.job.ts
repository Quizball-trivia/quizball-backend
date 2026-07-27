/**
 * question_stats refresh job (persistent-bot roster, PR4 deliverable B).
 *
 * Recomputes public.question_stats + public.question_stats_backoff from the
 * human ranked answer history using the SHARED aggregation (aggregate.ts) — the
 * exact same exclusions the offline calibration script uses (AI/seed/deleted
 * users, dev matches, timeout backfills, timing clean-window). Idempotent: the
 * upsert fully overwrites each row, and a second run over the same data yields
 * identical output.
 *
 * SHIPPED DISABLED. Nothing schedules this in PR4. A later PR that wires a
 * worker interval or pg_cron trigger MUST gate on config.QUESTION_STATS_REFRESH_ENABLED
 * (see runIfEnabled). The manual npm entrypoint (bot:refresh-question-stats)
 * calls refreshQuestionStats directly and is not gated — it is a human-run tool.
 */

import { sql as defaultSql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import type { Json } from '../../db/database.types.js';
import { aggregateQuestionStats, type AggregateResult } from './calibration/aggregate.js';

type Sql = typeof defaultSql;

export interface RefreshSummary {
  questionRows: number;
  backoffRows: number;
  globalMean: number;
  exclusions: AggregateResult['exclusions'];
  durationMs: number;
}

/**
 * Recompute and upsert question_stats + backoffs against the given DB (defaults
 * to the app DB). Optional `limit` caps the answers scanned (smoke runs only).
 */
export async function refreshQuestionStats(
  options: { sql?: Sql; limit?: number } = {},
): Promise<RefreshSummary> {
  const sql = options.sql ?? defaultSql;
  const startedAt = Date.now();

  const result = await aggregateQuestionStats(sql, { limit: options.limit });
  const now = new Date();

  // Per-row parameterized upserts inside one transaction. Single-value
  // interpolation handles NULLs and jsonb (sql.json) natively — the bulk
  // VALUES ${sql(rows)} helper does not accept nulls/json in its typed form.
  // Question counts are bounded (one row per question), so this is cheap and
  // keeps the whole refresh atomic (readers never see a half-rebuilt table).
  await sql.begin(async (transaction) => {
    // postgres.js types TransactionSql via Omit<Sql, …>, dropping the
    // tagged-template call signatures; the runtime object still supports them.
    // This cast is the established codebase idiom (see questions.repo.ts).
    const tx = transaction as unknown as typeof defaultSql;
    for (const r of result.questionStats) {
      await tx`
        INSERT INTO question_stats
          (question_id, answers_count, correct_count, smoothed_accuracy,
           median_time_ms, log_time_sigma, format_stats, refreshed_at)
        VALUES (
          ${r.questionId}, ${r.answersCount}, ${r.correctCount}, ${r.smoothedAccuracy},
          ${r.medianTimeMs}, ${r.logTimeSigma}, ${tx.json(r.formatStats as Json)}, ${now}
        )
        ON CONFLICT (question_id) DO UPDATE SET
          answers_count     = EXCLUDED.answers_count,
          correct_count     = EXCLUDED.correct_count,
          smoothed_accuracy = EXCLUDED.smoothed_accuracy,
          median_time_ms    = EXCLUDED.median_time_ms,
          log_time_sigma    = EXCLUDED.log_time_sigma,
          format_stats      = EXCLUDED.format_stats,
          refreshed_at      = EXCLUDED.refreshed_at
      `;
    }

    for (const r of result.backoffStats) {
      await tx`
        INSERT INTO question_stats_backoff
          (scope, scope_key, answers_count, correct_count, smoothed_accuracy,
           median_time_ms, log_time_sigma, refreshed_at)
        VALUES (
          ${r.scope}, ${r.scopeKey}, ${r.answersCount}, ${r.correctCount}, ${r.smoothedAccuracy},
          ${r.medianTimeMs}, ${r.logTimeSigma}, ${now}
        )
        ON CONFLICT (scope, scope_key) DO UPDATE SET
          answers_count     = EXCLUDED.answers_count,
          correct_count     = EXCLUDED.correct_count,
          smoothed_accuracy = EXCLUDED.smoothed_accuracy,
          median_time_ms    = EXCLUDED.median_time_ms,
          log_time_sigma    = EXCLUDED.log_time_sigma,
          refreshed_at      = EXCLUDED.refreshed_at
      `;
    }
  });

  const summary: RefreshSummary = {
    questionRows: result.questionStats.length,
    backoffRows: result.backoffStats.length,
    globalMean: result.globalMean,
    exclusions: result.exclusions,
    durationMs: Date.now() - startedAt,
  };
  logger.info({ event: 'question_stats_refresh', ...summary }, 'question_stats refresh complete');
  return summary;
}

/**
 * Scheduler entry point (INERT in PR4). A future worker/pg_cron trigger should
 * call this; it no-ops unless the flag is on, so wiring it up is safe before the
 * roster ships. The manual npm tool bypasses this and calls refreshQuestionStats.
 */
export async function runIfEnabled(options: { sql?: Sql; limit?: number } = {}): Promise<RefreshSummary | null> {
  if (!config.QUESTION_STATS_REFRESH_ENABLED) {
    logger.debug({ event: 'question_stats_refresh' }, 'question_stats refresh disabled by flag — skipping');
    return null;
  }
  return refreshQuestionStats(options);
}
