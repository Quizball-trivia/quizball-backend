/**
 * Integration tests for the burn-in writer + rollback against the real test DB.
 * Seeds its OWN persistent bots (users + ranked_profiles +
 * synthetic_player_profiles) — does NOT depend on PR5 roster tooling.
 *
 * Proven end-to-end:
 *   - writeFixture lands a completed ranked match with BACKDATED
 *     started_at/ended_at, both match_players seats, user_mode_match_stats W/L,
 *     a backdated ranked ledger row + moved profiles, and backdated XP — with
 *     ZERO coins for the bots (economy stays AI)
 *   - resume: writing the same fixture twice creates no duplicate rows
 *   - rollback restores profiles/XP and deletes only roster-bot matches
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bot-burnin/writer.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import type { PlannedFixture, BurnInBot } from '../../scripts/bot-burnin/types.js';

let sql: typeof import('../../src/db/index.js').sql;
let writeFixture: typeof import('../../scripts/bot-burnin/writer.js').writeFixture;
let fixtureMatchId: typeof import('../../scripts/bot-burnin/writer.js').fixtureMatchId;
let snapshotProfiles: typeof import('../../scripts/bot-burnin/snapshot.js').snapshotProfiles;
let rollback: typeof import('../../scripts/bot-burnin/snapshot.js').rollback;
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

function makeFixture(opts: {
  key: string;
  a: string;
  b: string;
  winner: string;
  startedAt: Date;
  endedAt: Date;
  isPlacement: boolean;
}): PlannedFixture {
  return {
    key: opts.key,
    botAUserId: opts.a,
    botBUserId: opts.b,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    winnerUserId: opts.winner,
    decision: 'goals',
    isPlacementContext: opts.isPlacement,
    scoreA: { goals: 3, penaltyGoals: 0, totalPoints: 900, correctAnswers: 8 },
    scoreB: { goals: 1, penaltyGoals: 0, totalPoints: 400, correctAnswers: 4 },
    categoryAId: categoryId,
    categoryBId: categoryId,
  };
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    ({ writeFixture, fixtureMatchId } = await import('../../scripts/bot-burnin/writer.js'));
    ({ snapshotProfiles, rollback } = await import('../../scripts/bot-burnin/snapshot.js'));
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    if (!cat) {
      const [created] = await sql<{ id: string }[]>`
        INSERT INTO categories (slug, name, is_active)
        VALUES (${`burnin_test_${Date.now()}`}, 'Burn-in Test', true)
        RETURNING id
      `;
      categoryId = created.id;
    } else {
      categoryId = cat.id;
    }
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
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('writeFixture — backdated bot-vs-bot fixture', () => {
  it('lands match+players+stats+ledger+XP backdated, bots earn zero coins', async ({ skip }) => {
    if (!dbAvailable) skip();

    const a = await seedBot(`bi_a_${Date.now()}`);
    const b = await seedBot(`bi_b_${Date.now()}`);
    const startedAt = new Date('2026-07-22T10:00:00Z');
    const endedAt = new Date('2026-07-22T10:05:00Z');
    const fixture = makeFixture({ key: `test:writer:${a}`, a, b, winner: a, startedAt, endedAt, isPlacement: true });
    const matchId = fixtureMatchId(fixture.key);
    testMatchIds.push(matchId);

    const res = await writeFixture(fixture);
    expect(res.created).toBe(true);
    expect(res.matchId).toBe(matchId);

    // Match backdated + completed.
    const [match] = await sql<{ status: string; is_dev: boolean; started_at: string; ended_at: string; winner_user_id: string }[]>`
      SELECT status, is_dev, started_at, ended_at, winner_user_id FROM matches WHERE id = ${matchId}
    `;
    expect(match.status).toBe('completed');
    expect(match.is_dev).toBe(false);
    expect(new Date(match.started_at).toISOString()).toBe(startedAt.toISOString());
    expect(new Date(match.ended_at).toISOString()).toBe(endedAt.toISOString());
    expect(match.winner_user_id).toBe(a);

    // Two seats.
    const players = await sql<{ user_id: string; goals: number }[]>`
      SELECT user_id, goals FROM match_players WHERE match_id = ${matchId} ORDER BY seat
    `;
    expect(players.length).toBe(2);

    // Winner profile moved up + ledger backdated to endedAt.
    const [winnerLedger] = await sql<{ result: string; delta_rp: number; coins_awarded: number; created_at: string }[]>`
      SELECT result, delta_rp, coins_awarded, created_at FROM ranked_rp_changes
      WHERE match_id = ${matchId} AND user_id = ${a}
    `;
    expect(winnerLedger.result).toBe('win');
    expect(winnerLedger.delta_rp).toBe(65); // +50 base +15 win-by-2 margin
    expect(winnerLedger.coins_awarded).toBe(0); // bots never earn coins
    expect(new Date(winnerLedger.created_at).toISOString()).toBe(endedAt.toISOString());

    const [winnerProfile] = await sql<{ rp: number; last_ranked_match_at: string }[]>`
      SELECT rp, last_ranked_match_at FROM ranked_profiles WHERE user_id = ${a}
    `;
    expect(winnerProfile.rp).toBe(515);
    expect(new Date(winnerProfile.last_ranked_match_at).toISOString()).toBe(endedAt.toISOString());

    // W/L fanned into user_mode_match_stats for both bots.
    const [winStats] = await sql<{ wins: number; losses: number }[]>`
      SELECT wins, losses FROM user_mode_match_stats WHERE user_id = ${a} AND mode = 'ranked'
    `;
    expect(winStats.wins).toBe(1);
    expect(winStats.losses).toBe(0);

    // XP granted + backdated for both bots; coins stay 0.
    const [xp] = await sql<{ count: number; created_at: string | null }[]>`
      SELECT COUNT(*)::int AS count, MIN(created_at) AS created_at FROM user_xp_events WHERE source_key = ${matchId}
    `;
    expect(xp.count).toBe(2);
    expect(new Date(xp.created_at!).toISOString()).toBe(endedAt.toISOString());
    const [aUser] = await sql<{ coins: number; total_xp: number }[]>`SELECT coins, total_xp FROM users WHERE id = ${a}`;
    expect(aUser.coins).toBe(0);
    expect(Number(aUser.total_xp)).toBeGreaterThan(0);
  });

  it('resume: re-writing the same fixture creates no duplicates', async ({ skip }) => {
    if (!dbAvailable) skip();

    const a = await seedBot(`bi_r_a_${Date.now()}`);
    const b = await seedBot(`bi_r_b_${Date.now()}`);
    const fixture = makeFixture({
      key: `test:resume:${a}`, a, b, winner: b,
      startedAt: new Date('2026-07-23T09:00:00Z'), endedAt: new Date('2026-07-23T09:05:00Z'),
      isPlacement: false,
    });
    testMatchIds.push(fixtureMatchId(fixture.key));

    const first = await writeFixture(fixture);
    expect(first.created).toBe(true);
    const second = await writeFixture(fixture);
    expect(second.created).toBe(false);

    const [ledgerCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM ranked_rp_changes WHERE match_id = ${first.matchId}
    `;
    expect(ledgerCount.count).toBe(2); // one per participant, not four
    const [xpCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM user_xp_events WHERE source_key = ${first.matchId}
    `;
    expect(xpCount.count).toBe(2);
    const [statB] = await sql<{ games_played: number }[]>`
      SELECT games_played FROM user_mode_match_stats WHERE user_id = ${b} AND mode = 'ranked'
    `;
    expect(statB.games_played).toBe(1); // not double-counted
  });

  it('rollback restores profiles/XP and deletes the burn-in match', async ({ skip }) => {
    if (!dbAvailable) skip();

    const a = await seedBot(`bi_rb_a_${Date.now()}`);
    const b = await seedBot(`bi_rb_b_${Date.now()}`);
    const bots: BurnInBot[] = [a, b].map((id) => ({
      userId: id, nickname: 'x', baseSkill: 0.1, dailyCap: 6,
      schedule: { activeHours: [], sessionMax: 4, intraSessionGapMin: 20 },
      status: 'active', rp: 450, placementPlayed: 0, placementWins: 0,
      placementStatus: 'unplaced', currentWinStreak: 0,
    }));

    const snapshot = await snapshotProfiles(bots, {
      seed: 1, env: 'test', ceilingRp: 1000, humanTop10Rp: 1200, marginRp: 200,
    });

    const fixture = makeFixture({
      key: `test:rollback:${a}`, a, b, winner: a,
      startedAt: new Date('2026-07-24T09:00:00Z'), endedAt: new Date('2026-07-24T09:05:00Z'),
      isPlacement: false,
    });
    const matchId = fixtureMatchId(fixture.key);
    testMatchIds.push(matchId);
    await writeFixture(fixture);

    // Winner moved above the snapshot value; now roll back.
    const [before] = await sql<{ rp: number }[]>`SELECT rp FROM ranked_profiles WHERE user_id = ${a}`;
    expect(before.rp).toBeGreaterThan(450);

    const result = await rollback(
      { createdAt: '', seed: 1, env: 'test', rosterUserIds: [a, b], matchIds: [matchId], fixtureKeys: [fixture.key] },
      snapshot,
    );
    expect(result.matchesDeleted).toBe(1);
    expect(result.matchesRefused).toEqual([]);

    const [after] = await sql<{ rp: number }[]>`SELECT rp FROM ranked_profiles WHERE user_id = ${a}`;
    expect(after.rp).toBe(450); // restored
    const gone = await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${matchId}`;
    expect(gone).toEqual([]);
    const ledgerGone = await sql<{ match_id: string }[]>`SELECT match_id FROM ranked_rp_changes WHERE match_id = ${matchId}`;
    expect(ledgerGone).toEqual([]);
  });

  it('rollback REFUSES a match with a non-roster participant', async ({ skip }) => {
    if (!dbAvailable) skip();

    const a = await seedBot(`bi_ref_a_${Date.now()}`);
    const b = await seedBot(`bi_ref_b_${Date.now()}`);
    const fixture = makeFixture({
      key: `test:refuse:${a}`, a, b, winner: a,
      startedAt: new Date('2026-07-25T09:00:00Z'), endedAt: new Date('2026-07-25T09:05:00Z'),
      isPlacement: false,
    });
    const matchId = fixtureMatchId(fixture.key);
    testMatchIds.push(matchId);
    await writeFixture(fixture);

    // Roster set excludes b → the match must be refused, NOT deleted.
    const snapshot = await snapshotProfiles(
      [{ userId: a, nickname: 'x', baseSkill: 0.1, dailyCap: 6, schedule: { activeHours: [], sessionMax: 4, intraSessionGapMin: 20 }, status: 'active', rp: 450, placementPlayed: 0, placementWins: 0, placementStatus: 'unplaced', currentWinStreak: 0 }],
      { seed: 1, env: 'test', ceilingRp: 1000, humanTop10Rp: 1200, marginRp: 200 },
    );
    const result = await rollback(
      { createdAt: '', seed: 1, env: 'test', rosterUserIds: [a], matchIds: [matchId], fixtureKeys: [fixture.key] },
      snapshot,
    );
    expect(result.matchesDeleted).toBe(0);
    expect(result.matchesRefused).toEqual([matchId]);
    const stillThere = await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${matchId}`;
    expect(stillThere.length).toBe(1);
  });
});
