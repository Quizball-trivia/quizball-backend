/**
 * Integration tests for the direct transactional burn-in writer.
 *
 * writeFixtureInTx(tx, fixture) writes one fixture's COMPLETE row-set (match +
 * match_players + settlement ledger/profile + stats + XP + achievements) inside
 * a caller-provided transaction, driving no live multi-tx services.
 *
 * Proven:
 *   - all rows land, BACKDATED; bots earn ZERO coins; XP + achievements accrue
 *   - the settlement matches the PRODUCTION path (parity vs settleCompletedRankedMatch)
 *   - CRASH ATOMICITY: a throw inside the tx commits NOTHING
 *
 * Run: npm run docker:start && npx vitest run tests/bot-burnin/writer.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import type { PlannedFixture } from '../../scripts/bot-burnin/types.js';
import { fixtureContentDigest, fixtureMatchIdFromDigest } from '../../scripts/bot-burnin/manifest.js';

const MANIFEST = 'test-manifest-writer';

let sql: typeof import('../../src/db/index.js').sql;
let writeFixtureInTx: typeof import('../../scripts/bot-burnin/writer.js').writeFixtureInTx;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];
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
    VALUES (${u.id}, 0.1, 6, 12345, ${sql.json({ activeHours: [], sessionMax: 4, intraSessionGapMin: 20 })})
  `;
  return u.id;
}

let ordinalCounter = 0;
function makeFixture(opts: {
  a: string; b: string; winner: string; startedAt: Date; endedAt: Date; isPlacement: boolean;
  scoreA?: PlannedFixture['scoreA']; scoreB?: PlannedFixture['scoreB']; decision?: 'goals' | 'penalty_goals';
}): PlannedFixture {
  const scoreA = opts.scoreA ?? { goals: 3, penaltyGoals: 0, totalPoints: 900, correctAnswers: 8 };
  const scoreB = opts.scoreB ?? { goals: 1, penaltyGoals: 0, totalPoints: 400, correctAnswers: 4 };
  const decision = opts.decision ?? 'goals';
  const key = fixtureContentDigest(MANIFEST, {
    botAUserId: opts.a, botBUserId: opts.b, startedAt: opts.startedAt, endedAt: opts.endedAt,
    winnerUserId: opts.winner, decision, scoreA, scoreB,
  });
  const matchId = fixtureMatchIdFromDigest(key);
  testMatchIds.push(matchId);
  return {
    key, matchId, ordinal: ordinalCounter++, botAUserId: opts.a, botBUserId: opts.b,
    startedAt: opts.startedAt, endedAt: opts.endedAt, winnerUserId: opts.winner, decision,
    isPlacementContext: opts.isPlacement, scoreA, scoreB, categoryAId: categoryId, categoryBId: categoryId,
    projectedRpA: 0, projectedRpB: 0,
  };
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    ({ writeFixtureInTx } = await import('../../scripts/bot-burnin/writer.js'));
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    categoryId = cat?.id
      ?? (await sql<{ id: string }[]>`INSERT INTO categories (slug, name, is_active) VALUES (${`burnin_w_${Date.now()}`}, 'W', true) RETURNING id`)[0].id;
  } catch {
    console.warn('\n⚠️  Skipping burn-in writer tests: DB unavailable. Run `npm run docker:start`.\n');
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
    await sql`DELETE FROM user_achievements WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('writeFixtureInTx — direct transactional write', () => {
  it('lands match+players+stats+ledger+XP+achievements backdated; bots earn zero coins', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`w_a_${Date.now()}`);
    const b = await seedBot(`w_b_${Date.now()}`);
    const startedAt = new Date('2026-07-22T10:00:00Z');
    const endedAt = new Date('2026-07-22T10:05:00Z');
    // A wins by 2 goals (3-1) — production formula: +50 base + 15 margin = +65.
    const fixture = makeFixture({ a, b, winner: a, startedAt, endedAt, isPlacement: true });

    await sql.begin(async (tx) => { await writeFixtureInTx(tx, fixture); });

    const [match] = await sql<{ status: string; is_dev: boolean; started_at: string; ended_at: string; winner_user_id: string; ranked_context: { burnIn?: boolean; fixtureKey?: string } }[]>`
      SELECT status, is_dev, started_at, ended_at, winner_user_id, ranked_context FROM matches WHERE id = ${fixture.matchId}
    `;
    expect(match.status).toBe('completed');
    expect(match.is_dev).toBe(false);
    expect(match.ranked_context.burnIn).toBe(true);
    expect(match.ranked_context.fixtureKey).toBe(fixture.key);
    expect(new Date(match.started_at).toISOString()).toBe(startedAt.toISOString());
    expect(new Date(match.ended_at).toISOString()).toBe(endedAt.toISOString());
    expect(match.winner_user_id).toBe(a);

    const [winnerLedger] = await sql<{ result: string; delta_rp: number; coins_awarded: number; created_at: string; calculation_method: string; placement_game_no: number | null }[]>`
      SELECT result, delta_rp, coins_awarded, created_at, calculation_method, placement_game_no
      FROM ranked_rp_changes WHERE match_id = ${fixture.matchId} AND user_id = ${a}
    `;
    expect(winnerLedger.result).toBe('win');
    expect(winnerLedger.delta_rp).toBe(65);
    expect(winnerLedger.coins_awarded).toBe(0);
    expect(winnerLedger.calculation_method).toBe('placement_seed'); // placement game
    expect(winnerLedger.placement_game_no).toBe(1);
    expect(new Date(winnerLedger.created_at).toISOString()).toBe(endedAt.toISOString());

    const [winnerProfile] = await sql<{ rp: number; placement_status: string; placement_played: number; last_ranked_match_at: string }[]>`
      SELECT rp, placement_status, placement_played, last_ranked_match_at FROM ranked_profiles WHERE user_id = ${a}
    `;
    expect(winnerProfile.rp).toBe(515);
    expect(winnerProfile.placement_status).toBe('in_progress');
    expect(winnerProfile.placement_played).toBe(1);
    expect(new Date(winnerProfile.last_ranked_match_at).toISOString()).toBe(endedAt.toISOString());

    const [winStats] = await sql<{ wins: number; losses: number }[]>`
      SELECT wins, losses FROM user_mode_match_stats WHERE user_id = ${a} AND mode = 'ranked'
    `;
    expect(winStats.wins).toBe(1);
    expect(winStats.losses).toBe(0);

    const [xp] = await sql<{ count: number; created_at: string | null }[]>`
      SELECT COUNT(*)::int AS count, MIN(created_at) AS created_at FROM user_xp_events WHERE source_key = ${fixture.matchId}
    `;
    expect(xp.count).toBe(2);
    expect(new Date(xp.created_at!).toISOString()).toBe(endedAt.toISOString());

    // debut_match unlocks on the first completed match, backdated + bot-sourced.
    const debut = await sql<{ unlocked_at: string | null; source_match_id: string | null }[]>`
      SELECT unlocked_at, source_match_id FROM user_achievements WHERE user_id = ${a} AND achievement_id = 'debut_match'
    `;
    expect(debut.length).toBe(1);
    expect(debut[0].unlocked_at).not.toBeNull();
    expect(new Date(debut[0].unlocked_at!).toISOString()).toBe(endedAt.toISOString());
    expect(debut[0].source_match_id).toBe(fixture.matchId);

    const [aUser] = await sql<{ coins: number; total_xp: number }[]>`SELECT coins, total_xp FROM users WHERE id = ${a}`;
    expect(aUser.coins).toBe(0);
    expect(Number(aUser.total_xp)).toBeGreaterThan(0);
  });

  it('CRASH ATOMICITY: a throw inside the tx commits NOTHING (finding: not resumable)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`w_atomic_a_${Date.now()}`);
    const b = await seedBot(`w_atomic_b_${Date.now()}`);
    const fixture = makeFixture({
      a, b, winner: a,
      startedAt: new Date('2026-07-22T12:00:00Z'), endedAt: new Date('2026-07-22T12:05:00Z'),
      isPlacement: false,
    });

    await expect(
      sql.begin(async (tx) => {
        await writeFixtureInTx(tx, fixture);
        // Simulate a mid-run crash AFTER this fixture's writes.
        throw new Error('simulated crash');
      })
    ).rejects.toThrow(/simulated crash/);

    // NOTHING committed: no match, no ledger, no xp, no stats, profile pristine.
    expect(await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${fixture.matchId}`).toEqual([]);
    expect(await sql<{ match_id: string }[]>`SELECT match_id FROM ranked_rp_changes WHERE match_id = ${fixture.matchId}`).toEqual([]);
    expect(await sql<{ user_id: string }[]>`SELECT user_id FROM user_xp_events WHERE source_key = ${fixture.matchId}`).toEqual([]);
    expect(await sql<{ user_id: string }[]>`SELECT user_id FROM user_mode_match_stats WHERE user_id = ${a} AND mode = 'ranked'`).toEqual([]);
    const [pa] = await sql<{ rp: number; total_xp: number }[]>`SELECT rp, (SELECT total_xp FROM users WHERE id = ${a}) AS total_xp FROM ranked_profiles WHERE user_id = ${a}`;
    expect(pa.rp).toBe(450);
    expect(Number(pa.total_xp)).toBe(0);
  });

  it('PARITY: direct settlement equals the production settleCompletedRankedMatch', async ({ skip }) => {
    if (!dbAvailable) skip();
    const { rankedService } = await import('../../src/modules/ranked/ranked.service.js');
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    // Direct-write path: bot X beats bot Y by 2 in a placement game.
    const dx = await seedBot(`w_par_dx_${Date.now()}`);
    const dy = await seedBot(`w_par_dy_${Date.now()}`);
    const fixture = makeFixture({
      a: dx, b: dy, winner: dx,
      startedAt: new Date('2026-07-25T10:00:00Z'), endedAt: new Date('2026-07-25T10:05:00Z'),
      isPlacement: true, scoreA: { goals: 3, penaltyGoals: 0, totalPoints: 900, correctAnswers: 8 },
      scoreB: { goals: 1, penaltyGoals: 0, totalPoints: 400, correctAnswers: 4 },
    });
    await sql.begin(async (tx) => { await writeFixtureInTx(tx, fixture); });

    // Production path: seed an equivalent active match + drive completeMatch + settle.
    const px = await seedBot(`w_par_px_${Date.now()}`);
    const py = await seedBot(`w_par_py_${Date.now()}`);
    const [pm] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, current_q_index, total_questions, state_payload, ranked_context, started_at)
      VALUES ('ranked', 'active', 12, 12, ${sql.json({ winnerDecisionMethod: 'goals' })}, ${sql.json({ isPlacement: true })}, NOW())
      RETURNING id
    `;
    testMatchIds.push(pm.id);
    await sql`
      INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
      VALUES (${pm.id}, ${px}, 1, 900, 8, 3, 0), (${pm.id}, ${py}, 2, 400, 4, 1, 0)
    `;
    await matchesService.completeMatch(pm.id, px);
    await rankedService.settleCompletedRankedMatch(pm.id);

    // Compare the ledger + profile fields for the winners (and losers).
    const cols = `result, delta_rp, new_rp, old_rp, is_placement, placement_game_no, placement_anchor_rp, calculation_method, coins_awarded`;
    const [dLedgerX] = await sql`SELECT ${sql.unsafe(cols)} FROM ranked_rp_changes WHERE match_id = ${fixture.matchId} AND user_id = ${dx}`;
    const [pLedgerX] = await sql`SELECT ${sql.unsafe(cols)} FROM ranked_rp_changes WHERE match_id = ${pm.id} AND user_id = ${px}`;
    expect(dLedgerX).toEqual(pLedgerX);
    const [dLedgerY] = await sql`SELECT ${sql.unsafe(cols)} FROM ranked_rp_changes WHERE match_id = ${fixture.matchId} AND user_id = ${dy}`;
    const [pLedgerY] = await sql`SELECT ${sql.unsafe(cols)} FROM ranked_rp_changes WHERE match_id = ${pm.id} AND user_id = ${py}`;
    expect(dLedgerY).toEqual(pLedgerY);

    const profCols = `rp, tier, placement_status, placement_played, placement_wins, placement_seed_rp, current_win_streak`;
    const [dProfX] = await sql`SELECT ${sql.unsafe(profCols)} FROM ranked_profiles WHERE user_id = ${dx}`;
    const [pProfX] = await sql`SELECT ${sql.unsafe(profCols)} FROM ranked_profiles WHERE user_id = ${px}`;
    expect(dProfX).toEqual(pProfX);
  });
});
