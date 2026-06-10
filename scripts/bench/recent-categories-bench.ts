/**
 * Benchmark: recent-category queries + featured ranked pool query.
 *
 * Measures, against a REAL Postgres (default: the native regression DB):
 *   1. userRecentCategoriesRepo.listRecentCategoriesForUsers (draft-start hot path)
 *   2. userRecentCategoriesRepo.recordPlayedCategoryForUsers (upsert + cap-trim)
 *   3. lobbiesRepo.listAllRankedEligibleCategories (featured-join pool query —
 *      cached in-process for 5 min in prod, so it runs ~1/instance/5min)
 *
 * Seeds a synthetic, namespaced dataset at ~staging scale first (idempotent):
 *   - 40 featured "bench" categories, each ranked-eligible
 *   - ~4,800 published questions with JSONB payloads
 *   - 20,000 bench users x 10 recents = 200,000 user_recent_categories rows
 *
 * Run (uses the repo's REAL repo code, not copied SQL):
 *   BENCH_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
 *     npx tsx scripts/bench/recent-categories-bench.ts
 *
 * Flags: --skip-seed   reuse existing seed
 *        --cleanup     delete the bench dataset and exit
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? 'local';
process.env.PORT = process.env.PORT ?? '8000';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://localhost:3000';
process.env.DATABASE_URL = process.env.BENCH_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression';
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://bench.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'bench-anon-key';

const BENCH_CATEGORY_COUNT = 40;
const BENCH_QUESTIONS_PER_CATEGORY = 120; // ~4.8k published questions ≈ staging scale
const BENCH_USER_COUNT = 20_000;
const BENCH_RECENTS_PER_USER = 10; // = RECENT_CATEGORY_LIMIT
const BENCH_NS = 'bench-recent-cats';

async function main(): Promise<void> {
  const { sql } = await import('../../src/db/index.js');
  const { userRecentCategoriesRepo, RANKED_RECENT_CATEGORY_MODE } = await import(
    '../../src/modules/user-recent-categories/user-recent-categories.repo.js'
  );
  const { lobbiesRepo } = await import('../../src/modules/lobbies/lobbies.repo.js');

  const args = new Set(process.argv.slice(2));

  if (args.has('--cleanup')) {
    console.log('Cleaning up bench dataset…');
    await sql`DELETE FROM users WHERE email LIKE ${BENCH_NS + '+%'}`; // cascades recents
    // questions.category_id is ON DELETE RESTRICT — remove children first.
    await sql`DELETE FROM question_payloads WHERE question_id IN (
      SELECT q.id FROM questions q JOIN categories c ON c.id = q.category_id
      WHERE c.slug LIKE ${BENCH_NS + '-%'}
    )`;
    await sql`DELETE FROM questions WHERE category_id IN (
      SELECT id FROM categories WHERE slug LIKE ${BENCH_NS + '-%'}
    )`;
    await sql`DELETE FROM categories WHERE slug LIKE ${BENCH_NS + '-%'}`; // cascades featured/recents
    await sql.end();
    console.log('Done.');
    return;
  }

  if (!args.has('--skip-seed')) {
    await seed(sql);
  }

  const categoryIds = (
    await sql<{ id: string }[]>`SELECT id FROM categories WHERE slug LIKE ${BENCH_NS + '-%'} ORDER BY slug`
  ).map((r) => r.id);
  const userIds = (
    await sql<{ id: string }[]>`SELECT id FROM users WHERE email LIKE ${BENCH_NS + '+%'} ORDER BY email LIMIT ${BENCH_USER_COUNT}`
  ).map((r) => r.id);
  if (categoryIds.length === 0 || userIds.length === 0) {
    throw new Error('Bench dataset missing — run without --skip-seed first');
  }
  console.log(`Dataset: ${categoryIds.length} categories, ${userIds.length} users`);
  const recentRowCount = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM user_recent_categories`;
  console.log(`user_recent_categories rows: ${recentRowCount[0]?.n}`);

  const pickUser = () => userIds[Math.floor(Math.random() * userIds.length)]!;
  const pickCategory = () => categoryIds[Math.floor(Math.random() * categoryIds.length)]!;

  // ── 1. Recents fetch (draft start hot path: 2 users) ──
  await bench('listRecentCategoriesForUsers (2 users)', 500, async () => {
    await userRecentCategoriesRepo.listRecentCategoriesForUsers(
      [pickUser(), pickUser()],
      RANKED_RECENT_CATEGORY_MODE
    );
  });

  // ── 2. Record played (upsert + trim, 2 users — once per finalized category) ──
  await bench('recordPlayedCategoryForUsers (2 users)', 500, async () => {
    await userRecentCategoriesRepo.recordPlayedCategoryForUsers({
      userIds: [pickUser(), pickUser()],
      categoryId: pickCategory(),
      mode: RANKED_RECENT_CATEGORY_MODE,
    });
  });

  // ── 3. Featured ranked pool query (cached 5 min in-process in prod) ──
  await bench('listAllRankedEligibleCategories (featured join)', 50, async () => {
    await lobbiesRepo.listAllRankedEligibleCategories();
  });

  // ── EXPLAIN ANALYZE: prove index usage ──
  const [u1, u2] = [pickUser(), pickUser()];
  await explain(sql, 'recents fetch', `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT user_id, category_id, played_at
    FROM user_recent_categories
    WHERE user_id = ANY('{${u1},${u2}}'::uuid[]) AND mode = 'ranked'
    ORDER BY played_at DESC
  `);
  await explain(sql, 'overflow trim', `
    EXPLAIN (ANALYZE, BUFFERS)
    DELETE FROM user_recent_categories
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY played_at DESC, id DESC) AS rn
        FROM user_recent_categories
        WHERE user_id = ANY('{${u1},${u2}}'::uuid[]) AND mode = 'ranked'
      ) ranked
      WHERE rn > 10
    )
  `);
  await explain(sql, 'featured ranked pool', `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT c.id, c.name, c.icon, c.image_url
    FROM categories c
    JOIN featured_categories fc ON fc.category_id = c.id
    JOIN questions q ON q.category_id = c.id
    WHERE c.is_active = true
      AND q.status = 'published'
      AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')
    GROUP BY c.id, c.name, c.icon, c.image_url
    HAVING COUNT(*) FILTER (WHERE q.type = 'mcq_single') >= 4
      AND COUNT(*) FILTER (WHERE q.type = 'put_in_order') >= 1
      AND COUNT(*) FILTER (WHERE q.type = 'clue_chain') >= 1
  `);

  await sql.end();
}

async function bench(label: string, iterations: number, fn: () => Promise<unknown>): Promise<void> {
  // Warmup
  for (let i = 0; i < 10; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]!;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `\n${label} — ${iterations} iters\n` +
    `  avg ${avg.toFixed(2)}ms | p50 ${pct(50).toFixed(2)}ms | p95 ${pct(95).toFixed(2)}ms | ` +
    `p99 ${pct(99).toFixed(2)}ms | max ${samples[samples.length - 1]!.toFixed(2)}ms`
  );
}

async function explain(
  sql: (typeof import('../../src/db/index.js'))['sql'],
  label: string,
  query: string
): Promise<void> {
  const rows = await sql.unsafe<Array<Record<string, string>>>(query);
  console.log(`\nEXPLAIN — ${label}`);
  for (const row of rows) console.log(`  ${Object.values(row)[0]}`);
}

async function seed(sql: (typeof import('../../src/db/index.js'))['sql']): Promise<void> {
  const existing = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM categories WHERE slug LIKE ${BENCH_NS + '-%'}
  `;
  if (Number(existing[0]?.n ?? 0) >= BENCH_CATEGORY_COUNT) {
    console.log('Seed already present — skipping (use --cleanup to reset).');
    return;
  }

  console.log('Seeding categories + featured…');
  await sql.unsafe(`
    WITH cats AS (
      INSERT INTO categories (slug, name, is_active)
      SELECT '${BENCH_NS}-' || i, jsonb_build_object('en', 'Bench WC ' || i), true
      FROM generate_series(1, ${BENCH_CATEGORY_COUNT}) i
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    )
    INSERT INTO featured_categories (category_id)
    SELECT id FROM cats
    ON CONFLICT (category_id) DO NOTHING
  `);

  console.log(`Seeding ~${BENCH_CATEGORY_COUNT * BENCH_QUESTIONS_PER_CATEGORY} questions + payloads…`);
  await sql.unsafe(`
    WITH cats AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY slug) AS cn
      FROM categories WHERE slug LIKE '${BENCH_NS}-%'
    ),
    q AS (
      INSERT INTO questions (category_id, type, status, difficulty, prompt)
      SELECT
        cats.id,
        CASE WHEN i <= ${BENCH_QUESTIONS_PER_CATEGORY - 4} THEN 'mcq_single'
             WHEN i <= ${BENCH_QUESTIONS_PER_CATEGORY - 2} THEN 'put_in_order'
             ELSE 'clue_chain' END,
        'published',
        (ARRAY['easy','medium','hard'])[1 + (i % 3)],
        jsonb_build_object('en', 'Bench question ' || cats.cn || '-' || i)
      FROM cats CROSS JOIN generate_series(1, ${BENCH_QUESTIONS_PER_CATEGORY}) i
      RETURNING id, type
    )
    INSERT INTO question_payloads (question_id, payload)
    SELECT id,
      CASE type
        WHEN 'mcq_single' THEN jsonb_build_object(
          'type', 'mcq_single',
          'options', jsonb_build_array(
            jsonb_build_object('id', 'a', 'text', jsonb_build_object('en', 'A'), 'is_correct', true),
            jsonb_build_object('id', 'b', 'text', jsonb_build_object('en', 'B'), 'is_correct', false),
            jsonb_build_object('id', 'c', 'text', jsonb_build_object('en', 'C'), 'is_correct', false),
            jsonb_build_object('id', 'd', 'text', jsonb_build_object('en', 'D'), 'is_correct', false)
          )
        )
        WHEN 'put_in_order' THEN jsonb_build_object('type', 'put_in_order', 'items', '[]'::jsonb)
        ELSE jsonb_build_object('type', 'clue_chain', 'clues', '[]'::jsonb)
      END
    FROM q
  `);

  console.log(`Seeding ${BENCH_USER_COUNT} users…`);
  await sql.unsafe(`
    INSERT INTO users (email, nickname)
    SELECT '${BENCH_NS}+u' || i || '@bench.local', 'bench_u' || i
    FROM generate_series(1, ${BENCH_USER_COUNT}) i
  `);

  console.log(`Seeding ${BENCH_USER_COUNT * BENCH_RECENTS_PER_USER} user_recent_categories rows…`);
  await sql.unsafe(`
    INSERT INTO user_recent_categories (user_id, category_id, mode, played_at)
    SELECT u.id, c.id, 'ranked', NOW() - (r || ' minutes')::interval
    FROM (SELECT id, ROW_NUMBER() OVER () AS un FROM users WHERE email LIKE '${BENCH_NS}+%') u
    CROSS JOIN generate_series(1, ${BENCH_RECENTS_PER_USER}) r
    JOIN LATERAL (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY slug) AS cn
        FROM categories WHERE slug LIKE '${BENCH_NS}-%'
      ) cc WHERE cc.cn = 1 + ((u.un + r) % ${BENCH_CATEGORY_COUNT})
    ) c ON true
    ON CONFLICT ON CONSTRAINT user_recent_categories_user_mode_category_key DO NOTHING
  `);
  await sql.unsafe('ANALYZE user_recent_categories, questions, categories, featured_categories, users');
  console.log('Seed complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
