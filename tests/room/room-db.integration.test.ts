import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the full schema (room migrations applied) and a seeded room_pool, e.g. a clone of the
 * local room DB:
 *   ROOM_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
// Capture SQL text only (never parameters) to enforce the hot-path query budgets against real Postgres.
const queries: string[] = [];
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.ROOM_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { roomService, ROOM_AWAY_MS } = await import('../../src/modules/room/room.service.js');

type Snapshot = NonNullable<Awaited<ReturnType<typeof roomService.snapshot>>>;
type View = {
  phase: string; round: number; scoring: string; mySeat: number; myGuess: number | null;
  question: Record<string, unknown>; reveal: { value: number; entries: Array<{ seat: number; guess: number | null }> } | null;
  results: unknown[]; standings: Array<{ seat: number; place: number; points: number }> | null;
  seats: Array<{ seat: number; status: string; answered: boolean }>;
};

describe.skipIf(!url)('room runtime on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined, debug: (_connection, query) => { queries.push(query); } });
    const [{ n }] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM room_pool WHERE game = 'aproximado' AND enabled`;
    if (n < 30) throw new Error('Seed room_pool first (scripts/room-seed-pool.ts)');
  });
  afterAll(async () => { await db.sql?.end(); });
  beforeEach(async () => {
    await db.sql`TRUNCATE room_commands, room_seats, room_match_content, room_matches`;
  });

  const user = async (isGuest = false) => {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`p-${randomUUID().slice(0, 8)}`}, ${isGuest}) RETURNING id`;
    return row.id;
  };

  /** A waiting room-game lobby with n ready members (the second one a guest). */
  async function room(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await user(i === 1));
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'aproximado') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    return { lobbyId: lobby.id, ids, players: ids.map((userId, i) => ({ userId, isGuest: i === 1 })) };
  }

  const create = async (n: number) => {
    const r = await room(n);
    const created = await roomService.createFromLobby({ lobbyId: r.lobbyId, game: 'aproximado', players: r.players });
    return { ...r, matchId: created.matchId, created };
  };

  /** Moves the match clock (and every away seat's window) to just past due and expires it with the current token. */
  async function runOut(matchId: string, seatsToo = true) {
    await db.sql`
      UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '10 milliseconds',
        state = CASE WHEN state IS NULL THEN NULL
          ELSE jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 10)) END
      WHERE id = ${matchId}`;
    if (seatsToo) await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '10 milliseconds' WHERE match_id = ${matchId} AND NOT connected AND absence_deadline_at IS NOT NULL`;
    return roomService.expire(matchId, await token(matchId));
  }

  const token = async (id: string) => (await db.sql<Array<{ phase_token: number }>>`SELECT phase_token FROM room_matches WHERE id = ${id}`)[0].phase_token;
  const matchRow = async (id: string) => (await db.sql`SELECT status, state, state_version, phase_token, phase_deadline_at, result FROM room_matches WHERE id = ${id}`)[0];
  const lobbyRow = async (id: string) => (await db.sql`SELECT status FROM lobbies WHERE id = ${id}`)[0];
  const seatRow = async (matchId: string, userId: string) => (await db.sql`SELECT * FROM room_seats WHERE match_id = ${matchId} AND user_id = ${userId}`)[0];
  const valueOf = async (matchId: string, r: number) =>
    ((await db.sql`SELECT content FROM room_match_content WHERE match_id = ${matchId}`)[0].content as { questions: Array<{ value: number; exactWithin: number }> }).questions[r];
  const view = async (matchId: string, userId: string) => ((await roomService.snapshot(matchId, userId)) as Snapshot).view as View;
  const guess = (matchId: string, userId: string, round: number, value: number, commandId = randomUUID()) =>
    roomService.command(matchId, userId, commandId, { type: 'guess', round, value });

  /** Everyone ready, the intro played out: question 1 is open. */
  async function started(n: number) {
    const r = await create(n);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'es');
    expect((await matchRow(r.matchId)).state.phase).toBe('intro');
    await runOut(r.matchId);
    expect((await matchRow(r.matchId)).state.phase).toBe('guess');
    return r;
  }

  it('a start flips the room active, opens the gate, and the same room cannot start twice', async () => {
    const r = await create(3);
    expect(r.created).toMatchObject({ status: 'ready', finished: false, timer: { token: 1 } });
    expect((await lobbyRow(r.lobbyId)).status).toBe('active');
    const seats = await db.sql`SELECT user_id, slot, seat, admitted, active FROM room_seats WHERE match_id = ${r.matchId} ORDER BY slot`;
    expect(seats.map((s) => [s.user_id, s.slot, s.seat, s.admitted, s.active])).toEqual(r.ids.map((id, i) => [id, i, null, false, true]));
    await expect(roomService.createFromLobby({ lobbyId: r.lobbyId, game: 'aproximado', players: r.players })).rejects.toMatchObject({ code: 'room_changed' });
    const content = (await db.sql`SELECT item_ids FROM room_match_content WHERE match_id = ${r.matchId}`)[0];
    expect(new Set(content.item_ids).size).toBe(10);
  });

  it('refuses a start with 1 or 7 players, or with a member who is not ready', async () => {
    await expect(roomService.createFromLobby({ lobbyId: randomUUID(), game: 'aproximado', players: [{ userId: randomUUID(), isGuest: false }] })).rejects.toMatchObject({ code: 'room_needs_players' });
    const seven = Array.from({ length: 7 }, () => ({ userId: randomUUID(), isGuest: false }));
    await expect(roomService.createFromLobby({ lobbyId: randomUUID(), game: 'aproximado', players: seven })).rejects.toMatchObject({ code: 'room_needs_players' });
    const r = await room(2);
    await db.sql`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${r.lobbyId} AND user_id = ${r.ids[1]}`;
    await expect(roomService.createFromLobby({ lobbyId: r.lobbyId, game: 'aproximado', players: r.players })).rejects.toMatchObject({ code: 'room_changed' });
  });

  it('closes the gate early once everyone is ready and admits seats densely in join order', async () => {
    const r = await create(2);
    expect(await roomService.ready(r.matchId, r.ids[1], 'en')).toMatchObject({ status: 'ready', timer: null });
    const go = await roomService.ready(r.matchId, r.ids[0], 'es');
    expect(go).toMatchObject({ status: 'active', finished: false });
    expect((await matchRow(r.matchId)).state).toMatchObject({ phase: 'intro', status: ['in', 'in'] });
    expect((await seatRow(r.matchId, r.ids[0])).seat).toBe(0);
    expect((await seatRow(r.matchId, r.ids[1])).seat).toBe(1);
    expect((await view(r.matchId, r.ids[1])).scoring).toBe('closest');
  });

  it('the gate runs out: ready seats play (renumbered), the rest are out and refused', async () => {
    const r = await create(4);
    await roomService.ready(r.matchId, r.ids[0], 'es');
    await roomService.ready(r.matchId, r.ids[2], 'es');
    await roomService.ready(r.matchId, r.ids[3], 'es');
    await runOut(r.matchId);
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('active');
    expect(row.state.status).toEqual(['in', 'in', 'in']);
    expect((await seatRow(r.matchId, r.ids[2])).seat).toBe(1);
    expect((await seatRow(r.matchId, r.ids[3])).seat).toBe(2);
    const out = await seatRow(r.matchId, r.ids[1]);
    expect(out).toMatchObject({ admitted: false, seat: null });
    const outSnap = (await roomService.snapshot(r.matchId, r.ids[1]))!;
    expect(outSnap.me.admitted).toBe(false);
    expect(outSnap.view).toBeNull();
    await runOut(r.matchId);
    expect((await guess(r.matchId, r.ids[1], 0, 10)).result).toEqual({ ok: false, code: 'excluded' });
    // A late ready after the gate changes nothing.
    await roomService.ready(r.matchId, r.ids[1], 'es');
    expect((await seatRow(r.matchId, r.ids[1])).admitted).toBe(false);
    expect((await view(r.matchId, r.ids[0])).scoring).toBe('podium');
  });

  it('fewer than two ready when the gate runs out cancels the match and reopens the room', async () => {
    const r = await create(3);
    await roomService.ready(r.matchId, r.ids[0], 'es');
    const res = await runOut(r.matchId);
    expect(res).toMatchObject({ status: 'cancelled', finished: true });
    expect((await matchRow(r.matchId)).result).toEqual({ reason: 'cancelled', standings: [] });
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
    expect(await roomService.liveMatchFor(r.ids[0])).toBeFalsy();
  });

  it('a leave at the gate drops the seat; the last two leaving cancels', async () => {
    const r = await create(3);
    await roomService.ready(r.matchId, r.ids[0], 'es');
    await roomService.ready(r.matchId, r.ids[1], 'es');
    // The third leaves: everyone left is ready, so the gate closes and the two play.
    const res = await roomService.leave(r.matchId, r.ids[2]);
    expect(res).toMatchObject({ status: 'active' });
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'in']);

    const r2 = await create(2);
    expect(await roomService.leave(r2.matchId, r2.ids[0])).toMatchObject({ status: 'cancelled', finished: true });
    expect((await lobbyRow(r2.lobbyId)).status).toBe('waiting');
  });

  it('plays a full 1v1: every round closes early, the result is stored, the room reopens with readiness reset', async () => {
    const r = await started(2);
    for (let round = 0; round < 10; round += 1) {
      const q = await valueOf(r.matchId, round);
      expect((await guess(r.matchId, r.ids[0], round, q.value)).result).toEqual({ ok: true });
      const second = await guess(r.matchId, r.ids[1], round, q.value + 1_000);
      expect(second.result).toEqual({ ok: true });
      const v = await view(r.matchId, r.ids[1]);
      expect(v.phase).toBe('reveal');
      expect(v.reveal!.value).toBe(q.value);
      expect(v.results).toHaveLength(round + 1);
      await runOut(r.matchId);
    }
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('completed');
    expect(row.result.reason).toBe('score');
    expect(row.result.standings[0]).toMatchObject({ userId: r.ids[0], place: 1, withdrawn: false });
    expect(row.result.standings[1]).toMatchObject({ userId: r.ids[1], place: 2 });
    expect(row.phase_deadline_at).toBeNull();
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
    const members = await db.sql`SELECT is_ready FROM lobby_members WHERE lobby_id = ${r.lobbyId}`;
    expect(members.every((m) => m.is_ready === false)).toBe(true);
    const seats = await db.sql`SELECT active, place FROM room_seats WHERE match_id = ${r.matchId} ORDER BY seat`;
    expect(seats.map((s) => [s.active, s.place])).toEqual([[false, 1], [false, 2]]);
    const end = (await roomService.snapshot(r.matchId, r.ids[0]))!;
    expect(end.status).toBe('completed');
    expect((end.view as View).standings).toHaveLength(2);
    // A new match can start from the same room.
    await db.sql`UPDATE lobby_members SET is_ready = true WHERE lobby_id = ${r.lobbyId}`;
    const again = await roomService.createFromLobby({ lobbyId: r.lobbyId, game: 'aproximado', players: r.players });
    expect(again.matchId).not.toBe(r.matchId);
  });

  it('never shows the value, the exact window or another seat\'s guess before the reveal', async () => {
    const r = await started(3);
    const q = await valueOf(r.matchId, 0);
    const secret = 7_654_321;
    await guess(r.matchId, r.ids[0], 0, secret);
    for (const id of r.ids) {
      const snap = (await roomService.snapshot(r.matchId, id))!;
      const v = snap.view as View;
      expect(v.phase).toBe('guess');
      expect(v.reveal).toBeNull();
      expect(v.results).toEqual([]);
      expect(Object.keys(v.question).sort()).toEqual(['id', 'kind', 'precision', 'prompt', 'unit']);
      const text = JSON.stringify(snap);
      expect(text).not.toContain('exactWithin');
      expect(text).not.toContain('"value"');
      if (id !== r.ids[0]) expect(text).not.toContain(String(secret));
      else expect(v.myGuess).toBe(secret);
      expect(v.seats.find((s) => s.seat === 0)!.answered).toBe(true);
      expect(v.seats.every((s) => !('guess' in s))).toBe(true);
    }
    expect(q.value).toBeGreaterThanOrEqual(0);
    expect(await roomService.snapshot(r.matchId, randomUUID())).toBeNull();
  });

  it('localizes the question per viewer', async () => {
    const r = await started(2);
    await roomService.setLocale(r.matchId, r.ids[1], 'ka');
    const es = await view(r.matchId, r.ids[0]);
    const ka = await view(r.matchId, r.ids[1]);
    expect(es.question.id).toBe(ka.question.id);
    expect(es.question.prompt).not.toBe(ka.question.prompt);
    expect(String(ka.question.prompt)).toMatch(/[Ⴀ-ჿ]/);
  });

  it('batch delivery keeps locales and guesses private and excludes non-members', async () => {
    const r = await started(3);
    await roomService.setLocale(r.matchId, r.ids[1], 'ka');
    await guess(r.matchId, r.ids[0], 0, 7_654_321);
    const outsider = randomUUID();
    const snapshots = await roomService.snapshots(r.matchId, [...r.ids, outsider]);
    expect(snapshots.size).toBe(3);
    expect(snapshots.has(outsider)).toBe(false);
    expect((snapshots.get(r.ids[0])!.view as View).myGuess).toBe(7_654_321);
    expect(JSON.stringify(snapshots.get(r.ids[1]))).not.toContain('7654321');
    expect(String((snapshots.get(r.ids[1])!.view as View).question.prompt)).toMatch(/[Ⴀ-ჿ]/);
    for (const snapshot of snapshots.values()) {
      expect(Object.keys((snapshot.view as View).question).sort()).toEqual(['id', 'kind', 'precision', 'prompt', 'unit']);
      expect((snapshot.view as View).reveal).toBeNull();
    }
  });

  it('reads one shared snapshot for six recipients and skips unused content reads', async () => {
    const r = await started(6);
    queries.length = 0;
    // The match and its seats; the content of a live match was read once, when it started, and is kept.
    expect((await roomService.snapshots(r.matchId, [...r.ids, r.ids[0]])).size).toBe(6);
    expect(queries).toHaveLength(2);
    expect(queries.some((query) => /SELECT content FROM room_match_content/.test(query))).toBe(false);
    queries.length = 0;
    expect((await roomService.snapshots(r.matchId, [])).size).toBe(0);
    expect(queries).toHaveLength(0);
    expect(await roomService.snapshot(r.matchId, randomUUID())).toBeNull();
    expect(queries).toHaveLength(2);
    expect(queries.some((query) => /SELECT content FROM room_match_content/.test(query))).toBe(false);
  });

  it('keeps the content of a live match in memory and reads an ended match from the table', async () => {
    const r = await started(2);
    queries.length = 0;
    await guess(r.matchId, r.ids[0], 0, 5);
    await roomService.snapshots(r.matchId, r.ids);
    expect(queries.some((query) => /SELECT content FROM room_match_content/.test(query))).toBe(false);
    await roomService.leave(r.matchId, r.ids[0]);
    expect((await matchRow(r.matchId)).status).not.toBe('active');
    queries.length = 0;
    expect((await roomService.snapshots(r.matchId, r.ids)).size).toBe(2);
    expect(queries.filter((query) => /SELECT content FROM room_match_content/.test(query))).toHaveLength(1);
  });

  it('a live match whose content row is gone is cancelled, whether or not this replica had the content in memory', async () => {
    const r = await started(2);
    await roomService.snapshots(r.matchId, r.ids); // the content is in memory now
    await db.sql`DELETE FROM room_match_content WHERE match_id = ${r.matchId}`;
    expect((await roomService.snapshot(r.matchId, r.ids[0]))?.view ?? null).toBeNull();
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '10 milliseconds' WHERE id = ${r.matchId}`;
    await roomService.expire(r.matchId, (await matchRow(r.matchId)).phase_token);
    expect((await matchRow(r.matchId)).status).toBe('cancelled');
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
  });

  it('batches six-seat creation, admission and final placements without losing any seat or score', async () => {
    queries.length = 0;
    const r = await create(6);
    expect(queries.filter((query) => /INSERT INTO room_seats/.test(query))).toHaveLength(1);
    for (const id of r.ids.slice(0, -1)) await roomService.ready(r.matchId, id, 'es');
    queries.length = 0;
    await roomService.ready(r.matchId, r.ids[5], 'es');
    expect(queries.filter((query) => /UPDATE room_seats s SET seat =/.test(query))).toHaveLength(1);
    const seats = await db.sql`SELECT user_id, seat, admitted FROM room_seats WHERE match_id = ${r.matchId} ORDER BY slot`;
    expect(seats.map((s) => [s.user_id, s.seat, s.admitted])).toEqual(r.ids.map((id, i) => [id, i, true]));
    await runOut(r.matchId);
    for (const id of r.ids) expect((await guess(r.matchId, id, 0, 1)).result.ok).toBe(true);
    for (const id of r.ids.slice(1, 5)) await roomService.leave(r.matchId, id);
    queries.length = 0;
    expect(await roomService.leave(r.matchId, r.ids[5])).toMatchObject({ status: 'completed', finished: true });
    expect(queries.filter((query) => /UPDATE room_seats s SET active = false/.test(query))).toHaveLength(1);
    const result = (await matchRow(r.matchId)).result;
    const finalSeats = await db.sql`SELECT user_id, active, place, points FROM room_seats WHERE match_id = ${r.matchId}`;
    expect(finalSeats).toHaveLength(6);
    for (const seat of finalSeats) {
      const standing = result.standings.find((s: { userId: string }) => s.userId === seat.user_id);
      expect(seat).toMatchObject({ active: false, place: standing.place, points: standing.points });
    }
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
  });

  it('commands are idempotent, and refused with clear codes', async () => {
    const r = await started(3);
    const id = randomUUID();
    expect((await guess(r.matchId, r.ids[0], 0, 100, id)).result).toEqual({ ok: true });
    expect(await guess(r.matchId, r.ids[0], 0, 100, id)).toEqual({ result: { ok: true }, effects: null });
    expect((await guess(r.matchId, r.ids[0], 0, 200, id)).result).toEqual({ ok: false, code: 'command_id_reused' });
    expect((await guess(r.matchId, r.ids[0], 0, 200)).result).toEqual({ ok: false, code: 'already_answered' });
    expect((await guess(r.matchId, r.ids[1], 3, 200)).result).toEqual({ ok: false, code: 'stale_round' });
    expect((await guess(r.matchId, r.ids[1], 0, 1.5)).result).toEqual({ ok: false, code: 'invalid' });
    expect((await guess(r.matchId, r.ids[1], 0, -1)).result).toEqual({ ok: false, code: 'invalid' });
    expect((await guess(r.matchId, r.ids[1], 0, 20_000_000)).result).toEqual({ ok: false, code: 'invalid' });
    expect((await roomService.command(r.matchId, r.ids[1], randomUUID(), { type: 'guess', round: 0, value: '12' })).result).toEqual({ ok: false, code: 'invalid_command' });
    expect((await roomService.command(r.matchId, r.ids[1], randomUUID(), { type: 'peek' })).result).toEqual({ ok: false, code: 'invalid_command' });
    await expect(guess(r.matchId, randomUUID(), 0, 1)).rejects.toMatchObject({ code: 'not_in_match' });
    await expect(guess(randomUUID(), r.ids[0], 0, 1)).rejects.toMatchObject({ code: 'room_not_found' });
    // Still one guess on the board.
    expect((await matchRow(r.matchId)).state.guesses).toEqual([100, null, null]);
  });

  it('a guess during the intro or after the deadline is not taken', async () => {
    const r = await create(2);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'es');
    expect((await guess(r.matchId, r.ids[0], 0, 5)).result).toEqual({ ok: false, code: 'not_open' });
    await runOut(r.matchId);
    // The question's deadline passes without the timer having fired: the command meets the reveal.
    await db.sql`UPDATE room_matches SET state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 10)) WHERE id = ${r.matchId}`;
    expect((await guess(r.matchId, r.ids[0], 0, 5)).result).toEqual({ ok: false, code: 'not_open' });
    expect((await matchRow(r.matchId)).state.phase).toBe('reveal');
  });

  it('an old phase token or a deadline not yet due changes nothing', async () => {
    const r = await started(2);
    const before = await matchRow(r.matchId);
    expect(await roomService.expire(r.matchId, before.phase_token - 1)).toBeNull();
    const early = await roomService.expire(r.matchId, before.phase_token);
    expect(early).toMatchObject({ status: 'active', timer: { token: before.phase_token } });
    expect((await matchRow(r.matchId)).state_version).toBe(before.state_version);
  });

  it('a long stall (outage) gives the open question a fresh window instead of charging everyone', async () => {
    const r = await started(2);
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '1 minute',
      state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 60000)) WHERE id = ${r.matchId}`;
    await roomService.expire(r.matchId, await token(r.matchId));
    const row = await matchRow(r.matchId);
    expect(row.state).toMatchObject({ phase: 'guess', round: 0, results: [] });
    expect(row.state.deadline).toBeGreaterThan(Date.now() + 10_000);
  });

  it('away and back within the window: rounds keep running, the seat is charged and plays on', async () => {
    const r = await started(3);
    const gen = (await seatRow(r.matchId, r.ids[1])).presence_gen;
    const away = await roomService.absent(r.ids[1], { matchId: r.matchId, gen });
    expect(away).toMatchObject({ status: 'active' });
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'away', 'in']);
    const seat = await seatRow(r.matchId, r.ids[1]);
    expect(seat.connected).toBe(false);
    expect(seat.absence_deadline_at.getTime() - seat.absent_since.getTime()).toBeGreaterThan(ROOM_AWAY_MS - 1_000);
    // The two seats that are in answer: the question closes without waiting for the away seat.
    await guess(r.matchId, r.ids[0], 0, 1);
    await guess(r.matchId, r.ids[2], 0, 2);
    expect((await matchRow(r.matchId)).state.phase).toBe('reveal');
    await db.sql`UPDATE room_seats SET absent_since = absent_since - interval '5 seconds' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[1]}`;
    await roomService.present(r.ids[1]);
    const back = await seatRow(r.matchId, r.ids[1]);
    expect(back).toMatchObject({ connected: true, absent_since: null, absence_deadline_at: null });
    expect(back.absence_used_ms).toBeGreaterThanOrEqual(5_000);
    expect(back.presence_gen).toBeGreaterThan(gen);
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'in', 'in']);
    // A stale disconnect check (old generation) does nothing.
    expect(await roomService.absent(r.ids[1], { matchId: r.matchId, gen })).toBeNull();
    expect((await seatRow(r.matchId, r.ids[1])).connected).toBe(true);
  });

  it('a server outage moves open absence windows on instead of withdrawing the away seat', async () => {
    const r = await started(3);
    await roomService.absent(r.ids[2]);
    // The server was down: the match deadline was missed by 40 s, the seat's absence deadline by 20 s.
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '40 seconds',
      state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 40000)) WHERE id = ${r.matchId}`;
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '20 seconds', absent_since = clock_timestamp() - interval '45 seconds'
      WHERE match_id = ${r.matchId} AND user_id = ${r.ids[2]}`;
    await roomService.expire(r.matchId, await token(r.matchId));
    const row = await matchRow(r.matchId);
    expect(row.state.status).toEqual(['in', 'in', 'away']);
    expect(row.state).toMatchObject({ phase: 'guess', round: 0, results: [] });
    const seat = await seatRow(r.matchId, r.ids[2]);
    expect(seat.active).toBe(true);
    expect(seat.absence_deadline_at.getTime()).toBeGreaterThan(Date.now());
    // Back now: charged only for the time before the outage (5 s), not the 40 s the server was down.
    await roomService.present(r.ids[2]);
    const back = await seatRow(r.matchId, r.ids[2]);
    expect(back.absence_used_ms).toBeGreaterThanOrEqual(4_000);
    expect(back.absence_used_ms).toBeLessThan(10_000);
  });

  it('the question closes at once when the last seat it waited for drops or leaves', async () => {
    const r = await started(3);
    await guess(r.matchId, r.ids[0], 0, 1);
    await guess(r.matchId, r.ids[1], 0, 2);
    expect((await matchRow(r.matchId)).state.phase).toBe('guess');
    await roomService.absent(r.ids[2]);
    expect((await matchRow(r.matchId)).state.phase).toBe('reveal');

    const r2 = await started(3);
    await guess(r2.matchId, r2.ids[0], 0, 1);
    await guess(r2.matchId, r2.ids[1], 0, 2);
    await roomService.leave(r2.matchId, r2.ids[2]);
    const row = await matchRow(r2.matchId);
    expect(row.state.phase).toBe('reveal');
    expect(row.state.status).toEqual(['in', 'in', 'withdrawn']);
  });

  it('the absence budget shortens later windows', async () => {
    const r = await started(2);
    await db.sql`UPDATE room_seats SET absence_used_ms = 50000 WHERE match_id = ${r.matchId} AND user_id = ${r.ids[1]}`;
    await roomService.absent(r.ids[1]);
    const seat = await seatRow(r.matchId, r.ids[1]);
    const window = seat.absence_deadline_at.getTime() - seat.absent_since.getTime();
    expect(window).toBeGreaterThan(9_000);
    expect(window).toBeLessThanOrEqual(10_500);
    // The match deadline follows the earliest of the question and the absence window.
    expect((await matchRow(r.matchId)).phase_deadline_at.getTime()).toBeLessThanOrEqual(seat.absence_deadline_at.getTime());
  });

  it('away past the window: the seat is withdrawn; in a 1v1 after a revealed round the other seat wins', async () => {
    const r = await started(2);
    const q = await valueOf(r.matchId, 0);
    await guess(r.matchId, r.ids[0], 0, q.value);
    await guess(r.matchId, r.ids[1], 0, q.value + 5);
    await runOut(r.matchId);
    await roomService.absent(r.ids[1]);
    const res = await runOut(r.matchId);
    expect(res).toMatchObject({ status: 'completed', finished: true });
    const row = await matchRow(r.matchId);
    expect(row.result.standings[0]).toMatchObject({ userId: r.ids[0], place: 1, withdrawn: false });
    expect(row.result.standings[1]).toMatchObject({ userId: r.ids[1], withdrawn: true });
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
    // Coming back after the end finds no live match.
    expect(await roomService.present(r.ids[1])).toBeNull();
  });

  it('withdrawal before any reveal cancels a 1v1', async () => {
    const r = await started(2);
    await roomService.absent(r.ids[0]);
    // The seat's window ran out while question 1 was still open.
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '1 second' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[0]}`;
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${r.matchId}`;
    expect(await roomService.expire(r.matchId, await token(r.matchId))).toMatchObject({ status: 'cancelled' });
  });

  it('a seat back after its window had passed (no timer ran) is withdrawn by the catch-up, not revived', async () => {
    const r = await started(3);
    await roomService.absent(r.ids[2]);
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '10 milliseconds' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[2]}`;
    await roomService.present(r.ids[2]);
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'in', 'withdrawn']);
    expect((await seatRow(r.matchId, r.ids[2])).active).toBe(false);
    expect((await guess(r.matchId, r.ids[2], 0, 3)).result).toEqual({ ok: false, code: 'withdrawn' });
  });

  it('a leave mid-match is final: the others play on and the leaver ranks last', async () => {
    const r = await started(4);
    const q = await valueOf(r.matchId, 0);
    await guess(r.matchId, r.ids[3], 0, q.value);
    expect(await roomService.leave(r.matchId, r.ids[3])).toMatchObject({ status: 'active' });
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'in', 'in', 'withdrawn']);
    expect(await roomService.leave(r.matchId, r.ids[3])).toBeNull();
    // The early close waits only for the three still in.
    for (const id of r.ids.slice(0, 3)) await guess(r.matchId, id, 0, q.value + 1);
    expect((await matchRow(r.matchId)).state.phase).toBe('reveal');
    // Then everyone else leaves at once except one: the match ends with a result.
    await roomService.leave(r.matchId, r.ids[1]);
    const end = await roomService.leave(r.matchId, r.ids[2]);
    expect(end).toMatchObject({ status: 'completed' });
    const standings = (await matchRow(r.matchId)).result.standings as Array<{ userId: string; place: number; withdrawn: boolean }>;
    expect(standings[0]).toMatchObject({ userId: r.ids[0], withdrawn: false, place: 1 });
    expect(standings.slice(1).every((s) => s.withdrawn)).toBe(true);
  });

  it('every away seat withdrawn in the same update cancels before a reveal (no last-processed winner)', async () => {
    const r = await started(3);
    for (const id of r.ids) await roomService.absent(id);
    expect(await runOut(r.matchId)).toMatchObject({ status: 'cancelled' });
  });

  it('plays a 6-seat match to the end with a podium, idle seats included', async () => {
    const r = await started(6);
    expect((await view(r.matchId, r.ids[5])).scoring).toBe('podium');
    for (let round = 0; round < 10; round += 1) {
      const q = await valueOf(r.matchId, round);
      // Seat 5 never answers: after two missed rounds it is idle and the early close stops waiting for it.
      for (const [i, id] of r.ids.slice(0, 5).entries()) await guess(r.matchId, id, round, q.value + i * 10);
      const row = await matchRow(r.matchId);
      if (round >= 2) expect(row.state.phase).toBe('reveal');
      else {
        expect(row.state.phase).toBe('guess');
        await runOut(r.matchId);
      }
      await runOut(r.matchId);
    }
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('completed');
    const standings = row.result.standings as Array<{ userId: string; place: number; points: number }>;
    expect(standings).toHaveLength(6);
    expect(standings[0]).toMatchObject({ userId: r.ids[0], place: 1 });
    expect(standings[5]).toMatchObject({ userId: r.ids[5], points: 0 });
  });

  it('the age cap cancels a stuck match; retention purges ended content', async () => {
    const r = await started(2);
    await db.sql`UPDATE room_matches SET created_at = now() - interval '4 hours' WHERE id = ${r.matchId}`;
    expect(await roomService.staleLiveMatches()).toContain(r.matchId);
    expect(await roomService.cancelStale(r.matchId)).toMatchObject({ status: 'cancelled' });
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
    await db.sql`UPDATE room_matches SET ended_at = now() - interval '31 days' WHERE id = ${r.matchId}`;
    const purged = await roomService.purgeEnded();
    expect(purged.contents).toBeGreaterThanOrEqual(1);
    expect(await roomService.snapshot(r.matchId, r.ids[0])).toMatchObject({ status: 'cancelled', view: null });
  });

  it('one live seat per user: a player in a live room match cannot be seated in a second one', async () => {
    const r = await started(2);
    const r2 = await room(2);
    // The shared player is a ready member of the second room too, so only the seat constraint can refuse the start.
    await db.sql`DELETE FROM lobby_members WHERE lobby_id = ${r2.lobbyId} AND user_id = ${r2.ids[0]}`;
    await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${r2.lobbyId}, ${r.ids[0]}, true)`;
    await expect(roomService.createFromLobby({
      lobbyId: r2.lobbyId, game: 'aproximado', players: [{ userId: r.ids[0], isGuest: false }, r2.players[1]],
    })).rejects.toMatchObject({ constraint_name: 'uq_room_seats_one_live' });
    // The losing start rolled back whole: the room is still waiting and holds no match.
    expect((await lobbyRow(r2.lobbyId)).status).toBe('waiting');
    expect((await db.sql`SELECT count(*)::int AS n FROM room_matches WHERE lobby_id = ${r2.lobbyId}`)[0].n).toBe(0);
  });

  /** Plays rounds 0..last with seat 0 exact and seat 1 off; stops in the reveal of `last`. */
  async function playThrough(r: { matchId: string; ids: string[] }, last: number) {
    for (let round = 0; round <= last; round += 1) {
      const q = await valueOf(r.matchId, round);
      await guess(r.matchId, r.ids[0], round, q.value);
      await guess(r.matchId, r.ids[1], round, q.value + 1_000);
      expect((await matchRow(r.matchId)).state).toMatchObject({ phase: 'reveal', round });
      if (round < last) await runOut(r.matchId);
    }
  }
  const msAgo = (ms: number) => db.sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${ms} AS t`.then(([x]) => Number(x.t));

  it('a match that was already over is not reversed by an absence that expired after it', async () => {
    const r = await started(2);
    await playThrough(r, 9);
    await roomService.absent(r.ids[0]); // the leader drops during the last reveal
    // Recovery runs late (but no outage): the final reveal ended 2 s ago, the leader's window 1 s ago.
    const end = await msAgo(2_000);
    await db.sql`UPDATE room_matches SET state = jsonb_set(state, '{deadline}', to_jsonb(${end}::bigint)), phase_deadline_at = to_timestamp(${end}::double precision / 1000) WHERE id = ${r.matchId}`;
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '1 second' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[0]}`;
    expect(await roomService.expire(r.matchId, await token(r.matchId))).toMatchObject({ status: 'completed' });
    const standings = (await matchRow(r.matchId)).result.standings;
    expect(standings[0]).toMatchObject({ userId: r.ids[0], place: 1, withdrawn: false });
  });

  it('an absence that expired first ends a 1v1 before a later reveal', async () => {
    const r = await started(2);
    await playThrough(r, 2);
    await roomService.absent(r.ids[0]);
    const end = await msAgo(1_000);
    await db.sql`UPDATE room_matches SET state = jsonb_set(state, '{deadline}', to_jsonb(${end}::bigint)), phase_deadline_at = clock_timestamp() - interval '2 seconds' WHERE id = ${r.matchId}`;
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '2 seconds' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[0]}`;
    expect(await roomService.expire(r.matchId, await token(r.matchId))).toMatchObject({ status: 'completed' });
    const row = await matchRow(r.matchId);
    expect(row.state.results).toHaveLength(3); // no fourth question was opened and revealed after the withdrawal
    expect(row.result.standings[0]).toMatchObject({ userId: r.ids[1], place: 1, withdrawn: false });
    expect(row.result.standings[1]).toMatchObject({ userId: r.ids[0], withdrawn: true });
  });

  it('an outage that began at an absence deadline gives that seat a grace window instead of withdrawing it', async () => {
    const r = await started(3);
    await roomService.absent(r.ids[2]);
    // The scheduler deadline was the seat's absence deadline, 8 s ago (an outage); the question itself is still open.
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '8 seconds' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[2]}`;
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '8 seconds' WHERE id = ${r.matchId}`;
    await roomService.expire(r.matchId, await token(r.matchId));
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'in', 'away']);
    const seat = await seatRow(r.matchId, r.ids[2]);
    expect(seat.active).toBe(true);
    expect(seat.absence_deadline_at.getTime() - Date.now()).toBeGreaterThan(3_000);
  });

  it('an outage found through an absence deadline also gives the open question a fresh window (no reveal)', async () => {
    const r = await started(3);
    await guess(r.matchId, r.ids[0], 0, 7);
    await roomService.absent(r.ids[2]);
    // Absence deadline 8 s ago revealed the outage; the question's own deadline passed only 1 s ago.
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '8 seconds' WHERE match_id = ${r.matchId} AND user_id = ${r.ids[2]}`;
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '8 seconds',
      state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1000)) WHERE id = ${r.matchId}`;
    await roomService.expire(r.matchId, await token(r.matchId));
    const row = await matchRow(r.matchId);
    expect(row.state).toMatchObject({ phase: 'guess', round: 0, results: [], missed: [0, 0, 0] });
    expect(row.state.guesses[0]).toBe(7);
    expect(row.state.deadline).toBeGreaterThan(Date.now() + 15_000);
    expect((await guess(r.matchId, r.ids[1], 0, 9)).result).toEqual({ ok: true });
  });

  it('a refused command during an outage persists the rebase, so the next poll does not rebase (and charge) twice', async () => {
    const r = await started(3);
    await roomService.absent(r.ids[2]);
    await db.sql`UPDATE room_seats SET absence_deadline_at = clock_timestamp() - interval '8 seconds', absent_since = clock_timestamp() - interval '38 seconds'
      WHERE match_id = ${r.matchId} AND user_id = ${r.ids[2]}`;
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '8 seconds' WHERE id = ${r.matchId}`;
    expect((await guess(r.matchId, r.ids[0], 5, 1)).result).toEqual({ ok: false, code: 'stale_round' });
    const after = await seatRow(r.matchId, r.ids[2]);
    const row = await matchRow(r.matchId);
    expect(row.phase_deadline_at.getTime()).toBeGreaterThan(Date.now());
    await roomService.expire(r.matchId, row.phase_token);
    const again = await seatRow(r.matchId, r.ids[2]);
    expect(again.absence_deadline_at.getTime()).toBe(after.absence_deadline_at.getTime());
    expect(again.absent_since.getTime()).toBe(after.absent_since.getTime());
  });

  it('a ready or a guess from a returning screen is a presence: an older disconnect check then does nothing', async () => {
    const r = await started(3);
    const gen = (await seatRow(r.matchId, r.ids[2])).presence_gen;
    // The screen reconnects and says ready before its connect is processed; then the old check lands.
    await roomService.ready(r.matchId, r.ids[2], 'es');
    expect(await roomService.absent(r.ids[2], { matchId: r.matchId, gen })).toBeNull();
    expect((await matchRow(r.matchId)).state.status).toEqual(['in', 'in', 'in']);
    // A seat marked away that sends a guess is back and its guess counts.
    await roomService.absent(r.ids[1]);
    expect((await matchRow(r.matchId)).state.status[1]).toBe('away');
    expect((await guess(r.matchId, r.ids[1], 0, 5)).result).toEqual({ ok: true });
    const row = await matchRow(r.matchId);
    expect(row.state.status[1]).toBe('in');
    expect(row.state.guesses[1]).toBe(5);
    expect((await seatRow(r.matchId, r.ids[1])).connected).toBe(true);
  });

  it('a guess that brings a seat back at the end of the match returns the final effects (everyone gets the result)', async () => {
    const r = await started(2);
    await playThrough(r, 9);
    await roomService.absent(r.ids[1]);
    // The final reveal ended a moment ago (no timer ran yet); the away seat's window is still open.
    const end = await msAgo(500);
    await db.sql`UPDATE room_matches SET state = jsonb_set(state, '{deadline}', to_jsonb(${end}::bigint)), phase_deadline_at = to_timestamp(${end}::double precision / 1000) WHERE id = ${r.matchId}`;
    const res = await guess(r.matchId, r.ids[1], 9, 1);
    expect(res.result).toEqual({ ok: false, code: 'not_active' });
    expect(res.effects).toMatchObject({ status: 'completed', finished: true });
    expect(res.effects!.userIds.sort()).toEqual([...r.ids].sort());
    expect((await lobbyRow(r.lobbyId)).status).toBe('waiting');
  });

  it('a replayed guess from a seat marked away brings it back, and keeps its stored answer', async () => {
    const r = await started(3);
    const id = randomUUID();
    expect((await guess(r.matchId, r.ids[1], 0, 5, id)).result).toEqual({ ok: true });
    await roomService.absent(r.ids[1]);
    expect((await matchRow(r.matchId)).state.status[1]).toBe('away');
    const replay = await guess(r.matchId, r.ids[1], 0, 5, id);
    expect(replay.result).toEqual({ ok: true });
    expect(replay.effects).toBeTruthy();
    const row = await matchRow(r.matchId);
    expect(row.state.status[1]).toBe('in');
    expect(row.state.guesses[1]).toBe(5);
  });

  it('a ready at the gate from a connected seat fences an older disconnect check; a ready just after the gate brings the admitted caller back', async () => {
    const r = await create(3);
    const gen = (await seatRow(r.matchId, r.ids[0])).presence_gen;
    await roomService.ready(r.matchId, r.ids[0], 'es');
    expect(await roomService.absent(r.ids[0], { matchId: r.matchId, gen })).toBeNull();
    expect((await seatRow(r.matchId, r.ids[0])).connected).toBe(true);
    // ids[1] readied, then dropped (away at the gate); the gate runs out; their ready arrives just after it.
    await roomService.ready(r.matchId, r.ids[1], 'es');
    await roomService.absent(r.ids[1]);
    expect((await seatRow(r.matchId, r.ids[1])).connected).toBe(false);
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '100 milliseconds' WHERE id = ${r.matchId}`;
    await roomService.ready(r.matchId, r.ids[1], 'es');
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('active');
    expect(row.state.status).toEqual(['in', 'in']);
    expect((await seatRow(r.matchId, r.ids[1])).connected).toBe(true);
  });

  it('a seat coming back to a question it already answered closes it at once when nobody else is eligible', async () => {
    const r = await started(2);
    await guess(r.matchId, r.ids[0], 0, 5);
    await roomService.absent(r.ids[0]);
    await roomService.absent(r.ids[1]);
    expect((await matchRow(r.matchId)).state.phase).toBe('guess'); // nobody eligible: no early close
    await roomService.present(r.ids[0]);
    expect((await matchRow(r.matchId)).state.phase).toBe('reveal');
    expect((await guess(r.matchId, r.ids[1], 0, 9)).result).toEqual({ ok: false, code: 'not_open' });
  });

  it("a disconnect check fenced on one match never touches the player's seat in the next one", async () => {
    const r = await started(2);
    const old = await roomService.presenceGeneration(r.ids[0]);
    expect(old).toEqual({ matchId: r.matchId, gen: expect.any(Number) });
    await roomService.cancelStale(r.matchId);
    await db.sql`UPDATE lobby_members SET is_ready = true WHERE lobby_id = ${r.lobbyId}`;
    const next = await roomService.createFromLobby({ lobbyId: r.lobbyId, game: 'aproximado', players: r.players });
    for (const id of r.ids) await roomService.ready(next.matchId, id, 'es');
    await db.sql`UPDATE room_seats SET presence_gen = ${old!.gen} WHERE match_id = ${next.matchId}`; // same number, other match
    expect(await roomService.absent(r.ids[0], old)).toBeNull();
    expect((await seatRow(next.matchId, r.ids[0])).connected).toBe(true);
  });

  it('who is sitting a live match out, and why: left on purpose vs left out at the gate', async () => {
    const r = await create(4);
    for (const id of r.ids.slice(0, 3)) await roomService.ready(r.matchId, id, 'es');
    await roomService.leave(r.matchId, r.ids[2]); // left at the gate; ids[3] never got in
    await runOut(r.matchId);
    expect((await roomService.snapshot(r.matchId, r.ids[2]))!.me).toMatchObject({ active: false, admitted: false, left: true });
    expect((await roomService.snapshot(r.matchId, r.ids[3]))!.me).toMatchObject({ active: false, admitted: false, left: false });
    expect(await roomService.sittingOutFor(r.ids[2])).toMatchObject({ id: r.matchId, lobby_id: r.lobbyId, left: true });
    expect(await roomService.sittingOutFor(r.ids[3])).toMatchObject({ id: r.matchId, left: false });
    expect(await roomService.sittingOutFor(r.ids[0])).toBeNull();
    // Out of the room (left the lobby) or the match over: nothing to sit out.
    await db.sql`DELETE FROM lobby_members WHERE lobby_id = ${r.lobbyId} AND user_id = ${r.ids[3]}`;
    expect(await roomService.sittingOutFor(r.ids[3])).toBeNull();
    await roomService.cancelStale(r.matchId);
    expect(await roomService.sittingOutFor(r.ids[2])).toBeNull();
  });

  it('a leave just after the gate ran out is judged after the gate: the roster and the podium scoring stand', async () => {
    const r = await create(4);
    for (const id of r.ids.slice(0, 3)) await roomService.ready(r.matchId, id, 'es');
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '100 milliseconds' WHERE id = ${r.matchId}`;
    await roomService.leave(r.matchId, r.ids[0]);
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('active');
    expect(row.state.status).toEqual(['withdrawn', 'in', 'in']);
    expect((await view(r.matchId, r.ids[1])).scoring).toBe('podium');
    expect((await seatRow(r.matchId, r.ids[3])).admitted).toBe(false);
  });

  it('review 2026-10-06 B6: the presence sweep pages through every connected live seat, then starts over', async () => {
    for (let i = 0; i < 3; i += 1) {
      const m = await create(2);
      await db.sql`UPDATE room_matches SET status = 'active', state = '{}'::jsonb WHERE id = ${m.matchId}`;
    }
    const all = (await db.sql<Array<{ user_id: string }>>`SELECT user_id FROM room_seats WHERE active AND connected`).map((r) => r.user_id);
    expect(all).toHaveLength(6);
    const seen = new Set<string>();
    let after: { userId: string; matchId: string } | null = null;
    for (let page = 0; page < 3; page += 1) {
      const rows = await roomService.connectedLiveSeats(2, after);
      rows.forEach((r) => seen.add(r.user_id));
      after = rows.length === 2 ? { userId: rows[1].user_id, matchId: rows[1].match_id } : null;
    }
    expect([...seen].sort()).toEqual([...all].sort());
    const wrapped = await roomService.connectedLiveSeats(2, after);
    expect(wrapped).toHaveLength(0);
  });

  it("review 2026-10-06 B9: the question picker remembers each player's last 40 matches, not the last 40 seat rows", async () => {
    const { roomRepo } = await import('../../src/modules/room/room.repo.js');
    const ids = await Promise.all(Array.from({ length: 6 }, () => user()));
    const items = (await db.sql<Array<{ item_id: string }>>`
      SELECT item_id FROM room_pool WHERE game = 'aproximado' AND enabled AND difficulty = 'easy' ORDER BY item_id LIMIT 11`).map((r) => r.item_id);
    const [fresh, ...seen] = items;
    // Ten earlier matches of this group, newest first, one question each.
    for (const [k, item] of seen.entries()) {
      const [m] = await db.sql<Array<{ id: string }>>`
        INSERT INTO room_matches (game, engine_version, status, result, created_at, ended_at)
        VALUES ('aproximado', 1, 'completed', '{}'::jsonb, now() - make_interval(mins => ${k + 1}), now() - make_interval(mins => ${k + 1}))
        RETURNING id`;
      for (const [slot, uid] of ids.entries()) {
        await db.sql`INSERT INTO room_seats (match_id, user_id, slot, active) VALUES (${m.id}, ${uid}, ${slot}, false)`;
      }
      await db.sql`INSERT INTO room_match_content (match_id, item_ids, content) VALUES (${m.id}, ${[item]}, '{}'::jsonb)`;
    }
    const enabled = (await db.sql<Array<{ item_id: string }>>`SELECT item_id FROM room_pool WHERE game = 'aproximado' AND enabled`).map((r) => r.item_id);
    try {
      await db.sql`UPDATE room_pool SET enabled = (item_id = ANY(${items})) WHERE game = 'aproximado'`;
      const picks: string[] = [];
      for (let n = 0; n < 20; n += 1) picks.push((await roomRepo.pickPool('aproximado', ids, { easy: 1 }))[0].item_id);
      expect(new Set(picks)).toEqual(new Set([fresh]));
    } finally {
      await db.sql`UPDATE room_pool SET enabled = (item_id = ANY(${enabled})) WHERE game = 'aproximado'`;
    }
  });

  it('review 2026-10-06 W6: a start carries its database time; pointer reads carry theirs, with or without a seat', async () => {
    const m = await create(2);
    expect(typeof m.created.startedAtMs).toBe('number');
    const seated = await roomService.livePointerFor(m.ids[0]);
    expect(seated.live?.id).toBe(m.matchId);
    expect(seated.asOf).toBeGreaterThanOrEqual(m.created.startedAtMs!);
    const nobody = await roomService.livePointerFor(await user());
    expect(nobody.live).toBeNull();
    expect(nobody.asOf).toBeGreaterThan(0);
  });
});
