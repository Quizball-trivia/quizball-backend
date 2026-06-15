/**
 * Integration test: featured categories are RANKED-EXCLUSIVE. The friendly/party
 * and daily-challenge pools must draw ONLY from NON-featured categories — a
 * featured category never appears in those casual modes (it's reserved for
 * ranked). Seeds one featured + one non-featured category, each with enough
 * published mcq_single questions, and asserts every casual selector returns the
 * non-featured one and excludes the featured one.
 *
 * Requires a running test database (DATABASE_URL in setup.ts). Skipped if the
 * database is not available.
 *
 *   npm run docker:start
 *   npx vitest run tests/lobbies/featured-only-pool.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let lobbiesRepo: typeof import('../../src/modules/lobbies/lobbies.repo.js').lobbiesRepo;
let dailyChallengesRepo: typeof import('../../src/modules/daily-challenges/daily-challenges.repo.js').dailyChallengesRepo;

let dbAvailable = false;
let featuredCategoryId = '';
let plainCategoryId = '';

const DIFFICULTIES = ['easy', 'medium', 'hard', 'easy', 'medium', 'hard'] as const;

async function seedCategoryWithQuestions(name: string): Promise<string> {
  const [category] = await sql<{ id: string }[]>`
    INSERT INTO categories (name, is_active)
    VALUES (${{ en: name }}::jsonb, true)
    RETURNING id
  `;
  const categoryId = category.id;
  // 6 published mcq_single questions spanning easy/medium/hard (covers both the
  // min-count >= 5 friendly filter and the daily-challenge difficulty coverage).
  for (let i = 0; i < DIFFICULTIES.length; i += 1) {
    const [question] = await sql<{ id: string }[]>`
      INSERT INTO questions (category_id, type, difficulty, status, prompt)
      VALUES (
        ${categoryId},
        'mcq_single',
        ${DIFFICULTIES[i]},
        'published',
        ${{ en: `${name} Q${i}` }}::jsonb
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO question_payloads (question_id, payload)
      VALUES (${question.id}, ${{ options: ['a', 'b', 'c', 'd'], correctIndex: 0 }}::jsonb)
    `;
  }
  return categoryId;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    lobbiesRepo = (await import('../../src/modules/lobbies/lobbies.repo.js')).lobbiesRepo;
    dailyChallengesRepo = (await import('../../src/modules/daily-challenges/daily-challenges.repo.js')).dailyChallengesRepo;
  } catch {
    console.warn('\n⚠️  Skipping featured-pool integration test: database not available.\n');
    return;
  }

  featuredCategoryId = await seedCategoryWithQuestions('FeaturedPoolTest');
  plainCategoryId = await seedCategoryWithQuestions('NonFeaturedPoolTest');

  // Only the first category is featured → it must be EXCLUDED from casual pools.
  await sql`
    INSERT INTO featured_categories (category_id, sort_order)
    VALUES (${featuredCategoryId}, 999)
  `;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await sql`DELETE FROM featured_categories WHERE category_id IN (${featuredCategoryId}, ${plainCategoryId})`;
  // question_payloads cascade on questions delete; questions block category delete (ON DELETE RESTRICT)
  await sql`DELETE FROM questions WHERE category_id IN (${featuredCategoryId}, ${plainCategoryId})`;
  await sql`DELETE FROM categories WHERE id IN (${featuredCategoryId}, ${plainCategoryId})`;
  await sql.end({ timeout: 5 });
});

describe('friendly/party category pool excludes featured (ranked-exclusive)', () => {
  it('listAllValidCategories returns the non-featured category, not the featured one', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await lobbiesRepo.listAllValidCategories(5);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(plainCategoryId);
    expect(ids).not.toContain(featuredCategoryId);
  });

  it('selectRandomActiveCategories never surfaces a featured category', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await lobbiesRepo.selectRandomActiveCategories(5, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(plainCategoryId);
    expect(ids).not.toContain(featuredCategoryId);
  });

  it('selectRandomActiveCategoriesExcluding stays within the non-featured pool', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await lobbiesRepo.selectRandomActiveCategoriesExcluding(5, 50, []);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(plainCategoryId);
    expect(ids).not.toContain(featuredCategoryId);
  });

  it('listValidCategoryIds rejects a featured id even when it has enough questions', async ({ skip }) => {
    if (!dbAvailable) skip();
    const validated = await lobbiesRepo.listValidCategoryIds([featuredCategoryId, plainCategoryId], 5);
    expect(validated).toContain(plainCategoryId);
    expect(validated).not.toContain(featuredCategoryId);
  });
});

describe('daily-challenge question pool excludes featured (ranked-exclusive)', () => {
  it('listAvailableCategoriesByQuestionType excludes featured categories', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await dailyChallengesRepo.listAvailableCategoriesByQuestionType('mcq_single', {
      requireDifficultyCoverage: true,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(plainCategoryId);
    expect(ids).not.toContain(featuredCategoryId);
  });

  it('listPublishedQuestionsByTypeAndCategories yields nothing for a featured category', async ({ skip }) => {
    if (!dbAvailable) skip();
    const onlyFeatured = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories(
      'mcq_single',
      [featuredCategoryId]
    );
    expect(onlyFeatured).toHaveLength(0);

    const onlyPlain = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories(
      'mcq_single',
      [plainCategoryId]
    );
    expect(onlyPlain.length).toBeGreaterThan(0);
  });

  it('countPublishedQuestionsByTypeAndCategories counts zero for a featured category', async ({ skip }) => {
    if (!dbAvailable) skip();
    const featuredCount = await dailyChallengesRepo.countPublishedQuestionsByTypeAndCategories(
      'mcq_single',
      [featuredCategoryId]
    );
    expect(featuredCount).toBe(0);

    const plainCount = await dailyChallengesRepo.countPublishedQuestionsByTypeAndCategories(
      'mcq_single',
      [plainCategoryId]
    );
    expect(plainCount).toBeGreaterThan(0);
  });
});
