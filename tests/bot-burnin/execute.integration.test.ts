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

/**
 * Run the CHUNKED execute exactly like index.ts (idempotent-resume aware). If
 * `crashAfterChunk` is set, throw after committing that many chunks (simulating
 * a mid-run crash) — the completed chunks stay committed.
 */
async function execute(bots: BurnInBot[], ceilingRp: number, opts: { chunk?: number; crashAfterChunk?: number } = {}) {
  const { manifestHash, schedule } = plan(bots, ceilingRp);
  const rosterIds = bots.map((b) => b.userId);
  const fixtures = schedule.fixtures;
  const alreadyWritten = await data.validatedExistingMatchIds(fixtures);
  const remaining = fixtures.filter((f) => !alreadyWritten.has(f.matchId));
  const writtenBots = new Set<string>();
  for (const f of fixtures) if (alreadyWritten.has(f.matchId)) { writtenBots.add(f.botAUserId); writtenBots.add(f.botBUserId); }
  const untouchedBotIds = rosterIds.filter((id) => !writtenBots.has(id));

  const CHUNK = opts.chunk ?? 250;
  let gateChecked = false;
  let committedChunks = 0;
  for (let i = 0; i < remaining.length; i += CHUNK) {
    const chunk = remaining.slice(i, i + CHUNK);
    const isLast = i + CHUNK >= remaining.length;
    await sql.begin(async (tx) => {
      await data.lockBurnIn(tx);
      await data.assertNotBurnedIn(tx);
      if (!gateChecked) {
        if (untouchedBotIds.length > 0) {
          await data.lockRosterGateRows(tx, untouchedBotIds);
          const violations = await data.findNonPristineBots(tx, untouchedBotIds);
          if (violations.length > 0) throw new Error(`not pristine: ${violations.map((v) => v.nickname).join(',')}`);
        }
        gateChecked = true;
      }
      for (const f of chunk) await writeFixtureInTx(tx, f);
      if (isLast) await data.insertBurnInMarker(tx, manifestHash, 42, fixtures.length, ceilingRp);
    });
    committedChunks++;
    if (opts.crashAfterChunk != null && committedChunks >= opts.crashAfterChunk && !isLast) {
      throw new Error('simulated crash between chunks');
    }
  }
  if (remaining.length === 0) {
    await sql.begin(async (tx) => {
      await data.lockBurnIn(tx);
      await data.assertNotBurnedIn(tx);
      await data.insertBurnInMarker(tx, manifestHash, 42, fixtures.length, ceilingRp);
    });
  }
  return { manifestHash, matchIds: fixtures.map((f) => f.matchId), fixtures };
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

describe('execute (chunked)', () => {
  it('crash between chunks leaves a committed PREFIX; rerun skips written fixtures + finishes (idempotent)', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(51, -0.4), seedBot(52, 0.1), seedBot(53, 0.3), seedBot(54, -0.1), seedBot(55, 0.2), seedBot(56, 0.0)]);
    const matchIds = plan(bots, 100_000).schedule.fixtures.map((f) => f.matchId);
    expect(matchIds.length).toBeGreaterThan(4); // need multiple small chunks

    // Crash after the first small chunk commits.
    await expect(execute(bots, 100_000, { chunk: 2, crashAfterChunk: 1 })).rejects.toThrow(/simulated crash/);

    // A committed PREFIX exists (some matches), the run is NOT marked complete.
    const written1 = new Set((await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ANY(${matchIds}::uuid[])`).map((r) => r.id));
    expect(written1.size).toBeGreaterThan(0);
    expect(written1.size).toBeLessThan(matchIds.length);
    expect(await data.readBurnInMarker()).toBeNull();

    // RERUN: same plan, skips the written prefix, finishes the rest, marks complete.
    await execute(bots, 100_000, { chunk: 2 });
    const written2 = new Set((await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ANY(${matchIds}::uuid[])`).map((r) => r.id));
    expect(written2.size).toBe(matchIds.length);
    expect(await data.readBurnInMarker()).not.toBeNull();
    // No duplicate ledger rows (idempotent) — exactly one ledger row per (match,user).
    const [{ dupes }] = await sql<{ dupes: number }[]>`
      SELECT COUNT(*)::int AS dupes FROM (
        SELECT match_id, user_id, COUNT(*) AS n FROM ranked_rp_changes
        WHERE match_id = ANY(${matchIds}::uuid[]) GROUP BY match_id, user_id HAVING COUNT(*) > 1
      ) d
    `;
    expect(dupes).toBe(0);

    // Teardown.
    await rollbackBurnIn(matchIds, bots.map((b) => b.userId));
  });

  it('pristine gate holds a users-row lock: a concurrent users write BLOCKS until commit (P3)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const bot = await seedBot(81, 0.0);

    let concurrentUpdateFinished = false;
    let releaseGate!: () => void;
    const gateHeld = new Promise<void>((r) => { releaseGate = r; });

    // Tx A: take the gate row locks, then hold the tx open until we release it.
    const gateTx = sql.begin(async (tx) => {
      await data.lockRosterGateRows(tx, [bot.userId]);
      await gateHeld; // keep the tx (and its FOR UPDATE locks) open
    });

    // Give tx A a moment to acquire its locks.
    await new Promise((r) => setTimeout(r, 100));

    // Tx B: a concurrent write to the SAME users row must BLOCK on the lock.
    const concurrentUpdate = sql`UPDATE users SET total_xp = total_xp + 1 WHERE id = ${bot.userId}`
      .then(() => { concurrentUpdateFinished = true; });

    // While the gate holds the lock, the concurrent update has NOT completed.
    await new Promise((r) => setTimeout(r, 250));
    expect(concurrentUpdateFinished).toBe(false);

    // Release the gate tx → the blocked update proceeds.
    releaseGate();
    await gateTx;
    await concurrentUpdate;
    expect(concurrentUpdateFinished).toBe(true);

    // Reset the +1 for teardown determinism.
    await sql`UPDATE users SET total_xp = 0 WHERE id = ${bot.userId}`;
  });

  it('resume ABORTS on a colliding non-burn-in match at a planned fixture slot (P2 validation depth)', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(71, -0.3), seedBot(72, 0.2), seedBot(73, 0.0), seedBot(74, 0.1)]);
    const p = plan(bots, 100_000);
    const first = p.schedule.fixtures[0];

    // A colliding match: same id as a planned fixture, but NOT a burn-in match
    // (no ranked_context.burnIn/fixtureKey). It must NEVER be accepted as done.
    await sql`
      INSERT INTO matches (id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at, ended_at)
      VALUES (${first.matchId}, 'ranked', 'completed', ${categoryIds[0]}, ${categoryIds[0]}, 12, 12, false, ${first.startedAt}, ${first.endedAt})
    `;
    await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${first.matchId}, ${first.botAUserId}, 1), (${first.matchId}, ${first.botBUserId}, 2)`;

    // Resume validation must throw (colliding non-burn-in match), NOT skip it.
    await expect(execute(bots, 100_000)).rejects.toThrow(/resume abort|not a burn-in match/i);
    // No completion marker was written.
    expect(await data.readBurnInMarker()).toBeNull();

    // Teardown: remove the colliding match.
    await sql`DELETE FROM match_players WHERE match_id = ${first.matchId}`;
    await sql`DELETE FROM matches WHERE id = ${first.matchId}`;
  });

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

  it('REFUSES + PRESERVES a post-burn-in non-burn-in XP row (daily challenge) (P1)', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(41, -0.3), seedBot(42, 0.2), seedBot(43, 0.0), seedBot(44, 0.1)]);
    const { matchIds } = await execute(bots, 100_000);

    // Real post-burn-in progression: a daily-challenge XP event (not a match).
    const dailyKey = `daily-${Date.now()}`;
    await sql`
      INSERT INTO user_xp_events (user_id, source_type, source_key, xp_delta, metadata)
      VALUES (${bots[0].userId}, 'daily_challenge_completion', ${dailyKey}, 50, '{}'::jsonb)
    `;
    await sql`UPDATE users SET total_xp = total_xp + 50 WHERE id = ${bots[0].userId}`;

    // Rollback must REFUSE (would destroy the daily XP), deleting nothing.
    await expect(rollbackBurnIn(matchIds, bots.map((b) => b.userId))).rejects.toBeInstanceOf(RollbackRefusedError);
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
    expect(c).toBe(matchIds.length);
    // The daily XP row survives.
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM user_xp_events WHERE source_key = ${dailyKey}`;
    expect(n).toBe(1);

    // Remove the daily XP, then rollback cleanly for teardown — total_xp is
    // DECREMENTED by exactly the burn-in contribution (back to 0), not zeroed.
    await sql`DELETE FROM user_xp_events WHERE source_key = ${dailyKey}`;
    await sql`UPDATE users SET total_xp = total_xp - 50 WHERE id = ${bots[0].userId}`;
    await rollbackBurnIn(matchIds, bots.map((b) => b.userId));
    const users = await sql<{ total_xp: number }[]>`SELECT total_xp FROM users WHERE id = ANY(${bots.map((b) => b.userId)}::uuid[])`;
    for (const u of users) expect(Number(u.total_xp)).toBe(0);
  });

  it('REFUSES + PRESERVES a null-sourced UNLOCKED non-burn-in achievement (P1)', async ({ skip }) => {
    if (!dbAvailable) skip();
    await clearMarker();
    const bots = await Promise.all([seedBot(61, -0.3), seedBot(62, 0.2), seedBot(63, 0.0), seedBot(64, 0.1)]);
    const { matchIds } = await execute(bots, 100_000);

    // A real, non-burn-in UNLOCKED achievement with a NULL source (the exact
    // case Sol flagged — must NOT be silently deleted).
    await sql`
      INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at, source_match_id)
      VALUES (${bots[0].userId}, 'quiz_legend_placeholder', 1, NOW(), NULL)
      ON CONFLICT (user_id, achievement_id) DO NOTHING
    `;

    // Rollback must REFUSE (would destroy the null-sourced unlocked achievement).
    await expect(rollbackBurnIn(matchIds, bots.map((b) => b.userId))).rejects.toBeInstanceOf(RollbackRefusedError);
    const survived = await sql<{ achievement_id: string }[]>`
      SELECT achievement_id FROM user_achievements WHERE user_id = ${bots[0].userId} AND achievement_id = 'quiz_legend_placeholder'
    `;
    expect(survived.length).toBe(1); // preserved, not deleted
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
    expect(c).toBe(matchIds.length); // nothing deleted

    // Remove the injected achievement, then rollback cleanly for teardown.
    await sql`DELETE FROM user_achievements WHERE user_id = ${bots[0].userId} AND achievement_id = 'quiz_legend_placeholder'`;
    await rollbackBurnIn(matchIds, bots.map((b) => b.userId));
  });
});
