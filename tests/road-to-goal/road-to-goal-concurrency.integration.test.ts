/**
 * Real-database proof that simultaneous same-nonce starts converge on one
 * round, one stake debit, and one exposure reservation batch.
 *
 * Run after applying the Road to Goal migrations to the local test database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let roadToGoalService: typeof import('../../src/modules/road-to-goal/road-to-goal.service.js').roadToGoalService;
let roadToGoalRepo: typeof import('../../src/modules/road-to-goal/road-to-goal.repo.js').roadToGoalRepo;
let schemaAvailable = false;
let userId: string | null = null;
let categoryId: string | null = null;
const questionIds: string[] = [];

const NONCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function payload(index: number) {
  return {
    type: 'mcq_single',
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
    const [schema] = await sql<{ ready: boolean }[]>`
      SELECT
        to_regclass('public.road_to_goal_rounds') IS NOT NULL
        AND to_regclass('public.road_to_goal_commitments') IS NOT NULL
        AND to_regclass('public.road_to_goal_zone_question_calibrations') IS NOT NULL
        AND to_regclass('public.road_to_goal_question_exposures') IS NOT NULL
        AND to_regclass('public.road_to_goal_events') IS NOT NULL AS ready
    `;
    if (!schema?.ready) {
      console.warn(
        '\n⚠️  Skipping Road to Goal concurrency integration test: migrations not applied.\n'
      );
      return;
    }
    roadToGoalService = (await import(
      '../../src/modules/road-to-goal/road-to-goal.service.js'
    )).roadToGoalService;
    roadToGoalRepo = (await import(
      '../../src/modules/road-to-goal/road-to-goal.repo.js'
    )).roadToGoalRepo;
    schemaAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping Road to Goal concurrency integration test: DB unavailable.\n');
  }
});

afterAll(async () => {
  if (!schemaAvailable || !sql) return;
  if (userId) {
    await sql`DELETE FROM road_to_goal_events WHERE user_id = ${userId}`;
    await sql`DELETE FROM road_to_goal_question_exposures WHERE user_id = ${userId}`;
    await sql`DELETE FROM road_to_goal_rounds WHERE user_id = ${userId}`;
    await sql`DELETE FROM road_to_goal_commitments WHERE user_id = ${userId}`;
    await sql`
      DELETE FROM store_transaction_logs
      WHERE user_id = ${userId}
        AND event_type IN ('road_to_goal_stake', 'road_to_goal_payout')
    `;
    await sql`DELETE FROM users WHERE id = ${userId}`;
  }
  if (questionIds.length > 0) {
    await sql`
      DELETE FROM road_to_goal_question_calibrations
      WHERE question_id = ANY(${questionIds}::uuid[])
    `;
    await sql`
      DELETE FROM road_to_goal_zone_question_calibrations
      WHERE question_id = ANY(${questionIds}::uuid[])
    `;
    await sql`DELETE FROM question_payloads WHERE question_id = ANY(${questionIds}::uuid[])`;
    await sql`DELETE FROM questions WHERE id = ANY(${questionIds}::uuid[])`;
  }
  if (categoryId) await sql`DELETE FROM categories WHERE id = ${categoryId}`;
});

describe('Road to Goal start concurrency', () => {
  it('charges and creates exactly once for two same-nonce requests', async (ctx) => {
    if (!schemaAvailable) return ctx.skip();

    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (nickname, is_ai, ai_kind, coins, onboarding_complete)
      VALUES (${`rtg-race-${Date.now()}`}, false, null, 100, true)
      RETURNING id
    `;
    userId = user.id;
    const [category] = await sql<{ id: string }[]>`
      INSERT INTO categories (name, slug, is_active)
      VALUES (${{ en: 'Road to Goal race' }}::jsonb, ${`rtg-race-${Date.now()}`}, true)
      RETURNING id
    `;
    categoryId = category.id;
    const calibration = await roadToGoalService.publishDailyCalibration();

    const difficulties = [
      ...Array.from({ length: 4 }, () => 'easy'),
      ...Array.from({ length: 4 }, () => 'medium'),
      ...Array.from({ length: 3 }, () => 'hard'),
    ];
    for (const [index, difficulty] of difficulties.entries()) {
      const [question] = await sql<{ id: string }[]>`
        INSERT INTO questions (
          category_id, type, difficulty, status, ranked_eligible, visibility, prompt, updated_at
        ) VALUES (
          ${categoryId}, 'mcq_single', ${difficulty}, 'published', true, 'public',
          ${sql.json({ en: `Road to Goal race ${index}` })},
          ${calibration.created_at}::timestamptz - interval '1 millisecond'
        )
        RETURNING id
      `;
      questionIds.push(question.id);
      await sql`
        INSERT INTO question_payloads (question_id, payload, updated_at)
        VALUES (
          ${question.id},
          ${sql.json(payload(index))},
          ${calibration.created_at}::timestamptz - interval '1 millisecond'
        )
      `;
      const zones = difficulty === 'easy'
        ? [1, 2, 3, 4]
        : difficulty === 'medium'
          ? [5, 6, 7, 8]
          : [9, 10, 11];
      const priors = [8_000, 8_042, 8_084, 8_126, 6_669, 6_713, 6_757, 6_802, 5_347, 5_393, 5_440];
      for (const zone of zones) {
        await sql`
          INSERT INTO road_to_goal_zone_question_calibrations (
            version_id, question_id, zone, difficulty, expected_accuracy_bp, source
          ) VALUES (
            ${calibration.id}, ${question.id}, ${zone}, ${difficulty},
            ${priors[zone - 1]}, 'difficulty_prior'
          )
          ON CONFLICT DO NOTHING
        `;
      }
    }

    // Keep this proof independent from whatever published pool happens to be
    // present in the shared test database. Existing questions are marked seen
    // only for this throwaway user, leaving the global pool untouched.
    const [historyRound] = await sql<{ id: string }[]>`
      INSERT INTO road_to_goal_rounds (
        user_id, status, phase, stake_coins, cleared_zones, run_questions,
        client_nonce, settled_at, settlement_reason
      ) VALUES (
        ${userId}, 'lost', 'settled', 10, 0,
        (SELECT jsonb_agg('{}'::jsonb) FROM generate_series(1, 11)),
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', now(), 'test_history'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO road_to_goal_question_exposures (
        user_id, question_id, exposure_count, last_round_id
      )
      SELECT ${userId}, q.id, 1, ${historyRound.id}
      FROM questions q
      JOIN categories category ON category.id = q.category_id AND category.is_active = true
      WHERE q.status = 'published'
        AND q.type = 'mcq_single'
        AND q.ranked_eligible = true
        AND q.visibility = 'public'
        AND q.id <> ALL(${questionIds}::uuid[])
    `;

    const candidates = await sql.begin(async (tx) => {
      const selected = await roadToGoalRepo.pickRunQuestionCandidates(tx, userId!, 'unseen');
      return roadToGoalRepo.filterCandidatesForCalibration(tx, calibration.id, selected);
    });
    expect(
      candidates
        .filter((candidate) => questionIds.includes(candidate.id))
        .map((candidate) => candidate.difficulty)
        .sort()
    ).toEqual([...difficulties].sort());

    const [leftCommitment, rightCommitment] = await Promise.all([
      roadToGoalService.prepareCommitment(userId, {
        stakeCoins: 25,
        requestNonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        autoCashoutZone: null,
      }),
      roadToGoalService.prepareCommitment(userId, {
        stakeCoins: 25,
        requestNonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        autoCashoutZone: null,
      }),
    ]);
    expect(leftCommitment.commitment_id).toBe(rightCommitment.commitment_id);

    const [left, right] = await Promise.all([
      roadToGoalService.startRound(userId, {
        commitmentId: leftCommitment.commitment_id,
        clientNonce: NONCE,
        clientSeed: 'concurrency-proof',
      }),
      roadToGoalService.startRound(userId, {
        commitmentId: rightCommitment.commitment_id,
        clientNonce: NONCE,
        clientSeed: 'concurrency-proof',
      }),
    ]);

    expect(left.round_id).toBe(right.round_id);
    const [wallet] = await sql<{ coins: number }[]>`
      SELECT coins FROM users WHERE id = ${userId}
    `;
    expect(wallet.coins).toBe(75);
    const [counts] = await sql<{
      rounds: number;
      stakes: number;
      exposures: number;
    }[]>`
      SELECT
        (
          SELECT count(*)::integer
          FROM road_to_goal_rounds
          WHERE user_id = ${userId} AND client_nonce = ${NONCE}
        ) AS rounds,
        (
          SELECT count(*)::integer
          FROM store_transaction_logs
          WHERE user_id = ${userId} AND event_type = 'road_to_goal_stake'
        ) AS stakes,
        (
          SELECT count(*)::integer
          FROM road_to_goal_question_exposures
          WHERE user_id = ${userId} AND last_round_id = ${left.round_id}
        ) AS exposures
    `;
    expect(counts).toEqual({ rounds: 1, stakes: 1, exposures: 1 });

    await sql`
      UPDATE road_to_goal_rounds
      SET question_deadline_at = clock_timestamp() - interval '1 second'
      WHERE id = ${left.round_id}
    `;
    await Promise.all([
      roadToGoalService.sweepStaleRounds(),
      roadToGoalService.sweepStaleRounds(),
    ]);
    const [timeoutCount] = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM road_to_goal_events
      WHERE round_id = ${left.round_id} AND event_type = 'timeout'
    `;
    expect(timeoutCount.count).toBe(1);
  });
});
