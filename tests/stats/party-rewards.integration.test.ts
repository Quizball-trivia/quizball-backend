import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

// Opt in to an isolated local DB; never fall back to a developer .env database.
const databaseUrl = process.env.PARTY_REWARDS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Party reward receipt — real database', () => {
  let sql: typeof import('../../src/db/index.js').sql;
  let getPartyRewards: typeof import('../../src/modules/stats/party-rewards.service.js').getPartyRewards;
  let categoryId: string;
  let matchId: string;
  let memberId: string;
  let otherId: string;
  let guestId: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Local database required');
    process.env.DATABASE_URL = databaseUrl;
    ({ sql } = await import('../../src/db/index.js'));
    ({ getPartyRewards } = await import('../../src/modules/stats/party-rewards.service.js'));
    const [cat] = await sql`INSERT INTO categories (name,slug,is_active)
      VALUES (${sql.json({ en: 'Reward receipt test' })}, ${'reward-receipt-'+randomUUID()}, true) RETURNING id`;
    categoryId = cat.id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [u] = await sql`INSERT INTO users (nickname,is_guest,is_ai,onboarding_complete)
        VALUES (${'receipt-'+randomUUID().slice(0,8)}, ${i === 2}, false, true) RETURNING id`;
      ids.push(u.id);
    }
    [memberId, otherId, guestId] = ids as [string, string, string];
    const [m] = await sql`INSERT INTO matches (mode,status,game_variant,category_a_id,category_b_id,is_dev,started_at,ended_at)
      VALUES ('friendly','completed','friendly_party_quiz',${categoryId},${categoryId},false,now()-interval '5 minutes',now()) RETURNING id`;
    matchId = m.id;
    for (const [i, userId] of [memberId, guestId].entries()) {
      await sql`INSERT INTO match_players (match_id,user_id,seat) VALUES (${matchId},${userId},${i+1})`;
    }
  });
  afterAll(async () => {
    if (matchId) await sql`DELETE FROM matches WHERE id=${matchId}`;
    if (memberId) await sql`DELETE FROM users WHERE id=ANY(${[memberId,otherId,guestId]}::uuid[])`;
    if (categoryId) await sql`DELETE FROM categories WHERE id=${categoryId}`;
    if (sql) await sql.end();
  });
  it('returns no estimated XP before the worker saves its ledger record', async () => {
    expect(await getPartyRewards(matchId, memberId)).toEqual({ matchId, status: 'pending', xpEarned: null });
  });
  it('refuses a nonparticipant, an unknown match, an active match and a different game', async () => {
    await expect(getPartyRewards(matchId, otherId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPartyRewards(randomUUID(), memberId)).rejects.toMatchObject({ statusCode: 404 });
    await sql`UPDATE matches SET status='active' WHERE id=${matchId}`;
    await expect(getPartyRewards(matchId, memberId)).rejects.toMatchObject({ statusCode: 404 });
    await sql`UPDATE matches SET status='completed',game_variant='friendly_possession' WHERE id=${matchId}`;
    await expect(getPartyRewards(matchId, memberId)).rejects.toMatchObject({ statusCode: 404 });
    await sql`UPDATE matches SET game_variant='friendly_party_quiz' WHERE id=${matchId}`;
  });
  it('does not promise rewards to guests or development matches', async () => {
    expect((await getPartyRewards(matchId, guestId)).status).toBe('ineligible');
    await sql`UPDATE matches SET is_dev=true WHERE id=${matchId}`;
    expect((await getPartyRewards(matchId, memberId)).status).toBe('ineligible');
    await sql`UPDATE matches SET is_dev=false WHERE id=${matchId}`;
  });
  it('shows a saved amount while other rewards are still pending, without writing anything', async () => {
    await sql`INSERT INTO party_reward_jobs (match_id,user_ids) VALUES (${matchId},${[memberId]}::uuid[])`;
    await sql`INSERT INTO user_xp_events (user_id,source_type,source_key,xp_delta) VALUES (${memberId},'match_result',${matchId},37)`;
    expect(await getPartyRewards(matchId, memberId)).toEqual({ matchId, status: 'pending', xpEarned: 37 });
    const [job] = await sql`SELECT attempts FROM party_reward_jobs WHERE match_id=${matchId}`;
    expect(job.attempts).toBe(0);
  });
  it('reports completion from saved records and never guesses the standard reward', async () => {
    await sql`UPDATE party_reward_jobs SET status='done' WHERE match_id=${matchId}`;
    expect(await getPartyRewards(matchId, memberId)).toEqual({ matchId, status: 'complete', xpEarned: 37 });
    expect((await getPartyRewards(matchId, guestId)).xpEarned).toBeNull();
  });
  it('exposes terminal failure instead of pretending the worker is still saving', async () => {
    await sql`UPDATE party_reward_jobs SET status='failed' WHERE match_id=${matchId}`;
    expect(await getPartyRewards(matchId, memberId)).toEqual({ matchId, status: 'failed', xpEarned: 37 });
  });
  // Review 2026-10-06 (Codex + Astra F3): XP can be saved outside the job (dropout ending, replay) while achievements
  // or objectives are still missing; within the backfill window the reconciler will create the job, so: pending.
  it('a recent match with an XP receipt but no job yet is still pending (the backfill will create its job)', async () => {
    await sql`DELETE FROM party_reward_jobs WHERE match_id=${matchId}`;
    expect(await getPartyRewards(matchId, memberId)).toEqual({ matchId, status: 'pending', xpEarned: 37 });
  });

  it('supports historical completions (ended before the backfill window) with an XP receipt and no job row', async () => {
    await sql`DELETE FROM party_reward_jobs WHERE match_id=${matchId}`;
    await sql`UPDATE matches SET started_at = now() - interval '4 days 5 minutes', ended_at = now() - interval '4 days' WHERE id=${matchId}`;
    expect(await getPartyRewards(matchId, memberId)).toEqual({ matchId, status: 'complete', xpEarned: 37 });
  });
});
