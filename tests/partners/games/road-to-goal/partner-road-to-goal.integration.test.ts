import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type postgres from 'postgres';
import { g4DatabaseTarget, playsOf, quizballRewards, scoreEvents, startG4Harness, type G4Harness } from './harness.js';

/**
 * Freecroco Road to Goal on real PostgreSQL (contract §7.5). Locally:
 *   PARTNER_RTG_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_rtg
 * or MIGRATION_TEST_DATABASE_URL (creates and drops a database of its own).
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({ getRedisClient: () => ({ isReady: true, ping: async () => 'PONG' }) }));

const target = g4DatabaseTarget('PARTNER_RTG_TEST_DATABASE_URL');
const BASE = '/partner/v1/games/road-to-goal';

describe.skipIf(!target.isolated && !target.admin)('Freecroco Road to Goal on real Postgres', { timeout: 30_000 }, () => {
  let h: G4Harness;
  beforeAll(async () => { h = await startG4Harness(db, target); }, 60_000);
  afterAll(async () => { await h?.teardown(); }, 60_000);

  const post = (access: string, path: string, body: Record<string, unknown> = {}) =>
    request(h.app).post(`${BASE}${path}`).set('authorization', `Bearer ${access}`).send(body);
  const get = (access: string, path: string) => request(h.app).get(`${BASE}${path}`).set('authorization', `Bearer ${access}`);
  const start = (access: string, startId: string = randomUUID()) => post(access, '/runs', { start_id: startId });
  // Generated fixtures: option "a" is the right one.
  const answer = (access: string, state: { run_id: string; state_version: number; question: { question_id: string } }, option: string) =>
    post(access, `/runs/${state.run_id}/answer`, { question_id: state.question.question_id, option_id: option, expected_version: state.state_version });

  it('accepts only a partner token', async () => {
    expect((await request(h.app).post(`${BASE}/runs`).send({ start_id: randomUUID() })).body.error.code).toBe('partner_session_required');
    const forged = await request(h.app).get(`${BASE}/runs/current`).set('authorization', 'Bearer not-a-partner-token');
    expect(forged.status).toBe(401);
  });

  it('a right answer always clears; cash-out at the decision scores floor(100 × multiplier); one event; no Quizball rewards', async () => {
    const { access, playerId } = await h.launch();
    const started = await start(access);
    expect(started.status).toBe(201);
    let state = started.body;
    expect(state).toMatchObject({ status: 'active', phase: 'question', start_points: 100, current_points: 100, next_points: 103 });
    expect(JSON.stringify(state)).not.toMatch(/correct|is_correct/);

    const expected = [103, 108, 115];
    for (const [i, points] of expected.entries()) {
      const res = await answer(access, state, 'a');
      expect(res.body).toMatchObject({ outcome: 'correct', correct_option_id: 'a' });
      state = res.body.state;
      expect(state).toMatchObject({ phase: 'decision', cleared_zones: i + 1, current_points: points });
      if (i < expected.length - 1) state = (await post(access, `/runs/${state.run_id}/continue`, { expected_version: state.state_version })).body;
    }
    const cashed = await post(access, `/runs/${state.run_id}/cashout`, { expected_version: state.state_version });
    expect(cashed.body).toMatchObject({ status: 'cashed', score: 115, settlement_reason: 'cashout' });
    // A replayed cash-out never settles twice.
    expect((await post(access, `/runs/${state.run_id}/cashout`, { expected_version: state.state_version })).body.error.code).toBe('play_not_active');

    const events = await scoreEvents(db, playerId);
    expect(events.map((e) => [e.game_id, e.score])).toEqual([['road-to-goal', 115]]);
    expect(await quizballRewards(db, playerId)).toEqual({ coins: 0, total_xp: 0, tickets: expect.any(Number) });
    const [site] = await db.sql`SELECT to_regclass('public.road_to_goal_rounds') AS t`;
    expect(site.t).toBeNull();
  });

  it('cash-out is refused before the first cleared zone; a wrong answer scores 0', async () => {
    const { access, playerId } = await h.launch();
    const state = (await start(access)).body;
    const early = await post(access, `/runs/${state.run_id}/cashout`, { expected_version: state.state_version });
    expect(early.status).toBe(409);
    const wrong = await answer(access, state, 'b');
    expect(wrong.body).toMatchObject({ outcome: 'wrong', correct_option_id: 'a', state: { status: 'lost', score: 0 } });
    expect((await scoreEvents(db, playerId)).map((e) => e.score)).toEqual([0]);
  });

  it('a second play the same day is refused; a retried start or a second tab resumes the open run', async () => {
    const { access } = await h.launch();
    const startId = randomUUID();
    const first = (await start(access, startId)).body;
    expect((await start(access, startId)).body.run_id).toBe(first.run_id);
    expect((await start(access)).body.run_id).toBe(first.run_id);
    expect((await get(access, '/runs/current')).body.run_id).toBe(first.run_id);
    await post(access, `/runs/${first.run_id}/leave`);
    const again = await start(access);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('quota_exhausted');
  });

  it('clearing zone 11 ends the play with 400', async () => {
    const { access, playerId } = await h.launch();
    let state = (await start(access)).body;
    for (let zone = 1; zone <= 11; zone += 1) {
      const res = await answer(access, state, 'a');
      state = res.body.state;
      if (zone < 11) state = (await post(access, `/runs/${state.run_id}/continue`, { expected_version: state.state_version })).body;
    }
    expect(state).toMatchObject({ status: 'completed', score: 400, cleared_zones: 11 });
    const [run] = await db.sql<{ question_ids: string[] }[]>`SELECT question_ids FROM partner_rtg_runs WHERE id = ${state.run_id}`;
    expect(new Set(run.question_ids).size).toBe(11);
    expect((await scoreEvents(db, playerId)).map((e) => e.score)).toEqual([400]);
  });

  it('timeouts: a question timeout scores 0 and a decision timeout cashes out, at the logical deadline, via the sweeper', async () => {
    const { partnerRoadToGoalService } = await import('../../../../src/modules/partners/games/road-to-goal/partner-road-to-goal.service.js');
    const q = await h.launch();
    const lostRun = (await start(q.access)).body;
    await db.sql`UPDATE partner_rtg_runs SET question_deadline_at = now() - interval '10 seconds' WHERE id = ${lostRun.run_id}`;

    const d = await h.launch();
    let decision = (await start(d.access)).body;
    decision = (await answer(d.access, decision, 'a')).body.state;
    decision = (await post(d.access, `/runs/${decision.run_id}/continue`, { expected_version: decision.state_version })).body;
    decision = (await answer(d.access, decision, 'a')).body.state;
    await db.sql`UPDATE partner_rtg_runs SET decision_deadline_at = now() - interval '1 minute' WHERE id = ${decision.run_id}`;

    expect((await partnerRoadToGoalService.sweep()).settled).toBeGreaterThanOrEqual(2);
    expect((await partnerRoadToGoalService.sweep()).settled).toBe(0);

    const lost = (await get(q.access, `/runs/${lostRun.run_id}`)).body;
    expect(lost).toMatchObject({ status: 'lost', score: 0, settlement_reason: 'question_timeout' });
    const cashed = (await get(d.access, `/runs/${decision.run_id}`)).body;
    expect(cashed).toMatchObject({ status: 'cashed', score: 108, settlement_reason: 'decision_timeout' });

    const [lostEvent] = await scoreEvents(db, q.playerId);
    const [deadline] = await db.sql<{ at: Date }[]>`SELECT settled_at AS at FROM partner_rtg_runs WHERE id = ${lostRun.run_id}`;
    expect(lostEvent.score).toBe(0);
    expect(lostEvent.occurred_at.getTime()).toBe(deadline.at.getTime());
    expect(lostEvent.occurred_at.getTime()).toBeLessThan(Date.now() - 9_000);
    expect((await scoreEvents(db, d.playerId)).map((e) => e.score)).toEqual([108]);
  });

  it('a late answer is a timeout; leaving at the decision cashes out, during a question scores 0', async () => {
    const late = await h.launch();
    const state = (await start(late.access)).body;
    await db.sql`UPDATE partner_rtg_runs SET question_deadline_at = now() - interval '1 second' WHERE id = ${state.run_id}`;
    const res = await answer(late.access, state, 'a');
    expect(res.body).toMatchObject({ outcome: 'late', state: { status: 'lost', score: 0 } });

    const leaver = await h.launch();
    let run = (await start(leaver.access)).body;
    run = (await answer(leaver.access, run, 'a')).body.state;
    expect((await post(leaver.access, `/runs/${run.run_id}/leave`)).body).toMatchObject({ status: 'cashed', score: 103, settlement_reason: 'left_decision' });

    const quitter = await h.launch();
    const open = (await start(quitter.access)).body;
    expect((await post(quitter.access, `/runs/${open.run_id}/leave`)).body).toMatchObject({ status: 'lost', score: 0, settlement_reason: 'left_question' });
    expect((await scoreEvents(db, quitter.playerId)).map((e) => e.score)).toEqual([0]);
  });

  it('a retried start returns its run even after a resume and a settlement; concurrent starts share one run', async () => {
    const { access } = await h.launch();
    const first = (await start(access)).body;
    const resumeId = randomUUID();
    expect((await start(access, resumeId)).body.run_id).toBe(first.run_id);
    await answer(access, first, 'b');
    const retried = await start(access, resumeId);
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ run_id: first.run_id, status: 'lost' });

    const racer = await h.launch();
    const [a, b] = await Promise.all([start(racer.access), start(racer.access)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.run_id).toBe(b.body.run_id);
  });

  it('concurrent retries of one start id racing a settlement return one run and never spend a second play', async () => {
    await h.setLimit('road-to-goal', 2);
    try {
      for (let round = 0; round < 5; round += 1) {
        const { access, playerId } = await h.launch();
        let run = (await start(access)).body;
        run = (await answer(access, run, 'a')).body.state;
        const startId = randomUUID();
        const [a, b] = await Promise.all([
          start(access, startId),
          start(access, startId),
          post(access, `/runs/${run.run_id}/cashout`, { expected_version: run.state_version }),
        ]);
        expect(a.body.run_id).toBe(b.body.run_id);
        expect(await playsOf(db, playerId, 'road-to-goal')).toBeLessThanOrEqual(2);
        const [mapped] = await db.sql`SELECT count(*)::int AS n FROM partner_game_starts WHERE start_id = ${startId}`;
        expect(mapped.n).toBe(1);
        // A later retry still gets the same run.
        expect((await start(access, startId)).body.run_id).toBe(a.body.run_id);
      }
    } finally {
      await h.setLimit('road-to-goal', 1);
    }
  });

  it('a block cancels the play: the run closes with no points and no event, even after an unblock', async () => {
    const { access, playerId } = await h.launch();
    let run = (await start(access)).body;
    run = (await answer(access, run, 'a')).body.state;
    await h.setStatus(playerId, 'block');
    await h.setStatus(playerId, 'unblock');
    const again = await h.launch(playerId);
    const resumed = await get(again.access, `/runs/${run.run_id}`);
    expect(resumed.body).toMatchObject({ status: 'cancelled', score: null, settlement_reason: 'play_cancelled' });
    expect((await post(again.access, `/runs/${run.run_id}/cashout`, { expected_version: run.state_version })).status).toBe(409);
    expect(await scoreEvents(db, playerId)).toEqual([]);
  });

  it('the 1 s grace (contract §7): 15 s visible, an answer up to 1 s after it counts, later is a timeout', async () => {
    const { access } = await h.launch();
    const run = (await start(access)).body;
    const [stored] = await db.sql<{ deadline: Date; created: Date }[]>`
      SELECT question_deadline_at AS deadline, created_at AS created FROM partner_rtg_runs WHERE id = ${run.run_id}`;
    expect(stored.deadline.getTime() - new Date(run.question.deadline_at).getTime()).toBe(1_000);
    expect(stored.deadline.getTime() - stored.created.getTime()).toBeGreaterThanOrEqual(15_900);
    expect(stored.deadline.getTime() - stored.created.getTime()).toBeLessThan(16_500);

    // Visible deadline 0.5 s ago: still counts.
    await db.sql`UPDATE partner_rtg_runs SET question_deadline_at = now() + interval '500 milliseconds' WHERE id = ${run.run_id}`;
    const inGrace = await answer(access, run, 'a');
    expect(inGrace.body).toMatchObject({ outcome: 'correct', state: { phase: 'decision' } });

    let next = (await post(access, `/runs/${run.run_id}/continue`, { expected_version: inGrace.body.state.state_version })).body;
    // Visible deadline 1.2 s ago: a timeout, even with the right answer.
    await db.sql`UPDATE partner_rtg_runs SET question_deadline_at = now() - interval '200 milliseconds' WHERE id = ${run.run_id}`;
    next = (await answer(access, next, 'a')).body;
    expect(next).toMatchObject({ outcome: 'late', state: { status: 'lost', score: 0 } });
  });

  it('a run is visible only to its own player', async () => {
    const owner = await h.launch();
    const other = await h.launch();
    const run = (await start(owner.access)).body;
    expect((await get(other.access, `/runs/${run.run_id}`)).status).toBe(404);
    expect((await answer(other.access, run, 'a')).status).toBe(404);
  });
});
