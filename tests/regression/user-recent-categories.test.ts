/**
 * Real-DB integration: user_recent_categories repo — verifies the actual SQL
 * (upsert dedupe, newest-first ordering, cap-10 trim) against local Postgres.
 *
 * Requires the local NATIVE stack (see match-boot.test.ts) and the
 * 20260610150000_user_recent_categories.sql migration applied. Skipped unless
 * REGRESSION_DB_URL points at a local host.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://regression.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'regression-anon-key';
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://localhost:3000';
  process.env.PORT = process.env.PORT ?? '8000';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

const NS = 'regression-recent-cats';

describeLocal('regression: user_recent_categories repo', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  let repo: (typeof import('../../src/modules/user-recent-categories/user-recent-categories.repo.js'))['userRecentCategoriesRepo'];
  let userIds: string[];
  let categoryIds: string[];

  async function setup() {
    ({ sql } = await import('../../src/db/index.js'));
    ({ userRecentCategoriesRepo: repo } = await import(
      '../../src/modules/user-recent-categories/user-recent-categories.repo.js'
    ));

    const users = await sql<{ id: string }[]>`
      INSERT INTO users (email, nickname)
      SELECT ${NS} || '+u' || i || '@test.local', ${NS} || '-u' || i
      FROM generate_series(1, 2) i
      RETURNING id
    `;
    userIds = users.map((row) => row.id);

    const categories = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name, is_active)
      SELECT ${NS} || '-c' || i, jsonb_build_object('en', 'Cat ' || i), true
      FROM generate_series(1, 15) i
      RETURNING id
    `;
    categoryIds = categories.map((row) => row.id);
  }

  async function cleanup() {
    if (!sql) return;
    await sql`DELETE FROM users WHERE email LIKE ${NS + '+%'}`;
    await sql`DELETE FROM categories WHERE slug LIKE ${NS + '-%'}`;
  }

  beforeEach(async () => {
    // Idempotent: wipe any leftovers from a previous (possibly crashed) run
    // before seeding fresh fixtures.
    ({ sql } = await import('../../src/db/index.js'));
    await cleanup();
    await setup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('records, dedupes (bump to newest) and caps at 10 per user', async () => {
    const [userA, userB] = userIds as [string, string];

    // Play 12 distinct categories for user A — only the newest 10 survive.
    for (let i = 0; i < 12; i++) {
      await repo.recordPlayedCategoryForUsers({
        userIds: [userA],
        categoryId: categoryIds[i]!,
        mode: 'ranked',
      });
    }
    let rows = await repo.listRecentCategoriesForUsers([userA], 'ranked');
    expect(rows).toHaveLength(10);
    const ids = rows.map((row) => row.category_id);
    expect(ids).not.toContain(categoryIds[0]); // oldest trimmed
    expect(ids).not.toContain(categoryIds[1]);
    expect(ids[0]).toBe(categoryIds[11]); // newest first

    // Replay an existing category — bumps to newest, no duplicate row.
    await repo.recordPlayedCategoryForUsers({
      userIds: [userA],
      categoryId: categoryIds[5]!,
      mode: 'ranked',
    });
    rows = await repo.listRecentCategoriesForUsers([userA], 'ranked');
    expect(rows).toHaveLength(10);
    expect(rows[0]!.category_id).toBe(categoryIds[5]);
    expect(rows.filter((row) => row.category_id === categoryIds[5]).length).toBe(1);

    // Both users in one call (the match-finalized path) — B gets its own row.
    await repo.recordPlayedCategoryForUsers({
      userIds: [userA, userB],
      categoryId: categoryIds[14]!,
      mode: 'ranked',
    });
    const both = await repo.listRecentCategoriesForUsers([userA, userB], 'ranked');
    expect(both.filter((row) => row.user_id === userB)).toHaveLength(1);
    expect(both.filter((row) => row.user_id === userA)).toHaveLength(10);

    // Mode isolation: nothing recorded under a different mode.
    expect(await repo.listRecentCategoriesForUsers([userA, userB], 'other-event')).toHaveLength(0);
  });

  it('is fast: recents fetch + record stay low-millisecond (indexed)', async () => {
    const [userA, userB] = userIds as [string, string];
    for (let i = 0; i < 10; i++) {
      await repo.recordPlayedCategoryForUsers({
        userIds: [userA, userB],
        categoryId: categoryIds[i]!,
        mode: 'ranked',
      });
    }

    const time = async (fn: () => Promise<unknown>, iters: number) => {
      const samples: number[] = [];
      for (let i = 0; i < iters; i++) {
        const start = process.hrtime.bigint();
        await fn();
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)]!; // p50
    };

    const fetchP50 = await time(
      () => repo.listRecentCategoriesForUsers([userA, userB], 'ranked'),
      50
    );
    const recordP50 = await time(
      () => repo.recordPlayedCategoryForUsers({
        userIds: [userA, userB],
        categoryId: categoryIds[Math.floor(Math.random() * 10)]!,
        mode: 'ranked',
      }),
      50
    );

    // Generous CI-safe ceilings — locally these run at ~0.2-0.5ms (see
    // scripts/bench/recent-categories-bench.ts for the 200k-row numbers).
    expect(fetchP50).toBeLessThan(20);
    expect(recordP50).toBeLessThan(30);
  });
});
