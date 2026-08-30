/**
 * question_stats refresh job (persistent-bot roster, PR4 deliverable B).
 *
 * Recomputes public.question_stats + public.question_stats_backoff from the
 * human ranked answer history using the SHARED aggregation (aggregate.ts) — the
 * exact same exclusions the offline calibration script uses.
 *
 * COMPLETE latest-snapshot semantics (finding #9): the refresh is not a plain
 * upsert. It upserts every current row AND deletes any question_stats /
 * question_stats_backoff row whose key is NOT in the new result, all inside one
 * transaction, so obsolete rows (a question that lost all eligible answers, a
 * category/type key that no longer occurs) cannot survive. Readers never see a
 * half-rebuilt table.
 *
 * `--limit` / `limit` is DRY-RUN ONLY: a limited scan produces arbitrary partial
 * aggregates (the source LIMIT has no ordering), so a limited run computes the
 * result and returns the summary but writes NOTHING.
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
  questionRowsDeleted: number;
  backoffRowsDeleted: number;
  globalMean: number;
  exclusions: AggregateResult['exclusions'];
  dryRun: boolean;
  durationMs: number;
}

/**
 * Recompute and REPLACE question_stats + backoffs against the given DB
 * (defaults to the app DB). A `limit` makes this a dry run (computes + returns
 * the summary, writes nothing).
 */
export async function refreshQuestionStats(
  options: { sql?: Sql; limit?: number } = {},
): Promise<RefreshSummary> {
  const sql = options.sql ?? defaultSql;
  const startedAt = Date.now();
  const dryRun = options.limit != null && options.limit > 0;

  const result = await aggregateQuestionStats(sql, { limit: options.limit });
  const now = new Date();

  let questionRowsDeleted = 0;
  let backoffRowsDeleted = 0;

  if (!dryRun) {
    await sql.begin(async (transaction) => {
      // postgres.js types TransactionSql via Omit<Sql, …>, dropping the
      // tagged-template call signatures; the runtime object still supports them.
      // This cast is the established codebase idiom (see questions.repo.ts).
      const tx = transaction as unknown as typeof defaultSql;

      const questionIds = result.questionStats.map((r) => r.questionId);
      const backoffKeys = result.backoffStats.map((r) => `${r.scope} ${r.scopeKey}`);

      for (const r of result.questionStats) {
        // INSERT … SELECT guarded by EXISTS: the aggregation ran outside this
        // transaction, so a question could be deleted between the read and the
        // write (never happens in prod during a refresh, but it makes the write
        // race-safe and avoids an FK violation under concurrent deletes).
        await tx`
          INSERT INTO question_stats
            (question_id, answers_count, correct_count, smoothed_accuracy,
             median_time_ms, log_time_sigma, timing_samples, format_stats, refreshed_at)
          SELECT ${r.questionId}, ${r.answersCount}, ${r.correctCount}, ${r.smoothedAccuracy},
                 ${r.medianTimeMs}, ${r.logTimeSigma}, ${r.timingSamples}, ${tx.json(r.formatStats as Json)}, ${now}
          WHERE EXISTS (SELECT 1 FROM questions q WHERE q.id = ${r.questionId})
          ON CONFLICT (question_id) DO UPDATE SET
            answers_count     = EXCLUDED.answers_count,
            correct_count     = EXCLUDED.correct_count,
            smoothed_accuracy = EXCLUDED.smoothed_accuracy,
            median_time_ms    = EXCLUDED.median_time_ms,
            log_time_sigma    = EXCLUDED.log_time_sigma,
            timing_samples    = EXCLUDED.timing_samples,
            -- clue solve-rate fields come from clue_guess_evaluations via
            -- scripts/bot-calibration/clue-solve-rates.ts, NOT this aggregation;
            -- a wholesale replace would silently erase them (Sol High)
            format_stats      = EXCLUDED.format_stats
              || (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                  FROM jsonb_each(coalesce(question_stats.format_stats, '{}'::jsonb))
                  WHERE key IN ('cluesSolveRate', 'cluesSolveSamples')),
            refreshed_at      = EXCLUDED.refreshed_at
        `;
      }
      // Delete-not-present: drop obsolete question rows — EXCEPT rows carrying
      // clue solve-rate calibration, which is produced by a different corpus
      // (clue-solve-rates.ts) and may legitimately cover questions this
      // aggregation saw no eligible answers for. Spared rows get their
      // aggregation fields RESET, not kept: a stale smoothed_accuracy would
      // otherwise keep feeding decideMcq via the question-scope backoff forever.
      const notPresent = questionIds.length > 0
        ? tx`question_id <> ALL(${questionIds}::uuid[])`
        : tx`true`;
      const delQ = await tx`DELETE FROM question_stats
        WHERE ${notPresent} AND NOT (coalesce(format_stats, '{}'::jsonb) ? 'cluesSolveRate')`;
      await tx`UPDATE question_stats
        SET answers_count = 0, correct_count = 0, smoothed_accuracy = NULL,
            median_time_ms = NULL, log_time_sigma = NULL, timing_samples = 0,
            format_stats = format_stats - 'clueRevealIndexDistribution'
                                        - 'countdownFoundCountDistribution'
                                        - 'putInOrderCorrectCountDistribution'
        WHERE ${notPresent} AND coalesce(format_stats, '{}'::jsonb) ? 'cluesSolveRate'`;
      questionRowsDeleted = delQ.count ?? 0;

      for (const r of result.backoffStats) {
        await tx`
          INSERT INTO question_stats_backoff
            (scope, scope_key, answers_count, correct_count, smoothed_accuracy,
             median_time_ms, log_time_sigma, timing_samples, refreshed_at)
          VALUES (
            ${r.scope}, ${r.scopeKey}, ${r.answersCount}, ${r.correctCount}, ${r.smoothedAccuracy},
            ${r.medianTimeMs}, ${r.logTimeSigma}, ${r.timingSamples}, ${now}
          )
          ON CONFLICT (scope, scope_key) DO UPDATE SET
            answers_count     = EXCLUDED.answers_count,
            correct_count     = EXCLUDED.correct_count,
            smoothed_accuracy = EXCLUDED.smoothed_accuracy,
            median_time_ms    = EXCLUDED.median_time_ms,
            log_time_sigma    = EXCLUDED.log_time_sigma,
            timing_samples    = EXCLUDED.timing_samples,
            refreshed_at      = EXCLUDED.refreshed_at
        `;
      }
      // Delete-not-present for backoffs. Composite key = scope || ' ' ||
      // scope_key (scope is a fixed enum with no space; the JS side builds the
      // same key), so a row absent from the new result is dropped.
      const delB = backoffKeys.length > 0
        ? await tx`
            DELETE FROM question_stats_backoff
            WHERE (scope || ' ' || scope_key) <> ALL(${backoffKeys}::text[])`
        : await tx`DELETE FROM question_stats_backoff`;
      backoffRowsDeleted = delB.count ?? 0;
    });
  }

  const summary: RefreshSummary = {
    questionRows: result.questionStats.length,
    backoffRows: result.backoffStats.length,
    questionRowsDeleted,
    backoffRowsDeleted,
    globalMean: result.globalMean,
    exclusions: result.exclusions,
    dryRun,
    durationMs: Date.now() - startedAt,
  };
  logger.info({ event: 'question_stats_refresh', ...summary }, dryRun ? 'question_stats refresh DRY RUN (no writes)' : 'question_stats refresh complete');
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
