/**
 * Database-backed coverage for the two Road to Goal question-selection SQL
 * shapes. Temporary tables shadow production relations, so this exercises the
 * real PostgreSQL queries without changing persistent schema or data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let roadToGoalRepo: typeof import('../../src/modules/road-to-goal/road-to-goal.repo.js').roadToGoalRepo;
let dbAvailable = false;

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROUND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CATEGORY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CALIBRATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function questionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function payload(index: number, withImage = false) {
  return {
    type: 'mcq_single',
    ...(withImage ? {
      image: {
        url: 'https://cdn.example.com/integration.jpg',
        width: 1200,
        height: 800,
        aspect_ratio: '3:2',
      },
    } : {}),
    options: [0, 1, 2, 3].map((option) => ({
      id: `option-${index}-${option}`,
      text: { en: `Option ${option}` },
      is_correct: option === 1,
    })),
  };
}

beforeAll(async () => {
  try {
    const db = await import('../../src/db/index.js');
    sql = db.sql;
    await sql`SELECT 1`;
    roadToGoalRepo = (await import(
      '../../src/modules/road-to-goal/road-to-goal.repo.js'
    )).roadToGoalRepo;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping Road to Goal repo integration tests: DB unavailable.\n');
  }
});

describe('Road to Goal question selection SQL', () => {
  it('selects image MCQs and preserves unseen-first fallback priority', async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    await sql.begin(async (tx) => {
      await tx`
        CREATE TEMP TABLE categories (
          id uuid PRIMARY KEY,
          is_active boolean NOT NULL
        ) ON COMMIT DROP
      `;
      await tx`
        CREATE TEMP TABLE questions (
          id uuid PRIMARY KEY,
          category_id uuid NOT NULL,
          status text NOT NULL,
          type text NOT NULL,
          ranked_eligible boolean NOT NULL,
          visibility text NOT NULL,
          difficulty text NOT NULL,
          prompt jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        ) ON COMMIT DROP
      `;
      await tx`
        CREATE TEMP TABLE question_payloads (
          question_id uuid PRIMARY KEY,
          payload jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        ) ON COMMIT DROP
      `;
      await tx`
        CREATE TEMP TABLE road_to_goal_question_exposures (
          user_id uuid NOT NULL,
          question_id uuid NOT NULL,
          exposure_count integer NOT NULL DEFAULT 1,
          first_exposed_at timestamptz NOT NULL DEFAULT now(),
          last_exposed_at timestamptz NOT NULL DEFAULT now(),
          last_round_id uuid NOT NULL,
          PRIMARY KEY (user_id, question_id)
        ) ON COMMIT DROP
      `;
      await tx`
        CREATE TEMP TABLE road_to_goal_calibration_versions (
          id uuid PRIMARY KEY,
          created_at timestamptz NOT NULL
        ) ON COMMIT DROP
      `;
      await tx`
        CREATE TEMP TABLE road_to_goal_zone_question_calibrations (
          version_id uuid NOT NULL,
          question_id uuid NOT NULL,
          zone smallint NOT NULL,
          difficulty text NOT NULL
        ) ON COMMIT DROP
      `;
      await tx`
        INSERT INTO road_to_goal_calibration_versions (id, created_at)
        VALUES (${CALIBRATION_ID}, now() + interval '1 second')
      `;
      await tx`INSERT INTO categories (id, is_active) VALUES (${CATEGORY_ID}, true)`;

      const difficulties = [
        ...Array.from({ length: 5 }, () => 'easy'),
        ...Array.from({ length: 5 }, () => 'medium'),
        ...Array.from({ length: 4 }, () => 'hard'),
      ];
      for (const [offset, difficulty] of difficulties.entries()) {
        const index = offset + 1;
        const id = questionId(index);
        await tx`
          INSERT INTO questions (
            id, category_id, status, type, ranked_eligible, visibility, difficulty, prompt
          ) VALUES (
            ${id}, ${CATEGORY_ID}, 'published', 'mcq_single', true, 'public',
            ${difficulty}, ${tx.json({ en: `Question ${index}` })}
          )
        `;
        await tx`
          INSERT INTO question_payloads (question_id, payload)
          VALUES (${id}, ${tx.json(payload(index, index === 1))})
        `;
        await tx`
          INSERT INTO road_to_goal_zone_question_calibrations (
            version_id, question_id, zone, difficulty
          ) VALUES (
            ${CALIBRATION_ID}, ${id},
            ${difficulty === 'easy' ? 1 : difficulty === 'medium' ? 5 : 9},
            ${difficulty}
          )
        `;
      }

      const unseenCandidates = await roadToGoalRepo.pickRunQuestionCandidates(
        tx,
        USER_ID,
        'unseen'
      );
      const unseen = await roadToGoalRepo.filterCandidatesForCalibration(
        tx,
        CALIBRATION_ID,
        unseenCandidates
      );
      expect(unseen).toHaveLength(14);
      expect(unseen.some((candidate) => {
        const value = candidate.payload as { image?: { url?: string } };
        return value.image?.url === 'https://cdn.example.com/integration.jpg';
      })).toBe(true);

      await tx`
        UPDATE question_payloads
        SET updated_at = now() + interval '1 day'
        WHERE question_id = ${questionId(1)}
      `;
      const afterIntradayEdit = await roadToGoalRepo.filterCandidatesForCalibration(
        tx,
        CALIBRATION_ID,
        unseenCandidates
      );
      expect(afterIntradayEdit.map((candidate) => candidate.id)).not.toContain(questionId(1));

      // Leave the first two hard questions unseen and give every other row a
      // deterministic exposure count. Fallback must rank those unseen rows 1/2.
      for (let index = 1; index <= 14; index += 1) {
        if (index === 11 || index === 12) continue;
        await tx`
          INSERT INTO road_to_goal_question_exposures (
            user_id, question_id, exposure_count, last_exposed_at, last_round_id
          ) VALUES (
            ${USER_ID}, ${questionId(index)}, ${1 + (index % 3)},
            now() - make_interval(days => ${index}), ${ROUND_ID}
          )
        `;
      }

      const fallbackCandidates = await roadToGoalRepo.pickRunQuestionCandidates(
        tx,
        USER_ID,
        'least_exposed'
      );
      const fallback = await roadToGoalRepo.filterCandidatesForCalibration(
        tx,
        CALIBRATION_ID,
        fallbackCandidates
      );
      const hard = fallback.filter((candidate) => candidate.difficulty === 'hard');
      expect(hard.slice(0, 2).map((candidate) => candidate.id).sort()).toEqual([
        questionId(11),
        questionId(12),
      ]);
      expect(hard.slice(0, 2).map((candidate) => candidate.selection_priority)).toEqual([1, 2]);

      const reserved = fallback.slice(0, 11).map((candidate) => ({
        question_id: candidate.id,
        difficulty: candidate.difficulty,
        prompt: { en: 'Question' },
        options: [
          { id: 'a', text: { en: 'A' } },
          { id: 'b', text: { en: 'B' } },
          { id: 'c', text: { en: 'C' } },
          { id: 'd', text: { en: 'D' } },
        ],
        correct_option_id: 'a',
      }));
      await roadToGoalRepo.recordQuestionExposures(tx, USER_ID, ROUND_ID, reserved);
      await roadToGoalRepo.recordQuestionExposures(tx, USER_ID, ROUND_ID, reserved);
      const [exposure] = await tx<{ exposure_count: number }[]>`
        SELECT exposure_count
        FROM road_to_goal_question_exposures
        WHERE user_id = ${USER_ID} AND question_id = ${reserved[0].question_id}
      `;
      expect(exposure.exposure_count).toBeGreaterThanOrEqual(2);
    });
  });
});
