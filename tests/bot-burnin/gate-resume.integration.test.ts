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
let acquireRunLock: typeof import('../../scripts/bot-burnin/data.js').acquireRunLock;
let resolveRun: typeof import('../../scripts/bot-burnin/data.js').resolveRun;
let insertRunningMarker: typeof import('../../scripts/bot-burnin/data.js').insertRunningMarker;
let markRunComplete: typeof import('../../scripts/bot-burnin/data.js').markRunComplete;
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
    ({ findNonPristineBots, acquireRunLock, resolveRun, insertRunningMarker, markRunComplete } = await import('../../scripts/bot-burnin/data.js'));
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

    expect(await findNonPristineBots([clean, dirty])).toEqual([]);

    const fixture = makeFixture(dirty, clean, dirty, new Date('2026-07-22T10:00:00Z'), new Date('2026-07-22T10:05:00Z'));
    await writeFixture(fixture, 100_000);

    const violations = await findNonPristineBots([clean, dirty]);
    const dirtyV = violations.find((v) => v.userId === dirty);
    expect(dirtyV).toBeDefined();
    expect(dirtyV!.reasons.some((r) => r.startsWith('rp=') || r.startsWith('ranked_games=') || r.startsWith('ranked_ledger='))).toBe(true);
  });

  it('ESCAPE: a MISSING ranked_profiles row FAILS (finding 1 — null must not pass)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
      VALUES (${`gr_noprofile_${Date.now()}`}, true, 'persistent', false, 0, true) RETURNING id
    `;
    testUserIds.push(u.id);
    const violations = await findNonPristineBots([u.id]);
    expect(violations.length).toBe(1);
    expect(violations[0].reasons).toContain('no ranked_profiles row');
  });

  it('ESCAPE: an existing user_achievements row FAILS', async ({ skip }) => {
    if (!dbAvailable) skip();
    const u = await seedBot(`gr_ach_${Date.now()}`);
    await sql`INSERT INTO user_achievements (user_id, achievement_id, progress) VALUES (${u}, 'debut_match', 1)`;
    const violations = await findNonPristineBots([u]);
    expect(violations[0]?.reasons.some((r) => r.startsWith('achievements='))).toBe(true);
    await sql`DELETE FROM user_achievements WHERE user_id = ${u}`;
  });

  it('ESCAPE: prior placement_wins / streak / finished-match history FAILS', async ({ skip }) => {
    if (!dbAvailable) skip();
    const u = await seedBot(`gr_hist_${Date.now()}`);
    // Dirty the profile accumulators without touching RP.
    await sql`UPDATE ranked_profiles SET placement_wins = 1, current_win_streak = 2 WHERE user_id = ${u}`;
    // Give it a completed (finished) match with a real opponent.
    const opp = await seedBot(`gr_hist_opp_${Date.now()}`);
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at, ended_at)
      VALUES ('ranked', 'completed', ${categoryId}, ${categoryId}, 12, 12, false, NOW(), NOW()) RETURNING id
    `;
    testMatchIds.push(m.id);
    await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${m.id}, ${u}, 1), (${m.id}, ${opp}, 2)`;

    const violations = await findNonPristineBots([u]);
    const reasons = violations.find((v) => v.userId === u)?.reasons ?? [];
    expect(reasons.some((r) => r.startsWith('placement_wins='))).toBe(true);
    expect(reasons.some((r) => r.startsWith('current_win_streak='))).toBe(true);
    expect(reasons.some((r) => r.startsWith('finished_matches='))).toBe(true);
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

describe('run-identity decision table (fresh / resume / refuse)', () => {
  it('resolveRun: no marker -> fresh; running+sameH -> resume; complete -> refuse; differentH -> refuse', async ({ skip }) => {
    if (!dbAvailable) skip();
    // Clear any leftover marker so this test starts from a known state.
    await sql`DELETE FROM bot_model_params WHERE note = 'persistent-bot-burnin:complete'`;
    const H = `gr-run-${Date.now()}`;
    markerHashes.push(H, `${H}-x`);

    const lock = await acquireRunLock();
    try {
      // 1. No marker -> fresh.
      expect((await resolveRun(lock, H)).kind).toBe('fresh');

      // Insert the 'running' marker for H.
      await insertRunningMarker(lock, H, 1);

      // 2. running + same H -> resume (this is what unblocks crash-resume).
      const resume = await resolveRun(lock, H);
      expect(resume.kind).toBe('resume');

      // 3. running + a DIFFERENT H -> refuse.
      expect((await resolveRun(lock, `${H}-x`)).kind).toBe('refuse');

      // 4. complete -> refuse.
      await markRunComplete(lock, H, 5);
      const done = await resolveRun(lock, H);
      expect(done.kind).toBe('refuse');
      if (done.kind === 'refuse') expect(done.reason).toMatch(/complete/i);
    } finally {
      await lock.release();
    }
  });

  it('the advisory lock serializes concurrent runs (second acquire blocks until release)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const first = await acquireRunLock();
    let secondAcquired = false;
    const secondPromise = acquireRunLock().then((l) => { secondAcquired = true; return l; });
    // While first holds the lock, the second must NOT have acquired yet.
    await new Promise((r) => setTimeout(r, 150));
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });
});
