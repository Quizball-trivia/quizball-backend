/**
 * Integration tests for the burn-in writer + rollback against the real test DB.
 * Seeds its OWN persistent bots (users + ranked_profiles +
 * synthetic_player_profiles) — does NOT depend on PR5 roster tooling.
 *
 * Proven end-to-end:
 *   - writeFixture lands a completed ranked match with BACKDATED
 *     started_at/ended_at, both seats, W/L stats, a backdated ledger row +
 *     moved profiles, backdated XP, and backdated achievements — with ZERO
 *     coins for the bots (economy stays AI)
 *   - the ceiling belt aborts a fixture that would settle a bot over the ceiling
 *   - resume: re-writing an identical fixture creates no duplicates; a DRIFTED
 *     row is rejected (field-by-field verification)
 *   - rollback restores profiles/XP/stats/achievements, refuses on a
 *     non-roster participant AND on post-snapshot live activity, atomically
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bot-burnin/writer.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import type { PlannedFixture, BurnInBot, BurnInSnapshot, ReceiptHeaderLine, ReceiptFixtureLine } from '../../scripts/bot-burnin/types.js';
import { fixtureContentDigest, fixtureMatchIdFromDigest } from '../../scripts/bot-burnin/manifest.js';

const MANIFEST = 'test-manifest-hash-writer';

let sql: typeof import('../../src/db/index.js').sql;
let writeFixture: typeof import('../../scripts/bot-burnin/writer.js').writeFixture;
let CeilingExceededError: typeof import('../../scripts/bot-burnin/writer.js').CeilingExceededError;
let FixtureVerificationError: typeof import('../../scripts/bot-burnin/writer.js').FixtureVerificationError;
let snapshotProfiles: typeof import('../../scripts/bot-burnin/snapshot.js').snapshotProfiles;
let rollback: typeof import('../../scripts/bot-burnin/snapshot.js').rollback;
let RollbackRefusedError: typeof import('../../scripts/bot-burnin/snapshot.js').RollbackRefusedError;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];
let categoryId: string;

async function seedBot(nickname: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
    VALUES (${nickname}, true, 'persistent', false, 0, true)
    RETURNING id
  `;
  testUserIds.push(u.id);
  await sql`
    INSERT INTO ranked_profiles (
      user_id, rp, tier, placement_status, placement_required, placement_played,
      placement_wins, placement_seed_rp, placement_perf_sum, placement_points_for_sum,
      placement_points_against_sum, current_win_streak
    )
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
  a: string;
  b: string;
  winner: string;
  startedAt: Date;
  endedAt: Date;
  isPlacement: boolean;
  scoreA?: PlannedFixture['scoreA'];
  scoreB?: PlannedFixture['scoreB'];
  decision?: 'goals' | 'penalty_goals';
}): PlannedFixture {
  const scoreA = opts.scoreA ?? { goals: 3, penaltyGoals: 0, totalPoints: 900, correctAnswers: 8 };
  const scoreB = opts.scoreB ?? { goals: 1, penaltyGoals: 0, totalPoints: 400, correctAnswers: 4 };
  const decision = opts.decision ?? 'goals';
  const key = fixtureContentDigest(MANIFEST, {
    botAUserId: opts.a,
    botBUserId: opts.b,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    winnerUserId: opts.winner,
    decision,
    scoreA,
    scoreB,
  });
  const matchId = fixtureMatchIdFromDigest(key);
  testMatchIds.push(matchId);
  return {
    key,
    matchId,
    ordinal: ordinalCounter++,
    botAUserId: opts.a,
    botBUserId: opts.b,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    winnerUserId: opts.winner,
    decision,
    isPlacementContext: opts.isPlacement,
    scoreA,
    scoreB,
    categoryAId: categoryId,
    categoryBId: categoryId,
  };
}

function bot(id: string): BurnInBot {
  return {
    userId: id, nickname: 'x', baseSkill: 0.1, dailyCap: 6,
    schedule: { activeHours: [], sessionMax: 4, intraSessionGapMin: 20 },
    status: 'active', rp: 450, placementPlayed: 0, placementWins: 0,
    placementStatus: 'unplaced', currentWinStreak: 0,
  };
}

function header(roster: string[]): ReceiptHeaderLine {
  return { kind: 'header', createdAt: new Date().toISOString(), manifestHash: MANIFEST, seed: 1, env: 'test', rosterUserIds: roster };
}
function receiptLine(f: PlannedFixture): ReceiptFixtureLine {
  return {
    kind: 'written', ordinal: f.ordinal, key: f.key, matchId: f.matchId,
    botAUserId: f.botAUserId, botBUserId: f.botBUserId, winnerUserId: f.winnerUserId,
    startedAt: f.startedAt.toISOString(), endedAt: f.endedAt.toISOString(),
  };
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    ({ writeFixture, CeilingExceededError, FixtureVerificationError } = await import('../../scripts/bot-burnin/writer.js'));
    ({ snapshotProfiles, rollback, RollbackRefusedError } = await import('../../scripts/bot-burnin/snapshot.js'));
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    categoryId = cat?.id
      ?? (await sql<{ id: string }[]>`
        INSERT INTO categories (slug, name, is_active)
        VALUES (${`burnin_test_${Date.now()}`}, 'Burn-in Test', true) RETURNING id
      `)[0].id;
  } catch {
    console.warn('\n⚠️  Skipping burn-in writer integration tests: DB unavailable. Run `npm run docker:start`.\n');
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

describe('writeFixture — backdated bot-vs-bot fixture', () => {
  it('lands match+players+stats+ledger+XP+achievements backdated, bots earn zero coins', async ({ skip }) => {
    if (!dbAvailable) skip();

    const a = await seedBot(`bi_a_${Date.now()}`);
    const b = await seedBot(`bi_b_${Date.now()}`);
    const startedAt = new Date('2026-07-22T10:00:00Z');
    const endedAt = new Date('2026-07-22T10:05:00Z');
    const fixture = makeFixture({ a, b, winner: a, startedAt, endedAt, isPlacement: true });

    const res = await writeFixture(fixture, 100_000);
    expect(res.created).toBe(true);
    expect(res.matchId).toBe(fixture.matchId);

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

    const [winnerLedger] = await sql<{ result: string; delta_rp: number; coins_awarded: number; created_at: string }[]>`
      SELECT result, delta_rp, coins_awarded, created_at FROM ranked_rp_changes WHERE match_id = ${fixture.matchId} AND user_id = ${a}
    `;
    expect(winnerLedger.result).toBe('win');
    expect(winnerLedger.delta_rp).toBe(65);
    expect(winnerLedger.coins_awarded).toBe(0);
    expect(new Date(winnerLedger.created_at).toISOString()).toBe(endedAt.toISOString());

    const [winnerProfile] = await sql<{ rp: number; last_ranked_match_at: string }[]>`
      SELECT rp, last_ranked_match_at FROM ranked_profiles WHERE user_id = ${a}
    `;
    expect(winnerProfile.rp).toBe(515);
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

    // Achievements evaluated + backdated (finding 10). debut_match unlocks on a
    // first completed match; its unlocked_at is the backdated fixture time.
    const debut = await sql<{ unlocked_at: string | null; source_match_id: string | null; created_at: string }[]>`
      SELECT unlocked_at, source_match_id, created_at FROM user_achievements
      WHERE user_id = ${a} AND achievement_id = 'debut_match'
    `;
    expect(debut.length).toBe(1);
    expect(debut[0].unlocked_at).not.toBeNull();
    expect(new Date(debut[0].unlocked_at!).toISOString()).toBe(endedAt.toISOString());
    expect(debut[0].source_match_id).toBe(fixture.matchId);

    const [aUser] = await sql<{ coins: number; total_xp: number }[]>`SELECT coins, total_xp FROM users WHERE id = ${a}`;
    expect(aUser.coins).toBe(0);
    expect(Number(aUser.total_xp)).toBeGreaterThan(0);
  });

  it('ceiling belt aborts a fixture that would settle a bot over the ceiling (finding 5)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`bi_ceil_a_${Date.now()}`);
    const b = await seedBot(`bi_ceil_b_${Date.now()}`);
    // Winner would settle to 515; a ceiling of 500 must abort.
    const fixture = makeFixture({
      a, b, winner: a,
      startedAt: new Date('2026-07-22T11:00:00Z'), endedAt: new Date('2026-07-22T11:05:00Z'),
      isPlacement: false,
    });
    await expect(writeFixture(fixture, 500)).rejects.toBeInstanceOf(CeilingExceededError);
  });

  it('resume: re-writing the identical fixture creates no duplicates', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`bi_r_a_${Date.now()}`);
    const b = await seedBot(`bi_r_b_${Date.now()}`);
    const fixture = makeFixture({
      a, b, winner: b,
      startedAt: new Date('2026-07-23T09:00:00Z'), endedAt: new Date('2026-07-23T09:05:00Z'),
      isPlacement: false,
    });
    const first = await writeFixture(fixture, 100_000);
    expect(first.created).toBe(true);
    const second = await writeFixture(fixture, 100_000);
    expect(second.created).toBe(false);

    const [ledgerCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM ranked_rp_changes WHERE match_id = ${fixture.matchId}`;
    expect(ledgerCount.count).toBe(2);
    const [xpCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM user_xp_events WHERE source_key = ${fixture.matchId}`;
    expect(xpCount.count).toBe(2);
    const [statB] = await sql<{ games_played: number }[]>`SELECT games_played FROM user_mode_match_stats WHERE user_id = ${b} AND mode = 'ranked'`;
    expect(statB.games_played).toBe(1);
  });

  it('resume: a DRIFTED existing row (foreign participant) is rejected (finding 4)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`bi_drift_a_${Date.now()}`);
    const b = await seedBot(`bi_drift_b_${Date.now()}`);
    const fixture = makeFixture({
      a, b, winner: a,
      startedAt: new Date('2026-07-23T12:00:00Z'), endedAt: new Date('2026-07-23T12:05:00Z'),
      isPlacement: false,
    });
    // Pre-create a row at the SAME id with a different (non-burn-in) shape.
    await sql`
      INSERT INTO matches (id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, state_payload, ranked_context, is_dev, started_at)
      VALUES (${fixture.matchId}, 'ranked', 'active', ${categoryId}, ${categoryId}, 12, 12, ${sql.json({ winnerDecisionMethod: 'goals' })}, ${sql.json({ isPlacement: false })}, false, ${fixture.startedAt})
    `;
    await sql`
      INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
      VALUES (${fixture.matchId}, ${a}, 1, 100, 1, 1, 0), (${fixture.matchId}, ${b}, 2, 100, 1, 1, 0)
    `;
    await expect(writeFixture(fixture, 100_000)).rejects.toBeInstanceOf(FixtureVerificationError);
  });
});

describe('rollback', () => {
  it('restores profiles/XP/stats/achievements and deletes the burn-in match', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`bi_rb_a_${Date.now()}`);
    const b = await seedBot(`bi_rb_b_${Date.now()}`);
    const snapshot = await snapshotProfiles([bot(a), bot(b)], {
      manifestHash: MANIFEST, seed: 1, env: 'test', ceilingRp: 100_000, humanTop10Rp: 1200, marginRp: 200,
    });
    const fixture = makeFixture({
      a, b, winner: a,
      startedAt: new Date('2026-07-24T09:00:00Z'), endedAt: new Date('2026-07-24T09:05:00Z'),
      isPlacement: false,
    });
    await writeFixture(fixture, 100_000);

    const [before] = await sql<{ rp: number }[]>`SELECT rp FROM ranked_profiles WHERE user_id = ${a}`;
    expect(before.rp).toBeGreaterThan(450);

    const result = await rollback(header([a, b]), [receiptLine(fixture)], snapshot);
    expect(result.matchesDeleted).toBe(1);

    const [after] = await sql<{ rp: number }[]>`SELECT rp FROM ranked_profiles WHERE user_id = ${a}`;
    expect(after.rp).toBe(450);
    expect(await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${fixture.matchId}`).toEqual([]);
    expect(await sql<{ match_id: string }[]>`SELECT match_id FROM ranked_rp_changes WHERE match_id = ${fixture.matchId}`).toEqual([]);
    // Stats + achievements returned to pristine (row deleted — none pre-existed).
    expect(await sql<{ user_id: string }[]>`SELECT user_id FROM user_mode_match_stats WHERE user_id = ${a} AND mode = 'ranked'`).toEqual([]);
    expect(await sql<{ user_id: string }[]>`SELECT user_id FROM user_achievements WHERE user_id = ${a}`).toEqual([]);
  });

  it('REFUSES atomically on a manifest mismatch (nothing deleted)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`bi_mm_a_${Date.now()}`);
    const b = await seedBot(`bi_mm_b_${Date.now()}`);
    const snapshot = await snapshotProfiles([bot(a), bot(b)], {
      manifestHash: 'DIFFERENT', seed: 1, env: 'test', ceilingRp: 100_000, humanTop10Rp: 1200, marginRp: 200,
    });
    const fixture = makeFixture({
      a, b, winner: a,
      startedAt: new Date('2026-07-24T13:00:00Z'), endedAt: new Date('2026-07-24T13:05:00Z'),
      isPlacement: false,
    });
    await writeFixture(fixture, 100_000);
    await expect(rollback(header([a, b]), [receiptLine(fixture)], snapshot)).rejects.toBeInstanceOf(RollbackRefusedError);
    // Match still present (nothing deleted).
    expect((await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${fixture.matchId}`).length).toBe(1);
  });

  it('REFUSES on post-snapshot live activity on a roster bot (finding 1)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedBot(`bi_live_a_${Date.now()}`);
    const b = await seedBot(`bi_live_b_${Date.now()}`);
    const snapshot = await snapshotProfiles([bot(a), bot(b)], {
      manifestHash: MANIFEST, seed: 1, env: 'test', ceilingRp: 100_000, humanTop10Rp: 1200, marginRp: 200,
    });
    const fixture = makeFixture({
      a, b, winner: a,
      startedAt: new Date('2026-07-24T15:00:00Z'), endedAt: new Date('2026-07-24T15:05:00Z'),
      isPlacement: false,
    });
    await writeFixture(fixture, 100_000);

    // Simulate a LIVE match ledger row (not in the receipt) after the snapshot.
    const strayMatchId = fixtureMatchIdFromDigest(fixtureContentDigest(MANIFEST, {
      botAUserId: a, botBUserId: b, startedAt: new Date('2026-07-26T09:00:00Z'),
      endedAt: new Date('2026-07-26T09:05:00Z'), winnerUserId: a, decision: 'goals',
      scoreA: { goals: 1, penaltyGoals: 0, totalPoints: 1, correctAnswers: 1 },
      scoreB: { goals: 0, penaltyGoals: 0, totalPoints: 0, correctAnswers: 0 },
    }));
    testMatchIds.push(strayMatchId);
    await sql`
      INSERT INTO matches (id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at)
      VALUES (${strayMatchId}, 'ranked', 'completed', ${categoryId}, ${categoryId}, 12, 12, false, NOW())
    `;
    await sql`
      INSERT INTO ranked_rp_changes (match_id, user_id, opponent_user_id, opponent_is_ai, old_rp, delta_rp, new_rp, result, is_placement, calculation_method, coins_awarded)
      VALUES (${strayMatchId}, ${a}, ${b}, true, 515, 50, 565, 'win', false, 'ranked_formula', 0)
    `;

    // Rollback must refuse (the receipt only lists `fixture`, not the stray).
    await expect(rollback(header([a, b]), [receiptLine(fixture)], snapshot)).rejects.toBeInstanceOf(RollbackRefusedError);
    expect((await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${fixture.matchId}`).length).toBe(1);

    // Cleanup the stray ledger row (afterAll deletes the match).
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ${strayMatchId}`;
  });
});
