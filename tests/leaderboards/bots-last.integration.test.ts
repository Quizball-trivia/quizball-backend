/**
 * Country and club boards rank every real player above every bot; the world
 * board ranks everyone by points. Real SQL against the local test DB.
 *
 *   npx vitest run tests/leaderboards/bots-last.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let rankedRepo: typeof import('../../src/modules/ranked/ranked.repo.js').rankedRepo;
let SEASON_BOARD_PODIUM_SQL: string;
let dbAvailable = false;

const SUITE = `lbb_${Date.now()}`;
// Codes no other test uses, so each board holds only this suite's players.
const COUNTRY = 'AQ';
const BOT_HEAVY_COUNTRY = 'BV';
const CLUB_ALIAS = `${SUITE} wanderers`;
const CLUB_ID = `zz-${SUITE.replace(/_/g, '-')}`;
const COUNTRY_BOARD = { kind: 'country', country: COUNTRY } as const;
const CLUB_BOARD = { kind: 'club', club: CLUB_ID } as const;

const userIds: string[] = [];
let batchId: string | null = null;
let seq = 0;

async function player(opts: { name: string; rp: number; bot?: boolean; country?: string; club?: string }) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, country, favorite_club, is_ai, ai_kind, onboarding_complete)
    VALUES (
      ${`${SUITE}_${opts.name}`}, ${opts.country ?? COUNTRY}, ${opts.club ?? null},
      ${opts.bot ?? false}, ${opts.bot ? 'persistent' : null}, true
    )
    RETURNING id
  `;
  userIds.push(row.id);
  // Distinct updated_at keeps tiebreaks deterministic without relying on insert timing.
  seq += 1;
  await sql`
    INSERT INTO ranked_profiles (
      user_id, rp, tier, placement_status, placement_required,
      placement_played, placement_wins, current_win_streak, updated_at
    )
    VALUES (${row.id}, ${opts.rp}, 'Rotation', 'placed', 3, 3, 2, 0, NOW() - make_interval(secs => ${seq}))
  `;
  return row.id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1 FROM leaderboard_club_aliases LIMIT 1`;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping bots-last leaderboard tests: test DB (with leaderboard_club_aliases) unavailable.\n');
    return;
  }
  const repoModule = await import('../../src/modules/ranked/ranked.repo.js');
  rankedRepo = repoModule.rankedRepo;
  SEASON_BOARD_PODIUM_SQL = repoModule.SEASON_BOARD_PODIUM_SQL;

  await sql`INSERT INTO leaderboard_club_aliases (alias, club_id) VALUES (${CLUB_ALIAS}, ${CLUB_ID})`;

  ids.botTop = await player({ name: 'bot_top', rp: 2000, bot: true });
  ids.botMid = await player({ name: 'bot_mid', rp: 1500, bot: true });
  ids.ana = await player({ name: 'ana', rp: 1200 });
  ids.ben = await player({ name: 'ben', rp: 900 });
  ids.cleo = await player({ name: 'cleo', rp: 300 });
  ids.botLow = await player({ name: 'bot_low', rp: 100, bot: true });
  for (let i = 0; i < 4; i += 1) await player({ name: `bot_tail_${i}`, rp: 50 - i, bot: true });

  // Two real fans and two bots: the bots fill the podium places left empty.
  ids.clubBot = await player({ name: 'club_bot', rp: 1800, bot: true, country: 'BV', club: 'Zz Wanderers' });
  ids.clubDan = await player({ name: 'club_dan', rp: 700, country: 'BV', club: CLUB_ALIAS.toUpperCase() });
  ids.clubEve = await player({ name: 'club_eve', rp: 650, country: 'BV', club: ` ${CLUB_ALIAS} ` });
  ids.clubBot2 = await player({ name: 'club_bot2', rp: 1700, bot: true, country: 'BV', club: CLUB_ALIAS });

  for (let i = 0; i < 6; i += 1) await player({ name: `bv_bot_${i}`, rp: 1600 - i, bot: true, country: BOT_HEAVY_COUNTRY });
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (batchId) await sql`DELETE FROM ranked_reset_batches WHERE id = ${batchId}`;
  await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${userIds}::uuid[])`;
  await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
  await sql`DELETE FROM leaderboard_club_aliases WHERE alias = ${CLUB_ALIAS}`;
  await sql.end();
});

const suiteOnly = <T extends { userId: string }>(rows: T[]) => rows.filter((row) => userIds.includes(row.userId));

describe('country board: real players before bots', () => {
  it('lists real players first, then bots, each by points', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await rankedRepo.listLeaderboard(50, 0, COUNTRY_BOARD);
    expect(rows.slice(0, 6).map((row) => row.userId)).toEqual([
      ids.ana, ids.ben, ids.cleo, ids.botTop, ids.botMid, ids.botLow,
    ]);
    expect(rows).toHaveLength(10);
  });

  it('pages without repeating or skipping anyone', async ({ skip }) => {
    if (!dbAvailable) skip();
    const first = await rankedRepo.listLeaderboard(4, 0, COUNTRY_BOARD);
    const second = await rankedRepo.listLeaderboard(4, 4, COUNTRY_BOARD);
    expect(first.map((row) => row.userId)).toEqual([ids.ana, ids.ben, ids.cleo, ids.botTop]);
    expect(second[0].userId).toBe(ids.botMid);
  });

  it('gives each player the rank of the row they occupy', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await rankedRepo.listLeaderboard(50, 0, COUNTRY_BOARD);
    for (const [index, row] of rows.entries()) {
      const rank = await rankedRepo.getUserRank(row.userId, COUNTRY_BOARD);
      expect(rank?.rank).toBe(index + 1);
      expect(rank?.total).toBe(rows.length);
    }
  });

  it('points the next target at the real player above, never a bot', async ({ skip }) => {
    if (!dbAvailable) skip();
    expect(await rankedRepo.getNextAbove(ids.ana, COUNTRY_BOARD)).toBeNull();
    expect(await rankedRepo.getNextAbove(ids.ben, COUNTRY_BOARD)).toEqual({ username: `${SUITE}_ana`, points: 1200 });
    expect(await rankedRepo.getNextAbove(ids.cleo, COUNTRY_BOARD)).toEqual({ username: `${SUITE}_ben`, points: 900 });
    // A bot's next row up is the last real player, then the bot above it.
    expect(await rankedRepo.getNextAbove(ids.botTop, COUNTRY_BOARD)).toEqual({ username: `${SUITE}_cleo`, points: 300 });
    expect(await rankedRepo.getNextAbove(ids.botMid, COUNTRY_BOARD)).toEqual({ username: `${SUITE}_bot_top`, points: 2000 });
  });
});

describe('world board: everyone by points', () => {
  it('keeps bots in points order among real players', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = suiteOnly(await rankedRepo.listLeaderboard(1000, 0));
    const order = rows.map((row) => row.userId);
    expect(order.indexOf(ids.botTop)).toBeLessThan(order.indexOf(ids.ana));
    expect(order.indexOf(ids.botMid)).toBeLessThan(order.indexOf(ids.ana));
    expect(order.indexOf(ids.cleo)).toBeLessThan(order.indexOf(ids.botLow));

    const botRank = await rankedRepo.getUserRank(ids.botTop);
    const anaRank = await rankedRepo.getUserRank(ids.ana);
    expect(botRank!.rank).toBeLessThan(anaRank!.rank);
    // Other suites share the world board, so only check the target is not a real player below.
    expect((await rankedRepo.getNextAbove(ids.ana))!.points).toBeGreaterThanOrEqual(1200);
  });
});

describe('club board: bots fill places real fans leave empty', () => {
  it('puts the two real fans on No.1 and No.2 and the bots after them', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await rankedRepo.listLeaderboard(50, 0, CLUB_BOARD);
    expect(rows.map((row) => row.userId)).toEqual([ids.clubDan, ids.clubEve, ids.clubBot2]);
    expect((await rankedRepo.getUserRank(ids.clubEve, CLUB_BOARD))?.rank).toBe(2);
    expect((await rankedRepo.getUserRank(ids.clubBot2, CLUB_BOARD))?.rank).toBe(3);
    expect(await rankedRepo.getNextAbove(ids.clubDan, CLUB_BOARD)).toBeNull();
  });
});

describe('season trophies', () => {
  it('go to the top three real players even when bots have more points', async ({ skip }) => {
    if (!dbAvailable) skip();
    const rows = await sql.unsafe<{ board_key: string; pos: number; user_id: string }[]>(
      `SELECT board_key, pos::int AS pos, user_id FROM (${SEASON_BOARD_PODIUM_SQL}) podium
       WHERE board_kind = 'country' AND board_key IN ('${COUNTRY}', '${BOT_HEAVY_COUNTRY}')
       ORDER BY board_key, pos`,
    );
    expect(rows.filter((row) => row.board_key === COUNTRY)).toEqual([
      { board_key: COUNTRY, pos: 1, user_id: ids.ana },
      { board_key: COUNTRY, pos: 2, user_id: ids.ben },
      { board_key: COUNTRY, pos: 3, user_id: ids.cleo },
    ]);
    // Two real players and eight bots: the bot in third place gets no trophy.
    expect(rows.filter((row) => row.board_key === BOT_HEAVY_COUNTRY)).toEqual([
      { board_key: BOT_HEAVY_COUNTRY, pos: 1, user_id: ids.clubDan },
      { board_key: BOT_HEAVY_COUNTRY, pos: 2, user_id: ids.clubEve },
    ]);
  });
});

describe('past season boards', () => {
  it('order and rank an archived country board the same way', async ({ skip }) => {
    if (!dbAvailable) skip();
    const [batch] = await sql<{ id: string }[]>`
      INSERT INTO ranked_reset_batches (notes) VALUES (${SUITE}) RETURNING id
    `;
    batchId = batch.id;
    const archived: Array<[string, number]> = [[ids.botTop, 2000], [ids.ana, 1200], [ids.ben, 900], [ids.botLow, 100]];
    for (const [userId, rp] of archived) {
      await sql`
        INSERT INTO ranked_profiles_archive (
          reset_batch_id, user_id, rp, tier, placement_status, placement_required, placement_played,
          placement_wins, placement_perf_sum, placement_points_for_sum, placement_points_against_sum, current_win_streak
        )
        VALUES (${batchId}, ${userId}, ${rp}, 'Rotation', 'placed', 3, 3, 2, 0, 0, 0, 0)
      `;
    }
    const rows = await rankedRepo.listArchivedLeaderboard(batchId, 50, 0, COUNTRY_BOARD);
    expect(rows.map((row) => row.userId)).toEqual([ids.ana, ids.ben, ids.botTop, ids.botLow]);
    expect((await rankedRepo.getArchivedUserRank(batchId, ids.botTop, COUNTRY_BOARD))?.rank).toBe(3);
    expect((await rankedRepo.getArchivedUserRank(batchId, ids.ben, COUNTRY_BOARD))?.rank).toBe(2);

    const world = suiteOnly(await rankedRepo.listArchivedLeaderboard(batchId, 50, 0));
    expect(world.map((row) => row.userId)).toEqual([ids.botTop, ids.ana, ids.ben, ids.botLow]);
  });
});
