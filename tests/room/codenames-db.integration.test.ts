import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the room migrations (incl. Football Codenames') applied, e.g.
 *   CODENAMES_ROOM_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_codenames
 * The test seeds its own INVENTED cards into room_pool (game 'codenames') of that isolated database.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.CODENAMES_ROOM_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { roomService } = await import('../../src/modules/room/room.service.js');
const { ABSENCE } = await import('../../src/modules/room/games/codenames/codenames.engine.js');

type Card = { id: string; revealed: string | null; key: string | null; picks: number[] };
type View = {
  phase: string; mySeat: number; host: number; turn: 0 | 1; turnNo: number; cards: Card[];
  players: Array<{ seat: number; team: 0 | 1 | null; scout: boolean; status: string }>;
  clue: { word: string; count: number; bot: boolean } | null; result: { winner: number; reason: string } | null;
};
const L = (en: string) => ({ en, es: en, tr: en, ru: en, ka: en });

describe.skipIf(!url)('Football Codenames room on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql`DELETE FROM room_pool WHERE game = 'codenames'`;
    for (let i = 0; i < 40; i += 1) {
      const face = i < 12;
      const id = `test-card-${i}`;
      const payload = { id, face, terms: [{ id: `test-term-${i % 7}`, label: L(`Term ${i % 7}`) }, { id: `test-solo-${i}`, label: L(`Solo ${i}`) }] };
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
        VALUES ('codenames', ${id}, 'easy', ${`fp-${id}`}, ${db.sql.json(payload)}, ${[face ? 'face' : 'object']})`;
    }
  });
  afterAll(async () => {
    if (!db.sql) return;
    await db.sql`DELETE FROM room_pool WHERE game = 'codenames'`;
    await db.sql.end();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE room_commands, room_seats, room_match_content, room_matches`;
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
      VALUES ('friendly', ${ids[1]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'codenames') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'codenames', players: ids.map((userId) => ({ userId, isGuest: false })) });
    return { lobbyId: lobby.id, ids, matchId: created.matchId };
  }

  const view = async (matchId: string, userId: string) => ((await roomService.snapshot(matchId, userId)) as { view: View }).view;
  const cmd = (matchId: string, userId: string, command: unknown) => roomService.command(matchId, userId, randomUUID(), command);
  const content = async (matchId: string) => (await db.sql`SELECT content FROM room_match_content WHERE match_id = ${matchId}`)[0].content as { starting: 0 | 1; cards: Array<{ id: string; key: string; face: boolean }> };

  it('eight seats: a random board of 6 faces + 14 others, the teams screen, the host kicks off, keys only to Scouts', async () => {
    const r = await create(8);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', ['codenames']);
    const pack = await content(r.matchId);
    expect(pack.cards).toHaveLength(20);
    expect(pack.cards.filter((c) => c.face)).toHaveLength(6);
    let v = await view(r.matchId, r.ids[0]);
    expect(v.phase).toBe('teams');
    // The lobby host (second member) holds the kick-off.
    expect(v.host).toBe(1);
    expect(v.cards.every((c) => c.key === null)).toBe(true);
    for (const [i, id] of r.ids.entries()) {
      const res = await cmd(r.matchId, id, { type: 'join', team: i % 2, scout: i < 2 });
      expect(res.result).toMatchObject({ ok: true });
    }
    expect((await cmd(r.matchId, r.ids[0], { type: 'kickoff' })).result).toMatchObject({ ok: false });
    expect((await cmd(r.matchId, r.ids[1], { type: 'kickoff' })).result).toMatchObject({ ok: true });
    v = await view(r.matchId, r.ids[0]);
    expect(v.phase).toBe('clue');
    expect(v.cards.every((c) => c.key !== null)).toBe(true);
    expect((await view(r.matchId, r.ids[2])).cards.every((c) => c.key === null)).toBe(true);

    // The starting team's Scout gives a clue; its guesser flips the Own Goal: the rivals win, the room is free again.
    const starting = pack.starting;
    const scout = r.ids[starting];
    const guesser = r.ids[starting + 2];
    expect((await cmd(r.matchId, scout, { type: 'clue', turn: 0, word: 'Invented', count: 2 })).result).toMatchObject({ ok: true });
    const ownGoal = pack.cards.findIndex((c) => c.key === 'owngoal');
    expect((await cmd(r.matchId, guesser, { type: 'flip', turn: 0, card: ownGoal })).result).toMatchObject({ ok: true });
    v = await view(r.matchId, guesser);
    expect(v.phase).toBe('over');
    expect(v.result).toEqual({ winner: 1 - starting, reason: 'owngoal' });
    expect((await db.sql`SELECT status FROM room_matches WHERE id = ${r.matchId}`)[0].status).toBe('completed');
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('waiting');
  });

  it('refuses nine players; an away seat gets the slow-game allowance', async () => {
    const nine = Array.from({ length: 9 }, () => ({ userId: randomUUID(), isGuest: false }));
    await expect(roomService.createFromLobby({ lobbyId: randomUUID(), game: 'codenames', players: nine })).rejects.toMatchObject({ code: 'room_needs_players' });
    const r = await create(2);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', ['codenames']);
    await db.sql`UPDATE room_seats SET connected = true WHERE match_id = ${r.matchId}`;
    await roomService.absent(r.ids[0]);
    const seat = (await db.sql`SELECT absent_since, absence_deadline_at FROM room_seats WHERE match_id = ${r.matchId} AND user_id = ${r.ids[0]}`)[0];
    expect(seat.absence_deadline_at.getTime() - seat.absent_since.getTime()).toBeGreaterThan(ABSENCE.awayMs - 1_000);
  });

  it('a tab that does not know the game is never admitted', async () => {
    const r = await create(2);
    await expect(roomService.ready(r.matchId, r.ids[0], 'en', [])).rejects.toMatchObject({ code: 'client_outdated' });
    const seat = (await db.sql`SELECT ready_at FROM room_seats WHERE match_id = ${r.matchId} AND user_id = ${r.ids[0]}`)[0];
    expect(seat.ready_at).toBeNull();
  });
});
