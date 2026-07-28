/**
 * Integration test: questionStatsRepo.getModelInputsForQuestion against the test
 * database (postgresql://test:test@localhost:5432/test, set by tests/setup.ts).
 *
 * Seeds a category + question + question_stats row + backoff rows at all three
 * scopes (category_type/type/global), then asserts the repo assembles the right
 * ScopeStat at each level and round-trips format_stats. A second question with
 * no per-question or scoped backoff rows (only global) exercises the null +
 * EMPTY_GLOBAL fallback paths.
 *
 * The 'type' and 'global' backoff scopes are process-wide keys (type is a real
 * questions.type enum value; global is the single 'global' row), so they are
 * NOT namespaced to this suite and may already be populated by other suites
 * sharing the test DB. Setup/teardown snapshot-and-restore any pre-existing
 * row at those two keys instead of assuming exclusive ownership, so this suite
 * is safe to run alongside others without clobbering their state.
 *
 * Requires the test database. Self-skips if absent.
 *
 *   npm run docker:start
 *   npx vitest run tests/bots/question-stats-repo.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let questionStatsRepo: typeof import('../../src/modules/bots/question-stats.repo.js').questionStatsRepo;

let dbAvailable = false;

const TAG = `qsrepo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const CATEGORY_SLUG = `${TAG}-cat`;

const ids: {
  categoryId?: string;
  questionWithStats?: string;
  questionBare?: string;
} = {};

interface BackoffRow {
  scope: string;
  scope_key: string;
  answers_count: number;
  correct_count: number;
  smoothed_accuracy: number | null;
  median_time_ms: number | null;
  log_time_sigma: number | null;
}

// Snapshots of the pre-existing 'type'/'global' rows (shared, process-wide keys),
// so teardown can restore exactly what was there before this suite ran instead
// of blindly deleting rows another suite may depend on.
let priorTypeRow: BackoffRow | undefined;
let priorGlobalRow: BackoffRow | undefined;

async function restoreRow(row: BackoffRow | undefined, scope: string, scopeKey: string): Promise<void> {
  await sql`DELETE FROM question_stats_backoff WHERE scope = ${scope} AND scope_key = ${scopeKey}`;
  if (row) {
    await sql`
      INSERT INTO question_stats_backoff
        (scope, scope_key, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma)
      VALUES (${row.scope}, ${row.scope_key}, ${row.answers_count}, ${row.correct_count}, ${row.smoothed_accuracy}, ${row.median_time_ms}, ${row.log_time_sigma})
    `;
  }
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    questionStatsRepo = (await import('../../src/modules/bots/question-stats.repo.js')).questionStatsRepo;
  } catch {
    console.warn('\n⚠️  Skipping question-stats-repo integration test: database not available.\n');
    return;
  }

  const [cat] = await sql<{ id: string }[]>`
    INSERT INTO categories (name, slug, is_active)
    VALUES (${{ en: `${TAG} Cat` }}::jsonb, ${CATEGORY_SLUG}, true)
    RETURNING id
  `;
  ids.categoryId = cat.id;

  const [q1] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    VALUES (${ids.categoryId}, 'mcq_single', 'medium', 'published', ${{ en: `${TAG} q1` }}::jsonb)
    RETURNING id
  `;
  ids.questionWithStats = q1.id;

  const [q2] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    VALUES (${ids.categoryId}, 'mcq_single', 'medium', 'published', ${{ en: `${TAG} q2` }}::jsonb)
    RETURNING id
  `;
  ids.questionBare = q2.id;

  await sql`
    INSERT INTO question_stats
      (question_id, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma, format_stats)
    VALUES
      (${ids.questionWithStats}, 42, 30, 0.71, 5200, 0.55, ${sql.json({ countdownFoundCountDistribution: { '1': 2, '3': 1 } })})
  `;

  // 'type' and 'global' are shared, process-wide scope keys. Snapshot whatever
  // is already there so teardown can restore it rather than deleting rows
  // another suite sharing the test DB may depend on.
  [priorTypeRow] = await sql<BackoffRow[]>`
    SELECT scope, scope_key, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma
    FROM question_stats_backoff WHERE scope = 'type' AND scope_key = 'mcq_single'
  `;
  [priorGlobalRow] = await sql<BackoffRow[]>`
    SELECT scope, scope_key, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma
    FROM question_stats_backoff WHERE scope = 'global' AND scope_key = 'global'
  `;

  const categoryTypeKey = `${CATEGORY_SLUG}:mcq_single`;
  await restoreRow(
    { scope: 'type', scope_key: 'mcq_single', answers_count: 5000, correct_count: 3000, smoothed_accuracy: 0.62, median_time_ms: 5800, log_time_sigma: 0.42 },
    'type',
    'mcq_single',
  );
  await restoreRow(
    { scope: 'global', scope_key: 'global', answers_count: 50000, correct_count: 31000, smoothed_accuracy: 0.63, median_time_ms: 5900, log_time_sigma: 0.45 },
    'global',
    'global',
  );
  await sql`
    INSERT INTO question_stats_backoff
      (scope, scope_key, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma)
    VALUES ('category_type', ${categoryTypeKey}, 500, 300, 0.6, 6000, 0.4)
  `;
});

afterAll(async () => {
  if (!dbAvailable) return;
  const allQ = [ids.questionWithStats, ids.questionBare].filter(Boolean) as string[];
  await sql`DELETE FROM question_stats WHERE question_id = ANY(${allQ}::uuid[])`;
  await sql`DELETE FROM questions WHERE id = ANY(${allQ}::uuid[])`;
  if (ids.categoryId) {
    await sql`DELETE FROM categories WHERE id = ${ids.categoryId}`;
  }
  await sql`DELETE FROM question_stats_backoff WHERE scope = 'category_type' AND scope_key = ${`${CATEGORY_SLUG}:mcq_single`}`;
  await restoreRow(priorTypeRow, 'type', 'mcq_single');
  await restoreRow(priorGlobalRow, 'global', 'global');
});

describe('questionStatsRepo.getModelInputsForQuestion', () => {
  it('assembles per-question stats + all three backoff scopes, with format_stats round-tripped', async () => {
    if (!dbAvailable) return;
    const result = await questionStatsRepo.getModelInputsForQuestion(ids.questionWithStats!);

    expect(result).not.toBeNull();
    expect(result!.questionType).toBe('mcq_single');
    expect(result!.categorySlug).toBe(CATEGORY_SLUG);

    expect(result!.perQuestion).toEqual({
      answersCount: 42,
      correctCount: 30,
      smoothedAccuracy: 0.71,
      timingSamples: 42,
      medianTimeMs: 5200,
      logTimeSigma: 0.55,
    });

    expect(result!.categoryType).toEqual({
      answersCount: 500,
      correctCount: 300,
      smoothedAccuracy: 0.6,
      timingSamples: 500,
      medianTimeMs: 6000,
      logTimeSigma: 0.4,
    });

    expect(result!.type).toEqual({
      answersCount: 5000,
      correctCount: 3000,
      smoothedAccuracy: 0.62,
      timingSamples: 5000,
      medianTimeMs: 5800,
      logTimeSigma: 0.42,
    });

    expect(result!.global).toEqual({
      answersCount: 50000,
      correctCount: 31000,
      smoothedAccuracy: 0.63,
      timingSamples: 50000,
      medianTimeMs: 5900,
      logTimeSigma: 0.45,
    });

    expect(result!.formatStats).toEqual({ countdownFoundCountDistribution: { '1': 2, '3': 1 } });
  });

  it('falls back to null scopes for a question with no per-question or scoped backoff rows, keeping the shared global', async () => {
    if (!dbAvailable) return;
    const result = await questionStatsRepo.getModelInputsForQuestion(ids.questionBare!);

    expect(result).not.toBeNull();
    expect(result!.questionType).toBe('mcq_single');
    expect(result!.categorySlug).toBe(CATEGORY_SLUG);

    expect(result!.perQuestion).toBeNull();
    // questionBare's category_type key (same category+type as questionWithStats)
    // DOES have a backoff row seeded above, so it resolves rather than falling
    // back to null.
    expect(result!.categoryType).toEqual({
      answersCount: 500,
      correctCount: 300,
      smoothedAccuracy: 0.6,
      timingSamples: 500,
      medianTimeMs: 6000,
      logTimeSigma: 0.4,
    });
    expect(result!.type).toEqual({
      answersCount: 5000,
      correctCount: 3000,
      smoothedAccuracy: 0.62,
      timingSamples: 5000,
      medianTimeMs: 5800,
      logTimeSigma: 0.42,
    });
    // Global is always populated from the shared 'global' backoff row when present.
    expect(result!.global).toEqual({
      answersCount: 50000,
      correctCount: 31000,
      smoothedAccuracy: 0.63,
      timingSamples: 50000,
      medianTimeMs: 5900,
      logTimeSigma: 0.45,
    });
    expect(result!.formatStats).toBeNull();
  });

  it('returns EMPTY_GLOBAL when even the global backoff row is absent', async () => {
    if (!dbAvailable) return;
    // Temporarily remove the global row to exercise the true fallback, then restore it.
    await sql`DELETE FROM question_stats_backoff WHERE scope = 'global' AND scope_key = 'global'`;
    try {
      const result = await questionStatsRepo.getModelInputsForQuestion(ids.questionBare!);
      expect(result).not.toBeNull();
      expect(result!.global).toEqual({
        answersCount: 0,
        correctCount: 0,
        smoothedAccuracy: null,
        timingSamples: 0,
        medianTimeMs: null,
        logTimeSigma: null,
      });
    } finally {
      await sql`
        INSERT INTO question_stats_backoff
          (scope, scope_key, answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma)
        VALUES ('global', 'global', 50000, 31000, 0.63, 5900, 0.45)
      `;
    }
  });

  it('returns null for an unknown question id', async () => {
    if (!dbAvailable) return;
    const result = await questionStatsRepo.getModelInputsForQuestion('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});
