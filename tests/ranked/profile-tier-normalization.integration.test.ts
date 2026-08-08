import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

const integrationDatabaseUrl = process.env.RANKED_PROFILE_INTEGRATION_DB_URL;
if (integrationDatabaseUrl) {
  process.env.DATABASE_URL = integrationDatabaseUrl;
}

let sql: typeof import('../../src/db/index.js').sql;
let rankedService: typeof import('../../src/modules/ranked/ranked.service.js').rankedService;
let dbAvailable = false;
let testUserId: string | null = null;

beforeAll(async () => {
  if (!integrationDatabaseUrl) return;
  // The URL was explicitly configured: a broken environment must fail the
  // suite, not silently green-skip it.
  sql = (await import('../../src/db/index.js')).sql;
  await sql`SELECT 1`;
  rankedService = (await import('../../src/modules/ranked/ranked.service.js')).rankedService;
  dbAvailable = true;
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testUserId) {
    await sql`DELETE FROM users WHERE id = ${testUserId}`;
  }
  await sql.end();
});

describe('ranked profile tier normalization', () => {
  it('repairs a stale tier without a synthetic match or timestamp mutation', async ({ skip }) => {
    if (!dbAvailable) skip();

    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
      VALUES (${`tier_repair_${Date.now()}`}, false, false, 0, true)
      RETURNING id
    `;
    testUserId = user.id;

    const [seeded] = await sql<{ updated_at: string }[]>`
      INSERT INTO ranked_profiles (
        user_id,
        rp,
        tier,
        placement_status,
        placement_required,
        placement_played,
        placement_wins,
        current_win_streak
      )
      VALUES (${user.id}, 4035, 'Key Player', 'placed', 3, 3, 0, 0)
      RETURNING updated_at
    `;

    const profile = await rankedService.ensureProfile(user.id);

    expect(profile.rp).toBe(4035);
    expect(profile.tier).toBe('Captain');

    const [stored] = await sql<{ rp: number; tier: string; updated_at: string }[]>`
      SELECT rp, tier, updated_at
      FROM ranked_profiles
      WHERE user_id = ${user.id}
    `;
    expect(stored).toEqual({
      rp: 4035,
      tier: 'Captain',
      updated_at: seeded.updated_at,
    });

    const [ledger] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM ranked_rp_changes
      WHERE user_id = ${user.id}
    `;
    expect(ledger.count).toBe(0);
  });
});
