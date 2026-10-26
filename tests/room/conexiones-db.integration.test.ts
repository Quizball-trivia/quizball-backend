import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the room migrations (incl. Conexiones') applied, e.g.
 *   CONEXIONES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_conexiones
 * The test seeds its own INVENTED boards into room_pool (game 'conexiones') of that isolated database.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.CONEXIONES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { roomService } = await import('../../src/modules/room/room.service.js');

type View = {
  phase: string; board: number; n: number; turn: number; mySeat: number;
  tiles: Array<{ id: string; name: string }>; out: Array<{ id: string; by: number | null }>;
  options: string[] | null; scores: number[];
  result: { winner: number | null; reason: string } | null;
  standings: Array<{ seat: number; points: number; place: number }> | null;
};
type Pack = { first: number; boards: Array<{ board: { groups: Array<{ id: string; members: string[] }> }; options: number[] }> };
const L = (en: string) => ({ en, es: en, tr: en, ru: en, ka: en });
const DIFF = ['easy', 'medium', 'hard'] as const;
const tid = (b: number, i: number) => `b${String(b).padStart(3, '0')}t${String(i).padStart(2, '0')}x`;

describe.skipIf(!url)('Conexiones room on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql`DELETE FROM room_pool WHERE game = 'conexiones'`;
    for (let b = 0; b < 30; b += 1) {
      const id = `test-cx-${b}`;
      const difficulty = DIFF[b % 3];
      const payload = {
        id, difficulty,
        tiles: Array.from({ length: 16 }, (_, i) => ({ id: tid(b, i), player: `test-p-${b}-${i}`, name: { en: `Invented ${b}-${i}`, ka: `ka ${b}-${i}`, ru: `ru ${b}-${i}` }, portrait: null })),
        groups: [0, 1, 2, 3].map((g) => ({
          id: `g${b}-${g}`, tier: g + 1, key: `club:invented-${b}-${g}`, link: L(`Link ${b}-${g}`), decoys: [1, 2, 3].map((d) => L(`Decoy ${b}-${g}-${d}`)),
          members: [0, 1, 2, 3].map((m) => tid(b, g * 4 + m)),
        })),
      };
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
        VALUES ('conexiones', ${id}, ${difficulty}, ${`fp-${id}`}, ${db.sql.json(payload)}, ${[]})`;
    }
  });
  afterAll(async () => {
    if (!db.sql) return;
    await db.sql`DELETE FROM room_pool WHERE game = 'conexiones'`;
    await db.sql.end();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE room_commands, room_seats, room_match_content, room_matches`;
    await db.sql`DELETE FROM lobby_members WHERE lobby_id IN (SELECT id FROM lobbies WHERE room_game = 'conexiones')`;
    await db.sql`DELETE FROM lobbies WHERE room_game = 'conexiones'`;
  });

  const user = async () => {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`p-${randomUUID().slice(0, 8)}`}, false) RETURNING id`;
    return row.id;
  };

  async function create(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await user());
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'conexiones') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'conexiones', players: ids.map((userId) => ({ userId, isGuest: false })) });
    return { lobbyId: lobby.id, ids, matchId: created.matchId };
  }

  const token = async (id: string) => (await db.sql<Array<{ phase_token: number }>>`SELECT phase_token FROM room_matches WHERE id = ${id}`)[0].phase_token;
  const matchRow = async (id: string) => (await db.sql`SELECT status, state, result FROM room_matches WHERE id = ${id}`)[0];
  async function runOut(matchId: string) {
    await db.sql`
      UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '10 milliseconds',
        state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 10))
      WHERE id = ${matchId}`;
    return roomService.expire(matchId, await token(matchId));
  }
  const view = async (matchId: string, userId: string) => ((await roomService.snapshot(matchId, userId)) as { view: View }).view;
  const pack = async (matchId: string) => (await db.sql`SELECT content FROM room_match_content WHERE match_id = ${matchId}`)[0].content as Pack;
  const cmd = (matchId: string, userId: string, command: unknown, commandId = randomUUID()) => roomService.command(matchId, userId, commandId, command);

  async function started() {
    const r = await create(2);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', ['conexiones']);
    expect((await matchRow(r.matchId)).state.phase).toBe('intro');
    await runOut(r.matchId);
    expect((await matchRow(r.matchId)).state.phase).toBe('turn');
    return r;
  }

  it('deals five boards on the curve, no footballer twice', async () => {
    const r = await create(2);
    const p = await pack(r.matchId);
    expect(p.boards).toHaveLength(5);
    const rows = await db.sql<Array<{ difficulty: string }>>`SELECT p.difficulty FROM room_match_content c, jsonb_array_elements(c.content->'boards') b JOIN room_pool p ON p.game = 'conexiones' AND p.item_id = b->'board'->>'id' WHERE c.match_id = ${r.matchId}`;
    expect(rows.map((x) => x.difficulty).sort()).toEqual(['easy', 'hard', 'medium', 'medium', 'medium']);
  });

  it('a full match: turns pass, the last group is named, nothing unsolved shows before its reveal, then the result', async () => {
    const r = await started();
    const p = await pack(r.matchId);
    const seatUser = (seat: number) => r.ids[seat];
    for (let b = 0; b < 5; b += 1) {
      const groups = p.boards[b].board.groups;
      for (let g = 0; g < 3; g += 1) {
        const v = await view(r.matchId, r.ids[0]);
        expect(v).toMatchObject({ phase: 'turn', board: b });
        for (const later of groups.slice(g)) expect(JSON.stringify(v)).not.toContain(`"${later.id}"`);
        const res = await cmd(r.matchId, seatUser(v.turn), { type: 'try', board: b, n: v.n, ids: groups[g].members });
        expect(res.result).toMatchObject({ ok: true });
      }
      const naming = await view(r.matchId, r.ids[1]);
      expect(naming.phase).toBe('name');
      expect(naming.options).toHaveLength(4);
      // Seat 1 names right, seat 0 names wrong.
      const right = p.boards[b].options.indexOf(0);
      await cmd(r.matchId, seatUser(naming.turn), { type: 'name', board: b, n: naming.n, pick: naming.turn === 1 ? right : (right + 1) % 4 });
      expect((await view(r.matchId, r.ids[0])).phase).toBe('reveal');
      await runOut(r.matchId);
    }
    expect((await matchRow(r.matchId)).status).toBe('completed');
    const final = await view(r.matchId, r.ids[0]);
    expect(final.result?.reason).toBe('score');
    expect(final.scores.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(15);
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('waiting');
  });

  it('a stale move number is refused; the same command id replays its result; a run-out turn passes', async () => {
    const r = await started();
    const v = await view(r.matchId, r.ids[0]);
    const mover = r.ids[v.turn];
    const p = await pack(r.matchId);
    const id = randomUUID();
    const four = p.boards[0].board.groups[0].members;
    const first = await cmd(r.matchId, mover, { type: 'try', board: 0, n: 0, ids: four }, id);
    expect((await cmd(r.matchId, mover, { type: 'try', board: 0, n: 0, ids: four }, id)).result).toEqual(first.result);
    expect((await cmd(r.matchId, r.ids[1 - v.turn], { type: 'try', board: 0, n: 0, ids: p.boards[0].board.groups[1].members })).result).toEqual({ ok: false, code: 'stale' });
    const before = await view(r.matchId, r.ids[0]);
    await runOut(r.matchId);
    const after = await view(r.matchId, r.ids[0]);
    expect(after).toMatchObject({ phase: 'turn', turn: v.turn, n: before.n + 1 });
  });

  it('two run-outs in a row by one seat forfeit the match to the other', async () => {
    const r = await started();
    const v = await view(r.matchId, r.ids[0]);
    const idle = v.turn;
    const p = await pack(r.matchId);
    await runOut(r.matchId);
    const mid = await view(r.matchId, r.ids[0]);
    await cmd(r.matchId, r.ids[mid.turn], { type: 'try', board: 0, n: mid.n, ids: p.boards[0].board.groups[0].members });
    await runOut(r.matchId);
    expect((await matchRow(r.matchId)).status).toBe('completed');
    const final = await view(r.matchId, r.ids[0]);
    expect(final.result).toEqual({ winner: 1 - idle, reason: 'forfeit' });
    expect(final.standings?.find((s) => s.seat === idle)?.place).toBe(2);
  });

  it('the janitor never lists the room of a live match, and lists it once the match is over and the room is old', async () => {
    const r = await started();
    await db.sql`UPDATE lobbies SET created_at = now() - interval '3 hours' WHERE id = ${r.lobbyId}`;
    const { lobbyJanitorService } = await import('../../src/realtime/services/lobby-janitor.service.js');
    const listed = async () => (await lobbyJanitorService.__internals.listStrandedCandidates()).some((l) => l.id === r.lobbyId);
    expect(await listed()).toBe(false);
    await db.sql`UPDATE room_matches SET status = 'cancelled', result = ${db.sql.json({ reason: 'cancelled', standings: [] })} WHERE id = ${r.matchId}`;
    expect(await listed()).toBe(true);
  });
});
