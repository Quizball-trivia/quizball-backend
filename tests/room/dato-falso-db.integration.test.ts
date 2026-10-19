import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the room migrations (incl. Dato falso's) applied, e.g.
 *   DATO_FALSO_ROOM_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_dato_falso
 * The test seeds its own INVENTED cards into room_pool (game 'dato_falso') of that isolated database.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.DATO_FALSO_ROOM_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { roomService } = await import('../../src/modules/room/room.service.js');

type Entry = { seat: number; pick: number | null; cut: boolean; doubled: boolean; right: boolean; points: number };
type View = {
  phase: string; card: number; totalCards: number; mySeat: number;
  current: { id: string; options: unknown[] } | null;
  seats: Array<{ seat: number; answered: boolean; score: number; jokers: { cut: boolean; double: boolean } | null }>;
  mine: { pick: number | null; removed: number[]; doubled: boolean };
  reveal: { fake: number; explain: string; entries: Entry[] } | null;
  standings: Array<{ seat: number; points: number; place: number }> | null;
};
const L = (en: string) => ({ en, es: en, tr: en, ru: en, ka: en });
const DIFF = ['easy', 'medium', 'hard'] as const;

describe.skipIf(!url)('Dato falso room on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql`DELETE FROM room_pool WHERE game = 'dato_falso'`;
    for (let i = 0; i < 36; i += 1) {
      const id = `test-df-${i}`;
      const difficulty = DIFF[i % 3];
      const payload = {
        id, category: 'clubs', difficulty,
        player: { id: `test-player-${i}`, name: L(`Invented Player ${i}`), portrait: null },
        options: [0, 1, 2, 3, 4].map((o) => ({ label: L(`Club ${i}-${o}`), art: { kind: 'text' } })),
        fake: i % 5,
        explain: L(`Invented reason ${i}.`),
      };
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
        VALUES ('dato_falso', ${id}, ${difficulty}, ${`fp-${id}`}, ${db.sql.json(payload)}, ${[]})`;
    }
  });
  afterAll(async () => {
    if (!db.sql) return;
    await db.sql`DELETE FROM room_pool WHERE game = 'dato_falso'`;
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
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'dato_falso') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'dato_falso', players: ids.map((userId) => ({ userId, isGuest: false })) });
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
  const pack = async (matchId: string) => (await db.sql`SELECT content FROM room_match_content WHERE match_id = ${matchId}`)[0].content as { cards: Array<{ fake: number; player: { id: string } }> };
  const cmd = (matchId: string, userId: string, command: unknown, commandId = randomUUID()) => roomService.command(matchId, userId, commandId, command);

  async function started(n: number) {
    const r = await create(n);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', ['dato_falso']);
    expect((await matchRow(r.matchId)).state.phase).toBe('intro');
    await runOut(r.matchId);
    expect((await matchRow(r.matchId)).state.phase).toBe('card');
    return r;
  }

  it('deals ten cards on the curve with ten different footballers', async () => {
    const r = await create(2);
    const p = await pack(r.matchId);
    expect(p.cards).toHaveLength(10);
    expect(new Set(p.cards.map((c) => c.player.id)).size).toBe(10);
  });

  it('a full 1v1: the card closes when both picked, nothing secret before the reveal, then the result and the room back to waiting', async () => {
    const r = await started(2);
    const p = await pack(r.matchId);
    for (let c = 0; c < 10; c += 1) {
      const fake = p.cards[c].fake;
      await cmd(r.matchId, r.ids[1], { type: 'joker', card: c, kind: c === 0 ? 'double' : 'cut' }).catch(() => undefined);
      const mid = await view(r.matchId, r.ids[0]);
      expect(JSON.stringify(mid)).not.toContain('Invented reason');
      expect(mid.reveal).toBeNull();
      // The joker played on the open card stays hidden; those of revealed cards are public.
      expect(mid.seats[1].jokers).toEqual([{ cut: false, double: false }, { cut: false, double: true }][c] ?? { cut: true, double: true });
      await cmd(r.matchId, r.ids[0], { type: 'pick', card: c, option: fake });
      const removed = (await view(r.matchId, r.ids[1])).mine.removed;
      const wrong = [0, 1, 2, 3, 4].find((o) => o !== fake && !removed.includes(o))!;
      await cmd(r.matchId, r.ids[1], { type: 'pick', card: c, option: wrong });
      const shown = await view(r.matchId, r.ids[0]);
      expect(shown.phase).toBe('reveal');
      expect(shown.reveal).toMatchObject({ fake, explain: expect.stringContaining('Invented reason') });
      await runOut(r.matchId);
    }
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('completed');
    const final = await view(r.matchId, r.ids[0]);
    expect(final.standings?.find((s) => s.seat === 0)).toMatchObject({ points: 10, place: 1 });
    expect(final.standings?.find((s) => s.seat === 1)).toMatchObject({ points: -1, place: 2 });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('waiting');
  });

  it('a stale card is refused; the same command id replays its result, a changed one is refused', async () => {
    const r = await started(3);
    const id = randomUUID();
    const first = await cmd(r.matchId, r.ids[0], { type: 'pick', card: 0, option: 1 }, id);
    const again = await cmd(r.matchId, r.ids[0], { type: 'pick', card: 0, option: 1 }, id);
    expect(again.result).toEqual(first.result);
    expect((await cmd(r.matchId, r.ids[0], { type: 'pick', card: 0, option: 2 }, id)).result).toEqual({ ok: false, code: 'command_id_reused' });
    expect((await cmd(r.matchId, r.ids[1], { type: 'pick', card: 3, option: 1 })).result).toEqual({ ok: false, code: 'stale_card' });
    expect((await view(r.matchId, r.ids[0])).mine.pick).toBe(1);
  });

  it('the janitor never lists the room of a live match, and lists it once the match is over and the room is old', async () => {
    const r = await started(2);
    await db.sql`UPDATE lobbies SET created_at = now() - interval '3 hours' WHERE id = ${r.lobbyId}`;
    // Imported here: the janitor's module graph touches the database client when it loads.
    const { lobbyJanitorService } = await import('../../src/realtime/services/lobby-janitor.service.js');
    const listed = async () => (await lobbyJanitorService.__internals.listStrandedCandidates()).some((l) => l.id === r.lobbyId);
    expect(await listed()).toBe(false);
    await db.sql`UPDATE room_matches SET status = 'cancelled', result = ${db.sql.json({ reason: 'cancelled', standings: [] })} WHERE id = ${r.matchId}`;
    expect(await listed()).toBe(true);
  });
});
