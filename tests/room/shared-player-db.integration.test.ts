import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: the room runtime playing "played for both" end to end. Its own database (the Aproximado
 * suite truncates the room tables between tests): a clone of the room test DB with the word game migrations applied.
 *   WORDGAMES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_wordgames
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.WORDGAMES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { roomService } = await import('../../src/modules/room/room.service.js');
const { footballersService } = await import('../../src/modules/footballers/footballers.service.js');
const { MATCHER_VERSION } = await import('../../src/modules/footballers/footballers.universe.js');

// Invented footballers and clubs only: the repository is public.
const RELEASE = 'it-sp-release';
const PLAYERS = [['p-orlen', 'Tarin Orlen', 80], ['p-kosel', 'Emir Kosel', 60], ['p-ravin', 'Dago Ravin', 45], ['p-brando', 'Stefano Brandolini', 15], ['p-out', 'Joan Marvelo', 30]] as const;
const GAMES = ['aproximado', 'shared_player'];

type View = {
  phase: string; round: number; format: string; clubs: Array<{ key: string }> | null; myAttempt: number; myHit: string | null;
  myLast: { kind: string; text: string } | null; seats: Array<{ seat: number; answered: boolean; score: number }>; mySeat: number;
  reveal: { winners: number[]; answers: Array<string | null>; examples: string[] } | null; standings: Array<{ seat: number; place: number }> | null;
};
type Snapshot = NonNullable<Awaited<ReturnType<typeof roomService.snapshot>>>;

describe.skipIf(!url)('played for both on the room runtime (real Postgres)', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    footballersService.forget();
    await db.sql`DELETE FROM room_pool WHERE game = 'shared_player'`;
    await db.sql`DELETE FROM wordgame_releases WHERE id = ${RELEASE}`;
    await db.sql`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${RELEASE}, 'fingerprint-0001', ${MATCHER_VERSION}, ${PLAYERS.length})`;
    for (const [pid, name, fame] of PLAYERS) {
      await db.sql`INSERT INTO wordgame_players (release_id, pid, name, game_name, fame) VALUES (${RELEASE}, ${pid}, ${name}, ${name.split(' ').pop()!}, ${fame})`;
    }
    const label = (name: string) => ({ es: name, en: name, ka: name, tr: name });
    for (let n = 0; n < 40; n += 1) {
      const payload = {
        id: `it-pair-${n}`, release: RELEASE, a: { key: `north-${n}`, label: label(`North ${n}`), crest: `/clubs/north-${n}.webp` },
        b: { key: `south-${n}`, label: label(`South ${n}`), crest: `/clubs/south-${n}.webp` }, accepted: ['p-orlen', 'p-kosel', 'p-ravin', 'p-brando'], examples: 2,
      };
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags) VALUES ('shared_player', ${payload.id}, ${n < 16 ? 'easy' : 'medium'}, ${`fp-it-pair-${n}`}, ${db.sql.json(payload)}, ${['mixed']})`;
    }
  });
  afterAll(async () => {
    await db.sql`DELETE FROM room_pool WHERE game = 'shared_player'`;
    await db.sql`DELETE FROM wordgame_releases WHERE id = ${RELEASE}`;
    await db.sql.end({ timeout: 5 });
  });

  const user = async (isGuest = false) => (await db.sql<Array<{ id: string }>>`
    INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`p-${randomUUID().slice(0, 8)}`}, ${isGuest}) RETURNING id`)[0].id;

  async function create(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await user(i === 1));
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'shared_player') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'shared_player', players: ids.map((userId, i) => ({ userId, isGuest: i === 1 })) });
    return { lobbyId: lobby.id, ids, matchId: created.matchId };
  }

  const token = async (id: string) => (await db.sql<Array<{ phase_token: number }>>`SELECT phase_token FROM room_matches WHERE id = ${id}`)[0].phase_token;
  const matchRow = async (id: string) => (await db.sql`SELECT status, state, engine_version, result FROM room_matches WHERE id = ${id}`)[0];
  /** Moves the match clock to just past due and expires it with the current token. */
  async function runOut(matchId: string) {
    await db.sql`
      UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '10 milliseconds',
        state = CASE WHEN state IS NULL THEN NULL ELSE jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 10)) END
      WHERE id = ${matchId}`;
    return roomService.expire(matchId, await token(matchId));
  }
  const view = async (matchId: string, userId: string) => ((await roomService.snapshot(matchId, userId, 'en')) as Snapshot).view as View;
  const answer = async (matchId: string, userId: string, text: string, commandId = randomUUID()) => {
    const v = await view(matchId, userId);
    return roomService.command(matchId, userId, commandId, { type: 'answer', round: v.round, attempt: v.myAttempt, text });
  };
  /** Everyone ready, the countdown played out: the first race is open. */
  async function racing(n: number) {
    const r = await create(n);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', GAMES);
    expect((await matchRow(r.matchId)).state.phase).toBe('countdown');
    await runOut(r.matchId);
    expect((await matchRow(r.matchId)).state.phase).toBe('race');
    return r;
  }

  it('deals ten pairs of one release and starts with the clubs hidden', async () => {
    const r = await create(2);
    const [content] = await db.sql`SELECT item_ids, content FROM room_match_content WHERE match_id = ${r.matchId}`;
    expect(new Set(content.item_ids).size).toBe(10);
    expect(content.content.release).toBe(RELEASE);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', GAMES);
    const v = await view(r.matchId, r.ids[0]);
    expect(v).toMatchObject({ phase: 'countdown', format: 'duel', clubs: null });
  });

  it('two seats: the first right answer takes the point, and nothing of it reaches the rival before the reveal', async () => {
    const r = await racing(2);
    const wrong = await answer(r.matchId, r.ids[0], 'Joan Marvelo');
    expect(wrong.result).toEqual({ ok: true });
    expect(await view(r.matchId, r.ids[0])).toMatchObject({ myAttempt: 1, myHit: null, myLast: { kind: 'wrong', text: 'Joan Marvelo' } });
    expect((await answer(r.matchId, r.ids[0], 'Orlen')).result).toEqual({ ok: false, code: 'locked' });
    expect((await answer(r.matchId, r.ids[1], 'stefano brandolni')).result).toEqual({ ok: true });
    expect((await matchRow(r.matchId)).state.phase).toBe('settle');
    const rival = await roomService.snapshot(r.matchId, r.ids[0], 'en');
    expect((rival!.view as View).seats.map((s) => s.answered)).toEqual([false, true]);
    for (const hidden of ['Brandolini', 'Orlen', 'Kosel', 'Ravin', 'p-brando']) expect(JSON.stringify(rival)).not.toContain(hidden);
    await runOut(r.matchId);
    const shown = await view(r.matchId, r.ids[0]);
    expect(shown.reveal).toMatchObject({ winners: [1], answers: [null, 'Stefano Brandolini'] });
    expect(shown.reveal!.examples).toEqual(['Tarin Orlen', 'Emir Kosel', 'Stefano Brandolini']);
    expect(shown.seats.map((s) => s.score)).toEqual([0, 1]);
  });

  it('a command sent twice is judged once', async () => {
    const r = await racing(3);
    const id = randomUUID();
    const v = await view(r.matchId, r.ids[0]);
    const command = { type: 'answer', round: v.round, attempt: v.myAttempt, text: 'Nobody Atall' };
    expect((await roomService.command(r.matchId, r.ids[0], id, command)).result).toEqual({ ok: true });
    expect((await roomService.command(r.matchId, r.ids[0], id, command)).result).toEqual({ ok: true });
    expect((await view(r.matchId, r.ids[0])).myAttempt).toBe(1);
    // The same attempt under a new id (a client that lost the answer and typed again) is refused, not judged again.
    expect((await roomService.command(r.matchId, r.ids[0], randomUUID(), command)).result).toEqual({ ok: false, code: 'stale_attempt' });
  });

  it('three seats: points by the order of the right answers, and the result is stored when the last round ends', async () => {
    const r = await racing(3);
    await answer(r.matchId, r.ids[2], 'Kosel');
    await answer(r.matchId, r.ids[0], 'Orlen');
    // Every connected seat but one has answered: the round stays open for it.
    expect((await matchRow(r.matchId)).state.phase).toBe('race');
    await answer(r.matchId, r.ids[1], 'Ravin');
    expect((await matchRow(r.matchId)).state).toMatchObject({ phase: 'reveal', scores: [2, 1, 3] });
    for (let round = 1; round < 8; round += 1) {
      await runOut(r.matchId); // reveal -> countdown
      await runOut(r.matchId); // countdown -> race
      await runOut(r.matchId); // nobody answers -> reveal
    }
    await runOut(r.matchId);
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('completed');
    expect(row.result.standings.map((s: { seat: number; place: number; points: number }) => [s.seat, s.place, s.points])).toEqual([[2, 1, 3], [0, 2, 2], [1, 3, 1]]);
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('waiting');
  });

  it('a client that does not list the game is never admitted, and the others play without it', async () => {
    const r = await create(3);
    await expect(roomService.ready(r.matchId, r.ids[2], 'en')).rejects.toMatchObject({ code: 'client_outdated' });
    await expect(roomService.ready(r.matchId, r.ids[2], 'en', ['aproximado'])).rejects.toMatchObject({ code: 'client_outdated' });
    await roomService.ready(r.matchId, r.ids[0], 'en', GAMES);
    await roomService.ready(r.matchId, r.ids[1], 'en', GAMES);
    await runOut(r.matchId); // the gate closes on its clock
    const seats = await db.sql`SELECT user_id, admitted FROM room_seats WHERE match_id = ${r.matchId} ORDER BY slot`;
    expect(seats.map((s) => s.admitted)).toEqual([true, true, false]);
    expect((await matchRow(r.matchId)).status).toBe('active');
    expect(((await roomService.snapshot(r.matchId, r.ids[2], 'en')) as Snapshot).view).toBeNull();
  });

  it('a tab that cannot draw the game does not bring an away seat back; one that can does', async () => {
    const r = await racing(3);
    await db.sql`UPDATE room_seats SET connected = true WHERE match_id = ${r.matchId}`;
    await roomService.absent(r.ids[1]);
    const status = async () => ((await matchRow(r.matchId)).state.status as string[])[1];
    expect(await status()).toBe('away');
    await roomService.present(r.ids[1]);
    await roomService.present(r.ids[1], ['aproximado']);
    expect(await status()).toBe('away');
    await roomService.present(r.ids[1], GAMES);
    expect(await status()).toBe('in');
  });

  it('a match whose engine this build does not have is left alone', async () => {
    const r = await racing(2);
    await db.sql`UPDATE room_matches SET engine_version = 99 WHERE id = ${r.matchId}`;
    expect(await roomService.expire(r.matchId, await token(r.matchId))).toBeNull();
    expect(await roomService.present(r.ids[0], GAMES)).toBeNull();
    await expect(roomService.command(r.matchId, r.ids[0], randomUUID(), { type: 'answer', round: 0, attempt: 0, text: 'Orlen' })).rejects.toMatchObject({ code: 'engine_unsupported' });
    expect(await matchRow(r.matchId)).toMatchObject({ status: 'active', engine_version: 99 });
    await db.sql`UPDATE room_matches SET engine_version = 1 WHERE id = ${r.matchId}`;
    expect((await answer(r.matchId, r.ids[0], 'Orlen')).result).toEqual({ ok: true });
  });

  it('a seat that leaves a two-seat match after a revealed round loses it; before one, the match is cancelled', async () => {
    const early = await racing(2);
    await roomService.leave(early.matchId, early.ids[0]);
    expect((await matchRow(early.matchId)).status).toBe('cancelled');
    const late = await racing(2);
    await answer(late.matchId, late.ids[0], 'Orlen');
    await runOut(late.matchId); // tie window -> reveal
    await roomService.leave(late.matchId, late.ids[0]);
    const row = await matchRow(late.matchId);
    expect(row.status).toBe('completed');
    expect(row.result.standings.map((s: { seat: number; place: number; withdrawn: boolean }) => [s.seat, s.place, s.withdrawn])).toEqual([[1, 1, false], [0, 2, true]]);
  });

  it('a Ready counts only while the room is still on the game it was pressed on', async () => {
    const ids = [await user(), await user(true)];
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'shared_player') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, false)`;
    const { lobbiesRepo } = await import('../../src/modules/lobbies/lobbies.repo.js');
    const ready = async (id: string) => (await db.sql`SELECT is_ready FROM lobby_members WHERE lobby_id = ${lobby.id} AND user_id = ${id}`)[0].is_ready;

    // Pressed on another room game, on a duel, on a quiz: refused, nothing written.
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'room_game', roomGame: 'name_chain' })).toBe('game_changed');
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'duel', duelGame: 'pistas' })).toBe('game_changed');
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'friendly_possession' })).toBe('game_changed');
    expect(await ready(ids[1])).toBe(false);
    // Pressed on the game the room holds (an older client names no room game).
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'room_game', roomGame: 'shared_player' })).toBe('ready');
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[0], { gameMode: 'room_game' })).toBe('ready');
    expect([await ready(ids[0]), await ready(ids[1])]).toEqual([true, true]);
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, await user(), { gameMode: 'room_game', roomGame: 'shared_player' })).toBe('not_member');

    // A game change racing the Ready, many times over: whichever order they land in, nobody is left ready on a game
    // they did not name. (A change is two statements, as in updateSettings: the room, then everybody's readiness.)
    for (let round = 0; round < 40; round += 1) {
      await db.sql`UPDATE lobbies SET game_mode = 'room_game', room_game = 'shared_player', duel_game = NULL WHERE id = ${lobby.id}`;
      await db.sql`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobby.id}`;
      const change = (async () => {
        await db.sql`UPDATE lobbies SET room_game = 'name_chain' WHERE id = ${lobby.id}`;
        await lobbiesRepo.setAllReady(lobby.id, false);
      })();
      const [outcome] = await Promise.all([lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'room_game', roomGame: 'shared_player' }), change]);
      expect(['ready', 'game_changed']).toContain(outcome);
      expect(await ready(ids[1])).toBe(false);
    }
    await db.sql`UPDATE lobbies SET room_game = 'shared_player' WHERE id = ${lobby.id}`;

    // A room whose match is running is left alone (never locked: the match may be finishing under the same row), and
    // a Ready racing that finish, which takes the room and then its members, never deadlocks with it.
    await db.sql`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobby.id}`;
    await db.sql`UPDATE lobbies SET status = 'active' WHERE id = ${lobby.id}`;
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'room_game', roomGame: 'shared_player' })).toBe('not_waiting');
    expect(await ready(ids[1])).toBe(false);
    for (let round = 0; round < 40; round += 1) {
      await db.sql`UPDATE lobbies SET status = 'active' WHERE id = ${lobby.id}`;
      const finish = db.sql.begin(async (tx) => {
        await tx`UPDATE lobbies SET status = 'waiting', updated_at = now() WHERE id = ${lobby.id} AND status = 'active'`;
        await tx`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobby.id}`;
      });
      const [outcome] = await Promise.all([lobbiesRepo.readyMemberOnGame(lobby.id, ids[1], { gameMode: 'room_game', roomGame: 'shared_player' }), finish]);
      expect(['ready', 'not_waiting']).toContain(outcome);
    }
    await db.sql`UPDATE lobbies SET status = 'waiting' WHERE id = ${lobby.id}`;
    await db.sql`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobby.id}`;
    // Options changes take the same order (room, then members): a Ready racing them never deadlocks either.
    for (let round = 0; round < 40; round += 1) {
      const options = lobbiesRepo.setRoomOptions(lobby.id, 'shared_player', round % 2 ? { scope: 'mixed' } : { scope: 'TR' });
      const [outcome] = await Promise.all([lobbiesRepo.readyMemberOnGame(lobby.id, ids[round % 2], { gameMode: 'room_game', roomGame: 'shared_player' }), options]);
      expect(outcome).toBe('ready');
    }
    await db.sql`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobby.id}`;

    // The same for a duel: its game is part of what was seen.
    await db.sql`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobby.id}`;
    await db.sql`UPDATE lobbies SET game_mode = 'duel', duel_game = 'pistas', room_game = NULL WHERE id = ${lobby.id}`;
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[0], { gameMode: 'duel', duelGame: 'ultimo' })).toBe('game_changed');
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[0], { gameMode: 'room_game', roomGame: 'shared_player' })).toBe('game_changed');
    expect(await lobbiesRepo.readyMemberOnGame(lobby.id, ids[0], { gameMode: 'duel', duelGame: 'pistas' })).toBe('ready');
    expect(await ready(ids[0])).toBe(true);
  });

  it('a change of options un-readies everyone at once, and a start dealt for the old options is refused', async () => {
    const ids = [await user(), await user(true)];
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'shared_player') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const players = ids.map((userId, i) => ({ userId, isGuest: i === 1 }));
    // Loaded here: the lobbies repo builds SQL fragments at import, which needs the test connection.
    const { lobbiesRepo } = await import('../../src/modules/lobbies/lobbies.repo.js');
    expect(await lobbiesRepo.setRoomOptions(lobby.id, 'shared_player', { scope: 'mixed', difficulty: 'easy' })).toBe(true);
    expect((await db.sql`SELECT count(*)::int AS n FROM lobby_members WHERE lobby_id = ${lobby.id} AND is_ready`)[0].n).toBe(0);
    expect(await lobbiesRepo.setRoomOptions(lobby.id, 'name_chain', null)).toBe(false);
    await db.sql`UPDATE lobby_members SET is_ready = true WHERE lobby_id = ${lobby.id}`;
    // A start that picked its content before the change: the room no longer holds those options.
    await expect(roomService.createFromLobby({ lobbyId: lobby.id, game: 'shared_player', options: null, players })).rejects.toMatchObject({ code: 'room_changed' });
    await expect(roomService.createFromLobby({ lobbyId: lobby.id, game: 'shared_player', options: { scope: 'mixed' }, players })).rejects.toMatchObject({ code: 'room_changed' });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${lobby.id}`)[0].status).toBe('waiting');
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'shared_player', options: { difficulty: 'easy', scope: 'mixed' }, players });
    expect(created.status).toBe('ready');
  });

  it('sweepers: a live match is left alone, one stuck past the age cap is cancelled and its room reopened', async () => {
    const live = await racing(2);
    const stuck = await racing(3);
    // Older than anything other tests may have left live in this database: first in the oldest-first listing.
    await db.sql`UPDATE room_matches SET created_at = now() - interval '10 years' WHERE id = ${stuck.matchId}`;
    const stale = await roomService.staleLiveMatches(100);
    expect(stale).toContain(stuck.matchId);
    expect(stale).not.toContain(live.matchId);
    expect(await roomService.cancelStale(stuck.matchId)).toMatchObject({ status: 'cancelled' });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${stuck.lobbyId}`)[0].status).toBe('waiting');
    expect((await matchRow(live.matchId)).status).toBe('active');
    // The swept players can sit down again at once.
    expect(await roomService.hasLiveSeat(stuck.ids[0], stuck.lobbyId)).toBe(false);
    expect(await roomService.hasLiveSeat(live.ids[0], live.lobbyId)).toBe(true);
  });

  it('"that was right": only a seat of the match, only for a round whose answers are out, only for a refused text', async () => {
    const r = await racing(2);
    expect(await roomService.refusal(r.matchId, r.ids[0], 0, 'Joan Marvelo')).toBeNull();
    await answer(r.matchId, r.ids[0], 'Orlen');
    await runOut(r.matchId); // tie window -> reveal
    expect((await matchRow(r.matchId)).state.phase).toBe('reveal');
    expect(await roomService.refusal(r.matchId, r.ids[1], 0, 'Joan Marvelo')).toMatchObject({ game: 'shared_player', release: RELEASE, resolvedPid: 'p-out' });
    expect(await roomService.refusal(r.matchId, r.ids[1], 0, 'Milo Vantar')).toMatchObject({ resolvedPid: null });
    expect(await roomService.refusal(r.matchId, r.ids[1], 0, 'Tarin Orlen')).toBeNull();
    expect(await roomService.refusal(r.matchId, r.ids[1], 1, 'Joan Marvelo')).toBeNull();
    expect(await roomService.refusal(r.matchId, await user(), 0, 'Joan Marvelo')).toBeNull();
    expect(await roomService.refusal(randomUUID(), r.ids[1], 0, 'Joan Marvelo')).toBeNull();
  });
});
