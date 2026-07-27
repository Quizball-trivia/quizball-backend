/**
 * Pristine-gate + crash-boundary (resume) integration tests.
 *
 *   - findNonPristineBots flags a bot with a ranked game / ledger / live match,
 *     and passes a freshly created (pristine) bot.
 *   - crash boundary: a fixture whose PLANNED receipt line was written but whose
 *     DB write did not complete (or completed partially) is reconciled on
 *     resume — re-running writeFixture with the SAME fixture completes it once,
 *     with no duplicate ledger/xp rows.
 *   - claimBurnInMarker is a one-time atomic guard: a second claim throws.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bot-burnin/gate-resume.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import type { PlannedFixture } from '../../scripts/bot-burnin/types.js';
import { fixtureContentDigest, fixtureMatchIdFromDigest } from '../../scripts/bot-burnin/manifest.js';

const MANIFEST = 'test-manifest-gate-resume';

let sql: typeof import('../../src/db/index.js').sql;
let findNonPristineBots: typeof import('../../scripts/bot-burnin/data.js').findNonPristineBots;
let claimBurnInMarker: typeof import('../../scripts/bot-burnin/data.js').claimBurnInMarker;
let writeFixture: typeof import('../../scripts/bot-burnin/writer.js').writeFixture;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];
const markerHashes: string[] = [];
let categoryId: string;

async function seedBot(nickname: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
    VALUES (${nickname}, true, 'persistent', false, 0, true) RETURNING id
  `;
  testUserIds.push(u.id);
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played, placement_wins, placement_seed_rp, placement_perf_sum, placement_points_for_sum, placement_points_against_sum, current_win_streak)
    VALUES (${u.id}, 450, 'Youth Prospect', 'unplaced', 3, 0, 0, NULL, 0, 0, 0, 0)
  `;
  await sql`
    INSERT INTO synthetic_player_profiles (user_id, base_skill, daily_cap, personality_seed, schedule)
    VALUES (${u.id}, 0.1, 6, 999, ${sql.json({ activeHours: [], sessionMax: 4, intraSessionGapMin: 20 })})
  `;
  return u.id;
}

function makeFixture(a: string, b: string, winner: string, startedAt: Date, endedAt: Date): PlannedFixture {
  const scoreA = { goals: 2, penaltyGoals: 0, totalPoints: 700, correctAnswers: 6 };
  const scoreB = { goals: 0, penaltyGoals: 0, totalPoints: 300, correctAnswers: 3 };
  const key = fixtureContentDigest(MANIFEST, { botAUserId: a, botBUserId: b, startedAt, endedAt, winnerUserId: winner, decision: 'goals', scoreA, scoreB });
  const matchId = fixtureMatchIdFromDigest(key);
  testMatchIds.push(matchId);
  return { key, matchId, ordinal: 0, botAUserId: a, botBUserId: b, startedAt, endedAt, winnerUserId: winner, decision: 'goals', isPlacementContext: false, scoreA, scoreB, categoryAId: categoryId, categoryBId: categoryId };
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    ({ findNonPristineBots, claimBurnInMarker } = await import('../../scripts/bot-burnin/data.js'));
    ({ writeFixture } = await import('../../scripts/bot-burnin/writer.js'));
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    categoryId = cat?.id ?? (await sql<{ id: string }[]>`INSERT INTO categories (slug, name, is_active) VALUES (${`gr_${Date.now()}`}, 'GR', true) RETURNING id`)[0].id;
  } catch {
    console.warn('\n⚠️  Skipping gate/resume integration tests: DB unavailable.\n');
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (markerHashes.length > 0) {
    await sql`DELETE FROM bot_model_params WHERE note = 'persistent-bot-burnin:complete' AND params->>'manifestHash' = ANY(${markerHashes})`;
  }
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${testMatchIds}::uuid[])`;
    await sql`DELETE FROM user_xp_events WHERE source_key = ANY(${testMatchIds})`;
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM user_achievements WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('pristine gate', () => {
  it('passes a freshly created bot and flags a dirtied one', async ({ skip }) => {
    if (!dbAvailable) skip();
    const clean = await seedBot(`gr_clean_${Date.now()}`);
    const dirty = await seedBot(`gr_dirty_${Date.now()}`);

    // A fresh roster is pristine.
    expect(await findNonPristineBots([clean, dirty])).toEqual([]);

    // Dirty one bot: give it a completed ranked game + ledger row via a real
    // burn-in write (RP moves to 515, games=1, ledger=1).
    const fixture = makeFixture(dirty, clean, dirty, new Date('2026-07-22T10:00:00Z'), new Date('2026-07-22T10:05:00Z'));
    await writeFixture(fixture, 100_000);

    const violations = await findNonPristineBots([clean, dirty]);
    const dirtyV = violations.find((v) => v.userId === dirty);
    expect(dirtyV).toBeDefined();
    // Its reasons include a non-450 RP and non-zero games/ledger.
    expect(dirtyV!.reasons.some((r) => r.startsWith('rp=') || r.startsWith('ranked_games=') || r.startsWith('ranked_ledger='))).toBe(true);
  });
});

describe('crash-boundary resume', () => {
  it('reconciles a fixture whose match row exists but was not settled (partial write)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`gr_res_a_${Date.now()}`);
    const b = await seedBot(`gr_res_b_${Date.now()}`);
    const fixture = makeFixture(a, b, a, new Date('2026-07-23T10:00:00Z'), new Date('2026-07-23T10:05:00Z'));

    // Simulate a crash AFTER the match+players insert but BEFORE settlement:
    // insert the active match rows directly (the writer's first tx), leaving no
    // ledger/xp. This is the exact state a kill between the PLANNED receipt line
    // and the settlement calls would leave.
    await sql`
      INSERT INTO matches (id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, state_payload, ranked_context, is_dev, started_at)
      VALUES (${fixture.matchId}, 'ranked', 'active', ${categoryId}, ${categoryId}, 12, 12, ${sql.json({ winnerDecisionMethod: 'goals' })}, ${sql.json({ isPlacement: false, burnIn: true, fixtureKey: fixture.key })}, false, ${fixture.startedAt})
    `;
    await sql`
      INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
      VALUES (${fixture.matchId}, ${a}, 1, ${fixture.scoreA.totalPoints}, ${fixture.scoreA.correctAnswers}, ${fixture.scoreA.goals}, ${fixture.scoreA.penaltyGoals}),
             (${fixture.matchId}, ${b}, 2, ${fixture.scoreB.totalPoints}, ${fixture.scoreB.correctAnswers}, ${fixture.scoreB.goals}, ${fixture.scoreB.penaltyGoals})
    `;

    // Resume: writeFixture verifies the existing row matches, then settles it.
    const res = await writeFixture(fixture, 100_000);
    expect(res.created).toBe(false); // row already present

    // Settlement completed exactly once.
    const [match] = await sql<{ status: string }[]>`SELECT status FROM matches WHERE id = ${fixture.matchId}`;
    expect(match.status).toBe('completed');
    const [ledgerCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM ranked_rp_changes WHERE match_id = ${fixture.matchId}`;
    expect(ledgerCount.count).toBe(2);
    const [xpCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM user_xp_events WHERE source_key = ${fixture.matchId}`;
    expect(xpCount.count).toBe(2);

    // Re-running again is still idempotent (no duplicates).
    await writeFixture(fixture, 100_000);
    const [ledgerCount2] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM ranked_rp_changes WHERE match_id = ${fixture.matchId}`;
    expect(ledgerCount2.count).toBe(2);
  });
});

describe('one-time marker', () => {
  it('claimBurnInMarker is atomic: a second claim for the env throws', async ({ skip }) => {
    if (!dbAvailable) skip();
    // The marker guard is note-based (global). Clear any leftover so the first
    // claim in THIS test succeeds; the second claim then proves the guard.
    await sql`DELETE FROM bot_model_params WHERE note = 'persistent-bot-burnin:complete'`;
    const hash = `gr-marker-${Date.now()}`;
    markerHashes.push(hash);
    await claimBurnInMarker(hash, 1, 10);
    await expect(claimBurnInMarker(`${hash}-other`, 2, 20)).rejects.toThrow(/already/i);
  });
});
