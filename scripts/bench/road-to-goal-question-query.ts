import { performance } from 'node:perf_hooks';
import { disconnectDb, sql, type TransactionSql } from '../../src/db/index.js';
import { roadToGoalRepo } from '../../src/modules/road-to-goal/road-to-goal.repo.js';
import { ensureRoadToGoalDailyCalibration } from '../../src/modules/road-to-goal/road-to-goal.calibration.js';
import type { RoadToGoalQuestionSelectionMode } from '../../src/modules/road-to-goal/road-to-goal.types.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
}

const samples = positiveInteger(process.env.ROAD_TO_GOAL_BENCH_SAMPLES, 50);
const warmups = positiveInteger(process.env.ROAD_TO_GOAL_BENCH_WARMUPS, 5);
const p95BudgetMs = positiveInteger(process.env.ROAD_TO_GOAL_BENCH_P95_MS, 50);
const userId = process.env.ROAD_TO_GOAL_BENCH_USER_ID ?? DEFAULT_USER_ID;

async function selectOnce(
  tx: TransactionSql,
  calibrationVersionId: string,
  mode: RoadToGoalQuestionSelectionMode
): Promise<number> {
  const selected = await roadToGoalRepo.pickRunQuestionCandidates(tx, userId, mode);
  const candidates = await roadToGoalRepo.filterCandidatesForCalibration(
    tx,
    calibrationVersionId,
    selected
  );
  return candidates.length;
}

async function measure(select: () => Promise<number>) {
  const latencies: number[] = [];
  let minimumCandidateCount = Number.POSITIVE_INFINITY;
  for (let index = 0; index < warmups; index += 1) await select();
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    minimumCandidateCount = Math.min(minimumCandidateCount, await select());
    latencies.push(performance.now() - startedAt);
  }

  latencies.sort((a, b) => a - b);
  return {
    candidates_per_query: minimumCandidateCount,
    latency_ms: {
      min: Number(latencies[0].toFixed(2)),
      p50: Number(percentile(latencies, 0.5).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      max: Number(latencies[latencies.length - 1].toFixed(2)),
    },
  };
}

class BenchmarkRollback extends Error {}

type BenchmarkReport = {
  samples: number;
  empty_history_unseen: Awaited<ReturnType<typeof measure>>;
  exhausted_history_unseen_then_fallback: Awaited<ReturnType<typeof measure>>;
  p95_budget_ms: number;
};

try {
  let report: BenchmarkReport | null = null;
  try {
    await sql.begin(async (tx) => {
      const calibration = await ensureRoadToGoalDailyCalibration(
        tx,
        undefined,
        { logPublication: false }
      );
      // This session-only relation shadows the production exposure table. The
      // forced rollback below also reverts a calibration created by this run.
      await tx`
        CREATE TEMP TABLE road_to_goal_question_exposures (
          user_id uuid NOT NULL,
          question_id uuid NOT NULL,
          exposure_count integer NOT NULL,
          last_exposed_at timestamptz NOT NULL
        ) ON COMMIT DROP
      `;
      await tx`
        CREATE INDEX ON road_to_goal_question_exposures (user_id, question_id)
      `;

      const emptyHistoryUnseen = await measure(() =>
        selectOnce(tx, calibration.id, 'unseen')
      );

      await tx`
        INSERT INTO road_to_goal_question_exposures (
          user_id, question_id, exposure_count, last_exposed_at
        )
        SELECT
          ${userId}::uuid,
          q.id,
          1 + ((hashtextextended(q.id::text, 0) & 2147483647) % 5)::integer,
          now() - make_interval(
            secs => ((hashtextextended(q.id::text, 0) & 2147483647) % 2592000)::integer
          )
        FROM questions q
        JOIN categories category
          ON category.id = q.category_id
         AND category.is_active = true
        WHERE q.status = 'published'
          AND q.type = 'mcq_single'
          AND q.ranked_eligible = true
          AND q.visibility = 'public'
      `;

      const exhaustedHistory = await measure(async () => {
        const unseenCount = await selectOnce(tx, calibration.id, 'unseen');
        if (unseenCount > 0) {
          throw new Error('Exhausted benchmark history unexpectedly returned unseen questions');
        }
        return selectOnce(tx, calibration.id, 'least_exposed');
      });

      report = {
        samples,
        empty_history_unseen: emptyHistoryUnseen,
        exhausted_history_unseen_then_fallback: exhaustedHistory,
        p95_budget_ms: p95BudgetMs,
      };
      throw new BenchmarkRollback('Roll back benchmark-only data');
    });
  } catch (error) {
    if (!(error instanceof BenchmarkRollback)) throw error;
  }
  if (!report) throw new Error('Question benchmark did not produce a report');

  console.log(JSON.stringify(report, null, 2));
  const paths = [
    report.empty_history_unseen,
    report.exhausted_history_unseen_then_fallback,
  ];
  if (paths.some((path) => path.candidates_per_query < 11)) {
    console.error('Question query returned fewer than 11 candidates.');
    process.exitCode = 1;
  } else if (paths.some((path) => path.latency_ms.p95 > p95BudgetMs)) {
    console.error(`A question-selection path exceeded the ${p95BudgetMs}ms p95 budget.`);
    process.exitCode = 1;
  }
} finally {
  await disconnectDb();
}
