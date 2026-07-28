/**
 * MERGE GATE for the batched burn-in writer (#343).
 *
 * Proves writeFixtureChunkInTx produces the SAME final database state as the
 * per-fixture writeFixtureInTx it replaces, by running ONE plan through both
 * paths and comparing an ordered content hash of every table burn-in writes.
 *
 * Method: ONE roster, ONE plan, run TWICE with a full reset to pristine in
 * between — once through the per-fixture writer, once through the batched
 * writer. Because the roster and plan are identical (same user ids, same
 * deterministic match ids), the two snapshots are compared VERBATIM with no
 * normalization: same UUIDs, same timestamps, same RP chains, same streaks,
 * same ledger deltas, same stats, same XP.
 *
 * (Planning is roster-identity-dependent — seededRpForBot and the per-bot RNG
 * streams derive from userId — so two disjoint rosters would NOT produce
 * comparable plans. Reuse of one roster is what makes the equality exact.)
 *
 * Why this shape: the batched writer's whole risk is the in-memory fold of the
 * read-modify-write ranked_profiles chain (streak chaining and RP accumulation
 * across a bot's MANY fixtures within one chunk). Only a full-plan, multi-chunk
 * comparison exercises that; a single hand-built fixture would not.
 *
 * Run: npm run docker:start && npm run test:burnin
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BurnInBot, PlannedFixture } from '../../scripts/bot-burnin/types.js';

let sql: typeof import('../../src/db/index.js').sql;
let buildSchedule: typeof import('../../scripts/bot-burnin/scheduler.js').buildSchedule;
let buildManifest: typeof import('../../scripts/bot-burnin/manifest.js').buildManifest;
let manifestHashFn: typeof import('../../scripts/bot-burnin/manifest.js').manifestHash;
let writeFixtureInTx: typeof import('../../scripts/bot-burnin/writer.js').writeFixtureInTx;
let writeFixtureChunkInTx: typeof import('../../scripts/bot-burnin/writer.js').writeFixtureChunkInTx;
let writeSeededProfilesInTx: typeof import('../../scripts/bot-burnin/writer.js').writeSeededProfilesInTx;
let seedRosterBots: typeof import('../../scripts/bot-burnin/s2-distribution.js').seedRosterBots;
let params: import('../../src/modules/bots/calibration/params-schema.js').BotModelParams;
let dbAvailable = false;

const testUserIds: string[] = [];
let categoryIds: string[] = [];

const SEASON_START = new Date('2026-07-21T00:00:00Z');
const SEASON_END = new Date('2026-07-28T00:00:00Z');
const SEED = 4343;
const BOTS = 24;
/** Small enough to force MULTIPLE chunks, so chunk seams are covered. */
const CHUNK = 25;

async function seedBot(tag: string, i: number, baseSkill: number): Promise<BurnInBot> {
  const [u] = await sql<{ id: string; nickname: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete, total_xp)
    VALUES (${`eq_${tag}_${i}_${Date.now()}`}, true, 'persistent', false, 0, true, 0) RETURNING id, nickname
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
  return {
    userId: u.id, nickname: u.nickname, baseSkill, dailyCap: 6, schedule, status: 'active',
    rp: 450, placementPlayed: 0, placementWins: 0, placementStatus: 'unplaced', currentWinStreak: 0,
  };
}

const skillFor = (i: number) => -1.2 + (i * 2.4) / (BOTS - 1);

async function buildRoster(tag: string): Promise<BurnInBot[]> {
  const bots: BurnInBot[] = [];
  for (let i = 0; i < BOTS; i++) bots.push(await seedBot(tag, i, skillFor(i)));
  return bots;
}

/**
 * Return the roster to the exact pre-burn-in state so the SAME plan can be
 * replayed through the other writer: drop every ledger row this plan produced
 * and restore each ranked_profile / users row to its pristine values.
 */
async function resetToPristine(roster: BurnInBot[], fixtures: readonly PlannedFixture[]): Promise<void> {
  const userIds = roster.map((b) => b.userId);
  const matchIds = fixtures.map((f) => f.matchId);
  await sql`DELETE FROM ranked_rp_changes WHERE user_id = ANY(${userIds}::uuid[])`;
  await sql`DELETE FROM user_xp_events WHERE user_id = ANY(${userIds}::uuid[])`;
  await sql`DELETE FROM match_players WHERE match_id = ANY(${matchIds}::uuid[])`;
  await sql`DELETE FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
  await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${userIds}::uuid[])`;
  await sql`UPDATE users SET total_xp = 0, coins = 0 WHERE id = ANY(${userIds}::uuid[])`;
  await sql`
    UPDATE ranked_profiles SET
      rp = 450, tier = 'Youth Prospect', placement_status = 'unplaced', placement_played = 0,
      placement_wins = 0, placement_seed_rp = NULL, placement_perf_sum = 0,
      placement_points_for_sum = 0, placement_points_against_sum = 0, current_win_streak = 0,
      last_ranked_match_at = NULL
    WHERE user_id = ANY(${userIds}::uuid[])`;
}

function planFor(roster: BurnInBot[]) {
  const manifest = buildManifest({
    seed: SEED, seasonStart: SEASON_START, seasonEnd: SEASON_END, targetMatches: 20,
    ceilingMarginRp: 50, params, bots: roster, categoryIds,
  });
  const hash = manifestHashFn(manifest);
  const seeded = seedRosterBots(roster, SEED, 3000);
  const schedule = buildSchedule({
    bots: roster, params, seed: SEED, seasonStart: SEASON_START, runDate: SEASON_END,
    targetMatches: 20, ceilingRp: 3000, categoryIds, manifestHash: hash,
    seedOverrides: new Map(seeded.map((s) => [s.userId, s.seededRp])),
  });
  return { schedule, hash };
}

/**
 * Ordered snapshot of every table burn-in writes, compared VERBATIM.
 *
 * Same roster + same plan across both runs means user ids, deterministic match
 * ids and backdated timestamps are all identical, so the only columns excluded
 * are the two random gen_random_uuid() surrogate PKs (ranked_rp_changes.id,
 * user_xp_events.id) which carry no burn-in semantics.
 */
async function snapshot(roster: BurnInBot[], fixtures: readonly PlannedFixture[]): Promise<string> {
  const userIds = roster.map((b) => b.userId);
  const userOrdinal = new Map(userIds.map((id, i) => [id, i]));
  const matchOrdinal = new Map(fixtures.map((f, i) => [f.matchId, i]));
  const u = (id: string | null) => (id == null ? 'null' : String(userOrdinal.get(id) ?? `EXT:${id}`));
  const m = (id: string | null) => (id == null ? 'null' : String(matchOrdinal.get(id) ?? `EXT:${id}`));
  const t = (d: Date | null) => (d == null ? 'null' : new Date(d).toISOString());
  const lines: string[] = [];

  const matches = await sql<any[]>`
    SELECT id, mode, status, winner_user_id, is_dev, started_at, ended_at, category_a_id,
           category_b_id, total_questions, current_q_index, state_payload, ranked_context
    FROM matches WHERE id = ANY(${fixtures.map((f) => f.matchId)}::uuid[]) ORDER BY id`;
  // Sort by the PLAN ordinal, not the raw uuid, so the two runs align.
  matches.sort((a, b) => matchOrdinal.get(a.id)! - matchOrdinal.get(b.id)!);
  for (const r of matches) {
    // ranked_context.fixtureKey + state_payload.winnerDecisionMethod are the
    // exact fields resume validates on (data.ts:322-334) — compared verbatim.
    lines.push(['MATCH', m(r.id), r.mode, r.status, u(r.winner_user_id), r.is_dev,
      t(r.started_at), t(r.ended_at), r.total_questions, r.current_q_index,
      JSON.stringify(r.state_payload), JSON.stringify(r.ranked_context),
      r.category_a_id, r.category_b_id].join('|'));
  }

  const players = await sql<any[]>`
    SELECT match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals
    FROM match_players WHERE match_id = ANY(${fixtures.map((f) => f.matchId)}::uuid[])`;
  players.sort((a, b) => (matchOrdinal.get(a.match_id)! - matchOrdinal.get(b.match_id)!) || a.seat - b.seat);
  for (const r of players) {
    lines.push(['PLAYER', m(r.match_id), u(r.user_id), r.seat, r.total_points,
      r.correct_answers, r.goals, r.penalty_goals].join('|'));
  }

  const profiles = await sql<any[]>`
    SELECT user_id, rp, tier, placement_status, placement_required, placement_played,
           placement_wins, placement_seed_rp, placement_perf_sum, placement_points_for_sum,
           placement_points_against_sum, current_win_streak, last_ranked_match_at, updated_at
    FROM ranked_profiles WHERE user_id = ANY(${userIds}::uuid[])`;
  profiles.sort((a, b) => userOrdinal.get(a.user_id)! - userOrdinal.get(b.user_id)!);
  for (const r of profiles) {
    lines.push(['PROFILE', u(r.user_id), r.rp, r.tier, r.placement_status, r.placement_required,
      r.placement_played, r.placement_wins, r.placement_seed_rp, r.placement_perf_sum,
      r.placement_points_for_sum, r.placement_points_against_sum, r.current_win_streak,
      t(r.last_ranked_match_at),
      // updated_at must EQUAL last_ranked_match_at (not NOW()) — assert the
      // relationship rather than a wall-clock value.
      t(r.updated_at) === t(r.last_ranked_match_at) ? 'updated_at=last_match' : `MISMATCH:${t(r.updated_at)}`,
    ].join('|'));
  }

  const changes = await sql<any[]>`
    SELECT match_id, user_id, opponent_user_id, opponent_is_ai, old_rp, delta_rp, new_rp, result,
           is_placement, placement_game_no, placement_anchor_rp, placement_perf_score,
           calculation_method, coins_awarded, created_at
    FROM ranked_rp_changes WHERE user_id = ANY(${userIds}::uuid[])`;
  changes.sort((a, b) => (matchOrdinal.get(a.match_id)! - matchOrdinal.get(b.match_id)!)
    || (userOrdinal.get(a.user_id)! - userOrdinal.get(b.user_id)!));
  for (const r of changes) {
    lines.push(['RPCHANGE', m(r.match_id), u(r.user_id), u(r.opponent_user_id), r.opponent_is_ai,
      r.old_rp, r.delta_rp, r.new_rp, r.result, r.is_placement, r.placement_game_no,
      r.placement_anchor_rp, r.placement_perf_score, r.calculation_method, r.coins_awarded,
      t(r.created_at)].join('|'));
  }

  const stats = await sql<any[]>`
    SELECT user_id, mode, games_played, wins, losses, draws, last_match_at
    FROM user_mode_match_stats WHERE user_id = ANY(${userIds}::uuid[])`;
  stats.sort((a, b) => (userOrdinal.get(a.user_id)! - userOrdinal.get(b.user_id)!) || a.mode.localeCompare(b.mode));
  for (const r of stats) {
    lines.push(['STATS', u(r.user_id), r.mode, r.games_played, r.wins, r.losses, r.draws,
      t(r.last_match_at)].join('|'));
  }

  const xp = await sql<any[]>`
    SELECT user_id, source_type, source_key, xp_delta, created_at
    FROM user_xp_events WHERE user_id = ANY(${userIds}::uuid[])`;
  xp.sort((a, b) => (userOrdinal.get(a.user_id)! - userOrdinal.get(b.user_id)!)
    || (matchOrdinal.get(a.source_key)! - matchOrdinal.get(b.source_key)!));
  for (const r of xp) {
    lines.push(['XP', u(r.user_id), r.source_type, m(r.source_key), r.xp_delta, t(r.created_at)].join('|'));
  }

  const users = await sql<any[]>`SELECT id, total_xp, coins FROM users WHERE id = ANY(${userIds}::uuid[])`;
  users.sort((a, b) => userOrdinal.get(a.id)! - userOrdinal.get(b.id)!);
  for (const r of users) lines.push(['USER', u(r.id), r.total_xp, r.coins].join('|'));

  return lines.join('\n');
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    ({ buildSchedule } = await import('../../scripts/bot-burnin/scheduler.js'));
    ({ buildManifest, manifestHash: manifestHashFn } = await import('../../scripts/bot-burnin/manifest.js'));
    ({ writeFixtureInTx, writeFixtureChunkInTx, writeSeededProfilesInTx } =
      await import('../../scripts/bot-burnin/writer.js'));
    ({ seedRosterBots } = await import('../../scripts/bot-burnin/s2-distribution.js'));
    const { parseBotModelParams } = await import('../../src/modules/bots/calibration/params-schema.js');
    params = parseBotModelParams(JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')));
    const cats = await sql<{ id: string }[]>`SELECT id FROM categories WHERE is_active = true LIMIT 3`;
    categoryIds = cats.map((c) => c.id);
    while (categoryIds.length < 3) {
      const [c] = await sql<{ id: string }[]>`
        INSERT INTO categories (slug, name, is_active)
        VALUES (${`burnin_eq_${Date.now()}_${categoryIds.length}`}, 'EQ', true) RETURNING id`;
      categoryIds.push(c.id);
    }
  } catch (err) {
    console.warn(`\n⚠️  Skipping equivalence tests: DB unavailable (${String(err)}).\n`);
  }
}, 60_000);

afterAll(async () => {
  if (!dbAvailable) return;
  if (testUserIds.length > 0) {
    await sql`DELETE FROM matches WHERE id IN (SELECT match_id FROM match_players WHERE user_id = ANY(${testUserIds}::uuid[]))`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('batched writer equivalence (#343 merge gate)', () => {
  it('produces IDENTICAL final state to the per-fixture writer across multiple chunks', async () => {
    if (!dbAvailable) return;

    const roster = await buildRoster('eqv');
    const plan = planFor(roster);
    const fixtures = plan.schedule.fixtures;
    expect(fixtures.length).toBeGreaterThan(CHUNK * 2); // genuinely multi-chunk

    // ── RUN 1: the per-fixture writer being replaced ──
    await sql.begin(async (tx) => { await writeSeededProfilesInTx(tx, plan.schedule.seededBots); });
    const oldStart = Date.now();
    let oldStatements = 0;
    for (let i = 0; i < fixtures.length; i += CHUNK) {
      const chunk = fixtures.slice(i, i + CHUNK);
      await sql.begin(async (tx) => {
        for (const f of chunk) { await writeFixtureInTx(tx, f); oldStatements += 7; }
      });
    }
    const oldMs = Date.now() - oldStart;
    const snapOld = await snapshot(roster, fixtures);

    // ── RESET, then RUN 2: the batched writer, SAME plan ──
    await resetToPristine(roster, fixtures);
    await sql.begin(async (tx) => { await writeSeededProfilesInTx(tx, plan.schedule.seededBots); });
    const newStart = Date.now();
    let newStatements = 0;
    for (let i = 0; i < fixtures.length; i += CHUNK) {
      const chunk = fixtures.slice(i, i + CHUNK);
      // 1 locked read + 6 writes per chunk, regardless of chunk size.
      await sql.begin(async (tx) => { await writeFixtureChunkInTx(tx, chunk); newStatements += 7; });
    }
    const newMs = Date.now() - newStart;
    const snapNew = await snapshot(roster, fixtures);

    // Guard against a vacuous pass (both empty / both missing rows).
    expect(snapOld.length).toBeGreaterThan(1000);
    expect(snapOld.split('\n').filter((l) => l.startsWith('PROFILE')).length).toBe(BOTS);
    expect(snapOld.split('\n').filter((l) => l.startsWith('MATCH')).length).toBe(fixtures.length);
    expect(snapOld).not.toContain('MISMATCH:');
    expect(snapNew).not.toContain('MISMATCH:');

    process.stdout.write(
      `\n  [#343] ${fixtures.length} fixtures, chunk=${CHUNK}: ` +
      `old ${oldStatements} statements / ${oldMs}ms -> new ${newStatements} statements / ${newMs}ms ` +
      `(${(oldStatements / newStatements).toFixed(0)}x fewer round-trips)\n`,
    );

    expect(snapNew).toBe(snapOld);
  }, 300_000);

  /**
   * RESUME SEAM (staging died at chunk 4/24 on CONNECTION_CLOSED): the real
   * resume writes fixtures 1..N with the OLD per-fixture writer (the code that
   * was deployed when the run started) and everything after with the BATCHED
   * writer. The batched writer must pick up mid-plan and land the same ladder.
   *
   * This works because the batched writer seeds its in-memory fold from a LIVE
   * locked read of ranked_profiles at chunk start — the resumed bots already
   * carry RP/streak/placement from the committed prefix — rather than from the
   * plan's initial values.
   */
  it('RESUME: an old-writer prefix + batched remainder equals a pure batched run', async () => {
    if (!dbAvailable) return;

    const roster = await buildRoster('res');
    const plan = planFor(roster);
    const fixtures = plan.schedule.fixtures;

    // ── Reference: the whole plan through the batched writer ──
    await sql.begin(async (tx) => { await writeSeededProfilesInTx(tx, plan.schedule.seededBots); });
    for (let i = 0; i < fixtures.length; i += CHUNK) {
      await sql.begin(async (tx) => { await writeFixtureChunkInTx(tx, fixtures.slice(i, i + CHUNK)); });
    }
    const snapPure = await snapshot(roster, fixtures);

    // ── RESET, then the MIXED run ──
    await resetToPristine(roster, fixtures);
    await sql.begin(async (tx) => { await writeSeededProfilesInTx(tx, plan.schedule.seededBots); });

    // An OLD-writer prefix that stops MID-CHUNK: the staging crash rolled back
    // its in-flight chunk, so the committed prefix is not chunk-aligned.
    const cut = Math.floor(CHUNK * 2.5);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(fixtures.length);
    for (let i = 0; i < cut; i += CHUNK) {
      const chunk = fixtures.slice(i, Math.min(i + CHUNK, cut));
      await sql.begin(async (tx) => { for (const f of chunk) await writeFixtureInTx(tx, f); });
    }

    // Resume exactly as index.ts:243-244 does: skip already-written BY ID. This
    // also asserts the batched rows satisfy every resume validation predicate
    // (burnIn, fixtureKey, status, winner, decision, ended_at, seats) — a
    // divergence makes validatedExistingMatchIds THROW rather than skip.
    const { validatedExistingMatchIds } = await import('../../scripts/bot-burnin/data.js');
    const alreadyWritten = await validatedExistingMatchIds(fixtures);
    expect(alreadyWritten.size).toBe(cut);

    const remaining = fixtures.filter((f) => !alreadyWritten.has(f.matchId));
    expect(remaining.length).toBe(fixtures.length - cut);
    for (let i = 0; i < remaining.length; i += CHUNK) {
      await sql.begin(async (tx) => { await writeFixtureChunkInTx(tx, remaining.slice(i, i + CHUNK)); });
    }

    const snapMixed = await snapshot(roster, fixtures);
    expect(snapPure.length).toBeGreaterThan(1000);
    expect(snapMixed).not.toContain('MISMATCH:');
    expect(snapMixed).toBe(snapPure);
  }, 300_000);

  /**
   * Directly pins the in-memory fold: ONE bot wins many fixtures inside a
   * SINGLE chunk. The batched writer must chain the streak (1,2,3...) and
   * accumulate RP exactly as the sequential read-modify-write did, while
   * writing only ONE final ranked_profiles row-state for that bot.
   *
   * A naive collapse (last-write-wins from the chunk's OPENING state) would
   * leave streak=1 and a single fixture's RP delta — this test names that bug.
   */
  it('FOLD: chains streak and accumulates RP across one bot\'s many fixtures in a chunk', async () => {
    if (!dbAvailable) return;

    const roster = await buildRoster('fold');
    const plan = planFor(roster);
    const fixtures = plan.schedule.fixtures;

    // Find the chunk where some bot recurs the most.
    let best = { start: 0, userId: '', count: 0 };
    for (let i = 0; i < fixtures.length; i += CHUNK) {
      const counts = new Map<string, number>();
      for (const f of fixtures.slice(i, i + CHUNK)) {
        counts.set(f.botAUserId, (counts.get(f.botAUserId) ?? 0) + 1);
        counts.set(f.botBUserId, (counts.get(f.botBUserId) ?? 0) + 1);
      }
      for (const [userId, count] of counts) {
        if (count > best.count) best = { start: i, userId, count };
      }
    }
    // The fold is only meaningfully tested if a bot recurs several times.
    expect(best.count).toBeGreaterThanOrEqual(4);

    await sql.begin(async (tx) => { await writeSeededProfilesInTx(tx, plan.schedule.seededBots); });
    // Write every chunk up to and including the densest one.
    for (let i = 0; i <= best.start; i += CHUNK) {
      await sql.begin(async (tx) => { await writeFixtureChunkInTx(tx, fixtures.slice(i, i + CHUNK)); });
    }

    // The bot's ledger must show a contiguous old_rp -> new_rp chain, and the
    // profile must equal the LAST link of that chain.
    const ledger = await sql<any[]>`
      SELECT c.old_rp, c.delta_rp, c.new_rp, c.result, m.ended_at
      FROM ranked_rp_changes c JOIN matches m ON m.id = c.match_id
      WHERE c.user_id = ${best.userId} ORDER BY m.ended_at, c.new_rp`;
    expect(ledger.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < ledger.length; i++) {
      // Each fixture starts from the previous fixture's result — the proof the
      // fold threaded state forward instead of reusing the chunk-open snapshot.
      expect(ledger[i].old_rp).toBe(ledger[i - 1].new_rp);
    }
    for (const row of ledger) expect(row.new_rp).toBe(Math.max(0, row.old_rp + row.delta_rp));

    const [profile] = await sql<any[]>`
      SELECT rp, current_win_streak, last_ranked_match_at, updated_at
      FROM ranked_profiles WHERE user_id = ${best.userId}`;
    expect(profile.rp).toBe(ledger[ledger.length - 1].new_rp);

    // Streak = the length of the trailing win run (0 if the last result was a loss).
    let expectedStreak = 0;
    for (let i = ledger.length - 1; i >= 0 && ledger[i].result === 'win'; i--) expectedStreak++;
    expect(profile.current_win_streak).toBe(expectedStreak);

    // Profile timestamps carry the bot's LAST fixture time, never NOW().
    expect(new Date(profile.updated_at).toISOString())
      .toBe(new Date(profile.last_ranked_match_at).toISOString());
    expect(new Date(profile.last_ranked_match_at).toISOString())
      .toBe(new Date(ledger[ledger.length - 1].ended_at).toISOString());

    // games_played must count EVERY fixture, not one per chunk.
    const [stats] = await sql<any[]>`
      SELECT games_played, wins, losses FROM user_mode_match_stats
      WHERE user_id = ${best.userId} AND mode = 'ranked'`;
    expect(stats.games_played).toBe(ledger.length);
    expect(stats.wins).toBe(ledger.filter((r) => r.result === 'win').length);
    expect(stats.losses).toBe(ledger.filter((r) => r.result === 'loss').length);

    // total_xp must be the SUM over all the bot's fixtures.
    const [user] = await sql<any[]>`SELECT total_xp FROM users WHERE id = ${best.userId}`;
    const [xpSum] = await sql<any[]>`
      SELECT COALESCE(SUM(xp_delta), 0)::int AS s FROM user_xp_events WHERE user_id = ${best.userId}`;
    expect(Number(user.total_xp)).toBe(xpSum.s); // total_xp is bigint → string
    expect(xpSum.s).toBeGreaterThan(0);
  }, 300_000);

  /**
   * The batched rows must ALSO be accepted by the resume validator when the
   * BATCHED writer wrote the prefix — i.e. a batched run that crashes can be
   * resumed. Guards the exact ranked_context/state_payload/seat shape.
   */
  it('RESUME: batched-written matches satisfy the skip-by-id validation predicates', async () => {
    if (!dbAvailable) return;

    const roster = await buildRoster('val');
    const plan = planFor(roster);
    const fixtures = plan.schedule.fixtures;
    const prefix = fixtures.slice(0, CHUNK);

    await sql.begin(async (tx) => { await writeSeededProfilesInTx(tx, plan.schedule.seededBots); });
    await sql.begin(async (tx) => { await writeFixtureChunkInTx(tx, prefix); });

    const { validatedExistingMatchIds } = await import('../../scripts/bot-burnin/data.js');
    const done = await validatedExistingMatchIds(fixtures);
    expect(done.size).toBe(prefix.length);
    for (const f of prefix) expect(done.has(f.matchId)).toBe(true);
  }, 300_000);
});
