/**
 * Integration test: listCategoryIdsWithMinPlainMcqCount must count exactly
 * what the runtime plain-MCQ picker can serve for a penalty shootout —
 * valid-payload plain MCQs in an active category, excluding image MCQs,
 * malformed payloads, and questions already used by the match.
 *
 * Requires a running test database (DATABASE_URL in setup.ts). Skipped if the
 * database is not available.
 *
 *   npm run docker:start
 *   npx vitest run tests/lobbies/penalty-depth-pool.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let lobbiesRepo: typeof import('../../src/modules/lobbies/lobbies.repo.js').lobbiesRepo;

let dbAvailable = false;
let categoryId = '';
let matchId = '';
let usedQuestionId = '';

const VALID_PLAIN_COUNT = 12;

function validMcqPayload(seed: number) {
  return {
    options: [
      { id: `${seed}-a`, text: { en: 'A' }, is_correct: true },
      { id: `${seed}-b`, text: { en: 'B' }, is_correct: false },
      { id: `${seed}-c`, text: { en: 'C' }, is_correct: false },
      { id: `${seed}-d`, text: { en: 'D' }, is_correct: false },
    ],
  };
}

async function seedMcq(payload: unknown, prompt: string): Promise<string> {
  const [question] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    VALUES (${categoryId}, 'mcq_single', 'medium', 'published', ${{ en: prompt }}::jsonb)
    RETURNING id
  `;
  await sql`
    INSERT INTO question_payloads (question_id, payload)
    VALUES (${question.id}, ${payload as never}::jsonb)
  `;
  return question.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    lobbiesRepo = (await import('../../src/modules/lobbies/lobbies.repo.js')).lobbiesRepo;
  } catch {
    console.warn('\n⚠️  Skipping penalty-depth integration test: database not available.\n');
    return;
  }

  const [category] = await sql<{ id: string }[]>`
    INSERT INTO categories (name, slug, is_active)
    VALUES (${{ en: 'PenaltyDepthTest' }}::jsonb, ${`penalty-depth-test-${Date.now()}`}, true)
    RETURNING id
  `;
  categoryId = category.id;

  for (let i = 0; i < VALID_PLAIN_COUNT; i += 1) {
    const id = await seedMcq(validMcqPayload(i), `PenaltyDepth Q${i}`);
    if (i === 0) usedQuestionId = id;
  }
  // Unservable for penalties: an image MCQ, a malformed payload, and an
  // MCQ excluded from ranked — none may count toward shootout depth.
  await seedMcq({ ...validMcqPayload(100), image: { url: 'https://example.com/x.webp' } }, 'PenaltyDepth image');
  await seedMcq({ options: ['a', 'b', 'c', 'd'], correctIndex: 0 }, 'PenaltyDepth malformed');
  const nonRankedId = await seedMcq(validMcqPayload(101), 'PenaltyDepth non-ranked');
  await sql`UPDATE questions SET ranked_eligible = false WHERE id = ${nonRankedId}`;

  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status) VALUES ('ranked', 'active') RETURNING id
  `;
  matchId = match.id;
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (matchId) await sql`DELETE FROM matches WHERE id = ${matchId}`;
  if (categoryId) {
    await sql`DELETE FROM questions WHERE category_id = ${categoryId}`;
    await sql`DELETE FROM categories WHERE id = ${categoryId}`;
  }
  await sql.end({ timeout: 5 });
});

describe('listCategoryIdsWithMinPlainMcqCount (DB)', () => {
  it('counts only valid, non-image, ranked-eligible plain MCQs', async ({ skip }) => {
    if (!dbAvailable) skip();
    await expect(
      lobbiesRepo.listCategoryIdsWithMinPlainMcqCount([categoryId], VALID_PLAIN_COUNT, matchId)
    ).resolves.toEqual([categoryId]);
    // The image, malformed, and non-ranked MCQs must not push it past 12.
    await expect(
      lobbiesRepo.listCategoryIdsWithMinPlainMcqCount([categoryId], VALID_PLAIN_COUNT + 1, matchId)
    ).resolves.toEqual([]);
  });

  it('subtracts questions already used by the match', async ({ skip }) => {
    if (!dbAvailable) skip();
    await sql`
      INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index, phase_kind)
      VALUES (${matchId}, 0, ${usedQuestionId}, ${categoryId}, 0, 'normal')
    `;
    await expect(
      lobbiesRepo.listCategoryIdsWithMinPlainMcqCount([categoryId], VALID_PLAIN_COUNT, matchId)
    ).resolves.toEqual([]);
    await expect(
      lobbiesRepo.listCategoryIdsWithMinPlainMcqCount([categoryId], VALID_PLAIN_COUNT - 1, matchId)
    ).resolves.toEqual([categoryId]);
  });

  it('excludes inactive categories', async ({ skip }) => {
    if (!dbAvailable) skip();
    await sql`UPDATE categories SET is_active = false WHERE id = ${categoryId}`;
    await expect(
      lobbiesRepo.listCategoryIdsWithMinPlainMcqCount([categoryId], 1, matchId)
    ).resolves.toEqual([]);
    await sql`UPDATE categories SET is_active = true WHERE id = ${categoryId}`;
  });
});
