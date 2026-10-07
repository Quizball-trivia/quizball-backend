import 'express-async-errors';
import request from 'supertest';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasTestDb, setupG1Env, type G1Env } from './g1-test-env.js';

const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isReady: true, ping: async () => 'PONG' }),
}));

describe.skipIf(!hasTestDb)('Freecroco Guess the Goal on real Postgres', { timeout: 30_000 }, () => {
  let env: G1Env;
  let service: typeof import('../../../../src/modules/partners/games/guess-the-goal/ggt-partner.service.js');

  beforeAll(async () => {
    env = await setupG1Env(db, 'ggt');
    service = await import('../../../../src/modules/partners/games/guess-the-goal/ggt-partner.service.js');
    await env.seedGoal();
  }, 60_000);
  afterAll(async () => env?.close(), 60_000);

  const as = (access: string) => ({
    get: (path: string) => request(env.app).get(`/partner/v1/games/guess-the-goal/${path}`).set('authorization', `Bearer ${access}`),
    post: (path: string, body: object = {}) =>
      request(env.app).post(`/partner/v1/games/guess-the-goal/${path}`).set('authorization', `Bearer ${access}`).send(body),
  });
  /** The right option of the play's own shuffled snapshot (ids are re-keyed per session). */
  const rightOption = async (sessionId: string, field: 'options' | 'bonus') => {
    const [row] = await env.sql<{ id: string }[]>`
      SELECT o->>'id' AS id FROM guess_the_goal_sessions s,
        jsonb_array_elements(CASE WHEN ${field} = 'options' THEN s.goal_snapshot->'options' ELSE s.goal_snapshot->'bonus'->'options' END) o
      WHERE s.id = ${sessionId} AND (o->>'is_correct')::boolean`;
    return row.id;
  };
  const wrongOption = async (sessionId: string) => {
    const [row] = await env.sql<{ id: string }[]>`
      SELECT o->>'id' AS id FROM guess_the_goal_sessions s, jsonb_array_elements(s.goal_snapshot->'options') o
      WHERE s.id = ${sessionId} AND NOT (o->>'is_correct')::boolean LIMIT 1`;
    return row.id;
  };
  const start = async (access: string, nonce = `nonce-${Math.random().toString(36).slice(2, 12)}`) => {
    const res = await as(access).post('start', { client_nonce: nonce });
    expect(res.status).toBe(201);
    return res.body;
  };

  it('accepts only the partner token', async () => {
    const res = await request(env.app).get('/partner/v1/games/guess-the-goal/current');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('partner_session_required');
    expect((await request(env.app).get('/partner/v1/games/guess-the-goal/current').set('authorization', 'Bearer nope')).status).toBe(401);
  });

  it('a right goal and a right bonus score 140 in one event; no answers before answering; no Quizball rewards', async () => {
    const player = await env.launch();
    const session = await start(player.access);
    expect(session.max_points).toBe(100);
    expect(JSON.stringify(session)).not.toMatch(/is_correct|Test goal|Fun fact|cdn\.example/);
    // A second start (another nonce) returns the open goal and reserves nothing.
    expect((await start(player.access)).session_id).toBe(session.session_id);

    const guess = await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
    expect(guess.status).toBe(200);
    expect(guess.body).toMatchObject({ correct: true, points: 100, session_state: 'guessed', finished: null });
    expect(guess.body.bonus.options.every((o: object) => !('is_correct' in o))).toBe(true);
    // Footage and fun fact often answer the bonus: held back until it is closed.
    expect(guess.body).toMatchObject({ video_url: null, fun_fact: null });
    expect(new Date(guess.body.bonus_deadline).getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(await env.events(player.externalId)).toHaveLength(0);

    const bonus = await as(player.access).post(`sessions/${session.session_id}/bonus`, { option_id: await rightOption(session.session_id, 'bonus') });
    expect(bonus.status).toBe(200);
    expect(bonus.body).toMatchObject({ correct: true, bonus_points: 40, finished: { score: 140, sent: true } });
    expect(bonus.body.video_url).toContain('cdn.example');
    // A retried answer replays; it never settles twice.
    const again = await as(player.access).post(`sessions/${session.session_id}/bonus`, { option_id: await rightOption(session.session_id, 'bonus') });
    expect(again.body.finished).toMatchObject({ score: 140 });

    const events = await env.events(player.externalId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ game_id: 'guess-the-goal', score: 140, play_id: bonus.body.finished.play_id });
    const [user] = await env.sql`SELECT coins, total_xp FROM users WHERE id = ${player.userId}`;
    expect(user).toEqual({ coins: 0, total_xp: 0 });

    // Default limit 1: today's play is used.
    const refused = await as(player.access).post('start', { client_nonce: 'another-nonce-1' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('quota_exhausted');
  });

  it('a wrong goal scores 0 and ends the play; a repeat goal is worth 40', async () => {
    await env.setLimit('guess-the-goal', 2);
    try {
      const player = await env.launch();
      const first = await start(player.access);
      const wrong = await as(player.access).post(`sessions/${first.session_id}/guess`, { option_id: await wrongOption(first.session_id) });
      expect(wrong.body).toMatchObject({ correct: false, points: 0, session_state: 'complete', finished: { score: 0 } });
      expect(wrong.body.bonus).toBeUndefined();
      expect((await as(player.access).post(`sessions/${first.session_id}/bonus`, { option_id: 'b1' })).status).toBe(409);

      // Only one published goal: the second play shows it again.
      const second = await start(player.access);
      expect(second.max_points).toBe(40);
      const right = await as(player.access).post(`sessions/${second.session_id}/guess`, { option_id: await rightOption(second.session_id, 'options') });
      expect(right.body.points).toBe(40);
      const bonus = await as(player.access).post(`sessions/${second.session_id}/bonus`, { option_id: (await rightOption(second.session_id, 'bonus')) === 'b1' ? 'b2' : 'b1' });
      expect(bonus.body).toMatchObject({ correct: false, bonus_points: 0, finished: { score: 40 } });
      expect((await env.events(player.externalId)).map((e) => e.score)).toEqual([0, 40]);
    } finally {
      await env.setLimit('guess-the-goal', 1);
    }
  });

  it('a goal left unanswered for 10 minutes is abandoned with 0, dated at that deadline', async () => {
    const player = await env.launch();
    const session = await start(player.access);
    expect((await as(player.access).post(`sessions/${session.session_id}/expire`)).status).toBe(400);
    const deadline = new Date(Date.now() - 10_000);
    const [{ idle }] = await env.sql<{ idle: number }[]>`
      SELECT extract(epoch FROM abandon_deadline - s.started_at)::int AS idle
      FROM partner_ggt_plays g JOIN guess_the_goal_sessions s ON s.id = g.session_id WHERE g.session_id = ${session.session_id}`;
    expect(idle).toBe(600);
    await env.sql`UPDATE partner_ggt_plays SET abandon_deadline = ${deadline} WHERE session_id = ${session.session_id}`;
    expect(await service.partnerGuessTheGoalService.sweepOverdue()).toBeGreaterThanOrEqual(1);
    expect(await service.partnerGuessTheGoalService.sweepOverdue()).toBe(0);

    const events = await env.events(player.externalId);
    expect(events).toHaveLength(1);
    expect(events[0].score).toBe(0);
    expect(new Date(events[0].occurred_at).getTime()).toBe(deadline.getTime());
    // An answer arriving after that gets the timeout, not a second judgement.
    const late = await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ correct: false, timed_out: true, finished: { score: 0 } });
    expect(await env.events(player.externalId)).toHaveLength(1);
  });

  it('an unanswered bonus keeps the base points, dated at the bonus deadline', async () => {
    const player = await env.launch();
    const session = await start(player.access);
    await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
    const deadline = new Date(Date.now() - 5_000);
    await env.sql`UPDATE partner_ggt_plays SET bonus_deadline = ${deadline} WHERE session_id = ${session.session_id}`;
    const expired = await as(player.access).post(`sessions/${session.session_id}/expire`);
    expect(expired.status).toBe(200);
    expect(expired.body).toMatchObject({ finished: { score: 100 }, bonus: { timed_out: true, bonus_points: 0 } });
    const events = await env.events(player.externalId);
    expect(events.map((e) => e.score)).toEqual([100]);
    expect(new Date(events[0].occurred_at).getTime()).toBe(deadline.getTime());
    // A late bonus answer cannot add the 40.
    const late = await as(player.access).post(`sessions/${session.session_id}/bonus`, { option_id: await rightOption(session.session_id, 'bonus') });
    expect(late.body).toMatchObject({ timed_out: true, finished: { score: 100 } });
  });

  it('answers and expiry share one cut-off: an answer up to 1 s after the deadline counts, later ones do not', async () => {
    await env.setLimit('guess-the-goal', 2);
    try {
      const player = await env.launch();
      const bonusAt = async (lateMs: number) => {
        const session = await start(player.access);
        await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
        await env.sql`UPDATE partner_ggt_plays SET bonus_deadline = clock_timestamp() - make_interval(secs => ${lateMs / 1000})
          WHERE session_id = ${session.session_id}`;
        return session.session_id as string;
      };
      const inGrace = await bonusAt(400);
      expect((await as(player.access).post(`sessions/${inGrace}/expire`)).status).toBe(400);
      const counted = await as(player.access).post(`sessions/${inGrace}/bonus`, { option_id: await rightOption(inGrace, 'bonus') });
      expect(counted.body).toMatchObject({ timed_out: false, finished: { score: 140 } });

      const tooLate = await bonusAt(1_500);
      const refused = await as(player.access).post(`sessions/${tooLate}/bonus`, { option_id: await rightOption(tooLate, 'bonus') });
      expect(refused.body).toMatchObject({ timed_out: true, bonus_points: 0, finished: { score: 40 } });
    } finally {
      await env.setLimit('guess-the-goal', 1);
    }
  });

  it('a lost expiry response is recovered through the play itself, finished state included', async () => {
    const player = await env.launch();
    const session = await start(player.access);
    const open = await as(player.access).get(`sessions/${session.session_id}`);
    expect(open.body).toMatchObject({ session: { session_id: session.session_id }, finished: null, outcome: null });
    expect(JSON.stringify(open.body)).not.toMatch(/is_correct|Test goal/);
    await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
    await env.sql`UPDATE partner_ggt_plays SET bonus_deadline = now() - interval '5 seconds' WHERE session_id = ${session.session_id}`;
    // The expiry commits, its response never arrives; /current no longer lists the play.
    expect((await as(player.access).post(`sessions/${session.session_id}/expire`)).status).toBe(200);
    expect((await as(player.access).get('current')).body).toEqual({ session: null, finished: null });
    const byId = await as(player.access).get(`sessions/${session.session_id}`);
    expect(byId.body).toMatchObject({
      session: null,
      finished: { score: 100, sent: true },
      outcome: { correct: true, points: 100 },
      bonus: { timed_out: true, bonus_points: 0 },
    });
    expect(await env.events(player.externalId)).toHaveLength(1);
    const other = await env.launch();
    expect((await as(other.access).get(`sessions/${session.session_id}`)).status).toBe(404);
  });

  describe('a block landing while a request is in flight', () => {
    const noAnswers = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/Right goal|Test goal|Fun fact|Which foot|Left|cdn\.example|correct_option_id/);
    const closedWithoutEvent = async (player: { externalId: string }, sessionId: string) => {
      const [row] = await env.sql`SELECT p.state FROM partner_ggt_plays g JOIN partner_plays p ON p.id = g.play_id WHERE g.session_id = ${sessionId}`;
      expect(row.state).toBe('cancelled');
      expect(await env.events(player.externalId)).toHaveLength(0);
    };

    it('a right main answer with a bonus reveals nothing', async () => {
      const player = await env.launch();
      const session = await start(player.access);
      const option = await rightOption(session.session_id, 'options');
      const res = await env.blockDuring(player.playerId, () => as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: option }));
      expect(res.status).toBe(409);
      noAnswers(res.body);
      const [s] = await env.sql`SELECT state FROM guess_the_goal_sessions WHERE id = ${session.session_id}`;
      expect(s.state).toBe('active');
      await closedWithoutEvent(player, session.session_id);
    });

    it('a retried main answer and the bonus reveal nothing', async () => {
      const player = await env.launch();
      const session = await start(player.access);
      const option = await rightOption(session.session_id, 'options');
      await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: option });
      const retry = await env.blockDuring(player.playerId, () => as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: option }));
      expect(retry.status).toBe(409);
      noAnswers(retry.body);
      await closedWithoutEvent(player, session.session_id);
    });

    it('the bonus answer reveals nothing and scores nothing', async () => {
      const player = await env.launch();
      const session = await start(player.access);
      await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
      const bonusOption = await rightOption(session.session_id, 'bonus');
      const res = await env.blockDuring(player.playerId, () => as(player.access).post(`sessions/${session.session_id}/bonus`, { option_id: bonusOption }));
      expect(res.status).toBe(409);
      noAnswers(res.body);
      await closedWithoutEvent(player, session.session_id);
    });

    it('reads of an open guessed play (GET, current) reveal nothing', async () => {
      const player = await env.launch();
      const session = await start(player.access);
      await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
      const principal = { userId: player.userId, playerId: player.playerId, language: 'en' } as never;
      const view = await env.blockDuring(player.playerId, () => service.partnerGuessTheGoalService.get(principal, session.session_id));
      expect(view).toEqual({ session: null, finished: { play_id: session.play_id, score: 0, sent: false }, outcome: null, bonus: null });
      // A second play of the same player, read through /current while a block lands.
      await env.sql`UPDATE partner_players SET status = 'active' WHERE id = ${player.playerId}`;
      await env.setLimit('guess-the-goal', 2);
      try {
        const launched = await env.launch();
        const second = await start(launched.access);
        await as(launched.access).post(`sessions/${second.session_id}/guess`, { option_id: await rightOption(second.session_id, 'options') });
        const current = await env.blockDuring(launched.playerId, () =>
          service.partnerGuessTheGoalService.current({ userId: launched.userId, playerId: launched.playerId, language: 'en' } as never));
        expect(current).toEqual({ session: null, finished: null });
        await closedWithoutEvent(launched, second.session_id);
      } finally {
        await env.setLimit('guess-the-goal', 1);
      }
    });

    it('a retried start of the open play reveals nothing', async () => {
      const player = await env.launch();
      const nonce = 'race-start-nonce-1';
      const session = await start(player.access, nonce);
      const principal = { userId: player.userId, playerId: player.playerId, sessionId: '00000000-0000-4000-8000-000000000000', language: 'en' };
      const [s] = await env.sql<{ session_id: string }[]>`SELECT session_id FROM partner_plays WHERE id = ${session.play_id}`;
      const retried = await env.blockDuring(player.playerId, () =>
        service.partnerGuessTheGoalService.start({ ...principal, sessionId: s.session_id } as never, nonce).then(
          (v) => ({ ok: true, v }),
          (e) => ({ ok: false, code: (e as { code?: string }).code }),
        ));
      expect(retried).toEqual({ ok: false, code: expect.stringMatching(/play_not_active|session_ended|player_blocked/) });
      await closedWithoutEvent(player, session.session_id);
    });

    it('expiry reveals nothing and sends no event', async () => {
      const player = await env.launch();
      const session = await start(player.access);
      await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
      await env.sql`UPDATE partner_ggt_plays SET bonus_deadline = now() - interval '5 seconds' WHERE session_id = ${session.session_id}`;
      const res = await env.blockDuring(player.playerId, () => as(player.access).post(`sessions/${session.session_id}/expire`));
      expect(res.status).toBe(409);
      noAnswers(res.body);
      await closedWithoutEvent(player, session.session_id);
    });

    it('the sweeper closes a cancelled play without an event', async () => {
      const player = await env.launch();
      const session = await start(player.access);
      await env.sql`UPDATE partner_ggt_plays SET abandon_deadline = now() - interval '1 minute' WHERE session_id = ${session.session_id}`;
      await env.blockDuring(player.playerId, () => service.partnerGuessTheGoalService.sweepOverdue());
      await service.partnerGuessTheGoalService.sweepOverdue();
      const [row] = await env.sql`SELECT p.state, g.settled_at IS NOT NULL AS settled FROM partner_plays p
        JOIN partner_ggt_plays g ON g.play_id = p.id WHERE g.session_id = ${session.session_id}`;
      expect(row).toEqual({ state: 'cancelled', settled: true });
      expect(await env.events(player.externalId)).toHaveLength(0);
    });
  });

  it('a play a block cancelled is closed, never resumed after unblocking; the play stays used', async () => {
    const player = await env.launch();
    const session = await start(player.access);
    // What a block does to a started play (partner core): cancel it, no event.
    await env.sql`UPDATE partner_plays SET state = 'cancelled', cancelled_at = now() WHERE id = ${session.play_id}`;
    expect((await as(player.access).get('current')).body).toEqual({ session: null, finished: null });
    const [closed] = await env.sql`SELECT g.settled_at IS NOT NULL AS settled, s.state FROM partner_ggt_plays g
      JOIN guess_the_goal_sessions s ON s.id = g.session_id WHERE g.session_id = ${session.session_id}`;
    expect(closed).toEqual({ settled: true, state: 'abandoned' });
    expect((await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: 'o1' })).body.error.code).toBe('play_not_active');
    expect((await as(player.access).get(`sessions/${session.session_id}`)).body).toEqual({
      session: null, finished: { play_id: session.play_id, score: 0, sent: false }, outcome: null, bonus: null,
    });
    expect((await as(player.access).post('start', { client_nonce: 'after-cancel-1' })).body.error.code).toBe('quota_exhausted');
    expect(await env.events(player.externalId)).toHaveLength(0);
  });

  it('a goal without a bonus settles on the main answer', async () => {
    await env.sql`UPDATE goal_choreographies SET status = 'archived'`;
    await env.seedGoal({ bonus: false });
    try {
      const player = await env.launch();
      const session = await start(player.access);
      const res = await as(player.access).post(`sessions/${session.session_id}/guess`, { option_id: await rightOption(session.session_id, 'options') });
      expect(res.body).toMatchObject({ correct: true, session_state: 'complete', finished: { score: 100 } });
      expect(res.body.video_url).toContain('cdn.example');
    } finally {
      await env.sql`UPDATE goal_choreographies SET status = 'published'`;
    }
  });

});
