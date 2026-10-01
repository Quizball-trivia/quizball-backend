/**
 * WL reward delivery — integration tests against the local DB.
 *
 * Proves the properties the payout depends on:
 *  - every band pays its exact amount once, highest band only;
 *  - "played" means an accepted answer, and placement needs a played final;
 *  - bots, seed, banned, deleted and disqualified accounts get nothing and do
 *    not consume human ranks;
 *  - repeat and concurrent settlement never double-pays;
 *  - bands frozen before payment are not re-ranked when an account forfeits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.WL_REWARDS_ENABLED = 'true';
process.env.WL_REWARDS_FROM_WEEK = '2099-01-01';

let sql: typeof import('../../src/db/index.js').sql;
let rewards: typeof import('../../src/modules/weekend-league/wl-rewards.js');
let config: typeof import('../../src/core/config.js').config;
let dbAvailable = false;

const WL_TEST_LOCK = 774431001;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;
const tournamentIds: string[] = [];
const userIds: string[] = [];
let weekCounter = 0;

function nextWeek(): string {
  weekCounter += 1;
  const day = new Date(Date.UTC(2099, 0, 3 + weekCounter * 7));
  return day.toISOString().slice(0, 10);
}

interface TournamentSeed { id: string; weekKey: string | null; qualifierRun: string; voidedRun: string; finalRun: string }

async function seedTournament(opts: {
  status?: string; isTest?: boolean; finalPlayed?: boolean; weekKey?: string | null;
  rewardPayout?: boolean;
} = {}): Promise<TournamentSeed> {
  const weekKey = opts.weekKey === undefined ? nextWeek() : opts.weekKey;
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO wl_tournaments (week_key, is_test, status, final_played, config)
    VALUES (${weekKey}, ${opts.isTest ?? false}, ${opts.status ?? 'completed'},
            ${opts.finalPlayed ?? true}, ${sql.json({ qp_target: 0, reward_payout: opts.rewardPayout ?? false })})
    RETURNING id
  `;
  tournamentIds.push(t.id);
  const run = async (gameIndex: number, questionIndex: number, status: string): Promise<string> => {
    const [q] = await sql<{ question_id: string }[]>`
      INSERT INTO wl_questions (tournament_id, game_index, round_index, question_index, kind, payload, evaluation)
      VALUES (${t.id}, ${gameIndex}, 0, ${questionIndex}, 'mcq', '{}'::jsonb, '{}'::jsonb)
      RETURNING question_id
    `;
    const [r] = await sql<{ attempt_id: string }[]>`
      INSERT INTO wl_question_runs (tournament_id, game_index, round_index, question_index, question_id, status)
      VALUES (${t.id}, ${gameIndex}, 0, ${questionIndex}, ${q.question_id}, ${status})
      RETURNING attempt_id
    `;
    return r.attempt_id;
  };
  return {
    id: t.id,
    weekKey,
    qualifierRun: await run(0, 0, 'revealed'),
    voidedRun: await run(0, 1, 'voided'),
    finalRun: await run(3, 0, 'revealed'),
  };
}

interface PlayerSeed {
  ai?: boolean; seed?: boolean; banned?: boolean; deleted?: boolean;
  state?: string;
  checkedIn?: boolean;
  qualifierAnswer?: 'accepted' | 'voided' | 'none';
  finalCheckedIn?: boolean;
  finalAnswer?: boolean;
  /** Overall rank on the final board; also writes the result row. */
  finalRank?: number;
  coins?: number;
}

async function seedPlayer(t: TournamentSeed, label: string, p: PlayerSeed = {}): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, is_seed, is_banned, is_deleted, deleted_at, coins, onboarding_complete)
    VALUES (${`wlr-${label}-${Math.random().toString(36).slice(2, 10)}`}, ${p.ai ?? false},
            ${p.ai ? 'persistent' : null}, ${p.seed ?? false}, ${p.banned ?? false},
            ${p.deleted ?? false}, ${p.deleted ? new Date() : null}, ${p.coins ?? 100}, true)
    RETURNING id
  `;
  userIds.push(u.id);
  const now = new Date();
  await sql`
    INSERT INTO wl_entries (tournament_id, user_id, state, checked_in_at, final_checked_in_at, final_rank)
    VALUES (${t.id}, ${u.id}, ${p.state ?? 'eliminated'}, ${p.checkedIn === false ? null : now},
            ${p.finalCheckedIn ? now : null}, ${p.finalRank ?? null})
  `;
  const answer = async (attemptId: string, gameIndex: number, timingSource: string) => {
    await sql`
      INSERT INTO wl_answers (attempt_id, user_id, tournament_id, game_index, answer, correct, points, elapsed_ms, time_charge_ms, timing_source)
      VALUES (${attemptId}, ${u.id}, ${t.id}, ${gameIndex}, '{}'::jsonb, false, 0, 1000, 1000, ${timingSource})
    `;
  };
  const qualifierAnswer = p.qualifierAnswer ?? 'accepted';
  if (qualifierAnswer === 'accepted') await answer(t.qualifierRun, 0, 'redis_accept');
  if (qualifierAnswer === 'voided') await answer(t.voidedRun, 0, 'voided_audit');
  if (p.finalAnswer) await answer(t.finalRun, 3, 'redis_accept');
  if (p.finalRank != null) {
    await sql`
      INSERT INTO wl_game_results (tournament_id, game_index, user_id, score, time_ms_total, rank, advanced)
      VALUES (${t.id}, 3, ${u.id}, ${1000 - p.finalRank}, 60000, ${p.finalRank}, false)
    `;
  }
  return u.id;
}

/** A finalist who checked in on Sunday and played the final at this overall rank. */
const finalist = (finalRank: number, extra: PlayerSeed = {}): PlayerSeed => ({
  state: finalRank === 1 ? 'champion' : 'finalist', finalCheckedIn: true, finalAnswer: true, finalRank, ...extra,
});

async function receiptOf(tournamentId: string, userId: string) {
  const [row] = await sql<Array<{
    band: string; coins: number; status: string; human_rank: number | null;
    items: Array<{ slug: string; alreadyOwned?: boolean }>; forfeit_reason: string | null;
  }>>`
    SELECT band, coins, status, human_rank, items, forfeit_reason
    FROM wl_reward_receipts WHERE tournament_id = ${tournamentId} AND user_id = ${userId}
  `;
  return row ?? null;
}

async function settlementOf(tournamentId: string) {
  const [row] = await sql<Array<{ frozen: boolean; settled: boolean; attempts: number; last_error: string | null }>>`
    SELECT frozen_at IS NOT NULL AS frozen, settled_at IS NOT NULL AS settled, attempts, last_error
    FROM wl_reward_settlements WHERE tournament_id = ${tournamentId}
  `;
  return row ?? null;
}

async function coinsOf(userId: string): Promise<number> {
  const [row] = await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${userId}`;
  return row.coins;
}

async function ledgerOf(userId: string) {
  const rows = await sql<Array<{ coins_delta: number; inventory_delta: unknown; idempotency_key: string }>>`
    SELECT coins_delta, inventory_delta, idempotency_key FROM store_transaction_logs
    WHERE user_id = ${userId} AND event_type = 'wl_reward'
  `;
  // storeRepo.insertTransactionLogInTx stores its JSON columns as a jsonb
  // string (existing behaviour for every ledger writer that uses it).
  return rows.map((row) => ({
    ...row,
    inventory_delta: (typeof row.inventory_delta === 'string'
      ? JSON.parse(row.inventory_delta) : row.inventory_delta) as Record<string, number>,
  }));
}

async function inventoryOf(userId: string) {
  return sql<Array<{ slug: string; quantity: number }>>`
    SELECT sp.slug, ui.quantity FROM user_inventory ui
    JOIN store_products sp ON sp.id = ui.product_id WHERE ui.user_id = ${userId}
  `;
}

beforeAll(async () => {
  const dbModule = await import('../../src/db/index.js');
  sql = dbModule.sql;
  try {
    await sql`SELECT 1`;
  } catch {
    // Same convention as the other WL integration files: no local DB, no run.
    console.warn('\n⚠️  Skipping WL reward integration tests: DB unavailable.\n');
    return;
  }
  // Past this point nothing may be swallowed: a missing migration or a broken
  // import must fail the suite, not turn every test into a silent pass.
  await sql`SELECT 1 FROM wl_reward_receipts, wl_reward_settlements LIMIT 1`;
  rewards = await import('../../src/modules/weekend-league/wl-rewards.js');
  config = (await import('../../src/core/config.js')).config;
  lockConn = await sql.reserve();
  await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
  dbAvailable = true;
}, 120_000);

afterAll(async () => {
  if (dbAvailable) {
    const t = sql.array(tournamentIds);
    const u = sql.array(userIds);
    await sql`DELETE FROM wl_reward_receipts WHERE tournament_id = ANY(${t}::uuid[])`;
    await sql`DELETE FROM wl_reward_settlements WHERE tournament_id = ANY(${t}::uuid[])`;
    await sql`DELETE FROM store_transaction_logs WHERE user_id = ANY(${u}::uuid[])`;
    await sql`DELETE FROM user_inventory WHERE user_id = ANY(${u}::uuid[])`;
    await sql`DELETE FROM wl_game_results WHERE tournament_id = ANY(${t}::uuid[])`;
    await sql`DELETE FROM wl_entries WHERE tournament_id = ANY(${t}::uuid[])`;
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${t}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${u}::uuid[])`;
  }
  if (lockConn) {
    await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`;
    lockConn.release();
  }
}, 120_000);

describe('WL reward delivery', () => {
  it('pays every band its exact amount once and skips everyone the policy excludes', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    // Overall rank 1 is a bot, so humans start at overall rank 2.
    const bot = await seedPlayer(t, 'bot', finalist(1, { ai: true }));
    const winner = await seedPlayer(t, 'winner', finalist(2));
    // Checked in on Sunday, sits on the board ABOVE real players, never answered:
    // no placement, and it must not push the humans below it down a rank.
    const idleFinalist = await seedPlayer(t, 'idle', { state: 'finalist', finalCheckedIn: true, finalRank: 3 });
    const second = await seedPlayer(t, 'second', finalist(4));
    const banned = await seedPlayer(t, 'banned', finalist(5, { banned: true }));
    const third = await seedPlayer(t, 'third', finalist(6));
    const top10: string[] = [];
    for (let rank = 7; rank <= 13; rank += 1) top10.push(await seedPlayer(t, `top10-${rank}`, finalist(rank)));
    const eleventh = await seedPlayer(t, 'eleventh', finalist(14));
    const noShow = await seedPlayer(t, 'noshow', { state: 'no_show' });
    const eliminated = await seedPlayer(t, 'eliminated');
    const registeredOnly = await seedPlayer(t, 'registered', { state: 'entered', checkedIn: false, qualifierAnswer: 'none' });
    const checkedInIdle = await seedPlayer(t, 'checkedin-idle', { qualifierAnswer: 'none' });
    const voidedOnly = await seedPlayer(t, 'voided-only', { qualifierAnswer: 'voided' });
    const seedAccount = await seedPlayer(t, 'seed', { seed: true });
    const deleted = await seedPlayer(t, 'deleted', { deleted: true });
    const disqualified = await seedPlayer(t, 'dq', finalist(15, { state: 'disqualified' }));

    const result = await rewards.settleWlRewards(t.id, { limit: 100 });
    expect(result.freeze).toEqual({ frozen: true, receipts: 14 });
    expect(result).toMatchObject({ granted: 14, forfeited: 0, failed: 0, remaining: 0, settled: true });

    const expectPaid = async (userId: string, band: string, coins: number, humanRank: number | null) => {
      expect(await receiptOf(t.id, userId)).toMatchObject({ band, coins, status: 'granted', human_rank: humanRank });
      expect(await coinsOf(userId)).toBe(100 + coins);
      const ledger = await ledgerOf(userId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ coins_delta: coins, idempotency_key: `wl_reward:${t.id}:${userId}` });
    };
    await expectPaid(winner, 'winner', 40000, 1);
    await expectPaid(second, 'second', 25000, 2);
    await expectPaid(third, 'third', 15000, 3);
    for (const [i, userId] of top10.entries()) await expectPaid(userId, 'top10', 8000, 4 + i);
    await expectPaid(eleventh, 'finalist', 4000, null);
    await expectPaid(idleFinalist, 'finalist', 4000, null);
    await expectPaid(noShow, 'participant', 1500, null);
    await expectPaid(eliminated, 'participant', 1500, null);

    expect(await inventoryOf(winner)).toEqual([{ slug: 'avatar_jersey_wl_retro_home', quantity: 1 }]);
    expect(await inventoryOf(second)).toEqual([{ slug: 'avatar_jersey_wl_retro_away', quantity: 1 }]);
    expect(await inventoryOf(third)).toEqual([{ slug: 'avatar_jersey_wl_retro_training', quantity: 1 }]);
    expect((await ledgerOf(winner))[0].inventory_delta).toEqual({ avatar_jersey_wl_retro_home: 1 });
    expect(await inventoryOf(top10[0])).toEqual([]);

    for (const userId of [bot, banned, registeredOnly, checkedInIdle, voidedOnly, seedAccount, deleted, disqualified]) {
      expect(await receiptOf(t.id, userId)).toBeNull();
      expect(await coinsOf(userId)).toBe(100);
      expect(await ledgerOf(userId)).toHaveLength(0);
    }

    expect(await settlementOf(t.id)).toMatchObject({ frozen: true, settled: true, last_error: null });
  }, 120_000);

  it('pays once when settlement is repeated or raced', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const winner = await seedPlayer(t, 'race-winner', finalist(1));
    const participant = await seedPlayer(t, 'race-participant');

    const outcomes = await Promise.all([
      rewards.settleWlRewards(t.id),
      rewards.settleWlRewards(t.id),
      rewards.settleWlRewards(t.id),
    ]);
    expect(outcomes.reduce((n, o) => n + o.granted, 0)).toBe(2);
    await rewards.settleWlRewards(t.id);

    expect(await coinsOf(winner)).toBe(100 + 40000);
    expect(await coinsOf(participant)).toBe(100 + 1500);
    expect(await ledgerOf(winner)).toHaveLength(1);
    expect(await ledgerOf(participant)).toHaveLength(1);
    expect(await inventoryOf(winner)).toEqual([{ slug: 'avatar_jersey_wl_retro_home', quantity: 1 }]);
  }, 120_000);

  it('resumes across bounded passes without paying anyone twice', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const players = [await seedPlayer(t, 'pass-a'), await seedPlayer(t, 'pass-b'), await seedPlayer(t, 'pass-c')];

    const first = await rewards.settleWlRewards(t.id, { limit: 1 });
    expect(first).toMatchObject({ granted: 1, remaining: 2, settled: false });
    expect(await settlementOf(t.id)).toMatchObject({ frozen: true, settled: false });
    const rest = await rewards.settleWlRewards(t.id, { limit: 5 });
    expect(rest).toMatchObject({ granted: 2, remaining: 0, settled: true });

    for (const userId of players) {
      expect(await coinsOf(userId)).toBe(100 + 1500);
      expect(await ledgerOf(userId)).toHaveLength(1);
    }
  }, 120_000);

  it('forfeits an account banned after the freeze and promotes nobody', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const winner = await seedPlayer(t, 'forfeit-winner', finalist(1));
    const second = await seedPlayer(t, 'forfeit-second', finalist(2));

    expect(await rewards.freezeWlRewards(t.id)).toEqual({ frozen: true, receipts: 2 });
    await sql`UPDATE users SET is_banned = true WHERE id = ${winner}`;
    const result = await rewards.settleWlRewards(t.id);
    expect(result).toMatchObject({ granted: 1, forfeited: 1, remaining: 0, settled: true });

    expect(await receiptOf(t.id, winner)).toMatchObject({
      band: 'winner', status: 'forfeited', forfeit_reason: 'account_ineligible_at_payment',
    });
    expect(await coinsOf(winner)).toBe(100);
    expect(await inventoryOf(winner)).toEqual([]);
    expect(await receiptOf(t.id, second)).toMatchObject({ band: 'second', coins: 25000, status: 'granted' });
    expect(await coinsOf(second)).toBe(100 + 25000);
    expect(await rewards.wlRewardsRepo.listForUser(winner)).toEqual([]);
  }, 120_000);

  it('gives no placement or pack on a walkover', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ finalPlayed: false });
    const present = await seedPlayer(t, 'walkover-present', { state: 'champion', finalCheckedIn: true });
    const absent = await seedPlayer(t, 'walkover-absent', { state: 'no_show' });

    await rewards.settleWlRewards(t.id);
    expect(await receiptOf(t.id, present)).toMatchObject({ band: 'finalist', coins: 4000, items: [] });
    expect(await receiptOf(t.id, absent)).toMatchObject({ band: 'participant', coins: 1500, items: [] });
    expect(await inventoryOf(present)).toEqual([]);
  }, 120_000);

  it('does not duplicate a jersey the winner already owns', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const winner = await seedPlayer(t, 'preowned', finalist(1));
    await sql`
      INSERT INTO user_inventory (user_id, product_id, quantity)
      SELECT ${winner}, id, 1 FROM store_products WHERE slug = 'avatar_jersey_wl_retro_home'
    `;

    await rewards.settleWlRewards(t.id);
    expect(await inventoryOf(winner)).toEqual([{ slug: 'avatar_jersey_wl_retro_home', quantity: 1 }]);
    expect((await receiptOf(t.id, winner))?.items).toMatchObject([{ slug: 'avatar_jersey_wl_retro_home', alreadyOwned: true }]);
    expect((await ledgerOf(winner))[0]).toMatchObject({ coins_delta: 40000, inventory_delta: {} });
  }, 120_000);

  it('refuses test, unfinished, undated and pre-rollout tournaments', async () => {
    if (!dbAvailable) return;
    const cases: Array<[Parameters<typeof seedTournament>[0], string]> = [
      [{ isTest: true, weekKey: null }, 'test_tournament'],
      [{ status: 'cancelled' }, 'not_completed'],
      [{ status: 'voided' }, 'not_completed'],
      [{ status: 'final_live' }, 'not_completed'],
      [{ weekKey: '2098-12-27' }, 'before_rollout'],
    ];
    for (const [opts, reason] of cases) {
      const t = await seedTournament(opts);
      const player = await seedPlayer(t, `refused-${reason}`);
      const result = await rewards.settleWlRewards(t.id);
      expect(result.freeze).toEqual({ frozen: false, reason });
      expect(await receiptOf(t.id, player)).toBeNull();
      expect(await coinsOf(player)).toBe(100);
    }
    expect((await rewards.settleWlRewards('00000000-0000-4000-8000-000000000000')).freeze)
      .toEqual({ frozen: false, reason: 'not_found' });
  }, 120_000);

  it('fails the freeze loudly when another tournament already paid the player that weekend', async () => {
    if (!dbAvailable) return;
    const first = await seedTournament();
    const player = await seedPlayer(first, 'weekend-clash');
    await rewards.settleWlRewards(first.id);
    expect(await coinsOf(player)).toBe(100 + 1500);

    // Relabel the paid tournament, then stand up a second one on the original weekend.
    await sql`UPDATE wl_tournaments SET week_key = ${nextWeek()} WHERE id = ${first.id}`;
    const second = await seedTournament({ weekKey: first.weekKey });
    await sql`
      INSERT INTO wl_entries (tournament_id, user_id, state, checked_in_at)
      VALUES (${second.id}, ${player}, 'eliminated', NOW())
    `;
    await sql`
      INSERT INTO wl_answers (attempt_id, user_id, tournament_id, game_index, answer, correct, points, elapsed_ms, time_charge_ms, timing_source)
      VALUES (${second.qualifierRun}, ${player}, ${second.id}, 0, '{}'::jsonb, false, 0, 1000, 1000, 'redis_accept')
    `;

    await expect(rewards.settleWlRewards(second.id)).rejects.toThrow();
    expect(await coinsOf(player)).toBe(100 + 1500);
    expect(await receiptOf(second.id, player)).toBeNull();
    const state = await settlementOf(second.id);
    expect(state).toMatchObject({ frozen: false, settled: false, attempts: 1 });
    expect(state?.last_error).toMatch(/uq_wl_reward_receipts_week_user/);

    // The failure is remembered in the database, so the sweep leaves it alone
    // for the backoff window instead of retrying on every pass.
    await rewards.wlRewardsSweep();
    expect((await settlementOf(second.id))?.attempts).toBe(1);
  }, 120_000);

  it('pays a winner who idled through Saturday and still made the final', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const idleThenWon = await seedPlayer(t, 'idle-saturday-winner', finalist(1, { qualifierAnswer: 'none' }));
    const idleFinalist = await seedPlayer(t, 'idle-saturday-finalist', {
      state: 'finalist', finalCheckedIn: true, finalRank: 2, qualifierAnswer: 'none',
    });
    const idleNoShow = await seedPlayer(t, 'idle-saturday-noshow', { state: 'no_show', qualifierAnswer: 'none' });

    await rewards.settleWlRewards(t.id);
    expect(await receiptOf(t.id, idleThenWon)).toMatchObject({ band: 'winner', coins: 40000, human_rank: 1 });
    expect(await inventoryOf(idleThenWon)).toEqual([{ slug: 'avatar_jersey_wl_retro_home', quantity: 1 }]);
    expect(await receiptOf(t.id, idleFinalist)).toMatchObject({ band: 'finalist', coins: 4000 });
    expect(await receiptOf(t.id, idleNoShow)).toBeNull();
  }, 120_000);

  it('stops paying a frozen tournament once it falls outside the rollout', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const first = await seedPlayer(t, 'gate-a');
    const second = await seedPlayer(t, 'gate-b');
    expect(await rewards.settleWlRewards(t.id, { limit: 1 })).toMatchObject({ granted: 1, remaining: 1 });

    const flags = config as { WL_REWARDS_FROM_WEEK?: string };
    const original = flags.WL_REWARDS_FROM_WEEK;
    flags.WL_REWARDS_FROM_WEEK = '2199-01-01';
    try {
      const blocked = await rewards.settleWlRewards(t.id, { limit: 10 });
      expect(blocked.freeze).toEqual({ frozen: false, reason: 'before_rollout' });
      expect(blocked.granted).toBe(0);
    } finally {
      flags.WL_REWARDS_FROM_WEEK = original;
    }
    const paid = [await coinsOf(first), await coinsOf(second)].sort((a, b) => a - b);
    expect(paid).toEqual([100, 100 + 1500]);

    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, remaining: 0, settled: true });
    expect(await coinsOf(first)).toBe(100 + 1500);
    expect(await coinsOf(second)).toBe(100 + 1500);
  }, 120_000);

  it('treats an impossible rollout date as unset: real events wait, rehearsals still pay, the sweep does not throw', async () => {
    if (!dbAvailable) return;
    const real = await seedTournament();
    const realPlayer = await seedPlayer(real, 'bad-date-real');
    const rehearsal = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    const rehearsalPlayer = await seedPlayer(rehearsal, 'bad-date-rehearsal');

    const flags = config as { WL_REWARDS_FROM_WEEK?: string };
    const original = flags.WL_REWARDS_FROM_WEEK;
    for (const bad of ['2099-02-30', '2099-13-01', 'next-week']) {
      flags.WL_REWARDS_FROM_WEEK = bad;
      try {
        await expect(rewards.wlRewardsSweep()).resolves.toBeUndefined();
        expect((await rewards.settleWlRewards(real.id)).freeze).toEqual({ frozen: false, reason: 'before_rollout' });
      } finally {
        flags.WL_REWARDS_FROM_WEEK = original;
      }
    }
    expect(await coinsOf(realPlayer)).toBe(100);
    expect(await coinsOf(rehearsalPlayer)).toBe(100 + 1500);
  }, 120_000);

  it('refuses a single-game rehearsal, whose final is not where the facts look', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    await sql`UPDATE wl_tournaments SET config = config || '{"single_game": true}'::jsonb WHERE id = ${t.id}`;
    const player = await seedPlayer(t, 'single-game');
    expect((await rewards.settleWlRewards(t.id)).freeze).toEqual({ frozen: false, reason: 'test_tournament' });
    expect(await coinsOf(player)).toBe(100);
  }, 120_000);

  it('stops a pass when its time budget is spent and finishes on the next', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const players = [await seedPlayer(t, 'budget-a'), await seedPlayer(t, 'budget-b')];
    await rewards.freezeWlRewards(t.id);
    expect(await rewards.settleWlRewards(t.id, { budgetMs: -1 })).toMatchObject({ granted: 0, remaining: 2, settled: false });
    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 2, remaining: 0, settled: true });
    for (const userId of players) expect(await coinsOf(userId)).toBe(100 + 1500);
  }, 120_000);

  it('fails a grant fast when the wallet row is locked, and pays it on retry', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const player = await seedPlayer(t, 'locked-wallet');
    await rewards.freezeWlRewards(t.id);

    const holder = await sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM users WHERE id = ${player} FOR UPDATE`;
      const started = Date.now();
      const blocked = await rewards.settleWlRewards(t.id);
      expect(blocked).toMatchObject({ granted: 0, failed: 1, remaining: 1, settled: false });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await ledgerOf(player)).toHaveLength(0);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, remaining: 0, settled: true });
    expect(await coinsOf(player)).toBe(100 + 1500);
    expect(await ledgerOf(player)).toHaveLength(1);
  }, 120_000);

  it('settles a tournament nobody earned anything in, and stops revisiting it', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const registered = await seedPlayer(t, 'empty-registered', { state: 'entered', checkedIn: false, qualifierAnswer: 'none' });

    const result = await rewards.settleWlRewards(t.id);
    expect(result).toMatchObject({ freeze: { frozen: true, receipts: 0 }, granted: 0, remaining: 0, settled: true });
    expect(await coinsOf(registered)).toBe(100);
    expect((await rewards.settleWlRewards(t.id)).freeze).toEqual({ frozen: false, reason: 'already_frozen' });
  }, 120_000);

  it('pays a finalist who quit mid-final by the rank they finished on, and one who quit before answering as a finalist', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const stayed = await seedPlayer(t, 'quit-stayed', finalist(1));
    // Answered, then left: still on the final board, just lower.
    const leftMidFinal = await seedPlayer(t, 'quit-mid', finalist(2));
    // Checked in, dropped before the first question, never came back.
    const leftBeforeFirst = await seedPlayer(t, 'quit-before', { state: 'finalist', finalCheckedIn: true, finalRank: 3 });
    // Dropped in the qualifier after one answer and missed the cut.
    const leftQualifier = await seedPlayer(t, 'quit-qualifier');

    await rewards.settleWlRewards(t.id);
    expect(await receiptOf(t.id, stayed)).toMatchObject({ band: 'winner', human_rank: 1 });
    expect(await receiptOf(t.id, leftMidFinal)).toMatchObject({ band: 'second', human_rank: 2, coins: 25000 });
    expect(await receiptOf(t.id, leftBeforeFirst)).toMatchObject({ band: 'finalist', coins: 4000, items: [] });
    expect(await receiptOf(t.id, leftQualifier)).toMatchObject({ band: 'participant', coins: 1500 });
  }, 120_000);

  it('breaks final ties by the persisted board rank, never by re-sorting scores', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const first = await seedPlayer(t, 'tie-first', finalist(1));
    const second = await seedPlayer(t, 'tie-second', finalist(2));
    // Same score and time as rank 1: the engine already ordered them.
    await sql`
      UPDATE wl_game_results SET score = 999, time_ms_total = 60000
      WHERE tournament_id = ${t.id} AND game_index = 3
    `;
    await rewards.settleWlRewards(t.id);
    expect(await receiptOf(t.id, first)).toMatchObject({ band: 'winner', human_rank: 1 });
    expect(await receiptOf(t.id, second)).toMatchObject({ band: 'second', human_rank: 2 });
  }, 120_000);

  it('pays an opted-in test tournament outside prod, and refuses it under prod', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    const winner = await seedPlayer(t, 'rehearsal-winner', finalist(1));

    const mutableConfig = config as { NODE_ENV: string };
    const original = mutableConfig.NODE_ENV;
    mutableConfig.NODE_ENV = 'prod';
    try {
      expect((await rewards.settleWlRewards(t.id)).freeze).toEqual({ frozen: false, reason: 'test_tournament' });
      expect(await coinsOf(winner)).toBe(100);
    } finally {
      mutableConfig.NODE_ENV = original;
    }

    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, settled: true });
    expect(await coinsOf(winner)).toBe(100 + 40000);
    const [mine] = await rewards.wlRewardsRepo.listForUser(winner);
    expect(mine).toMatchObject({ band: 'winner', week_key: null });
  }, 120_000);

  it('sweeps only when enabled, and a second sweep changes nothing', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const player = await seedPlayer(t, 'sweep-player');
    const flags = config as { WL_REWARDS_ENABLED: boolean };

    flags.WL_REWARDS_ENABLED = false;
    try {
      await rewards.wlRewardsSweep();
      expect(await receiptOf(t.id, player)).toBeNull();
      expect(await settlementOf(t.id)).toBeNull();
    } finally {
      flags.WL_REWARDS_ENABLED = true;
    }

    await rewards.wlRewardsSweep();
    expect(await receiptOf(t.id, player)).toMatchObject({ band: 'participant', status: 'granted' });
    expect(await coinsOf(player)).toBe(100 + 1500);
    expect(await settlementOf(t.id)).toMatchObject({ settled: true });

    await rewards.wlRewardsSweep();
    expect(await coinsOf(player)).toBe(100 + 1500);
    expect(await ledgerOf(player)).toHaveLength(1);
  }, 120_000);

  it('never lets the sweep pick up test tournaments that did not opt in, or single-game ones', async () => {
    if (!dbAvailable) return;
    const plain = await seedTournament({ isTest: true, weekKey: null });
    const single = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    await sql`UPDATE wl_tournaments SET config = config || '{"single_game": true}'::jsonb WHERE id = ${single.id}`;
    const players = [await seedPlayer(plain, 'sweep-plain'), await seedPlayer(single, 'sweep-single')];

    await rewards.wlRewardsSweep();
    expect(await settlementOf(plain.id)).toBeNull();
    expect(await settlementOf(single.id)).toBeNull();
    for (const userId of players) expect(await coinsOf(userId)).toBe(100);
  }, 120_000);

  it('moves a failing receipt to the back so the ones behind it still get paid', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const ids = [await seedPlayer(t, 'starve-a'), await seedPlayer(t, 'starve-b')].sort();
    const [stuck, healthy] = ids;
    await rewards.freezeWlRewards(t.id);

    const holder = await sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM users WHERE id = ${stuck} FOR UPDATE`;
      // One receipt per pass: the first pass hits the locked wallet and fails...
      expect(await rewards.settleWlRewards(t.id, { limit: 1 })).toMatchObject({ granted: 0, failed: 1, remaining: 2 });
      // ...and the next pass must move on to the healthy receipt, not retry the stuck one.
      expect(await rewards.settleWlRewards(t.id, { limit: 1 })).toMatchObject({ granted: 1, failed: 0, remaining: 1 });
      expect(await coinsOf(healthy)).toBe(100 + 1500);
      expect(await settlementOf(t.id)).toMatchObject({ settled: false });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, remaining: 0, settled: true });
    expect(await coinsOf(stuck)).toBe(100 + 1500);
    expect(await ledgerOf(stuck)).toHaveLength(1);
    expect(await settlementOf(t.id)).toMatchObject({ settled: true, last_error: null });
  }, 120_000);

  it('lets two workers pay the same tournament at once without waiting on each other', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const players: string[] = [];
    for (let i = 0; i < 6; i += 1) players.push(await seedPlayer(t, `workers-${i}`));
    await rewards.freezeWlRewards(t.id);

    const passes = await Promise.all([rewards.settleWlRewards(t.id), rewards.settleWlRewards(t.id)]);
    expect(passes.reduce((n, p) => n + p.granted, 0)).toBe(6);
    expect(passes.reduce((n, p) => n + p.failed, 0)).toBe(0);
    await rewards.settleWlRewards(t.id);
    for (const userId of players) {
      expect(await coinsOf(userId)).toBe(100 + 1500);
      expect(await ledgerOf(userId)).toHaveLength(1);
    }
    expect(await settlementOf(t.id)).toMatchObject({ settled: true });
  }, 120_000);

  it('forfeits a player disqualified after the freeze', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const winner = await seedPlayer(t, 'late-dq-winner', finalist(1));
    const second = await seedPlayer(t, 'late-dq-second', finalist(2));
    await rewards.freezeWlRewards(t.id);
    await sql`UPDATE wl_entries SET state = 'disqualified' WHERE tournament_id = ${t.id} AND user_id = ${winner}`;

    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, forfeited: 1, settled: true });
    expect(await receiptOf(t.id, winner)).toMatchObject({ status: 'forfeited', forfeit_reason: 'entry_ineligible_at_payment' });
    expect(await coinsOf(winner)).toBe(100);
    expect(await inventoryOf(winner)).toEqual([]);
    expect(await receiptOf(t.id, second)).toMatchObject({ band: 'second', status: 'granted' });
  }, 120_000);

  it('skips a receipt another worker holds instead of waiting for it or failing', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const player = await seedPlayer(t, 'held-receipt');
    await rewards.freezeWlRewards(t.id);

    const holder = await sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wl_reward_receipts WHERE tournament_id = ${t.id} FOR UPDATE`;
      const started = Date.now();
      const pass = await rewards.settleWlRewards(t.id);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(pass).toMatchObject({ granted: 0, failed: 0, remaining: 1, settled: false });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, settled: true });
    expect(await coinsOf(player)).toBe(100 + 1500);
  }, 120_000);

  it('keeps a recorded failure when a later pass pays nothing', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const player = await seedPlayer(t, 'backoff-kept');
    await rewards.freezeWlRewards(t.id);

    const wallet = await sql.reserve();
    try {
      await wallet`BEGIN`;
      await wallet`SELECT id FROM users WHERE id = ${player} FOR UPDATE`;
      expect(await rewards.settleWlRewards(t.id)).toMatchObject({ failed: 1, remaining: 1 });
    } finally {
      await wallet`ROLLBACK`;
      wallet.release();
    }
    expect((await settlementOf(t.id))?.last_error).toBeTruthy();

    // A second worker finds the receipt held elsewhere and pays nothing: that
    // must not wipe the failure the first worker recorded.
    const receipt = await sql.reserve();
    try {
      await receipt`BEGIN`;
      await receipt`SELECT id FROM wl_reward_receipts WHERE tournament_id = ${t.id} FOR UPDATE`;
      expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 0, failed: 0, remaining: 1 });
    } finally {
      await receipt`ROLLBACK`;
      receipt.release();
    }
    expect((await settlementOf(t.id))?.last_error).toBeTruthy();

    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, settled: true });
    expect(await settlementOf(t.id)).toMatchObject({ settled: true, last_error: null });
  }, 120_000);

  it('gives up promptly, bookkeeping included, when the settlement row itself is locked', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const player = await seedPlayer(t, 'locked-settlement');
    await rewards.freezeWlRewards(t.id);

    const holder = await sql.reserve();
    const started = Date.now();
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM wl_reward_settlements WHERE tournament_id = ${t.id} FOR UPDATE`;
      await expect(rewards.settleWlRewards(t.id)).rejects.toThrow();
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    // 3 s freeze lock wait + at most 1 s of bookkeeping, never the 30 s statement timeout.
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await coinsOf(player)).toBe(100);
    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 1, settled: true });
  }, 120_000);

  it('does not treat a string "true" as an opt-in, in the sweep or the gate', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ isTest: true, weekKey: null });
    await sql`UPDATE wl_tournaments SET config = config || '{"reward_payout": "true"}'::jsonb WHERE id = ${t.id}`;
    const player = await seedPlayer(t, 'string-optin');

    await rewards.wlRewardsSweep();
    expect(await settlementOf(t.id)).toBeNull();
    expect((await rewards.settleWlRewards(t.id)).freeze).toEqual({ frozen: false, reason: 'test_tournament' });
    expect(await coinsOf(player)).toBe(100);
  }, 120_000);

  it('lets a rehearsal tournament be deleted after it paid out', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    const player = await seedPlayer(t, 'rehearsal-delete', finalist(1));
    await rewards.settleWlRewards(t.id);
    expect(await coinsOf(player)).toBe(100 + 40000);

    const { wlAdminController } = await import('../../src/modules/weekend-league/wl-admin.controller.js');
    const json = vi.fn();
    await wlAdminController.deleteTest({ params: { id: t.id } } as never, { json } as never);
    expect(json).toHaveBeenCalledWith({ deleted: true });
    expect(await receiptOf(t.id, player)).toBeNull();
    expect(await settlementOf(t.id)).toBeNull();
    // What was paid stays paid.
    expect(await coinsOf(player)).toBe(100 + 40000);
  }, 120_000);

  it('refuses to delete a real tournament through the rehearsal endpoint, keeping its receipts', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const player = await seedPlayer(t, 'real-delete');
    await rewards.settleWlRewards(t.id);

    const { wlAdminController } = await import('../../src/modules/weekend-league/wl-admin.controller.js');
    await expect(wlAdminController.deleteTest({ params: { id: t.id } } as never, { json: vi.fn() } as never)).rejects.toThrow();
    expect(await receiptOf(t.id, player)).toMatchObject({ status: 'granted' });
  }, 120_000);

  it('leaves a receipt pending, unpaid, when the tournament stops being eligible after the freeze', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    const player = await seedPlayer(t, 'opt-out', finalist(1));
    expect(await rewards.freezeWlRewards(t.id)).toEqual({ frozen: true, receipts: 1 });
    const [{ id: receiptId }] = await sql<{ id: string }[]>`
      SELECT id FROM wl_reward_receipts WHERE tournament_id = ${t.id}
    `;

    await sql`UPDATE wl_tournaments SET config = config || '{"reward_payout": false}'::jsonb WHERE id = ${t.id}`;
    expect(await rewards.grantWlReward(receiptId)).toBe('skipped');
    expect(await receiptOf(t.id, player)).toMatchObject({ status: 'pending' });
    expect(await coinsOf(player)).toBe(100);

    await sql`UPDATE wl_tournaments SET config = config || '{"reward_payout": true}'::jsonb WHERE id = ${t.id}`;
    expect(await rewards.grantWlReward(receiptId)).toBe('granted');
    expect(await coinsOf(player)).toBe(100 + 40000);
  }, 120_000);

  it('rolls a payment back when an opt-out being written commits while the payment is in flight', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
    const player = await seedPlayer(t, 'racing-opt-out', finalist(1));
    await rewards.freezeWlRewards(t.id);
    const [{ id: receiptId }] = await sql<{ id: string }[]>`
      SELECT id FROM wl_reward_receipts WHERE tournament_id = ${t.id}
    `;

    const admin = await sql.reserve();
    let grant: Promise<string>;
    try {
      await admin`BEGIN`;
      await admin`UPDATE wl_tournaments SET config = config || '{"reward_payout": false}'::jsonb WHERE id = ${t.id}`;
      // The payment starts while the opt-out is written but not yet committed:
      // its early read still sees the old, eligible configuration.
      grant = rewards.grantWlReward(receiptId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await admin`COMMIT`;
    } finally {
      admin.release();
    }
    expect(await grant).toBe('skipped');
    expect(await receiptOf(t.id, player)).toMatchObject({ status: 'pending' });
    expect(await coinsOf(player)).toBe(100);
    expect(await inventoryOf(player)).toEqual([]);
    expect(await ledgerOf(player)).toHaveLength(0);
  }, 120_000);

  it('does not block the orchestrator\'s cursor updates on the tournament while a freeze is open', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    await seedPlayer(t, 'cursor');

    // Stand in for a freeze that is mid-flight: the lock it takes first.
    const freezer = await sql.reserve();
    try {
      await freezer`BEGIN`;
      await freezer`SELECT id FROM wl_tournaments WHERE id = ${t.id} FOR KEY SHARE`;
      const started = Date.now();
      await sql`UPDATE wl_tournaments SET live_delivered_seq = live_delivered_seq + 1 WHERE id = ${t.id}`;
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      await freezer`ROLLBACK`;
      freezer.release();
    }
  }, 120_000);

  it('survives a rehearsal being deleted while its payout is retried, whichever goes first', async () => {
    if (!dbAvailable) return;
    const { wlAdminController } = await import('../../src/modules/weekend-league/wl-admin.controller.js');
    for (let round = 0; round < 4; round += 1) {
      const t = await seedTournament({ isTest: true, weekKey: null, rewardPayout: true });
      const player = await seedPlayer(t, `delete-race-${round}`, finalist(1));
      // An earlier failed pass left an unfrozen settlement row behind.
      await sql`INSERT INTO wl_reward_settlements (tournament_id, attempts, last_error) VALUES (${t.id}, 1, 'earlier failure')`;

      const outcomes = await Promise.allSettled([
        rewards.settleWlRewards(t.id),
        wlAdminController.deleteTest({ params: { id: t.id } } as never, { json: vi.fn() } as never),
      ]);
      // Neither may die of a deadlock; the delete always wins in the end.
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') expect(String(outcome.reason)).not.toMatch(/deadlock/i);
      }
      if (outcomes[1].status === 'rejected') {
        await wlAdminController.deleteTest({ params: { id: t.id } } as never, { json: vi.fn() } as never);
      }
      const [gone] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wl_tournaments WHERE id = ${t.id}`;
      expect(gone.n).toBe(0);
      expect(await receiptOf(t.id, player)).toBeNull();
      expect([100, 100 + 40000]).toContain(await coinsOf(player));
    }
  }, 120_000);

  it('waits for a disqualification still in flight instead of paying around it', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const winner = await seedPlayer(t, 'racing-dq', finalist(1));
    await rewards.freezeWlRewards(t.id);

    const admin = await sql.reserve();
    let pass: Promise<Awaited<ReturnType<typeof rewards.settleWlRewards>>>;
    try {
      await admin`BEGIN`;
      await admin`UPDATE wl_entries SET state = 'disqualified' WHERE tournament_id = ${t.id} AND user_id = ${winner}`;
      // The payout starts while the disqualification is written but not yet committed.
      pass = rewards.settleWlRewards(t.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await admin`COMMIT`;
    } finally {
      admin.release();
    }
    expect(await pass).toMatchObject({ granted: 0, forfeited: 1, failed: 0, settled: true });
    expect(await receiptOf(t.id, winner)).toMatchObject({ status: 'forfeited', forfeit_reason: 'entry_ineligible_at_payment' });
    expect(await coinsOf(winner)).toBe(100);
    expect(await inventoryOf(winner)).toEqual([]);
  }, 120_000);

  it('shutdown waits for the pass in flight and lets it start nothing new', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const ids = [await seedPlayer(t, 'drain-a'), await seedPlayer(t, 'drain-b')].sort();
    const [held, behind] = ids;
    await rewards.freezeWlRewards(t.id);

    const wallet = await sql.reserve();
    const started = Date.now();
    try {
      await wallet`BEGIN`;
      await wallet`SELECT id FROM users WHERE id = ${held} FOR UPDATE`;
      // The pass reaches the held wallet first and waits there (3 s lock wait).
      rewards.wlRewardsWorkerTick();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await rewards.stopWlRewardsWorker();
    } finally {
      await wallet`ROLLBACK`;
      wallet.release();
    }
    // stop() resolved only once the waiting grant gave up...
    expect(Date.now() - started).toBeGreaterThan(2500);
    // ...and the pass did not go on to the receipt behind it.
    expect(await coinsOf(behind)).toBe(100);
    expect(await coinsOf(held)).toBe(100);

    // After shutdown began, a tick starts nothing.
    rewards.wlRewardsWorkerTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await coinsOf(behind)).toBe(100);

    // Nothing was lost: a direct settlement pays both.
    expect(await rewards.settleWlRewards(t.id)).toMatchObject({ granted: 2, settled: true });
  }, 120_000);

  it('lists only the caller\'s granted rewards and acknowledges only their own', async () => {
    if (!dbAvailable) return;
    const t = await seedTournament();
    const winner = await seedPlayer(t, 'api-winner', finalist(1));
    const other = await seedPlayer(t, 'api-other');

    await rewards.freezeWlRewards(t.id);
    expect(await rewards.wlRewardsRepo.listForUser(winner)).toEqual([]);
    await rewards.settleWlRewards(t.id);

    const [mine] = await rewards.wlRewardsRepo.listForUser(winner);
    expect(mine).toMatchObject({ band: 'winner', coins: 40000, human_rank: 1, seen_at: null, week_key: t.weekKey });
    expect(await rewards.wlRewardsRepo.markSeen(other, mine.id)).toBe(false);
    expect(await rewards.wlRewardsRepo.markSeen(winner, mine.id)).toBe(true);
    expect(await rewards.wlRewardsRepo.markSeen(winner, mine.id)).toBe(false);
    const [after] = await rewards.wlRewardsRepo.listForUser(winner);
    expect(after.seen_at).not.toBeNull();
    expect(await coinsOf(winner)).toBe(100 + 40000);
  }, 120_000);
});
