/**
 * WL QP accrual — settlement-path integration tests against the local DB.
 *
 * Proves the properties the design depends on:
 *  - QP lands exactly once per (match, user) even when the same match is
 *    settled repeatedly (the replay/crash-retry path);
 *  - the accrual week comes from the match's ended_at, not from when the
 *    settlement ran;
 *  - matches ended outside Mon 00:00–Fri 12:00 GE accrue nothing;
 *  - bots accrue nothing even when their RP settles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let sql: typeof import('../../src/db/index.js').sql;
let rankedService: typeof import('../../src/modules/ranked/ranked.service.js').rankedService;
let rankedRepo: typeof import('../../src/modules/ranked/ranked.repo.js').rankedRepo;
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

async function seedCompletedMatch(
  winner: string,
  loser: string,
  endedAt: Date,
): Promise<string> {
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO matches (
      mode, status, current_q_index, total_questions, state_payload,
      ranked_context, winner_user_id, started_at, ended_at
    )
    VALUES (
      'ranked', 'completed', 12, 12, ${sql.json({ winnerDecisionMethod: 'goals' })},
      ${sql.json({ isPlacement: false })}, ${winner},
      ${new Date(endedAt.getTime() - 10 * 60 * 1000)}, ${endedAt}
    )
    RETURNING id
  `;
  testMatchIds.push(m.id);
  await sql`
    INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    VALUES (${m.id}, ${winner}, 1, 900, 6, 2, 0), (${m.id}, ${loser}, 2, 400, 3, 0, 0)
  `;
  return m.id;
}

async function qpRows(userId: string) {
  const awards = await sql<{ match_id: string; week_key: string; points: number; result: string }[]>`
    SELECT match_id, week_key::text, points, result FROM wl_qp_awards WHERE user_id = ${userId} ORDER BY created_at
  `;
  const totals = await sql<{ week_key: string; points: number; wins: number; losses: number }[]>`
    SELECT week_key::text, points, wins, losses FROM wl_qp WHERE user_id = ${userId}
  `;
  return { awards, totals };
}

// Wednesday 18:00 Georgia (14:00 UTC) of the week whose Saturday is 2026-08-01.
const IN_WINDOW = new Date('2026-07-29T14:00:00Z');
// Saturday inside the same week — outside the accrual window.
const OUT_OF_WINDOW = new Date('2026-08-01T14:00:00Z');

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    rankedService = (await import('../../src/modules/ranked/ranked.service.js')).rankedService;
    rankedRepo = (await import('../../src/modules/ranked/ranked.repo.js')).rankedRepo;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping WL QP settlement integration tests: DB unavailable.\n');
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM wl_qp_awards WHERE match_id = ANY(${sql.array(testMatchIds)}::uuid[])`;
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${sql.array(testMatchIds)}::uuid[])`;
    await sql`DELETE FROM match_players WHERE match_id = ANY(${sql.array(testMatchIds)}::uuid[])`;
    await sql`DELETE FROM matches WHERE id = ANY(${sql.array(testMatchIds)}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM wl_qp WHERE user_id = ANY(${sql.array(testUserIds)}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${sql.array(testUserIds)}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(testUserIds)}::uuid[])`;
  }
  await sql.end({ timeout: 5 });
});

describe('WL QP settlement accrual', () => {
  it('awards win 25 / loss 10 into the ended_at week, exactly once across replays', async ({ skip }) => {
    if (!dbAvailable) skip();
    const winner = await seedUser(`wlqp-w-${Date.now()}`, false);
    const loser = await seedUser(`wlqp-l-${Date.now()}`, false);
    const matchId = await seedCompletedMatch(winner, loser, IN_WINDOW);

    const outcome = await rankedService.settleCompletedRankedMatch(matchId);
    // The result payload carries the QP moment for the client.
    expect(outcome?.byUserId[winner]?.qpAwarded).toBe(25);
    expect(outcome?.byUserId[winner]?.qpWeekTotal).toBe(25);
    expect(outcome?.byUserId[loser]?.qpAwarded).toBe(10);
    // Replay (crash-retry / duplicate event) — must be a no-op for QP, and
    // the replayed payload still reports the original award + current total.
    const replayed = await rankedService.settleCompletedRankedMatch(matchId);
    expect(replayed?.byUserId[winner]?.qpAwarded).toBe(25);
    expect(replayed?.byUserId[winner]?.qpWeekTotal).toBe(25);

    const w = await qpRows(winner);
    expect(w.awards).toEqual([
      { match_id: matchId, week_key: '2026-08-01', points: 25, result: 'win' },
    ]);
    expect(w.totals).toEqual([
      { week_key: '2026-08-01', points: 25, wins: 1, losses: 0 },
    ]);

    const l = await qpRows(loser);
    expect(l.awards).toEqual([
      { match_id: matchId, week_key: '2026-08-01', points: 10, result: 'loss' },
    ]);
    expect(l.totals).toEqual([
      { week_key: '2026-08-01', points: 10, wins: 0, losses: 1 },
    ]);
  });

  it('accumulates totals across multiple matches in the same week', async ({ skip }) => {
    if (!dbAvailable) skip();
    const a = await seedUser(`wlqp-a-${Date.now()}`, false);
    const b = await seedUser(`wlqp-b-${Date.now()}`, false);
    const m1 = await seedCompletedMatch(a, b, IN_WINDOW);
    const m2 = await seedCompletedMatch(b, a, new Date(IN_WINDOW.getTime() + 60 * 60 * 1000));

    await rankedService.settleCompletedRankedMatch(m1);
    await rankedService.settleCompletedRankedMatch(m2);

    const rowsA = await qpRows(a);
    expect(rowsA.totals).toEqual([
      { week_key: '2026-08-01', points: 35, wins: 1, losses: 1 },
    ]);
  });

  it('accrues nothing for matches ended outside the Mon–Fri window', async ({ skip }) => {
    if (!dbAvailable) skip();
    const winner = await seedUser(`wlqp-sat-w-${Date.now()}`, false);
    const loser = await seedUser(`wlqp-sat-l-${Date.now()}`, false);
    const matchId = await seedCompletedMatch(winner, loser, OUT_OF_WINDOW);

    await rankedService.settleCompletedRankedMatch(matchId);

    const w = await qpRows(winner);
    expect(w.awards).toEqual([]);
    expect(w.totals).toEqual([]);
    // RP itself must still have settled — only QP is window-gated.
    const rp = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_rp_changes WHERE match_id = ${matchId}
    `;
    expect(rp.length).toBe(2);
  });

  it('repo-level replay of the IDENTICAL settlement input awards QP once (gate test)', async ({ skip }) => {
    if (!dbAvailable) skip();
    // Calls applySettlement directly twice, bypassing the service's
    // already-settled short-circuit — this fails if the qp_award CTE loses
    // its FROM inserted gating (a bare upsert would double-count totals).
    const winner = await seedUser(`wlqp-gate-w-${Date.now()}`, false);
    const loser = await seedUser(`wlqp-gate-l-${Date.now()}`, false);
    const matchId = await seedCompletedMatch(winner, loser, IN_WINDOW);
    await sql`
      INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required)
      VALUES (${winner}, 1000, 'Bench', 'placed', 3), (${loser}, 1000, 'Bench', 'placed', 3)
      ON CONFLICT (user_id) DO NOTHING
    `;
    const entryFor = (userId: string, result: 'win' | 'loss') => ({
      profile: {
        userId, rp: 1000, tier: 'Bench' as const, placementStatus: 'placed' as const,
        placementPlayed: 3, placementWins: 1, placementSeedRp: null,
        placementPerfSum: 0, placementPointsForSum: 0, placementPointsAgainstSum: 0,
        currentWinStreak: 0,
      },
      change: {
        matchId, userId, opponentUserId: null, opponentIsAi: false,
        oldRp: 1000, deltaRp: 0, newRp: 1000, result, isPlacement: false,
        placementGameNo: null, placementAnchorRp: null, placementPerfScore: null,
        calculationMethod: 'ranked_formula' as const,
      },
      coinsAwarded: 0,
      qpAwarded: result === 'win' ? 25 : 10,
      qpWeekKey: '2026-08-01',
      qpEndedAt: IN_WINDOW,
    });

    const first = await rankedRepo.applySettlement([entryFor(winner, 'win'), entryFor(loser, 'loss')]);
    expect(first.size).toBe(2);
    const second = await rankedRepo.applySettlement([entryFor(winner, 'win'), entryFor(loser, 'loss')]);
    expect(second.size).toBe(0);

    const w = await qpRows(winner);
    expect(w.awards.length).toBe(1);
    expect(w.totals).toEqual([{ week_key: '2026-08-01', points: 25, wins: 1, losses: 0 }]);
  });

  it('repairs QP for a match whose RP settled before the QP feature (replay path)', async ({ skip }) => {
    if (!dbAvailable) skip();
    const winner = await seedUser(`wlqp-rep-w-${Date.now()}`, false);
    const loser = await seedUser(`wlqp-rep-l-${Date.now()}`, false);
    const matchId = await seedCompletedMatch(winner, loser, IN_WINDOW);
    // Simulate a pre-deploy settlement: RP ledger rows exist, no QP rows.
    await sql`
      INSERT INTO ranked_rp_changes (
        match_id, user_id, opponent_user_id, opponent_is_ai, old_rp, delta_rp,
        new_rp, result, is_placement, calculation_method, coins_awarded
      ) VALUES
        (${matchId}, ${winner}, ${loser}, false, 1000, 50, 1050, 'win', false, 'ranked_formula', 0),
        (${matchId}, ${loser}, ${winner}, false, 1000, -25, 975, 'loss', false, 'ranked_formula', 0)
    `;
    await sql`
      INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required)
      VALUES (${winner}, 1050, 'Bench', 'placed', 3), (${loser}, 975, 'Reserve', 'placed', 3)
      ON CONFLICT (user_id) DO NOTHING
    `;

    // The replay short-circuits RP (fully settled) but must repair QP.
    await rankedService.settleCompletedRankedMatch(matchId);
    const w = await qpRows(winner);
    expect(w.awards).toEqual([
      { match_id: matchId, week_key: '2026-08-01', points: 25, result: 'win' },
    ]);
    const l = await qpRows(loser);
    expect(l.totals).toEqual([{ week_key: '2026-08-01', points: 10, wins: 0, losses: 1 }]);

    // Replaying the replay stays exactly-once.
    await rankedService.settleCompletedRankedMatch(matchId);
    const w2 = await qpRows(winner);
    expect(w2.totals).toEqual([{ week_key: '2026-08-01', points: 25, wins: 1, losses: 0 }]);
  });

  it('accrues nothing for bots even though their RP settles', async ({ skip }) => {
    if (!dbAvailable) skip();
    const human = await seedUser(`wlqp-h-${Date.now()}`, false);
    const bot = await seedUser(`wlqp-bot-${Date.now()}`, true);
    const matchId = await seedCompletedMatch(bot, human, IN_WINDOW);

    await rankedService.settleCompletedRankedMatch(matchId);

    const botRows = await qpRows(bot);
    expect(botRows.awards).toEqual([]);
    expect(botRows.totals).toEqual([]);
    // The human loser still earns their participation QP.
    const humanRows = await qpRows(human);
    expect(humanRows.awards.map((r) => r.points)).toEqual([10]);
  });
});
