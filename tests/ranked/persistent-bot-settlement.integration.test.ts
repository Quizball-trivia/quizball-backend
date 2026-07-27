/**
 * Integration tests for persistent-bot ranked settlement (PR2) against the real
 * test DB. Mirrors the fixture/skip pattern of
 * tests/matches/matches.service.orchestrators.integration.test.ts.
 *
 * Proven end-to-end here:
 *   - a persistent bot settles a REAL ranked_profiles row on both sides: RP,
 *     W/L, streak move; a ranked_rp_changes ledger row is written for the bot
 *   - the bot earns ZERO coins (its users.coins stays 0) while the human earns
 *     the win coin reward
 *   - the bot accrues XP (progression is in scope) — a user_xp_events row exists
 *   - the season reset zeroes persistent bots' profiles but leaves
 *     ephemeral/auction/seed profiles untouched
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/ranked/persistent-bot-settlement.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let rankedService: typeof import('../../src/modules/ranked/ranked.service.js').rankedService;
let progressionService: typeof import('../../src/modules/progression/progression.service.js').progressionService;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];
const testBatchIds: string[] = [];

async function seedUser(opts: {
  nickname: string;
  isAi?: boolean;
  aiKind?: 'ephemeral' | 'persistent' | 'auction';
  isSeed?: boolean;
  coins?: number;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
    VALUES (
      ${opts.nickname},
      ${opts.isAi ?? false},
      ${opts.isAi ? opts.aiKind ?? 'ephemeral' : null},
      ${opts.isSeed ?? false},
      ${opts.coins ?? 0},
      true
    )
    RETURNING id
  `;
  testUserIds.push(row.id);
  return row.id;
}

async function seedCompletedRankedMatch(opts: {
  playerA: string;
  goalsA: number;
  playerB: string;
  goalsB: number;
  winnerUserId: string | null;
  isPlacementContext?: boolean;
}): Promise<string> {
  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (
      mode, status, current_q_index, total_questions,
      state_payload, ranked_context, winner_user_id, started_at, ended_at
    )
    VALUES (
      'ranked', 'completed', 12, 12,
      ${sql.json({ winnerDecisionMethod: 'goals' })},
      ${sql.json({ isPlacement: opts.isPlacementContext ?? false })},
      ${opts.winnerUserId},
      NOW(), NOW()
    )
    RETURNING id
  `;
  testMatchIds.push(match.id);

  await sql`
    INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    VALUES
      (${match.id}, ${opts.playerA}, 1, 900, 6, ${opts.goalsA}, 0),
      (${match.id}, ${opts.playerB}, 2, 400, 3, ${opts.goalsB}, 0)
  `;
  return match.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    rankedService = (await import('../../src/modules/ranked/ranked.service.js')).rankedService;
    progressionService = (await import('../../src/modules/progression/progression.service.js')).progressionService;
  } catch {
    console.warn(
      '\n⚠️  Skipping persistent-bot settlement integration tests: DB unavailable.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${testMatchIds}::uuid[])`;
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testBatchIds.length > 0) {
    await sql`DELETE FROM ranked_rp_changes_archive WHERE reset_batch_id = ANY(${testBatchIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles_archive WHERE reset_batch_id = ANY(${testBatchIds}::uuid[])`;
    await sql`DELETE FROM ranked_reset_batches WHERE id = ANY(${testBatchIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM user_xp_events WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('settleCompletedRankedMatch — persistent bot both-sides settlement', () => {
  it('settles the bot: real profile, RP+streak move, ledger row, coins stay 0', async ({ skip }) => {
    if (!dbAvailable) skip();

    const human = await seedUser({ nickname: `pbs_human_${Date.now()}`, coins: 500 });
    const bot = await seedUser({
      nickname: `pbs_bot_${Date.now()}`,
      isAi: true,
      aiKind: 'persistent',
      coins: 0,
    });

    // Bot wins 2-0.
    const matchId = await seedCompletedRankedMatch({
      playerA: human, goalsA: 0,
      playerB: bot, goalsB: 2,
      winnerUserId: bot,
    });

    const outcome = await rankedService.settleCompletedRankedMatch(matchId);
    expect(outcome).not.toBeNull();

    // Bot got a real profile ensured-on-settle, RP moved up (win by 2 = +65).
    const [botProfile] = await sql<{ rp: number; current_win_streak: number; placement_status: string }[]>`
      SELECT rp, current_win_streak, placement_status FROM ranked_profiles WHERE user_id = ${bot}
    `;
    expect(botProfile).toBeDefined();
    expect(botProfile.rp).toBe(450 + 65); // starter 450 + win-by-2
    expect(botProfile.current_win_streak).toBe(1);

    // Ledger row written for the bot with a win result.
    const [botLedger] = await sql<{ result: string; delta_rp: number; coins_awarded: number }[]>`
      SELECT result, delta_rp, coins_awarded FROM ranked_rp_changes
      WHERE match_id = ${matchId} AND user_id = ${bot}
    `;
    expect(botLedger).toBeDefined();
    expect(botLedger.result).toBe('win');
    expect(botLedger.delta_rp).toBe(65);
    expect(botLedger.coins_awarded).toBe(0);

    // Bot coins UNCHANGED at 0; human earned the win coin reward.
    const [botUser] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${bot}`;
    expect(botUser.coins).toBe(0);
    const [humanUser] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${human}`;
    expect(humanUser.coins).toBeGreaterThan(500); // starter 500 + loss reward

    // Human also settled (loss).
    const [humanLedger] = await sql<{ result: string; coins_awarded: number }[]>`
      SELECT result, coins_awarded FROM ranked_rp_changes
      WHERE match_id = ${matchId} AND user_id = ${human}
    `;
    expect(humanLedger.result).toBe('loss');
    expect(humanLedger.coins_awarded).toBeGreaterThan(0);
  });

  it('grants XP to a persistent bot (progression is in scope)', async ({ skip }) => {
    if (!dbAvailable) skip();

    const human = await seedUser({ nickname: `pbs_xp_human_${Date.now()}` });
    const bot = await seedUser({
      nickname: `pbs_xp_bot_${Date.now()}`,
      isAi: true,
      aiKind: 'persistent',
      coins: 0,
    });
    const matchId = await seedCompletedRankedMatch({
      playerA: human, goalsA: 3,
      playerB: bot, goalsB: 0,
      winnerUserId: human,
    });

    await progressionService.awardCompletedMatchXp(matchId);

    const [botXp] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM user_xp_events
      WHERE user_id = ${bot} AND source_key = ${matchId}
    `;
    expect(botXp.count).toBe(1);

    const [botTotal] = await sql<{ total_xp: number }[]>`SELECT total_xp::int AS total_xp FROM users WHERE id = ${bot}`;
    expect(botTotal.total_xp).toBeGreaterThan(0);
  });

  it('leaves an ephemeral AI opponent unsettled (regression: no profile, no ledger)', async ({ skip }) => {
    if (!dbAvailable) skip();

    const human = await seedUser({ nickname: `pbs_eph_human_${Date.now()}` });
    const ai = await seedUser({
      nickname: `pbs_eph_ai_${Date.now()}`,
      isAi: true,
      aiKind: 'ephemeral',
    });
    const matchId = await seedCompletedRankedMatch({
      playerA: human, goalsA: 2,
      playerB: ai, goalsB: 0,
      winnerUserId: human,
    });

    await rankedService.settleCompletedRankedMatch(matchId);

    const aiProfile = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_profiles WHERE user_id = ${ai}
    `;
    expect(aiProfile).toEqual([]);
    const aiLedger = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${ai}
    `;
    expect(aiLedger).toEqual([]);
  });
});

describe('resetLeaderboard — persistent bots included, others excluded', () => {
  it('zeroes persistent bots but spares ephemeral / auction / seed profiles', async ({ skip }) => {
    if (!dbAvailable) skip();

    const admin = await seedUser({ nickname: `pbs_reset_admin_${Date.now()}` });
    const persistent = await seedUser({
      nickname: `pbs_reset_persistent_${Date.now()}`,
      isAi: true, aiKind: 'persistent', coins: 0,
    });
    const ephemeral = await seedUser({
      nickname: `pbs_reset_ephemeral_${Date.now()}`,
      isAi: true, aiKind: 'ephemeral',
    });
    const auction = await seedUser({
      nickname: `pbs_reset_auction_${Date.now()}`,
      isAi: true, aiKind: 'auction',
    });
    const seed = await seedUser({
      nickname: `pbs_reset_seed_${Date.now()}`,
      isSeed: true,
    });

    // Give each a non-zero ranked profile so a reset is observable.
    for (const id of [persistent, ephemeral, auction, seed]) {
      await sql`
        INSERT INTO ranked_profiles (
          user_id, rp, tier, placement_status, placement_required,
          placement_played, placement_wins, placement_seed_rp,
          placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
          current_win_streak
        )
        VALUES (${id}, 1500, 'Rotation', 'placed', 3, 3, 2, 1500, 0, 0, 0, 4)
      `;
    }

    const result = await rankedService.resetLeaderboard({ actorId: admin, notes: 'pbs test reset' });
    testBatchIds.push(result.batchId);

    const rows = await sql<{ user_id: string; rp: number; tier: string }[]>`
      SELECT user_id, rp, tier FROM ranked_profiles
      WHERE user_id = ANY(${[persistent, ephemeral, auction, seed]}::uuid[])
    `;
    const byId = new Map(rows.map((r) => [r.user_id, r]));

    // Persistent bot RESET to 0 / Academy.
    expect(byId.get(persistent)?.rp).toBe(0);
    expect(byId.get(persistent)?.tier).toBe('Academy');

    // Ephemeral, auction, and seed UNTOUCHED.
    expect(byId.get(ephemeral)?.rp).toBe(1500);
    expect(byId.get(auction)?.rp).toBe(1500);
    expect(byId.get(seed)?.rp).toBe(1500);
  });
});
