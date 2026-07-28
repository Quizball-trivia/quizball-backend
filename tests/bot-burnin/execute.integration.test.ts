/**
 * Integration tests for the burn-in EXECUTE (one transaction) + ROLLBACK paths.
 * These mutate the SINGLETON run marker, so they run serially via
 * vitest.burnin.config.ts (`npm run test:burnin`).
 *
 * Proven:
 *   - one-tx execute writes ALL fixtures + the 'complete' marker atomically
 *   - the pristine gate refuses a dirty bot INSIDE the tx (nothing committed)
 *   - the one-time marker refuses a second run
 *   - rollback deletes exactly the plan's matches + resets bots to pristine
 *   - rollback REFUSES on non-plan (post-burn-in) activity, deleting nothing
 *
 * Run: npm run docker:start && npm run test:burnin
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BurnInBot } from '../../scripts/bot-burnin/types.js';

let sql: typeof import('../../src/db/index.js').sql;
let data: typeof import('../../scripts/bot-burnin/data.js');
let buildSchedule: typeof import('../../scripts/bot-burnin/scheduler.js').buildSchedule;
let buildManifest: typeof import('../../scripts/bot-burnin/manifest.js').buildManifest;
let manifestHashFn: typeof import('../../scripts/bot-burnin/manifest.js').manifestHash;
let writeFixtureInTx: typeof import('../../scripts/bot-burnin/writer.js').writeFixtureInTx;
let rollbackBurnIn: typeof import('../../scripts/bot-burnin/rollback-core.js').rollbackBurnIn;
let RollbackRefusedError: typeof import('../../scripts/bot-burnin/rollback-core.js').RollbackRefusedError;
let params: import('../../src/modules/bots/calibration/params-schema.js').BotModelParams;
let dbAvailable = false;

const testUserIds: string[] = [];
let categoryIds: string[] = [];

const SEASON_START = new Date('2026-07-21T00:00:00Z');
const SEASON_END = new Date('2026-07-28T00:00:00Z');

async function seedBot(i: number, baseSkill: number): Promise<BurnInBot> {
  const [u] = await sql<{ id: string; nickname: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
    VALUES (${`ex_bot_${i}_${Date.now()}`}, true, 'persistent', false, 0, true) RETURNING id, nickname
  `;
  testUserIds.push(u.id);
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played, placement_wins, placement_seed_rp, placement_perf_sum, placement_points_for_sum, placement_points_against_sum, current_win_streak)
    VALUES (${u.id}, 450, 'Youth Prospect', 'unplaced', 3, 0, 0, NULL, 0, 0, 0, 0)
  `;
  const schedule = { activeHours: [], sessionMax: 4, intraSessionGapMin: 20 };
  await sql`
    INSERT INTO synthetic_player_profiles (user_id, base_skill, daily_cap, personality_seed, schedule)
    VALUES (${u.id}, ${baseSkill}, 6, ${1000 + i}, ${sql.json(schedule)})
  `;
  return { userId: u.id, nickname: u.nickname, baseSkill, dailyCap: 6, schedule, status: 'active', rp: 450, placementPlayed: 0, placementWins: 0, placementStatus: 'unplaced', currentWinStreak: 0 };
}

async function clearMarker() {
  await sql`DELETE FROM bot_model_params WHERE note = 'persistent-bot-burnin:complete'`;
}

/** Plan for a roster + return {manifestHash, matchIds, fixtures}. */
function plan(bots: BurnInBot[], ceilingRp: number) {
  const manifest = buildManifest({ seed: 42, seasonStart: SEASON_START, seasonEnd: SEASON_END, targetMatches: 6, ceilingMarginRp: 200, params, bots, categoryIds });
  const manifestHash = manifestHashFn(manifest);
  const schedule = buildSchedule({ bots, params, seed: 42, seasonStart: SEASON_START, runDate: SEASON_END, targetMatches: 6, ceilingRp, categoryIds, manifestHash });
  return { manifestHash, schedule, ceilingRp };
}

/** Run the execute transaction exactly like index.ts. */
async function execute(bots: BurnInBot[], ceilingRp: number) {
  const { manifestHash, schedule } = plan(bots, ceilingRp);
  await sql.begin(async (tx) => {
    await data.lockBurnIn(tx);
    await data.assertNotBurnedIn(tx);
    const violations = await data.findNonPristineBots(tx, bots.map((b) => b.userId));
    if (violations.length > 0) throw new Error(`not pristine: ${violations.map((v) => v.nickname).join(',')}`);
    for (const f of schedule.fixtures) await writeFixtureInTx(tx, f);
    await data.insertBurnInMarker(tx, manifestHash, 42, schedule.fixtures.length, ceilingRp);
  });
  return { manifestHash, matchIds: schedule.fixtures.map((f) => f.matchId) };
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    data = await import('../../scripts/bot-burnin/data.js');
    ({ buildSchedule } = await import('../../scripts/bot-burnin/scheduler.js'));
    ({ buildManifest, manifestHash: manifestHashFn } = await import('../../scripts/bot-burnin/manifest.js'));
    ({ writeFixtureInTx } = await import('../../scripts/bot-burnin/writer.js'));
    ({ rollbackBurnIn, RollbackRefusedError } = await import('../../scripts/bot-burnin/rollback-core.js'));
    params = (await import('../../src/modules/bots/calibration/params-schema.js')).parseBotModelParams(
      JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
    );
    const cats = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 3`;
    categoryIds = cats.length > 0 ? cats.map((c) => c.id) : [(await sql<{ id: string }[]>`INSERT INTO categories (slug, name, is_active) VALUES (${`ex_${Date.now()}`}, 'EX', true) RETURNING id`)[0].id];
    await clearMarker();
  } catch {
    console.warn('\n⚠️  Skipping burn-in execute tests: DB unavailable.\n');
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  await clearMarker();
  if (testUserIds.length > 0) {
    const mids = (await sql<{ match_id: string }[]>`SELECT DISTINCT match_id FROM match_players WHERE user_id = ANY(${testUserIds}::uuid[])`).map((r) => r.match_id);
    if (mids.length > 0) {
      await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${mids}::uuid[])`;
      await sql`DELETE FROM user_xp_events WHERE source_key = ANY(${mids})`;
      await sql`DELETE FROM matches WHERE id = ANY(${mids}::uuid[])`;
    }
    await sql`DELETE FROM user_xp_events WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM user_achievements WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('execute (one transaction)', () => {
  it('writes all fixtures + the complete marker atomically; a second run refuses', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(1, -0.4), seedBot(2, 0.0), seedBot(3, 0.3), seedBot(4, -0.2)]);
    const { manifestHash, matchIds } = await execute(bots, 100_000);

    expect(matchIds.length).toBeGreaterThan(0);
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
    expect(c).toBe(matchIds.length);
    const marker = await data.readBurnInMarker();
    expect(marker?.manifestHash).toBe(manifestHash);
    expect(marker?.status).toBe('complete');

    // A second run (same plan) refuses via the one-time marker.
    await expect(execute(bots, 100_000)).rejects.toThrow(/already burned in/i);
  });

  it('the pristine gate refuses a dirty bot INSIDE the tx — nothing committed', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(11, -0.3), seedBot(12, 0.2), seedBot(13, 0.0)]);
    // Dirty one bot's profile.
    await sql`UPDATE ranked_profiles SET rp = 600, placement_status = 'placed' WHERE user_id = ${bots[0].userId}`;

    await expect(execute(bots, 100_000)).rejects.toThrow(/not pristine/i);
    // No marker, no matches for these bots.
    expect(await data.readBurnInMarker()).toBeNull();
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM match_players WHERE user_id = ANY(${bots.map((b) => b.userId)}::uuid[])`;
    expect(c).toBe(0);
    // Restore for cleanup determinism.
    await sql`UPDATE ranked_profiles SET rp = 450, placement_status = 'unplaced' WHERE user_id = ${bots[0].userId}`;
  });
});

describe('rollback', () => {
  it('deletes exactly the plan matches and resets bots to pristine', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(21, -0.4), seedBot(22, 0.1), seedBot(23, 0.3), seedBot(24, -0.1)]);
    const { matchIds } = await execute(bots, 100_000);

    // Bots moved off pristine.
    const rpBefore = await sql<{ rp: number }[]>`SELECT rp FROM ranked_profiles WHERE user_id = ANY(${bots.map((b) => b.userId)}::uuid[])`;
    expect(rpBefore.some((r) => r.rp !== 450)).toBe(true);

    const result = await rollbackBurnIn(matchIds, bots.map((b) => b.userId));
    expect(result.matchesDeleted).toBe(matchIds.length);

    // Matches gone; bots pristine again; marker cleared.
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
    expect(c).toBe(0);
    const profiles = await sql<{ rp: number; placement_status: string; current_win_streak: number }[]>`
      SELECT rp, placement_status, current_win_streak FROM ranked_profiles WHERE user_id = ANY(${bots.map((b) => b.userId)}::uuid[])
    `;
    for (const p of profiles) { expect(p.rp).toBe(450); expect(p.placement_status).toBe('unplaced'); expect(p.current_win_streak).toBe(0); }
    const users = await sql<{ total_xp: number }[]>`SELECT total_xp FROM users WHERE id = ANY(${bots.map((b) => b.userId)}::uuid[])`;
    for (const u of users) expect(Number(u.total_xp)).toBe(0);
    expect(await data.readBurnInMarker()).toBeNull();
  });

  it('REFUSES (deletes nothing) if a roster bot has a match NOT in the plan', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(31, -0.3), seedBot(32, 0.2), seedBot(33, 0.0), seedBot(34, 0.1)]);
    const { matchIds } = await execute(bots, 100_000);

    // Simulate REAL post-burn-in activity: a match for a roster bot NOT in the plan.
    const [foreign] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at, ended_at)
      VALUES ('ranked', 'completed', ${categoryIds[0]}, ${categoryIds[0]}, 12, 12, false, NOW(), NOW()) RETURNING id
    `;
    await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${foreign.id}, ${bots[0].userId}, 1), (${foreign.id}, ${bots[1].userId}, 2)`;

    await expect(rollbackBurnIn(matchIds, bots.map((b) => b.userId))).rejects.toBeInstanceOf(RollbackRefusedError);
    // Nothing deleted — the plan matches + marker survive.
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
    expect(c).toBe(matchIds.length);
    expect(await data.readBurnInMarker()).not.toBeNull();

    // Cleanup the foreign match + then roll back properly for teardown.
    await sql`DELETE FROM match_players WHERE match_id = ${foreign.id}`;
    await sql`DELETE FROM matches WHERE id = ${foreign.id}`;
    await rollbackBurnIn(matchIds, bots.map((b) => b.userId));
  });
});
