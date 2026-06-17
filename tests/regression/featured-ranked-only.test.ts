/**
 * Featured categories are reserved for RANKED only (commit fbd4f03). Ranked
 * draws exclusively from featured_categories; the casual/friendly pool draws
 * exclusively from NON-featured categories. We pin the split against the real
 * DB so casual players can't pre-play the ranked category pool.
 *
 *   - a FEATURED category appears in listAllRankedEligibleCategories() and is
 *     ABSENT from listAllValidCategories() (casual pool).
 *   - a NON-featured category is the mirror image.
 *
 * Local-only: REGRESSION_DB_URL must point at the native regression DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;
const NS = 'regression-featuredsplit';

describeLocal('regression: featured categories reserved for ranked (real DB)', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  let repo: (typeof import('../../src/modules/lobbies/lobbies.repo.js'))['lobbiesRepo'];
  let featuredId: string;
  let casualId: string;

  beforeAll(async () => {
    ({ sql } = await import('../../src/db/index.js'));
    ({ lobbiesRepo: repo } = await import('../../src/modules/lobbies/lobbies.repo.js'));

    await sql`DELETE FROM featured_categories WHERE category_id IN (SELECT id FROM categories WHERE slug LIKE ${NS + '%'})`;
    await sql`DELETE FROM questions WHERE category_id IN (SELECT id FROM categories WHERE slug LIKE ${NS + '%'})`;
    await sql`DELETE FROM categories WHERE slug LIKE ${NS + '%'}`;

    const cats = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name, is_active)
      VALUES
        (${NS} || '-featured', jsonb_build_object('en', 'Featured Cat'), true),
        (${NS} || '-casual',   jsonb_build_object('en', 'Casual Cat'),   true)
      RETURNING id`;
    [featuredId, casualId] = cats.map((r) => r.id);

    // Ranked eligibility (RANKED_ELIGIBILITY_HAVING_COUNTS) needs >=4 mcq_single
    // AND >=1 put_in_order AND >=1 clue_chain. Seed that full spread in both
    // categories so the split (not eligibility) is what each test measures.
    for (const cid of [featuredId, casualId]) {
      await sql`
        INSERT INTO questions (category_id, type, difficulty, status, prompt)
        SELECT ${cid}, 'mcq_single', 'easy', 'published', jsonb_build_object('en', 'q' || i)
        FROM generate_series(1, 6) i`;
      await sql`
        INSERT INTO questions (category_id, type, difficulty, status, prompt)
        VALUES
          (${cid}, 'put_in_order', 'easy', 'published', jsonb_build_object('en', 'order')),
          (${cid}, 'clue_chain',   'easy', 'published', jsonb_build_object('en', 'clue'))`;
    }

    // Mark ONLY the first as featured.
    await sql`INSERT INTO featured_categories (category_id) VALUES (${featuredId})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM featured_categories WHERE category_id IN (${featuredId}, ${casualId})`;
    await sql`DELETE FROM questions WHERE category_id IN (${featuredId}, ${casualId})`;
    await sql`DELETE FROM categories WHERE id IN (${featuredId}, ${casualId})`;
  });

  it('a featured category is ranked-eligible and ABSENT from the casual pool', async () => {
    const ranked = (await repo.listAllRankedEligibleCategories()).map((c) => c.id);
    const casual = (await repo.listAllValidCategories(1)).map((c) => c.id);

    expect(ranked, 'featured category must be in the ranked pool').toContain(featuredId);
    expect(casual, 'featured category must NOT leak into the casual pool').not.toContain(featuredId);
  });

  it('a non-featured category is in the casual pool and ABSENT from ranked', async () => {
    const ranked = (await repo.listAllRankedEligibleCategories()).map((c) => c.id);
    const casual = (await repo.listAllValidCategories(1)).map((c) => c.id);

    expect(casual, 'non-featured category must be in the casual pool').toContain(casualId);
    expect(ranked, 'non-featured category must NOT be ranked-eligible').not.toContain(casualId);
  });
});
