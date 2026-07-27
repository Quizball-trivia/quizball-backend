/**
 * Sol's note: the backdate seams bind NULL through COALESCE($n, NOW()) when the
 * optional timestamp is omitted, rather than a literal NOW(). This test proves
 * the OMITTED case is behaviorally indistinguishable from the pre-seam live path
 * across the three settlement write paths — the inserted rows carry a fresh
 * NOW()-ish timestamp (bounded by the test's wall clock), exactly as before.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/ranked/occurredat-seam.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
let rankedService: typeof import('../../src/modules/ranked/ranked.service.js').rankedService;
let progressionService: typeof import('../../src/modules/progression/progression.service.js').progressionService;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];

async function seedUser(nickname: string, isAi: boolean): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
    VALUES (${nickname}, ${isAi}, ${isAi ? 'persistent' : null}, false, 0, true)
    RETURNING id
  `;
  testUserIds.push(u.id);
  return u.id;
}

async function seedActiveMatch(a: string, b: string): Promise<string> {
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, current_q_index, total_questions, state_payload, ranked_context, started_at)
    VALUES ('ranked', 'active', 12, 12, ${sql.json({ winnerDecisionMethod: 'goals' })}, ${sql.json({ isPlacement: false })}, NOW())
    RETURNING id
  `;
  testMatchIds.push(m.id);
  await sql`
    INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    VALUES (${m.id}, ${a}, 1, 900, 6, 2, 0), (${m.id}, ${b}, 2, 400, 3, 0, 0)
  `;
  return m.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    matchesService = (await import('../../src/modules/matches/matches.service.js')).matchesService;
    rankedService = (await import('../../src/modules/ranked/ranked.service.js')).rankedService;
    progressionService = (await import('../../src/modules/progression/progression.service.js')).progressionService;
  } catch {
    console.warn('\n⚠️  Skipping occurredAt-seam integration tests: DB unavailable.\n');
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${testMatchIds}::uuid[])`;
    await sql`DELETE FROM user_xp_events WHERE source_key = ANY(${testMatchIds})`;
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('omitted occurredAt is indistinguishable from literal NOW()', () => {
  it('completeMatch/settle/XP stamp a fresh NOW()-bounded timestamp when omitted', async ({ skip }) => {
    if (!dbAvailable) skip();

    const a = await seedUser(`seam_a_${Date.now()}`, false);
    const b = await seedUser(`seam_b_${Date.now()}`, false);
    const matchId = await seedActiveMatch(a, b);

    const before = new Date();
    // Live-path calls: NO occurredAt argument.
    await matchesService.completeMatch(matchId, a);
    await rankedService.settleCompletedRankedMatch(matchId);
    await progressionService.awardCompletedMatchXp(matchId);
    const after = new Date();

    // matches.ended_at ∈ [before, after].
    const [match] = await sql<{ ended_at: string }[]>`SELECT ended_at FROM matches WHERE id = ${matchId}`;
    const endedAt = new Date(match.ended_at).getTime();
    expect(endedAt).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(endedAt).toBeLessThanOrEqual(after.getTime() + 1000);

    // ranked_rp_changes.created_at + ranked_profiles.last_ranked_match_at ∈ window.
    const [ledger] = await sql<{ created_at: string }[]>`
      SELECT created_at FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${a}
    `;
    const ledgerAt = new Date(ledger.created_at).getTime();
    expect(ledgerAt).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(ledgerAt).toBeLessThanOrEqual(after.getTime() + 1000);

    const [profile] = await sql<{ last_ranked_match_at: string }[]>`
      SELECT last_ranked_match_at FROM ranked_profiles WHERE user_id = ${a}
    `;
    const profileAt = new Date(profile.last_ranked_match_at).getTime();
    expect(profileAt).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(profileAt).toBeLessThanOrEqual(after.getTime() + 1000);

    // user_xp_events.created_at ∈ window.
    const [xp] = await sql<{ created_at: string }[]>`
      SELECT created_at FROM user_xp_events WHERE source_key = ${matchId} AND user_id = ${a}
    `;
    const xpAt = new Date(xp.created_at).getTime();
    expect(xpAt).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(xpAt).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});
