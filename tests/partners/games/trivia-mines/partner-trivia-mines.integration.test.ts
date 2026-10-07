import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type postgres from 'postgres';
import { g4DatabaseTarget, playsOf, quizballRewards, scoreEvents, startG4Harness, type G4Harness } from '../road-to-goal/harness.js';
import { boardHmacInput, defendersFromSeed } from '../../../../src/modules/trivia-mines/trivia-mines.fairness.js';
import { cashoutValue, fairPotAfterPick, MILLI } from '../../../../src/modules/trivia-mines/trivia-mines.constants.js';

/**
 * Freecroco Trivia Mines on real PostgreSQL (contract §7.6). Locally:
 *   PARTNER_MINES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_mines
 * or MIGRATION_TEST_DATABASE_URL (creates and drops a database of its own).
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({ getRedisClient: () => ({ isReady: true, ping: async () => 'PONG' }) }));

const target = g4DatabaseTarget('PARTNER_MINES_TEST_DATABASE_URL');
const BASE = '/partner/v1/games/trivia-mines';

interface MinesState {
  run_id: string;
  state_version: number;
  status: string;
  phase: string;
  points: number;
  next_points: number;
  opened: number[];
  flagged: number[];
  scouts_left: number;
  score: number | null;
  question: { question_id: string } | null;
}

describe.skipIf(!target.isolated && !target.admin)('Freecroco Trivia Mines on real Postgres', { timeout: 30_000 }, () => {
  let h: G4Harness;
  beforeAll(async () => { h = await startG4Harness(db, target); }, 60_000);
  afterAll(async () => { await h?.teardown(); }, 60_000);

  const post = (access: string, path: string, body: Record<string, unknown> = {}) =>
    request(h.app).post(`${BASE}${path}`).set('authorization', `Bearer ${access}`).send(body);
  const get = (access: string, path: string) => request(h.app).get(`${BASE}${path}`).set('authorization', `Bearer ${access}`);
  const start = async (access: string, startId: string = randomUUID()) => (await post(access, '/runs', { start_id: startId })).body as MinesState;
  const defenders = async (runId: string) => {
    const [row] = await db.sql<{ server_seed: string }[]>`SELECT server_seed FROM partner_mines_runs WHERE id = ${runId}`;
    return defendersFromSeed(row.server_seed, boardHmacInput(runId, null));
  };
  const safeTiles = async (state: MinesState) => {
    const bad = await defenders(state.run_id);
    return Array.from({ length: 25 }, (_, i) => i).filter((t) => !bad.includes(t) && !state.opened.includes(t) && !state.flagged.includes(t));
  };
  const pick = async (access: string, state: MinesState, tile: number) =>
    (await post(access, `/runs/${state.run_id}/pick`, { tile, expected_version: state.state_version })).body as { safe: boolean; state: MinesState };
  const scout = async (access: string, state: MinesState) =>
    (await post(access, `/runs/${state.run_id}/question`, { expected_version: state.state_version })).body as MinesState;
  const runRow = async (runId: string) => {
    const [row] = await db.sql<{ status: string; play_id: string }[]>`SELECT status, play_id FROM partner_mines_runs WHERE id = ${runId}`;
    return row;
  };

  it('accepts only a partner token', async () => {
    expect((await request(h.app).post(`${BASE}/runs`).send({ start_id: randomUUID() })).body.error.code).toBe('partner_session_required');
  });

  it('safe tiles follow the site pricing from 100; cash-out = floor(value × 0.97); one event; no Quizball rewards', async () => {
    const { access, playerId } = await h.launch();
    let state = await start(access);
    expect(state).toMatchObject({ status: 'active', phase: 'picking', points: 100, scouts_left: 3 });
    expect(JSON.stringify(state)).not.toMatch(/defenders|server_seed|correct/);
    const cashEarly = await post(access, `/runs/${state.run_id}/cashout`, { expected_version: state.state_version });
    expect(cashEarly.status).toBe(400);

    let fair = 100 * MILLI;
    for (const tile of (await safeTiles(state)).slice(0, 3)) {
      fair = fairPotAfterPick(fair, 25 - state.opened.length, 4);
      const res = await pick(access, state, tile);
      expect(res.safe).toBe(true);
      state = res.state;
      expect(state.points).toBe(cashoutValue(fair));
    }
    const banked = (await post(access, `/runs/${state.run_id}/cashout`, { expected_version: state.state_version })).body;
    expect(banked).toMatchObject({ status: 'cashed', score: cashoutValue(fair), reveal: { defenders: await defenders(state.run_id) } });
    expect((await scoreEvents(db, playerId)).map((e) => [e.game_id, e.score])).toEqual([['trivia-mines', cashoutValue(fair)]]);
    expect(await quizballRewards(db, playerId)).toEqual({ coins: 0, total_xp: 0, tickets: expect.any(Number) });
  });

  it('a defender scores 0 and the second play the same day is refused', async () => {
    const { access, playerId } = await h.launch();
    const state = await start(access);
    const [first] = await defenders(state.run_id);
    const res = await pick(access, state, first);
    expect(res).toMatchObject({ safe: false, state: { status: 'lost', score: 0 } });
    expect((await scoreEvents(db, playerId)).map((e) => e.score)).toEqual([0]);
    const again = await post(access, '/runs', { start_id: randomUUID() });
    expect(again.body.error.code).toBe('quota_exhausted');
  });

  it('scouting: a right answer flags a defender, a wrong one only uses the scout; nothing leaks before the answer', async () => {
    const { access } = await h.launch();
    let state = await scout(access, await start(access));
    expect(state.phase).toBe('question');
    expect(JSON.stringify(state)).not.toMatch(/is_correct|correct_option/);
    const right = (await post(access, `/runs/${state.run_id}/answer`, { question_id: state.question!.question_id, option_id: 'a', expected_version: state.state_version })).body;
    expect(right.outcome).toBe('correct');
    expect(await defenders(state.run_id)).toContain(right.flagged_tile);
    state = await scout(access, right.state);
    const wrong = (await post(access, `/runs/${state.run_id}/answer`, { question_id: state.question!.question_id, option_id: 'b', expected_version: state.state_version })).body;
    expect(wrong).toMatchObject({ outcome: 'wrong', flagged_tile: null, state: { scouts_left: 1, flagged: [right.flagged_tile] } });
    // The same committed board on resume.
    expect((await get(access, '/runs/current')).body).toMatchObject({ run_id: state.run_id, flagged: [right.flagged_tile] });
    expect((await post(access, '/runs', { start_id: randomUUID() })).body.run_id).toBe(state.run_id);
  });

  it('the 1 s grace (contract §7): 10 s visible, an answer up to 1 s after it counts, later only uses the scout', async () => {
    const { access } = await h.launch();
    let state = await scout(access, await start(access));
    const [stored] = await db.sql<{ deadline: Date }[]>`SELECT question_deadline_at AS deadline FROM partner_mines_runs WHERE id = ${state.run_id}`;
    const visible = new Date((state.question as unknown as { deadline_at: string }).deadline_at).getTime();
    expect(stored.deadline.getTime() - visible).toBe(1_000);
    expect(visible - Date.now()).toBeGreaterThan(8_000);
    expect(visible - Date.now()).toBeLessThanOrEqual(10_000);

    await db.sql`UPDATE partner_mines_runs SET question_deadline_at = now() + interval '500 milliseconds' WHERE id = ${state.run_id}`;
    const inGrace = (await post(access, `/runs/${state.run_id}/answer`, { question_id: state.question!.question_id, option_id: 'a', expected_version: state.state_version })).body;
    expect(inGrace.outcome).toBe('correct');
    expect(inGrace.flagged_tile).not.toBeNull();

    state = await scout(access, inGrace.state);
    await db.sql`UPDATE partner_mines_runs SET question_deadline_at = now() - interval '200 milliseconds' WHERE id = ${state.run_id}`;
    const late = (await post(access, `/runs/${state.run_id}/answer`, { question_id: state.question!.question_id, option_id: 'a', expected_version: state.state_version })).body;
    expect(late).toMatchObject({ outcome: 'late', flagged_tile: null, state: { scouts_left: 1 } });
  });

  it('an unanswered scout burns when its time is up', async () => {
    const { access } = await h.launch();
    const state = await scout(access, await start(access));
    await db.sql`UPDATE partner_mines_runs SET question_deadline_at = now() - interval '1 second' WHERE id = ${state.run_id}`;
    expect((await get(access, '/runs/current')).body).toMatchObject({ phase: 'picking', scouts_left: 2, flagged: [] });
  });

  it('leaving: before touching the board returns the play; after a scout only = 0; after a safe tile = cash-out', async () => {
    const untouched = await h.launch();
    const fresh = await start(untouched.access);
    expect((await post(untouched.access, `/runs/${fresh.run_id}/leave`)).body).toMatchObject({ status: 'cancelled', score: null });
    const [play] = await db.sql`SELECT state, refunded FROM partner_plays WHERE id = ${(await runRow(fresh.run_id)).play_id}`;
    expect(play).toEqual({ state: 'cancelled', refunded: true });
    expect(await scoreEvents(db, untouched.playerId)).toEqual([]);
    // The play came back: a new run starts.
    expect((await start(untouched.access)).status).toBe('active');

    const scouted = await h.launch();
    const s = await scout(scouted.access, await start(scouted.access));
    expect((await post(scouted.access, `/runs/${s.run_id}/leave`)).body).toMatchObject({ status: 'lost', score: 0, settlement_reason: 'left_before_safe_tile' });

    const picker = await h.launch();
    let p = await start(picker.access);
    p = (await pick(picker.access, p, (await safeTiles(p))[0])).state;
    expect((await post(picker.access, `/runs/${p.run_id}/leave`)).body).toMatchObject({ status: 'cashed', score: p.points, settlement_reason: 'left_cashout' });
    expect((await scoreEvents(db, picker.playerId)).map((e) => e.score)).toEqual([p.points]);
  });

  it('the sweeper settles silent runs at the end of the heartbeat window, exactly once', async () => {
    const { partnerTriviaMinesService } = await import('../../../../src/modules/partners/games/trivia-mines/partner-trivia-mines.service.js');
    const picker = await h.launch();
    let p = await start(picker.access);
    p = (await pick(picker.access, p, (await safeTiles(p))[0])).state;
    const idle = await h.launch();
    const untouched = await start(idle.access);
    await db.sql`UPDATE partner_mines_runs SET last_seen_at = now() - interval '5 minutes' WHERE id IN (${p.run_id}, ${untouched.run_id})`;

    expect((await partnerTriviaMinesService.sweep()).settled).toBeGreaterThanOrEqual(2);
    expect((await partnerTriviaMinesService.sweep()).settled).toBe(0);
    expect((await runRow(p.run_id)).status).toBe('cashed');
    expect((await runRow(untouched.run_id)).status).toBe('cancelled');
    const [event] = await scoreEvents(db, picker.playerId);
    expect(event.score).toBe(p.points);
    expect(event.occurred_at.getTime()).toBeLessThan(Date.now() - 4 * 60_000);
    expect(await scoreEvents(db, idle.playerId)).toEqual([]);
  });

  it('a player silent past the window is settled on the next request, at the window end, whatever comes next', async () => {
    const { access, playerId } = await h.launch();
    let p = await start(access);
    p = (await pick(access, p, (await safeTiles(p))[0])).state;
    await db.sql`UPDATE partner_mines_runs SET last_seen_at = now() - interval '46 seconds' WHERE id = ${p.run_id}`;
    // A heartbeat no longer revives it, and a pick (even of a defender) is refused: the cash-out was owed at 45 s.
    expect((await post(access, '/runs/heartbeat')).status).toBe(204);
    const [defender] = await defenders(p.run_id);
    const late = await post(access, `/runs/${p.run_id}/pick`, { tile: defender, expected_version: p.state_version });
    expect(late.body.error.code).toBe('play_not_active');
    expect((await get(access, '/runs/latest')).body).toMatchObject({ status: 'cashed', score: p.points, settlement_reason: 'left_cashout' });
    const [event] = await scoreEvents(db, playerId);
    expect(event.score).toBe(p.points);
    expect(event.occurred_at.getTime()).toBeLessThan(Date.now() - 500);
  });

  it('concurrent retries of one start id racing a settlement return one run and never spend a second play', async () => {
    await h.setLimit('trivia-mines', 2);
    try {
      for (let round = 0; round < 5; round += 1) {
        const { access, playerId } = await h.launch();
        let p = await start(access);
        p = (await pick(access, p, (await safeTiles(p))[0])).state;
        const startId = randomUUID();
        const [a, b] = await Promise.all([
          start(access, startId),
          start(access, startId),
          post(access, `/runs/${p.run_id}/cashout`, { expected_version: p.state_version }),
        ]);
        expect(a.run_id).toBe(b.run_id);
        expect(await playsOf(db, playerId, 'trivia-mines')).toBeLessThanOrEqual(2);
        const [mapped] = await db.sql`SELECT count(*)::int AS n FROM partner_game_starts WHERE start_id = ${startId}`;
        expect(mapped.n).toBe(1);
        expect((await start(access, startId)).run_id).toBe(a.run_id);
      }
    } finally {
      await h.setLimit('trivia-mines', 1);
    }
  });

  it('a block cancels the play: the run closes with no points and no event', async () => {
    const { access, playerId } = await h.launch();
    let p = await start(access);
    p = (await pick(access, p, (await safeTiles(p))[0])).state;
    await h.setStatus(playerId, 'block');
    await h.setStatus(playerId, 'unblock');
    const again = await h.launch(playerId);
    expect((await get(again.access, `/runs/${p.run_id}`)).body).toMatchObject({ status: 'cancelled', score: null, settlement_reason: 'play_cancelled' });
    expect(await scoreEvents(db, playerId)).toEqual([]);
  });

  it('a replacement start racing a block waits on the player first and never deadlocks (lock order: player → play)', async () => {
    const { access, playerId } = await h.launch();
    const stale = await start(access);
    await db.sql`UPDATE partner_mines_runs SET last_seen_at = now() - interval '5 minutes' WHERE id = ${stale.run_id}`;
    const [{ id: player, play_id: oldPlay }] = await db.sql<{ id: string; play_id: string }[]>`
      SELECT p.id, r.play_id FROM partner_players p JOIN partner_mines_runs r ON r.player_id = p.id
      WHERE p.external_player_id = ${playerId} AND r.id = ${stale.run_id}`;

    // The block's transaction, held open: it owns the player row, as setPlayerStatus does before cancelling plays.
    const block = await db.sql.reserve();
    try {
      await block`BEGIN`;
      await block`SELECT 1 FROM partner_players WHERE id = ${player} FOR UPDATE`;
      // Without the player lock first, this start would refund the stale run (locking its play) before waiting.
      const replacing = post(access, '/runs', { start_id: randomUUID() }).then((r) => r);
      for (let i = 0; ; i += 1) {
        const [{ n }] = await db.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FROM partner_players WHERE id =%FOR SHARE%'`;
        if (n > 0) break;
        if (i > 100) throw new Error('the start never waited on the player row');
        await new Promise((r) => setTimeout(r, 50));
      }
      // The waiting start holds nothing on the old play: the block can take it at once.
      await db.sql.begin((tx) => tx`SELECT id FROM partner_plays WHERE id = ${oldPlay} FOR UPDATE NOWAIT`);
      await block`UPDATE partner_players SET status = 'blocked', status_version = status_version + 1 WHERE id = ${player}`;
      await block`UPDATE partner_sessions SET state = 'revoked', end_reason = 'blocked', ended_at = clock_timestamp() WHERE player_id = ${player} AND state IN ('issued', 'redeemed')`;
      await block`UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp() WHERE player_id = ${player} AND state = 'started'`;
      await block`COMMIT`;

      const res = await replacing;
      expect([401, 403]).toContain(res.status);
      expect(['player_blocked', 'session_ended']).toContain(res.body.error.code);
    } finally {
      block.release();
    }
    const [play] = await db.sql`SELECT state, refunded FROM partner_plays WHERE id = ${oldPlay}`;
    expect(play).toEqual({ state: 'cancelled', refunded: false });
    expect((await runRow(stale.run_id)).status).toBe('cancelled');
    const [{ n: plays }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM partner_plays WHERE player_id = ${player}`;
    expect(plays).toBe(1);
    expect(await scoreEvents(db, playerId)).toEqual([]);
  });

  it('a retried start returns its run after a resume; concurrent starts share one run', async () => {
    const { access } = await h.launch();
    const first = await start(access);
    const resumeId = randomUUID();
    expect((await start(access, resumeId)).run_id).toBe(first.run_id);
    await post(access, `/runs/${first.run_id}/leave`);
    expect(await start(access, resumeId)).toMatchObject({ run_id: first.run_id, status: 'cancelled' });

    const racer = await h.launch();
    const [a, b] = await Promise.all([start(racer.access), start(racer.access)]);
    expect(a.run_id).toBe(b.run_id);
  });

  it('the cap: a cash-out never scores above 1,000', async () => {
    const { partnerMinesCashoutPoints } = await import('../../../../src/modules/partners/games/trivia-mines/partner-trivia-mines.service.js');
    let fair = 100 * MILLI;
    for (let unknown = 25; unknown > 4; unknown -= 1) fair = fairPotAfterPick(fair, unknown, 4);
    expect(cashoutValue(fair)).toBeGreaterThan(1_000);
    expect(partnerMinesCashoutPoints(fair)).toBe(1_000);
    expect(partnerMinesCashoutPoints(119_047)).toBe(115);
  });
});
