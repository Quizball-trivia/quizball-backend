import { afterAll, describe, expect, it, vi } from 'vitest';

// Opt-in local PostgreSQL test. Fixtures are connection-local temporary tables.
const { databaseUrl } = vi.hoisted(() => ({ databaseUrl: process.env.ELIGIBILITY_TEST_DATABASE_URL }));
vi.mock('../../src/db/index.js', async () => {
  const { default: postgres } = await import('postgres');
  return { sql: postgres(databaseUrl ?? 'postgresql://localhost/postgres', { max: 1 }) };
});
import { sql } from '../../src/db/index.js';
import { RANKED_ELIGIBILITY_HAVING_COUNTS } from '../../src/db/sql-fragments.js';

describe.skipIf(!databaseUrl)('ranked category usable MCQ depth', () => {
  afterAll(async () => { await sql.end(); });

  const payload = { options: ['a', 'b', 'c', 'd'].map((id, index) => ({
    id, text: { en: id }, is_correct: index === 0,
  })) };

  it.each([
    { name: 'four valid MCQs plus specials', count: 4, invalidLast: false, seoLast: false, expected: 0 },
    { name: 'five valid MCQs plus specials', count: 5, invalidLast: false, seoLast: false, expected: 1 },
    { name: 'four valid MCQs and one malformed MCQ', count: 5, invalidLast: true, seoLast: false, expected: 0 },
    { name: 'four gameplay MCQs and one SEO MCQ', count: 5, invalidLast: false, seoLast: true, expected: 0 },
  ])('$name', async ({ count, invalidLast, seoLast, expected }) => {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE questions (id integer, category_id integer, type text, status text, visibility text, ranked_eligible boolean) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE question_payloads (question_id integer, payload jsonb) ON COMMIT DROP`;
      for (let id = 1; id <= count; id++) {
        await tx`INSERT INTO questions VALUES (${id}, 1, 'mcq_single', 'published', 'public', ${!(seoLast && id === count)})`;
        await tx`INSERT INTO question_payloads VALUES (${id}, ${tx.json(invalidLast && id === count ? { options: [] } : payload)})`;
      }
      await tx`INSERT INTO questions VALUES (100,1,'put_in_order','published','public',true),(101,1,'clue_chain','published','public',true)`;
      const eligible = await tx`
        SELECT q.category_id FROM questions q
        WHERE q.status='published' AND q.visibility='public' AND q.ranked_eligible=true
        GROUP BY q.category_id ${RANKED_ELIGIBILITY_HAVING_COUNTS}
      `;
      expect(eligible).toHaveLength(expected);
    });
  });
});
