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
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
let dbAvailable = false;

// Coin participation rewards (source of truth: ranked.service.ts
// RANKED_WIN_COINS / RANKED_LOSS_COINS). Not exported, mirrored here for exact
// balance assertions.
const RANKED_WIN_COINS = 300;
const RANKED_LOSS_COINS = 100;
const STARTER_COINS = 500;

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

// Seed an ACTIVE ranked match with the decision method already persisted (as the
// real flow does before completion), so the test can drive the real
// matchesService.completeMatch — flipping status AND fanning W/L into
// user_mode_match_stats for every player, bots included.
async function seedActiveRankedMatch(opts: {
  playerA: string;
  goalsA: number;
  playerB: string;
  goalsB: number;
  isPlacementContext?: boolean;
}): Promise<string> {
  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (
      mode, status, current_q_index, total_questions,
      state_payload, ranked_context, started_at
    )
    VALUES (
      'ranked', 'active', 12, 12,
      ${sql.json({ winnerDecisionMethod: 'goals' })},
      ${sql.json({ isPlacement: opts.isPlacementContext ?? false })},
      NOW()
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
    matchesService = (await import('../../src/modules/matches/matches.service.js')).matchesService;
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
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('settleCompletedRankedMatch — persistent bot both-sides settlement', () => {
  it('settles the bot end-to-end via completeMatch: profile, RP+streak, W/L stats, ledger, coins stay 0', async ({ skip }) => {
    if (!dbAvailable) skip();

    const human = await seedUser({ nickname: `pbs_human_${Date.now()}`, coins: STARTER_COINS });
    const bot = await seedUser({
      nickname: `pbs_bot_${Date.now()}`,
      isAi: true,
      aiKind: 'persistent',
      coins: 0,
    });

    // Bot wins 2-0. Drive the REAL completion path so user_mode_match_stats W/L
    // is exercised for both the human and the bot, then settle RP.
    const matchId = await seedActiveRankedMatch({
      playerA: human, goalsA: 0,
      playerB: bot, goalsB: 2,
    });
    await matchesService.completeMatch(matchId, bot);

    const outcome = await rankedService.settleCompletedRankedMatch(matchId);
    expect(outcome).not.toBeNull();

    // Bot got a real profile ensured-on-settle, RP moved up (win by 2 = +65).
    const [botProfile] = await sql<{ rp: number; current_win_streak: number; placement_status: string }[]>`
      SELECT rp, current_win_streak, placement_status FROM ranked_profiles WHERE user_id = ${bot}
    `;
    expect(botProfile).toBeDefined();
    expect(botProfile.rp).toBe(450 + 65); // starter 450 + win-by-2
    expect(botProfile.current_win_streak).toBe(1);

    // The real completion path aggregated a WIN for the bot and a LOSS for the
    // human into user_mode_match_stats (persistent bots count like humans here).
    const [botStats] = await sql<{ wins: number; losses: number; games_played: number }[]>`
      SELECT wins, losses, games_played FROM user_mode_match_stats
      WHERE user_id = ${bot} AND mode = 'ranked'
    `;
    expect(botStats).toBeDefined();
    expect(botStats.wins).toBe(1);
    expect(botStats.losses).toBe(0);
    expect(botStats.games_played).toBe(1);
    const [humanStats] = await sql<{ wins: number; losses: number }[]>`
      SELECT wins, losses FROM user_mode_match_stats
      WHERE user_id = ${human} AND mode = 'ranked'
    `;
    expect(humanStats.wins).toBe(0);
    expect(humanStats.losses).toBe(1);

    // Ledger row written for the bot with a win result.
    const [botLedger] = await sql<{ result: string; delta_rp: number; coins_awarded: number }[]>`
      SELECT result, delta_rp, coins_awarded FROM ranked_rp_changes
      WHERE match_id = ${matchId} AND user_id = ${bot}
    `;
    expect(botLedger).toBeDefined();
    expect(botLedger.result).toBe('win');
    expect(botLedger.delta_rp).toBe(65);
    expect(botLedger.coins_awarded).toBe(0);

    // Bot coins UNCHANGED at exactly 0; human earned exactly the loss reward.
    const [botUser] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${bot}`;
    expect(botUser.coins).toBe(0);
    const [humanUser] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${human}`;
    expect(humanUser.coins).toBe(STARTER_COINS + RANKED_LOSS_COINS);

    // Human also settled (loss) with exactly the loss coin reward.
    const [humanLedger] = await sql<{ result: string; coins_awarded: number }[]>`
      SELECT result, coins_awarded FROM ranked_rp_changes
      WHERE match_id = ${matchId} AND user_id = ${human}
    `;
    expect(humanLedger.result).toBe('loss');
    expect(humanLedger.coins_awarded).toBe(RANKED_LOSS_COINS);
  });

  it('a human beating a persistent bot earns exactly the win coin reward', async ({ skip }) => {
    if (!dbAvailable) skip();

    const human = await seedUser({ nickname: `pbs_wincoin_human_${Date.now()}`, coins: STARTER_COINS });
    const bot = await seedUser({
      nickname: `pbs_wincoin_bot_${Date.now()}`, isAi: true, aiKind: 'persistent', coins: 0,
    });
    const matchId = await seedActiveRankedMatch({ playerA: human, goalsA: 3, playerB: bot, goalsB: 0 });
    await matchesService.completeMatch(matchId, human);
    await rankedService.settleCompletedRankedMatch(matchId);

    const [humanUser] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${human}`;
    expect(humanUser.coins).toBe(STARTER_COINS + RANKED_WIN_COINS);
    const [botUser] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${bot}`;
    expect(botUser.coins).toBe(0);
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
    const matchId = await seedActiveRankedMatch({
      playerA: human, goalsA: 3,
      playerB: bot, goalsB: 0,
    });
    await matchesService.completeMatch(matchId, human);

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
    const matchId = await seedActiveRankedMatch({
      playerA: human, goalsA: 2,
      playerB: ai, goalsB: 0,
    });
    await matchesService.completeMatch(matchId, human);

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

describe('resetLeaderboard predicate — persistent bots included, others excluded', () => {
  // resetLeaderboard is GLOBAL: calling the real service would zero every
  // settle-eligible profile in the shared test DB and flake parallel suites.
  // We instead run the production reset UPDATE + archive INSERT predicates
  // inside a rolled-back transaction (same pattern as the ai-kind-safety
  // cleanup_ai_users test), capturing assertions into outer variables so NO
  // global mutation ever persists.
  it('zeroes/archives persistent bots but spares ephemeral / auction / seed', async ({ skip }) => {
    if (!dbAvailable) skip();

    // Predicate shared by the live reset UPDATE and both archive INSERTs
    // (ranked.repo.ts). Kept in one string so the test can't drift between them.
    const eligiblePredicate = `
      (u.is_ai = false OR u.ai_kind = 'persistent')
      AND u.is_seed = false
      AND u.is_deleted = false
      AND u.deleted_at IS NULL
      AND u.pending_deletion_at IS NULL
    `;

    const resetRp: Record<string, number> = {};
    const archived: Record<string, boolean> = {};
    const rollback = Symbol('rollback');

    await sql
      .begin(async (tx) => {
        const mkUser = async (label: string, opts: { isAi?: boolean; aiKind?: string; isSeed?: boolean }) => {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
            VALUES (${`pbs_reset_${label}_${Date.now()}`}, ${opts.isAi ?? false}, ${opts.aiKind ?? null}, ${opts.isSeed ?? false}, 0, true)
            RETURNING id
          `;
          return row.id;
        };

        const ids: Record<string, string> = {
          persistent: await mkUser('persistent', { isAi: true, aiKind: 'persistent' }),
          human: await mkUser('human', {}),
          ephemeral: await mkUser('ephemeral', { isAi: true, aiKind: 'ephemeral' }),
          auction: await mkUser('auction', { isAi: true, aiKind: 'auction' }),
          seed: await mkUser('seed', { isSeed: true }),
        };
        const all = Object.values(ids);

        for (const id of all) {
          await tx`
            INSERT INTO ranked_profiles (
              user_id, rp, tier, placement_status, placement_required,
              placement_played, placement_wins, placement_seed_rp,
              placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
              current_win_streak
            )
            VALUES (${id}, 1500, 'Rotation', 'placed', 3, 3, 2, 1500, 0, 0, 0, 4)
          `;
        }

        const [batch] = await tx<{ id: string }[]>`
          INSERT INTO ranked_reset_batches (notes) VALUES ('pbs in-tx predicate test') RETURNING id
        `;

        // Production ARCHIVE predicate (profiles snapshot) — item 2.
        await tx.unsafe(
          `INSERT INTO ranked_profiles_archive (
            reset_batch_id, user_id, rp, tier, placement_status,
            placement_required, placement_played, placement_wins, placement_seed_rp,
            placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
            current_win_streak, last_ranked_match_at
          )
          SELECT $1, rp.user_id, rp.rp, rp.tier, rp.placement_status,
            rp.placement_required, rp.placement_played, rp.placement_wins, rp.placement_seed_rp,
            rp.placement_perf_sum, rp.placement_points_for_sum, rp.placement_points_against_sum,
            rp.current_win_streak, rp.last_ranked_match_at
          FROM ranked_profiles rp
          WHERE rp.user_id = ANY($2::uuid[])
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = rp.user_id AND ${eligiblePredicate})`,
          [batch.id, all]
        );

        // Production live-reset predicate.
        await tx.unsafe(
          `UPDATE ranked_profiles rp
           SET rp = 0, tier = 'Academy', updated_at = NOW()
           WHERE rp.user_id = ANY($1::uuid[])
             AND EXISTS (SELECT 1 FROM users u WHERE u.id = rp.user_id AND ${eligiblePredicate})`,
          [all]
        );

        const rpRows = await tx<{ user_id: string; rp: number }[]>`
          SELECT user_id, rp FROM ranked_profiles WHERE user_id = ANY(${all}::uuid[])
        `;
        const rpByUser = new Map(rpRows.map((r) => [r.user_id, r.rp]));
        const archivedRows = await tx<{ user_id: string }[]>`
          SELECT user_id FROM ranked_profiles_archive WHERE reset_batch_id = ${batch.id}
        `;
        const archivedSet = new Set(archivedRows.map((r) => r.user_id));

        for (const [label, id] of Object.entries(ids)) {
          resetRp[label] = rpByUser.get(id) ?? -1;
          archived[label] = archivedSet.has(id);
        }

        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    // Live reset: persistent + human zeroed; ephemeral/auction/seed untouched.
    expect(resetRp.persistent).toBe(0);
    expect(resetRp.human).toBe(0);
    expect(resetRp.ephemeral).toBe(1500);
    expect(resetRp.auction).toBe(1500);
    expect(resetRp.seed).toBe(1500);

    // Archive snapshot: only the settle-eligible (persistent + human) captured.
    expect(archived.persistent).toBe(true);
    expect(archived.human).toBe(true);
    expect(archived.ephemeral).toBe(false);
    expect(archived.auction).toBe(false);
    expect(archived.seed).toBe(false);
  });
});
