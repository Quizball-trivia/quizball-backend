import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Mentalista on a REAL, test-owned PostgreSQL (room migrations already applied), driven through roomService exactly as
 * the realtime layer does. The database and Redis are dedicated to this rehearsal and loopback-only; this file never
 * executes a migration or writes outside its own scoped rows beyond the identity-guarded truncate below.
 *
 * It fails CLOSED: the run requires the exact rehearsal URL (no silent skip, no default localhost:5432/test), and
 * before it truncates anything it asserts the live connection really is the local rehearsal database. Every fixture is
 * an INVENTED universe — synthetic labels only, no real quiz content.
 */
const EXPECTED_URL = 'postgresql://mentalista_local@127.0.0.1:55519/rehearsal_mentalista';
const url = process.env.RELEASE_TEST_DATABASE_URL;
if (url !== EXPECTED_URL) {
  throw new Error(`Mentalista DB integration requires RELEASE_TEST_DATABASE_URL=${EXPECTED_URL} (got ${url ?? 'unset'}); refusing to run.`);
}

// roomService reads the shared db client; point it at our owned rehearsal connection (as the sibling Dato-falso test does).
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const { roomService } = await import('../../src/modules/room/room.service.js');

type Seat = { seat: number; status: string; isChooser: boolean; committed: boolean; predicted: boolean; score: number };
type Result = { round: number; chooser: number; target: number | null; voided: boolean; entries: Array<{ seat: number; prediction: number | null; matched: boolean; points: number }> };
type View = {
  phase: string; round: number; totalRounds: number; chooserSeat: number;
  category: { id: string; prompt: string; options: Array<{ id: string; name: string }> } | null;
  iAmChooser: boolean; seats: Seat[]; mySeat: number; myChoice: number | null; myPrediction: number | null;
  reveal: Result | null; results: Result[];
  standings: Array<{ seat: number; points: number; place: number; roundWins: number }> | null; deadline: string | null;
};

const L = (s: string) => ({ es: s, en: s, ka: s, tr: s });
const DIFF = ['easy', 'medium', 'hard'] as const;
// Six invented categories (two per difficulty) with four distinctly-labelled options each — enough for any 3–4 roster.
const category = (i: number) => ({
  id: `test-ment-${i}`, difficulty: DIFF[i % 3], prompt: L(`Invented prompt ${i}`),
  options: [0, 1, 2, 3].map((o) => ({ id: `test-ment-${i}-opt-${o}`, name: L(`Invented option ${i}-${o}`) })),
});

let identityVerified = false;

describe('Mentalista room on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    // Identity gate BEFORE any destructive work: prove this really is the loopback rehearsal database on port 55519.
    const [id] = await db.sql<Array<{ db: string; addr: string | null; port: number }>>`
      SELECT current_database() AS db, host(inet_server_addr()) AS addr, inet_server_port() AS port`
      .catch(async (e: unknown) => { await db.sql.end(); return Promise.reject(e); });
    if (id.db !== 'rehearsal_mentalista' || !['127.0.0.1', '::1'].includes(id.addr ?? '') || Number(id.port) !== 55519) {
      await db.sql.end();
      throw new Error(`Refusing to touch a database that is not the local Mentalista rehearsal (db=${id.db} addr=${id.addr} port=${id.port}).`);
    }
    identityVerified = true;
    await db.sql`DELETE FROM room_pool WHERE game = 'mentalista'`;
    for (let i = 0; i < 6; i += 1) {
      const payload = category(i);
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
        VALUES ('mentalista', ${payload.id}, ${payload.difficulty}, ${`fp-${payload.id}`}, ${db.sql.json(payload)}, ${[]})`;
    }
  });
  afterAll(async () => {
    if (!db.sql) return;
    if (identityVerified) await db.sql`DELETE FROM room_pool WHERE game = 'mentalista'`;
    await db.sql.end();
  });
  beforeEach(async () => {
    if (!identityVerified) return;
    await db.sql`TRUNCATE room_commands, room_seats, room_match_content, room_matches`;
    await db.sql`DELETE FROM lobby_members WHERE lobby_id IN (SELECT id FROM lobbies WHERE room_game = 'mentalista')`;
    await db.sql`DELETE FROM lobbies WHERE room_game = 'mentalista'`;
  });

  // ----- harness -----
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
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'mentalista') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'mentalista', players: ids.map((userId) => ({ userId, isGuest: false })) });
    return { lobbyId: lobby.id, ids, matchId: created.matchId };
  }
  const token = async (id: string) => (await db.sql<Array<{ phase_token: number }>>`SELECT phase_token FROM room_matches WHERE id = ${id}`)[0].phase_token;
  const matchRow = async (id: string) => (await db.sql<Array<{ status: string; state: { phase: string; round: number; schedule: number[] } | null; result: unknown }>>`SELECT status, state, result FROM room_matches WHERE id = ${id}`)[0];
  const view = async (matchId: string, userId: string) => ((await roomService.snapshot(matchId, userId)) as { view: View }).view;
  const cmd = (matchId: string, userId: string, command: unknown, commandId = randomUUID()) => roomService.command(matchId, userId, commandId, command);
  // Push the ready gate's deadline into the past, then expire it (close the gate).
  const expireGate = async (matchId: string) => {
    await db.sql`UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '20 milliseconds' WHERE id = ${matchId}`;
    return roomService.expire(matchId, await token(matchId));
  };
  // Narrowly move the match clock past its current engine deadline, then expire (advances a reveal to the next round/over).
  const runOut = async (matchId: string) => {
    await db.sql`
      UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '20 milliseconds',
        state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 20))
      WHERE id = ${matchId}`;
    return roomService.expire(matchId, await token(matchId));
  };
  async function started(n: number) {
    const r = await create(n);
    for (const id of r.ids) await roomService.ready(r.matchId, id, 'en', ['mentalista']);
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('active');
    expect(row.state?.phase).toBe('choose');
    return r;
  }
  // Drive one healthy round: the scheduled chooser (seat === round) commits `pick`, each predictor locks its guess.
  async function playRound(r: { matchId: string; ids: string[] }, seats: number, round: number, pick: number, guess: (seat: number) => number) {
    expect((await cmd(r.matchId, r.ids[round], { type: 'choose', round, option: pick })).result).toEqual({ ok: true });
    for (let seat = 0; seat < seats; seat += 1) {
      if (seat === round) continue;
      expect((await cmd(r.matchId, r.ids[seat], { type: 'predict', round, option: guess(seat) })).result).toEqual({ ok: true });
    }
    await runOut(r.matchId); // leave the reveal for the next round (or the terminal)
  }

  // ----- gate / admission -----
  it('refuses a two-seat room: Mentalista needs at least three admitted seats', async () => {
    const ids = [await user(), await user()];
    await expect(roomService.createFromLobby({ lobbyId: randomUUID(), game: 'mentalista', players: ids.map((userId) => ({ userId, isGuest: false })) }))
      .rejects.toThrow();
  });

  it('three ready seats start in the choose phase with a frozen three-round schedule', async () => {
    const r = await started(3);
    const row = await matchRow(r.matchId);
    expect(row.state?.schedule).toEqual([0, 1, 2]);
    const v = await view(r.matchId, r.ids[0]);
    expect(v).toMatchObject({ phase: 'choose', round: 0, totalRounds: 3, chooserSeat: 0, iAmChooser: true });
    expect(v.category?.options).toHaveLength(4);
  });

  it('the ready gate cancels the match when it closes with only two of three ready', async () => {
    const r = await create(3);
    await roomService.ready(r.matchId, r.ids[0], 'en', ['mentalista']);
    await roomService.ready(r.matchId, r.ids[1], 'en', ['mentalista']);
    await expireGate(r.matchId);
    expect((await matchRow(r.matchId)).status).toBe('cancelled');
  });

  it('a four-seat room with three ready admits exactly three and schedules three rounds', async () => {
    const r = await create(4);
    for (const id of r.ids.slice(0, 3)) await roomService.ready(r.matchId, id, 'en', ['mentalista']);
    await expireGate(r.matchId);
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('active');
    expect(row.state?.schedule).toHaveLength(3);
    expect((await view(r.matchId, r.ids[0])).totalRounds).toBe(3);
  });

  it('a leave in the ready phase that drops the roster below three cancels the match', async () => {
    const r = await create(3);
    await roomService.leave(r.matchId, r.ids[0]);
    expect((await matchRow(r.matchId)).status).toBe('cancelled');
  });

  // ----- a full cycle & scoring -----
  it('a full three-seat cycle scores +2 per hit, 0 for the chooser, and banks final standings', async () => {
    const r = await started(3);
    await playRound(r, 3, 0, 1, (seat) => (seat === 1 ? 1 : 0)); // seat1 hits, seat2 misses
    await playRound(r, 3, 1, 2, () => 2); // seat0 and seat2 both hit chooser 1
    await playRound(r, 3, 2, 0, (seat) => (seat === 0 ? 0 : 1)); // seat0 hits, seat1 misses
    const row = await matchRow(r.matchId);
    expect(row.status).toBe('completed');
    const v = await view(r.matchId, r.ids[0]);
    expect(v.phase).toBe('over');
    expect(v.standings?.find((s) => s.seat === 0)).toMatchObject({ points: 4, place: 1 });
    expect(v.standings?.find((s) => s.seat === 1)).toMatchObject({ points: 2, place: 2 });
    expect(v.standings?.find((s) => s.seat === 2)).toMatchObject({ points: 2, place: 2 });
    // The chooser of a round never scores on their own round.
    for (const res of v.results) expect(res.entries[res.chooser]).toMatchObject({ prediction: null, points: 0 });
  });

  // ----- commands: immutability & idempotency -----
  it('a prediction is final, and a command id replays its result but refuses an altered payload', async () => {
    const r = await started(3);
    await cmd(r.matchId, r.ids[0], { type: 'choose', round: 0, option: 1 }); // → predict phase
    const idA = randomUUID();
    const first = await cmd(r.matchId, r.ids[1], { type: 'predict', round: 0, option: 1 }, idA);
    expect(first.result).toEqual({ ok: true });
    // A second prediction under a NEW id is rejected as final (seat2 never locks, so the round stays open).
    expect((await cmd(r.matchId, r.ids[1], { type: 'predict', round: 0, option: 2 })).result).toEqual({ ok: false, code: 'already_predicted' });
    // The SAME id with the SAME payload replays the first result; the same id with a changed payload is refused.
    expect((await cmd(r.matchId, r.ids[1], { type: 'predict', round: 0, option: 1 }, idA)).result).toEqual(first.result);
    expect((await cmd(r.matchId, r.ids[1], { type: 'predict', round: 0, option: 3 }, idA)).result).toEqual({ ok: false, code: 'command_id_reused' });
    expect((await view(r.matchId, r.ids[1])).myPrediction).toBe(1);
  });

  it('rejects the wrong role, a stale round, an illegal option, the wrong phase and an unauthorized user', async () => {
    const r = await started(3);
    expect((await cmd(r.matchId, r.ids[1], { type: 'choose', round: 0, option: 0 })).result).toEqual({ ok: false, code: 'not_chooser' });
    expect((await cmd(r.matchId, r.ids[0], { type: 'choose', round: 1, option: 0 })).result).toEqual({ ok: false, code: 'stale_round' });
    expect((await cmd(r.matchId, r.ids[0], { type: 'choose', round: 0, option: 7 })).result).toEqual({ ok: false, code: 'illegal_option' }); // past this category's four options
    expect((await cmd(r.matchId, r.ids[1], { type: 'predict', round: 0, option: 0 })).result).toEqual({ ok: false, code: 'wrong_phase' }); // predict during the choose phase
    await expect(cmd(r.matchId, await user(), { type: 'choose', round: 0, option: 0 })).rejects.toThrow(); // not a seat of this match
  });

  // ----- secrets -----
  it('redacts the open secret per seat: only the author sees their own choice, never another seat', async () => {
    const r = await started(3);
    await cmd(r.matchId, r.ids[0], { type: 'choose', round: 0, option: 2 }); // seat0 commits, now in predict
    const chooser = await view(r.matchId, r.ids[0]);
    expect(chooser.myChoice).toBe(2); // the author sees their own committed pick
    const other = await view(r.matchId, r.ids[1]);
    expect(other.myChoice).toBeNull();
    expect(other.reveal).toBeNull();
    expect(other.seats[0]).toMatchObject({ committed: true }); // a public boolean (whether), never the value
    expect(JSON.stringify(other)).not.toContain('"myChoice":2');
  });

  it('a terminal projection carries no open category, pick or prediction', async () => {
    const r = await started(3);
    await playRound(r, 3, 0, 0, () => 0);
    await playRound(r, 3, 1, 0, () => 0);
    await playRound(r, 3, 2, 0, () => 0);
    expect((await matchRow(r.matchId)).status).toBe('completed');
    for (const id of r.ids) {
      const v = await view(r.matchId, id);
      expect(v).toMatchObject({ phase: 'over', category: null, reveal: null, myChoice: null, myPrediction: null, deadline: null, iAmChooser: false });
      expect(v.standings).not.toBeNull();
    }
  });

  // ----- chooser leave semantics -----
  it('the chooser leaving before committing voids the round; a commit that lands first is preserved', async () => {
    // before commit → voided
    const voidRun = await started(3);
    await roomService.leave(voidRun.matchId, voidRun.ids[0]); // chooser of round 0 leaves before choosing
    const vv = await view(voidRun.matchId, voidRun.ids[1]);
    expect(vv.results[0]).toMatchObject({ round: 0, chooser: 0, target: null, voided: true });
    // after commit → preserved: a banked reveal scores on the committed pick despite the chooser's leave
    const keepRun = await started(3);
    await cmd(keepRun.matchId, keepRun.ids[0], { type: 'choose', round: 0, option: 1 });
    await roomService.leave(keepRun.matchId, keepRun.ids[0]); // leaves after committing
    await cmd(keepRun.matchId, keepRun.ids[1], { type: 'predict', round: 0, option: 1 });
    await cmd(keepRun.matchId, keepRun.ids[2], { type: 'predict', round: 0, option: 1 });
    const kv = await view(keepRun.matchId, keepRun.ids[1]);
    expect(kv.results[0]).toMatchObject({ target: 1, voided: false });
    expect(kv.results[0].entries[1]).toMatchObject({ matched: true, points: 2 });
  });

  // ----- absence -----
  it('an away predictor keeps the round from revealing early, and a reconnect keeps its locked prediction', async () => {
    const r = await started(3);
    await cmd(r.matchId, r.ids[0], { type: 'choose', round: 0, option: 2 }); // → predict
    await cmd(r.matchId, r.ids[1], { type: 'predict', round: 0, option: 1 }); // seat1 locks
    await roomService.absent(r.ids[2]); // seat2 away and still unlocked → the round cannot bank early
    expect((await view(r.matchId, r.ids[0])).phase).toBe('predict');
    await roomService.absent(r.ids[1]); // the locked predictor drops...
    await roomService.present(r.ids[1], ['mentalista']); // ...and returns
    expect((await view(r.matchId, r.ids[1])).myPrediction).toBe(1); // its prediction survived the round trip
  });

  // ----- expiry token -----
  it('an expiry with a stale phase token is inert', async () => {
    const r = await started(3);
    const before = await matchRow(r.matchId);
    await roomService.expire(r.matchId, (await token(r.matchId)) + 1000); // a token this phase never held
    const after = await matchRow(r.matchId);
    expect(after.status).toBe('active');
    expect(after.state?.phase).toBe(before.state?.phase);
    expect(after.state?.round).toBe(before.state?.round);
  });
});
