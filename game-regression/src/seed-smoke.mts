/**
 * Smoke test: seed fixtures into the local DB via the engine's own sql client,
 * then confirm the engine's REAL ranked-eligibility query accepts them.
 *
 * MUST run with DATABASE_URL pointing at the LOCAL DB (the engine's sql client
 * reads config.DATABASE_URL at import time):
 *   cd backend-node && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
 *     npx tsx ../game-regression/src/seed-smoke.mts
 */
import { sql } from '../../src/db/index.js';
import { config } from '../../src/core/config.js';
import { RANKED_ELIGIBILITY_HAVING } from '../../src/db/sql-fragments.js';
import { seedFixtures, seedTestUserWithTicket } from './fixtures.mjs';

async function main() {
  const dbUrl = config.DATABASE_URL ?? '';
  if (!dbUrl.includes('127.0.0.1') && !dbUrl.includes('localhost')) {
    throw new Error(`Refusing to seed a non-local DB: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);
  }

  console.log('Seeding fixtures into local DB…');
  const seeded = await seedFixtures({ categoryCount: 3, mcqPerCategory: 5 });
  console.log(`  seeded ${seeded.categoryIds.length} categories`);

  const userId = '00000000-0000-0000-0000-0000000000b0';
  await seedTestUserWithTicket({ userId, nickname: 'RegressionBot', tickets: 1 });
  console.log(`  seeded test user ${userId} with 1 ticket`);

  // The proof: the engine's own ranked-eligibility query must return our categories.
  const eligible = await sql<{ id: string }[]>`
    SELECT c.id
    FROM categories c
    JOIN questions q ON q.category_id = c.id
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE c.is_active = true
      AND q.status = 'published'
      AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')
    GROUP BY c.id
    ${RANKED_ELIGIBILITY_HAVING}
  `;
  const eligibleSeeded = eligible.filter((r) => seeded.categoryIds.includes(r.id));
  console.log(`  ranked-eligible (of ours): ${eligibleSeeded.length}/${seeded.categoryIds.length}`);
  if (eligibleSeeded.length < 2) {
    throw new Error('FAIL: fewer than 2 seeded categories are ranked-eligible — fixtures are malformed.');
  }
  console.log('✅ Fixtures are valid: the engine accepts them as ranked-eligible.');

  const [u] = await sql<{ tickets: number }[]>`SELECT tickets FROM users WHERE id = ${userId}`;
  console.log(`  test user tickets: ${u?.tickets}`);
  if (!u || u.tickets < 1) throw new Error('FAIL: test user has no ticket.');
  console.log('✅ Test user has a ranked ticket.');
}

main()
  .then(async () => { await sql.end(); process.exit(0); })
  .catch(async (err) => { console.error('SMOKE FAILED:', err.message); await sql.end().catch(() => {}); process.exit(1); });
