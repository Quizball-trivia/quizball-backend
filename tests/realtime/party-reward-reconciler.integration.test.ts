import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../setup.js';

// The local .env turns objectives off; these tests cover both settings.
const objectives = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop) => (prop === 'OBJECTIVES_ENABLED' ? objectives.enabled : target[prop as keyof typeof target]),
    }),
  };
});

// Review 2026-10-06 rounds 1–2: Party rewards must survive a backlog, a restart, a failed step and a poisoned batch.
let sql: typeof import('../../src/db/index.js').sql;
let work: typeof import('../../src/realtime/party-completion-work.js');
let reconciler: typeof import('../../src/realtime/party-reward-reconciler.js');
let achievementsService: typeof import('../../src/modules/achievements/index.js').achievementsService;
let objectivesService: typeof import('../../src/modules/objectives/index.js').objectivesService;
let progressionService: typeof import('../../src/modules/progression/progression.service.js').progressionService;
let dbAvailable = false;
let categoryId: string;
const userIds: string[] = [];
const matchIds: string[] = [];

async function seedUser(opts: { guest?: boolean; ephemeralAi?: boolean } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_guest, is_ai, ai_kind, onboarding_complete)
    VALUES (${`recon_${randomUUID().slice(0, 8)}`}, ${opts.guest ?? false}, ${opts.ephemeralAi ?? false}, ${opts.ephemeralAi ? 'ephemeral' : null}, true)
    RETURNING id
  `;
  userIds.push(row.id);
  return row.id;
}

async function seedPartyMatch(players: string[], opts: { endedMinutesAgo?: number; isDev?: boolean; variant?: string } = {}): Promise<string> {
  const ended = opts.endedMinutesAgo ?? 10;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, game_variant, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at, ended_at)
    VALUES ('friendly', 'completed', ${opts.variant ?? 'friendly_party_quiz'}, ${categoryId}, ${categoryId}, 10, 10, ${opts.isDev ?? false},
            now() - make_interval(mins => ${ended + 5}), now() - make_interval(mins => ${ended}))
    RETURNING id
  `;
  matchIds.push(row.id);
  await sql`UPDATE matches SET state_payload = ${sql.json({ variant: opts.variant ?? 'friendly_party_quiz' })} WHERE id = ${row.id}`;
  for (const [i, userId] of players.entries()) {
    await sql`INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
              VALUES (${row.id}, ${userId}, ${i + 1}, ${10 - i}, 1, 0, 0)`;
  }
  return row.id;
}

const twoMembers = async () => {
  const players = [await seedUser(), await seedUser()];
  return { players, matchId: await seedPartyMatch(players) };
};
const job = async (matchId: string) =>
  (await sql<Array<{ status: string; attempts: number; last_error: string | null; due: boolean }>>`
    SELECT status, attempts, last_error, next_attempt_at <= now() AS due FROM party_reward_jobs WHERE match_id = ${matchId}
  `)[0];
const makeDue = (ids: string[]) => sql`UPDATE party_reward_jobs SET next_attempt_at = now() WHERE match_id = ANY(${ids}::uuid[])`;
const xpRows = async (matchId: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_xp_events WHERE source_type = 'match_result' AND source_key = ${matchId}`)[0].n;
const debut = async (userId: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_achievements WHERE user_id = ${userId} AND achievement_id = 'debut_match' AND unlocked_at IS NOT NULL`)[0].n;
/** The real due-job query, restricted to this test's matches (other rows in the shared test DB stay out of it). */
const dueAmong = (ids: Set<string>) => async () =>
  (await reconciler.findDuePartyRewardJobs(10_000)).filter((j) => ids.has(j.matchId)).slice(0, 25);
const noBackfill = async () => 0;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const lease = async (matchId: string) =>
  (await sql<Array<{ token: string | null; held: boolean }>>`
    SELECT claim_token AS token, COALESCE(claimed_until > now(), false) AS held FROM party_reward_jobs WHERE match_id = ${matchId}
  `)[0];
/** Models the lease running out (10 minutes passing, which also clears the 2-minute first-attempt grace). */
const expireLease = (matchId: string) =>
  sql`UPDATE party_reward_jobs SET claimed_until = now() - interval '1 second', next_attempt_at = now() WHERE match_id = ${matchId}`;
const coins = async (userId: string) => Number((await sql<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${userId}`)[0].coins);
const clockAt = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); };

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    work = await import('../../src/realtime/party-completion-work.js');
    reconciler = await import('../../src/realtime/party-reward-reconciler.js');
    achievementsService = (await import('../../src/modules/achievements/index.js')).achievementsService;
    objectivesService = (await import('../../src/modules/objectives/index.js')).objectivesService;
    progressionService = (await import('../../src/modules/progression/progression.service.js')).progressionService;
    const [cat] = await sql<{ id: string }[]>`
      INSERT INTO categories (name, slug, is_active)
      VALUES (${sql.json({ en: 'IntegrationTest_Reconciler' })}, ${`integration-test-reconciler-${randomUUID()}`}, true)
      RETURNING id
    `;
    categoryId = cat.id;
  } catch (error) {
    if (dbAvailable) throw error;
    console.warn('\n⚠️  Skipping Party reward reconciler integration tests: DB unavailable.\n');
  }
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); objectives.enabled = true; });

afterAll(async () => {
  if (!dbAvailable) return;
  if (matchIds.length) await sql`DELETE FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
  if (userIds.length) {
    for (const table of ['user_xp_events', 'user_achievements', 'user_objective_events', 'user_mode_match_stats']) {
      await sql`DELETE FROM ${sql(table)} WHERE user_id = ANY(${userIds}::uuid[])`;
    }
    await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
  }
  if (categoryId) await sql`DELETE FROM categories WHERE id = ${categoryId}`;
  await sql.end();
});

// Every case does real reward work (achievements, objectives, XP) against Postgres: slow under a full parallel run.
vi.setConfig({ testTimeout: 30_000 });

describe('Party reward jobs — real database', () => {
  it('a match completes with every step succeeding: one XP row per member, the job done', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    await work.runPartyCompletionWork(matchId, players, async () => {});
    expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 1, last_error: null });
    expect(await xpRows(matchId)).toBe(2);
    expect(await debut(players[0])).toBe(1);
  });

  it('round 2 P2-1: an achievement failure keeps the job pending although XP was written, and the retry unlocks it', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    const original = achievementsService.evaluateForMatch.bind(achievementsService);
    vi.spyOn(achievementsService, 'evaluateForMatch')
      .mockRejectedValueOnce(new Error('temporary achievement DB failure'))
      .mockImplementation(original);
    await work.runPartyCompletionWork(matchId, players, async () => {});
    expect(await xpRows(matchId)).toBe(2);
    expect(await debut(players[0])).toBe(0);
    expect(await job(matchId)).toMatchObject({ status: 'pending', attempts: 1, due: false, last_error: expect.stringContaining('temporary achievement DB failure') });

    await makeDue([matchId]);
    expect(await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill })).toBe(1);
    expect(await debut(players[0])).toBe(1);
    expect(await xpRows(matchId)).toBe(2);
    expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('round 2 P2-1: an objectives failure (no longer swallowed by the best-effort wrapper) is retried', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    const original = objectivesService.evaluateForMatch.bind(objectivesService);
    const spy = vi.spyOn(objectivesService, 'evaluateForMatch')
      .mockRejectedValueOnce(new Error('temporary objective DB failure'))
      .mockImplementation(original);
    await work.runPartyCompletionWork(matchId, players, async () => {});
    expect(await job(matchId)).toMatchObject({ status: 'pending', last_error: expect.stringContaining('objectives') });
    await makeDue([matchId]);
    await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('with objectives switched off the job completes without them (the kill switch is respected)', async () => {
    if (!dbAvailable) return;
    objectives.enabled = false;
    const { players, matchId } = await twoMembers();
    const spy = vi.spyOn(objectivesService, 'evaluateForMatch');
    await work.runPartyCompletionWork(matchId, players, async () => {});
    expect(spy).not.toHaveBeenCalled();
    expect(await job(matchId)).toMatchObject({ status: 'done' });
  });

  it('round 2 P2-2: 25 older matches that keep failing back off; the healthy newer match is rewarded on the next sweep', async () => {
    if (!dbAvailable) return;
    const bad: string[] = [];
    for (let i = 0; i < 25; i += 1) bad.push((await twoMembers()).matchId);
    const healthy = await twoMembers();
    const ids = [...bad, healthy.matchId];
    for (const id of ids) {
      const players = (await sql<{ user_id: string }[]>`SELECT user_id FROM match_players WHERE match_id = ${id} ORDER BY seat`).map((r) => r.user_id);
      await work.enqueuePartyRewardJob(id, players);
    }
    // Oldest first: every bad job is due before the healthy one.
    await sql`UPDATE party_reward_jobs SET next_attempt_at = now() - interval '1 hour' WHERE match_id = ANY(${bad}::uuid[])`;
    await sql`UPDATE party_reward_jobs SET next_attempt_at = now() - interval '1 minute' WHERE match_id = ${healthy.matchId}`;
    const poisoned = new Set(bad);
    const original = progressionService.awardCompletedMatchXp.bind(progressionService);
    const xp = vi.spyOn(progressionService, 'awardCompletedMatchXp').mockImplementation(async (id, at) => {
      if (poisoned.has(id)) throw new Error('repeated per-match XP failure');
      return original(id, at);
    });
    const family = new Set(ids);

    expect(await reconciler.reconcilePartyRewards({ findDue: dueAmong(family), backfill: noBackfill })).toBe(25);
    expect(xp.mock.calls.map(([id]) => id)).not.toContain(healthy.matchId);
    expect(await reconciler.reconcilePartyRewards({ findDue: dueAmong(family), backfill: noBackfill })).toBe(1);
    expect(await job(healthy.matchId)).toMatchObject({ status: 'done' });
    expect(xp).toHaveBeenCalledTimes(26);
    const states = await sql<{ status: string; attempts: number; due: boolean }[]>`
      SELECT status, attempts, next_attempt_at <= now() AS due FROM party_reward_jobs WHERE match_id = ANY(${bad}::uuid[])
    `;
    expect(states.every((s) => s.status === 'pending' && s.attempts === 1 && !s.due)).toBe(true);
  }, 30_000);

  it('two workers on the same match (live path + sweep, or two replicas): the lease lets one run it', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    await work.enqueuePartyRewardJob(matchId, players);
    const spy = vi.spyOn(achievementsService, 'evaluateForMatch');
    await Promise.all([
      work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false }),
      work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false }),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('a job still failing on its last attempt is marked failed and logged as an error, not retried forever', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    await work.enqueuePartyRewardJob(matchId, players);
    await sql`UPDATE party_reward_jobs SET attempts = ${work.PARTY_REWARD_MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE match_id = ${matchId}`;
    vi.spyOn(progressionService, 'awardCompletedMatchXp').mockRejectedValue(new Error('permanent'));
    await work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
    expect(await job(matchId)).toMatchObject({ status: 'failed', attempts: work.PARTY_REWARD_MAX_ATTEMPTS });
    expect((await dueAmong(new Set([matchId]))()).length).toBe(0);
  });

  it('backfill: a completed match with no job gets one; one that has a job, guest/bot-only, too fresh, older than 72 h, dev and other modes do not', async () => {
    if (!dbAvailable) return;
    const [a, b, guest, bot] = [await seedUser(), await seedUser(), await seedUser({ guest: true }), await seedUser({ ephemeralAi: true })];
    const missing = await seedPartyMatch([b, a, guest]);
    const rewarded = await seedPartyMatch([a, b]);
    await sql`INSERT INTO party_reward_jobs (match_id, user_ids, status) VALUES (${rewarded}, ${[a, b]}::uuid[], 'done')`;
    const skipped = [
      rewarded,
      await seedPartyMatch([guest, bot]),
      await seedPartyMatch([a, b], { endedMinutesAgo: 1 }),
      await seedPartyMatch([a, b], { endedMinutesAgo: 73 * 60 }),
      await seedPartyMatch([a, b], { isDev: true }),
      await seedPartyMatch([a, b], { variant: 'friendly_possession' }),
    ];
    await reconciler.backfillPartyRewardJobs();
    const rows = await sql<{ match_id: string; user_ids: string[] }[]>`
      SELECT match_id, user_ids FROM party_reward_jobs WHERE match_id = ANY(${[missing, ...skipped.slice(1)]}::uuid[])
    `;
    expect(rows).toEqual([{ match_id: missing, user_ids: [b, a, guest] }]);
    expect(await job(rewarded)).toMatchObject({ status: 'done', attempts: 0 });

    // The backfilled job runs like any other; a repeat sweep awards nothing twice.
    await makeDue([missing]);
    await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([missing])), backfill: noBackfill });
    await sql`UPDATE party_reward_jobs SET status = 'pending', next_attempt_at = now() WHERE match_id = ${missing}`;
    await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([missing])), backfill: noBackfill });
    const xp = await sql<{ user_id: string; n: number }[]>`
      SELECT user_id, count(*)::int AS n FROM user_xp_events WHERE source_type = 'match_result' AND source_key = ${missing} GROUP BY user_id
    `;
    expect(new Map(xp.map((r) => [r.user_id, r.n]))).toEqual(new Map([[a, 1], [b, 1]]));
    await reconciler.backfillPartyRewardJobs();
    expect(await job(missing)).toMatchObject({ status: 'done' });
  });

  it('review 2026-10-06 B3: a match whose XP was written outside the job (dropout ending, replay) still gets a job and the missing steps', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    // The dropout ending / replay awards XP directly; achievements never ran.
    await progressionService.awardCompletedMatchXp(matchId);
    expect(await xpRows(matchId)).toBe(2);
    expect(await debut(players[0])).toBe(0);
    await reconciler.backfillPartyRewardJobs();
    expect(await job(matchId)).toMatchObject({ status: 'pending' });
    await makeDue([matchId]);
    await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill });
    expect(await debut(players[0])).toBe(1);
    expect(await xpRows(matchId)).toBe(2);
    expect(await job(matchId)).toMatchObject({ status: 'done' });
  });

  it('review 2026-10-06 B3: a match finished 2 days ago without a job is still recovered (72 h window)', async () => {
    if (!dbAvailable) return;
    const players = [await seedUser(), await seedUser()];
    const matchId = await seedPartyMatch(players, { endedMinutesAgo: 48 * 60 });
    await reconciler.backfillPartyRewardJobs();
    expect(await job(matchId)).toMatchObject({ status: 'pending' });
  });

  it('review 2026-10-06 B8: job bookkeeping blocked by a stuck lock gives up at its server deadline instead of waiting it out', async () => {
    if (!dbAvailable) return;
    const { players, matchId } = await twoMembers();
    await work.enqueuePartyRewardJob(matchId, players);
    const { default: postgres } = await import('postgres');
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    try {
      const locked = holder.begin(async (tx) => {
        await tx`SELECT 1 FROM party_reward_jobs WHERE match_id = ${matchId} FOR UPDATE`;
        held();
        await gate;
      });
      await holding;
      const started = Date.now();
      setTimeout(release, 9_000);
      await work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
      const waited = Date.now() - started;
      expect(waited).toBeLessThan(7_000);
      await locked;
      expect(await job(matchId)).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      release();
      await holder.end();
    }
  }, 20_000);

  it('review round 4 (#5): completing a Party match creates its reward job in the same transaction (no crash gap); other modes get none', async () => {
    if (!dbAvailable) return;
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const party = await twoMembers();
    await sql`UPDATE matches SET status = 'active', ended_at = NULL WHERE id = ${party.matchId}`;
    await matchesService.completeMatch(party.matchId, party.players[0]);
    expect(await job(party.matchId)).toMatchObject({ status: 'pending', attempts: 0 });
    const players = [await seedUser(), await seedUser()];
    const other = await seedPartyMatch(players, { variant: 'friendly_possession' });
    await sql`UPDATE matches SET status = 'active', ended_at = NULL WHERE id = ${other}`;
    await matchesService.completeMatch(other, players[0]);
    expect(await job(other)).toBeUndefined();
  });

  describe('round 3', () => {
    it('P2-1: a retry after midnight credits the match to its own day (one objective event, not one per day)', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      await sql`UPDATE matches SET started_at = '2026-10-06T23:54:00Z', ended_at = '2026-10-06T23:59:00Z' WHERE id = ${matchId}`;
      const original = progressionService.awardCompletedMatchXp.bind(progressionService);
      vi.spyOn(progressionService, 'awardCompletedMatchXp').mockRejectedValueOnce(new Error('transient')).mockImplementation(original);
      clockAt('2026-10-06T23:59:30Z');
      await work.runPartyCompletionWork(matchId, players, async () => {});
      expect(await job(matchId)).toMatchObject({ status: 'pending' });
      vi.setSystemTime(new Date('2026-10-07T00:05:00Z'));
      await makeDue([matchId]);
      await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill });
      expect(await job(matchId)).toMatchObject({ status: 'done' });
      const events = await sql<{ period_start: string }[]>`
        SELECT to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_start FROM user_objective_events
        WHERE user_id = ${players[0]} AND objective_id = 'daily_play_3_online_matches' AND event_key = ${`match:${matchId}`}
      `;
      expect(events.map((e) => e.period_start)).toEqual(['2026-10-06']);
    });

    it('P2-1: a retry across the Sunday→Monday reset pays the friend-match objective once (300 coins, not 600)', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      await sql`UPDATE matches SET started_at = '2026-10-04T23:54:00Z', ended_at = '2026-10-04T23:59:00Z' WHERE id = ${matchId}`;
      await sql`INSERT INTO friendships (user_low_id, user_high_id)
                VALUES (LEAST(${players[0]}::uuid, ${players[1]}::uuid), GREATEST(${players[0]}::uuid, ${players[1]}::uuid))`;
      const before = await coins(players[0]);
      const original = progressionService.awardCompletedMatchXp.bind(progressionService);
      vi.spyOn(progressionService, 'awardCompletedMatchXp').mockRejectedValueOnce(new Error('transient')).mockImplementation(original);
      clockAt('2026-10-04T23:59:30Z');
      await work.runPartyCompletionWork(matchId, players, async () => {});
      vi.setSystemTime(new Date('2026-10-05T00:05:00Z'));
      await makeDue([matchId]);
      await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill });
      expect(await job(matchId)).toMatchObject({ status: 'done' });
      expect(await coins(players[0]) - before).toBe(300);
      const rows = await sql`SELECT 1 FROM user_objective_progress WHERE user_id = ${players[0]} AND objective_id = 'weekly_play_friend_custom_room' AND rewarded_at IS NOT NULL`;
      expect(rows).toHaveLength(1);
    });

    it('P2-2: a worker holding a stale due list cannot run a job that just backed off', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      const original = progressionService.awardCompletedMatchXp.bind(progressionService);
      const xp = vi.spyOn(progressionService, 'awardCompletedMatchXp').mockRejectedValueOnce(new Error('transient')).mockImplementation(original);
      await work.runPartyCompletionWork(matchId, players, async () => {});
      expect(await job(matchId)).toMatchObject({ status: 'pending', attempts: 1, due: false });
      await work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
      expect(xp).toHaveBeenCalledTimes(1);
      expect(await job(matchId)).toMatchObject({ status: 'pending', attempts: 1, due: false });
    });

    it('P2-3: a worker whose lease expired can neither clear its replacement\'s lease nor keep working', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      await work.enqueuePartyRewardJob(matchId, players);
      const heldA = deferred<never>();
      const heldB = deferred<Record<string, never>>();
      const original = achievementsService.evaluateForMatch.bind(achievementsService);
      vi.spyOn(achievementsService, 'evaluateForMatch')
        .mockImplementationOnce(() => heldA.promise)
        .mockImplementationOnce(() => heldB.promise)
        .mockImplementation(original);
      const xp = vi.spyOn(progressionService, 'awardCompletedMatchXp');
      const a = work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
      await vi.waitFor(async () => expect((await lease(matchId)).held).toBe(true), { timeout: 10_000 });
      await expireLease(matchId);
      const b = work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
      await vi.waitFor(async () => expect((await job(matchId)).attempts).toBe(2), { timeout: 10_000 });
      // Both workers inside their first achievement step (A on heldA, B on heldB) before A is released.
      await vi.waitFor(() => expect(achievementsService.evaluateForMatch).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      const tokenB = (await lease(matchId)).token;
      heldA.reject(new Error('A failed late'));
      await a;
      expect(await lease(matchId)).toEqual({ token: tokenB, held: true });
      expect(xp).not.toHaveBeenCalled();
      heldB.resolve({});
      await b;
      expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 2 });
      expect(xp).toHaveBeenCalledTimes(1);
    });

    it('P2-3: a stale worker failing after its replacement finished leaves the job done', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      await work.enqueuePartyRewardJob(matchId, players);
      const heldA = deferred<never>();
      const original = progressionService.awardCompletedMatchXp.bind(progressionService);
      vi.spyOn(progressionService, 'awardCompletedMatchXp').mockImplementationOnce(() => heldA.promise).mockImplementation(original);
      const a = work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
      await vi.waitFor(async () => expect(progressionService.awardCompletedMatchXp).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      await expireLease(matchId);
      await work.runPartyCompletionWork(matchId, players, async () => {}, { enqueue: false });
      expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 2 });
      heldA.reject(new Error('A failed after B finished'));
      await a;
      expect(await job(matchId)).toMatchObject({ status: 'done', attempts: 2, last_error: null });
    });

    it('review round 4 (#2): a match whose objectives were credited at processing time (old ending, after the reset) is not paid again by its job', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      await sql`UPDATE matches SET started_at = '2026-10-04T23:54:00Z', ended_at = '2026-10-04T23:59:00Z' WHERE id = ${matchId}`;
      await sql`INSERT INTO friendships (user_low_id, user_high_id)
                VALUES (LEAST(${players[0]}::uuid, ${players[1]}::uuid), GREATEST(${players[0]}::uuid, ${players[1]}::uuid))`;
      const before = await coins(players[0]);
      // Before this release, the ending evaluated objectives with the processing clock: Monday 00:05, the new week.
      clockAt('2026-10-05T00:05:00Z');
      await objectivesService.evaluateForMatch(matchId);
      expect(await coins(players[0]) - before).toBe(300);
      // The job (backfilled, as for every match without one) evaluates it by its real end: Sunday, the old week.
      await reconciler.backfillPartyRewardJobs().catch(() => 0);
      await work.enqueuePartyRewardJob(matchId, players);
      await makeDue([matchId]);
      await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill });
      expect(await job(matchId)).toMatchObject({ status: 'done' });
      expect(await coins(players[0]) - before).toBe(300);
      const events = await sql`SELECT 1 FROM user_objective_events WHERE user_id = ${players[0]} AND objective_id = 'weekly_play_friend_custom_room' AND event_key = ${`match:${matchId}`}`;
      expect(events).toHaveLength(1);
    });

    it('a worker that died on the last attempt does not leave the job pending forever: the sweep marks it failed', async () => {
      if (!dbAvailable) return;
      const { players, matchId } = await twoMembers();
      await work.enqueuePartyRewardJob(matchId, players);
      await sql`UPDATE party_reward_jobs SET attempts = ${work.PARTY_REWARD_MAX_ATTEMPTS}, claimed_until = now() - interval '1 second', next_attempt_at = now()
                WHERE match_id = ${matchId}`;
      expect((await dueAmong(new Set([matchId]))()).length).toBe(0);
      await reconciler.reconcilePartyRewards({ findDue: dueAmong(new Set([matchId])), backfill: noBackfill });
      expect(await job(matchId)).toMatchObject({ status: 'failed' });
    });
  });
});
