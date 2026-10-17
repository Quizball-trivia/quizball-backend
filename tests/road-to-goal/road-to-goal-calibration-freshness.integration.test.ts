import { beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';
import { applyQuestionCalibrations } from '../../src/modules/road-to-goal/road-to-goal.calibration.js';
import { ROAD_TO_GOAL_DIFFICULTIES, ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP } from '../../src/modules/road-to-goal/road-to-goal.constants.js';
import { roadToGoalQuestionSetHash } from '../../src/modules/road-to-goal/road-to-goal.fairness.js';
import type { RoadToGoalQuestionSnapshot } from '../../src/modules/road-to-goal/road-to-goal.types.js';

let sql: typeof import('../../src/db/index.js').sql;
let repo: typeof import('../../src/modules/road-to-goal/road-to-goal.repo.js').roadToGoalRepo;
let available = false;
const VERSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const questions: RoadToGoalQuestionSnapshot[] = ROAD_TO_GOAL_DIFFICULTIES.map((difficulty, index) => ({
  question_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  difficulty,
  prompt: { en: `Question ${index}` },
  options: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: { en: id } })),
  correct_option_id: 'a',
  expected_accuracy_bp: 7000,
  calibration_source: 'blended',
}));
const requested = questions.map((q, index) => ({ questionId: q.question_id, zone: index + 1 }));

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    repo = (await import('../../src/modules/road-to-goal/road-to-goal.repo.js')).roadToGoalRepo;
    available = true;
  } catch (error) {
    if (process.env.RELEASE_TEST_DATABASE_URL) throw error;
  }
});

async function withFixture(check: (tx: import('../../src/db/index.js').TransactionSql) => Promise<void>) {
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE questions (id uuid PRIMARY KEY, difficulty text, updated_at timestamptz) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE question_payloads (question_id uuid PRIMARY KEY, updated_at timestamptz) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE road_to_goal_calibration_versions (id uuid PRIMARY KEY, created_at timestamptz) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE road_to_goal_zone_question_calibrations (
      version_id uuid, question_id uuid, zone smallint, difficulty text,
      expected_accuracy_bp integer, source text
    ) ON COMMIT DROP`;
    await tx`INSERT INTO road_to_goal_calibration_versions VALUES (${VERSION}, '2026-10-17T00:00:00Z')`;
    for (const [index, q] of questions.entries()) {
      await tx`INSERT INTO questions VALUES (${q.question_id}, ${q.difficulty}, '2026-10-16T00:00:00Z')`;
      await tx`INSERT INTO question_payloads VALUES (${q.question_id}, '2026-10-16T00:00:00Z')`;
      await tx`INSERT INTO road_to_goal_zone_question_calibrations VALUES (
        ${VERSION}, ${q.question_id}, ${index + 1}, ${q.difficulty}, 7000, 'blended'
      )`;
    }
    await check(tx);
  });
}

describe('Road to Goal calibration freshness SQL', () => {
  it('keeps all eleven zones playable after bulk edits without reusing stale measured accuracy', async (ctx) => {
    if (!available) return ctx.skip();
    await withFixture(async (tx) => {
      const fresh = await repo.getQuestionCalibrations(tx, VERSION, requested);
      expect(fresh).toHaveLength(11);
      const committed = applyQuestionCalibrations(questions, fresh);
      const committedHash = roadToGoalQuestionSetHash(committed);

      await tx`UPDATE question_payloads SET updated_at='2026-10-17T12:00:00Z'`;
      const stale = await repo.getQuestionCalibrations(tx, VERSION, requested);
      expect(stale).toEqual([]);
      const nextRun = applyQuestionCalibrations(questions, stale);
      expect(nextRun).toHaveLength(11);
      expect(nextRun.map((q) => q.expected_accuracy_bp)).toEqual(ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP);
      expect(nextRun.every((q) => q.calibration_source === 'difficulty_prior')).toBe(true);
      // Existing snapshots and immutable calibration records are not rewritten.
      expect(roadToGoalQuestionSetHash(committed)).toBe(committedHash);
      expect(committed.every((q) => q.expected_accuracy_bp === 7000)).toBe(true);
      const [stored] = await tx`SELECT count(*)::int AS n FROM road_to_goal_zone_question_calibrations WHERE expected_accuracy_bp=7000`;
      expect(stored.n).toBe(11);
    });
  });

  it('rejects measured accuracy after prompt edits or difficulty changes, and handles new questions', async (ctx) => {
    if (!available) return ctx.skip();
    await withFixture(async (tx) => {
      await tx`UPDATE questions SET updated_at='2026-10-17T12:00:00Z' WHERE id=${questions[0].question_id}`;
      await tx`UPDATE questions SET difficulty='hard' WHERE id=${questions[1].question_id}`;
      await tx`DELETE FROM road_to_goal_zone_question_calibrations WHERE question_id=${questions[2].question_id}`;
      const rows = await repo.getQuestionCalibrations(tx, VERSION, requested);
      expect(rows).toHaveLength(8);
      const mixed = applyQuestionCalibrations(questions, rows);
      expect(mixed.slice(0, 3).map((q) => q.expected_accuracy_bp)).toEqual(ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP.slice(0, 3));
      expect(mixed.slice(3).every((q) => q.expected_accuracy_bp === 7000)).toBe(true);
      expect(await repo.getQuestionCalibrations(tx, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', requested)).toEqual([]);
      expect(await repo.getQuestionCalibrations(tx, VERSION, [])).toEqual([]);
    });
  });
});
