import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { buscaminasPack, pistasPack } from './duel-fixtures.js';
import { rawGoal } from '../minuto/fixtures.js';

/**
 * Opt-in, real PostgreSQL with the full schema (duel migration applied), e.g. a schema-only copy of a local DB:
 * Isolated audit clones on port 5436 are also accepted.
 *   DUEL_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_duel_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.DUEL_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:543(?:2|6)\/quizball_duel_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local duel test database required');

const { duelService, DUEL_OUTAGE_GRACE_MS, DUEL_COUNTDOWN_MS, DUEL_RECONNECT_MS, DUEL_RESUME_GRACE_MS } = await import('../../src/modules/duel/duel.service.js');
const { PD_WINDOW_MS } = await import('../../src/modules/duel/engines/pistas.engine.js');

describe.skipIf(!url)('duel runtime on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
  });
  afterAll(async () => { await db.sql?.end(); });

  beforeEach(async () => {
    await db.sql`TRUNCATE duel_commands, duel_participants, duel_match_content, duel_matches, duel_pool`;
    // Exactly one pack's worth per game, in the pack's difficulty mix (the deal order within a difficulty is random).
    const order = ['easy', 'medium', 'hard', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard'] as const;
    // Minuto: one goal per pack slot, in the pack's tier mix (3 easy, 4 medium, 3 hard).
    const tiers = ['easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard'] as const;
    const minuto = tiers.map((tier, r) => ({ ...rawGoal('2099-01-01', r), tier, id: `g20990101-${String(r).padStart(10, '0')}`, difficulty: tier }));
    const pools = { pistas: pistasPack().rounds.map((r, i) => ({ ...r, difficulty: order[i] })), buscaminas: buscaminasPack().rounds, minuto };
    for (const [game, rounds] of Object.entries(pools)) {
      for (const round of rounds) {
        const { difficulty, ...payload } = round as { difficulty: string } & Record<string, unknown>;
        await db.sql`INSERT INTO duel_pool (game, item_id, difficulty, fingerprint, payload) VALUES (${game}, ${round.id as string}, ${difficulty}, ${(game === 'minuto' ? payload.fingerprint : round.id) as string}, ${db.sql.json((game === 'minuto' ? payload : round) as never)})`;
      }
    }
  });

  const user = async (nickname: string, isGuest = false) => {
    const [row] = await db.sql<Array<{ id: string }>>`INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${nickname}, ${isGuest}) RETURNING id`;
    return row.id;
  };

  /** A waiting duel room with two ready members: the host (a member) and a guest. */
  async function room(game: 'pistas' | 'buscaminas' | 'minuto') {
    const a = await user(`host-${randomUUID().slice(0, 6)}`);
    const b = await user(`guest-${randomUUID().slice(0, 6)}`, true);
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, duel_game)
      VALUES ('friendly', ${a}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'duel', ${game}) RETURNING id
    `;
    await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${a}, true), (${lobby.id}, ${b}, true)`;
    const players = [{ userId: a, isGuest: false }, { userId: b, isGuest: true }];
    return { lobbyId: lobby.id, a, b, players };
  }

  /** Runs the match's clock out now (as if its deadline passed) and expires it with its current token. */
  async function runOut(matchId: string) {
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '10 milliseconds' WHERE id = ${matchId}`;
    await db.sql`UPDATE duel_participants SET absence_deadline_at = clock_timestamp() - interval '10 milliseconds' WHERE match_id = ${matchId} AND NOT connected`;
    const [{ phase_token }] = await db.sql<Array<{ phase_token: number }>>`SELECT phase_token FROM duel_matches WHERE id = ${matchId}`;
    return duelService.expire(matchId, phase_token);
  }

  /** Both ready, the intro played out: the first game phase is live. */
  async function started(game: 'pistas' | 'buscaminas' | 'minuto') {
    const r = await room(game);
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game, players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    const intro = await duelService.ready(created.matchId, r.b, 'en');
    expect(intro).toMatchObject({ status: 'countdown' });
    const live = (await runOut(created.matchId))!;
    return { ...r, matchId: created.matchId, live };
  }

  /** The first accepted answer of round r in this match's dealt pack, e.g. "Número 4". */
  const answerOf = async (matchId: string, r: number): Promise<string> =>
    ((await db.sql`SELECT content FROM duel_match_content WHERE match_id = ${matchId}`)[0].content as { rounds: Array<{ answer: { accepted: string[] } }> }).rounds[r].answer.accepted[0];

  const matchRow = async (id: string) => (await db.sql`SELECT status, state, state_version, phase_token, phase_deadline_at, result FROM duel_matches WHERE id = ${id}`)[0];

  it('a start flips the room active and opens the ready gate; the same room cannot start twice', async () => {
    const r = await room('pistas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    expect(created).toMatchObject({ status: 'ready', finished: false, timer: { token: 1 } });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('active');
    await expect(duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players })).rejects.toMatchObject({ code: 'duel_room_changed' });
    const content = (await db.sql`SELECT item_ids, content FROM duel_match_content WHERE match_id = ${created.matchId}`)[0];
    expect(content.item_ids).toHaveLength(10);
    const snapshot = await duelService.snapshot(created.matchId, r.b);
    expect(snapshot).toMatchObject({ status: 'ready', mySeat: 1, view: null, seats: [{ isGuest: false, ready: false }, { isGuest: true, ready: false }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/Número|accepted/);
  });

  it('a start refuses a room whose roster or readiness changed; one live duel per person', async () => {
    const r = await room('pistas');
    await db.sql`UPDATE lobby_members SET is_ready = false WHERE user_id = ${r.b}`;
    await expect(duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players })).rejects.toMatchObject({ code: 'duel_room_changed' });
    await db.sql`UPDATE lobby_members SET is_ready = true WHERE user_id = ${r.b}`;
    await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    const other = await room('pistas');
    await db.sql`UPDATE lobby_members SET user_id = ${r.a} WHERE lobby_id = ${other.lobbyId} AND user_id = ${other.a}`;
    await expect(duelService.createFromLobby({ lobbyId: other.lobbyId, game: 'pistas', players: [{ userId: r.a, isGuest: false }, other.players[1]] }))
      .rejects.toThrow(/uq_duel_participants_one_live/);
  });

  it('the game starts when both seats are ready; each seat sees its own locale and nothing unrevealed', async () => {
    const { matchId, a, b, live } = await started('pistas');
    expect(live).toMatchObject({ status: 'active', timer: { token: 3 } });
    const mine = await duelService.snapshot(matchId, a);
    const theirs = await duelService.snapshot(matchId, b);
    expect(mine).toMatchObject({ status: 'active', mySeat: 0, view: { clue: 1, clues: [{ text: expect.stringMatching(/^pista \d\.1 es$/) }] } });
    expect(theirs).toMatchObject({ mySeat: 1, view: { clues: [{ text: expect.stringMatching(/^pista \d\.1 en$/) }] } });
    expect(JSON.stringify(mine)).not.toMatch(/Número|pista \d\.2/);
    const deadline = new Date(mine!.phaseDeadlineAt!).getTime() - new Date(mine!.serverNow).getTime();
    expect(deadline).toBeGreaterThan(PD_WINDOW_MS - 2_000);
  });

  it('commands are idempotent per (user, id): same payload replays, changed payload is refused, rule rejections replay', async () => {
    const { matchId, a, b } = await started('pistas');
    const id = randomUUID();
    const answer = await answerOf(matchId, 0);
    const first = await duelService.command(matchId, a, id, { type: 'guess', round: 0, text: answer.toUpperCase() });
    expect(first.result).toEqual({ ok: true });
    const version = (await matchRow(matchId)).state_version;
    expect((await duelService.command(matchId, a, id, { type: 'guess', round: 0, text: answer.toUpperCase() })).result).toEqual({ ok: true });
    expect((await matchRow(matchId)).state_version).toBe(version);
    expect((await duelService.command(matchId, a, id, { type: 'guess', round: 0, text: 'otro' })).result).toEqual({ ok: false, code: 'command_id_reused' });
    const late = randomUUID();
    expect((await duelService.command(matchId, b, late, { type: 'guess', round: 0, text: 'x' })).result).toEqual({ ok: false, code: 'round_over' });
    expect((await duelService.command(matchId, b, late, { type: 'guess', round: 0, text: 'x' })).result).toEqual({ ok: false, code: 'round_over' });
    expect((await duelService.snapshot(matchId, b))!.view).toMatchObject({ scores: [10, 0], settled: { winner: 0, answer: expect.stringMatching(/^Número \d en$/) } });
    await expect(duelService.command(matchId, await user(`stranger-${randomUUID().slice(0, 6)}`), randomUUID(), { type: 'pass', round: 0, clue: 1 })).rejects.toMatchObject({ code: 'not_in_match' });
  });

  it('a command after the deadline meets the state that followed it (late fence); an old timer token does nothing', async () => {
    const { matchId, a, live } = await started('pistas');
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '2 seconds' WHERE id = ${matchId}`;
    const late = await duelService.command(matchId, a, randomUUID(), { type: 'pass', round: 0, clue: 1 });
    expect(late.result).toEqual({ ok: false, code: 'stale_clue' });
    const row = await matchRow(matchId);
    expect(row.state).toMatchObject({ n: 2, idle: [1, 1] });
    expect(row.phase_token).toBeGreaterThan(live.timer!.token);
    expect(await duelService.expire(matchId, live.timer!.token)).toBeNull();
  });

  it('an outage is not replayed: the open phase gets a short fresh deadline and nobody is charged', async () => {
    const { matchId, live } = await started('pistas');
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '5 minutes' WHERE id = ${matchId}`;
    const effects = await duelService.expire(matchId, live.timer!.token);
    const row = await matchRow(matchId);
    expect(row.state).toMatchObject({ n: 1, idle: [0, 0] });
    const left = effects!.timer!.dueAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(DUEL_OUTAGE_GRACE_MS - 3_000);
    expect(left).toBeLessThan(DUEL_OUTAGE_GRACE_MS + 3_000);
  });

  it('a forfeit gives the match to the rival and sends both back to the waiting room, not ready', async () => {
    const { matchId, lobbyId, a, b } = await started('pistas');
    const effects = await duelService.forfeit(matchId, b);
    expect(effects).toMatchObject({ status: 'completed', finished: true, lobbyId });
    expect((await matchRow(matchId)).result).toMatchObject({ winnerSeat: 0, reason: 'forfeit', leftSeat: 1 });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${lobbyId}`)[0].status).toBe('waiting');
    expect((await db.sql`SELECT bool_or(is_ready) AS any FROM lobby_members WHERE lobby_id = ${lobbyId}`)[0].any).toBe(false);
    expect((await db.sql`SELECT count(*)::int AS n FROM duel_participants WHERE match_id = ${matchId} AND active`)[0].n).toBe(0);
    expect(await duelService.liveMatchFor(a)).toBeNull();
    const again = await duelService.command(matchId, a, randomUUID(), { type: 'pass', round: 0, clue: 1 });
    expect(again.result).toEqual({ ok: false, code: 'not_active' });
  });

  it('a ready gate that runs out cancels the match and names the seat that never arrived', async () => {
    const r = await room('buscaminas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'buscaminas', players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${created.matchId}`;
    const effects = await duelService.expire(created.matchId, created.timer!.token);
    expect(effects).toMatchObject({ status: 'cancelled', finished: true });
    expect((await matchRow(created.matchId)).result).toMatchObject({ reason: 'cancelled', leftSeat: 1 });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('waiting');
  });

  it('both ready opens the intro countdown; commands wait for it; its end deals the first phase', async () => {
    const r = await room('pistas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    const intro = await duelService.ready(created.matchId, r.b, 'es');
    expect(intro).toMatchObject({ status: 'countdown' });
    expect(intro.timer!.dueAt.getTime() - Date.now()).toBeGreaterThan(DUEL_COUNTDOWN_MS - 2_000);
    expect((await duelService.snapshot(created.matchId, r.a))).toMatchObject({ status: 'countdown', view: null });
    expect((await duelService.command(created.matchId, r.a, randomUUID(), { type: 'pass', round: 0, clue: 1 })).result).toEqual({ ok: false, code: 'not_active' });
    expect(await runOut(created.matchId)).toMatchObject({ status: 'active' });
    expect((await duelService.snapshot(created.matchId, r.a))!.view).toMatchObject({ clue: 1 });
  });

  it('a disconnection pauses the match with the phase time kept; commands wait; the return resumes it with that time plus a grace', async () => {
    const { matchId, a, b } = await started('pistas');
    const paused = await duelService.absent(b);
    expect(paused).toMatchObject({ status: 'paused' });
    const row = await matchRow(matchId);
    expect(row).toMatchObject({ status: 'paused' });
    const pausedRow = (await db.sql`SELECT paused_from, paused_remaining_ms FROM duel_matches WHERE id = ${matchId}`)[0];
    expect(pausedRow.paused_from).toBe('active');
    expect(pausedRow.paused_remaining_ms).toBeGreaterThan(PD_WINDOW_MS - 3_000);
    expect(paused!.timer!.dueAt.getTime() - Date.now()).toBeLessThanOrEqual(DUEL_RECONNECT_MS + 500);
    expect((await duelService.snapshot(matchId, a))).toMatchObject({ status: 'paused', pausedFrom: 'active', seats: [{ connected: true }, { connected: false }] });
    expect((await duelService.command(matchId, a, randomUUID(), { type: 'pass', round: 0, clue: 1 })).result).toEqual({ ok: false, code: 'paused' });
    expect(await duelService.absent(b)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const resumed = await duelService.present(b);
    expect(resumed).toMatchObject({ status: 'active' });
    const left = resumed!.timer!.dueAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(PD_WINDOW_MS + DUEL_RESUME_GRACE_MS - 4_000);
    const budget = (await db.sql`SELECT absence_budget_ms FROM duel_participants WHERE match_id = ${matchId} AND user_id = ${b}`)[0].absence_budget_ms;
    expect(budget).toBeLessThan(60_000);
    expect(budget).toBeGreaterThan(55_000);
    expect(await duelService.present(b)).toBeNull();
  });

  it('the resume grace is never more than the pause lasted: a quick drop earns nothing, a real one its seconds back', async () => {
    const quick = await started('buscaminas');
    await duelService.absent(quick.b);
    const kept = (await db.sql`SELECT paused_remaining_ms FROM duel_matches WHERE id = ${quick.matchId}`)[0].paused_remaining_ms as number;
    const blip = await duelService.present(quick.b);
    expect(blip!.timer!.dueAt.getTime() - Date.now()).toBeLessThan(kept + 1_000);
    const real = await started('buscaminas');
    await duelService.absent(real.b);
    // The pause began five seconds ago: the full grace is due.
    await db.sql`UPDATE duel_matches SET paused_at = clock_timestamp() - interval '5 seconds' WHERE id = ${real.matchId}`;
    const keptReal = (await db.sql`SELECT paused_remaining_ms FROM duel_matches WHERE id = ${real.matchId}`)[0].paused_remaining_ms as number;
    const back = await duelService.present(real.b);
    expect(back!.timer!.dueAt.getTime() - Date.now()).toBeGreaterThan(keptReal + DUEL_RESUME_GRACE_MS - 1_000);
    expect((await db.sql`SELECT paused_at FROM duel_matches WHERE id = ${real.matchId}`)[0].paused_at).toBeNull();
  });

  it('a seat that does not come back within its window forfeits: the rival wins by disconnect', async () => {
    const { matchId, lobbyId, b } = await started('buscaminas');
    await duelService.absent(b);
    const ended = await runOut(matchId);
    expect(ended).toMatchObject({ status: 'completed', finished: true });
    expect((await matchRow(matchId)).result).toMatchObject({ reason: 'disconnect', leftSeat: 1, winnerSeat: 0 });
    expect((await db.sql`SELECT status FROM lobbies WHERE id = ${lobbyId}`)[0].status).toBe('waiting');
  });

  it('both seats away past the window: no contest', async () => {
    const { matchId, a, b } = await started('pistas');
    await duelService.absent(a);
    await duelService.absent(b);
    expect(await runOut(matchId)).toMatchObject({ status: 'cancelled' });
    expect((await matchRow(matchId)).result).toMatchObject({ reason: 'cancelled', leftSeat: null });
  });

  it('the reconnect window is capped by what is left of the seat budget; an empty budget forfeits at once', async () => {
    const { matchId, b } = await started('pistas');
    await db.sql`UPDATE duel_participants SET absence_budget_ms = 4000 WHERE match_id = ${matchId} AND user_id = ${b}`;
    const paused = await duelService.absent(b);
    expect(paused!.timer!.dueAt.getTime() - Date.now()).toBeLessThan(4_500);
    await duelService.present(b);
    await db.sql`UPDATE duel_participants SET absence_budget_ms = 0 WHERE match_id = ${matchId} AND user_id = ${b}`;
    const empty = await duelService.absent(b);
    expect(empty!.timer!.dueAt.getTime() - Date.now()).toBeLessThan(500);
    expect(await runOut(matchId)).toMatchObject({ status: 'completed' });
    expect((await matchRow(matchId)).result).toMatchObject({ reason: 'disconnect', leftSeat: 1 });
  });

  it('a disconnection during the intro pauses it too, and a forfeit during a pause still ends the match', async () => {
    const r = await room('pistas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    await duelService.ready(created.matchId, r.b, 'es');
    expect(await duelService.absent(r.a)).toMatchObject({ status: 'paused' });
    expect((await db.sql`SELECT paused_from FROM duel_matches WHERE id = ${created.matchId}`)[0].paused_from).toBe('countdown');
    expect(await duelService.present(r.a)).toMatchObject({ status: 'countdown' });
    await duelService.absent(r.b);
    expect(await duelService.forfeit(created.matchId, r.a)).toMatchObject({ status: 'completed' });
    expect((await matchRow(created.matchId)).result).toMatchObject({ reason: 'forfeit', leftSeat: 0, winnerSeat: 1 });
  });

  it('at the ready gate a disconnection pauses nothing (the gate has its own deadline)', async () => {
    const r = await room('pistas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    const away = await duelService.absent(r.b);
    expect(away).toMatchObject({ status: 'ready' });
    expect((await matchRow(created.matchId)).status).toBe('ready');
  });

  it('a disconnect check that started before a reconnect is stale and does nothing (presence generation fence)', async () => {
    const { matchId, b } = await started('pistas');
    const generation = await duelService.presenceGeneration(b);
    expect(generation).not.toBeNull();
    await duelService.present(b);
    expect(await duelService.absent(b, generation)).toBeNull();
    expect((await matchRow(matchId)).status).toBe('active');
    expect(await duelService.absent(b, await duelService.presenceGeneration(b))).toMatchObject({ status: 'paused' });
  });

  it('coming back after your own reconnect deadline is too late: you forfeit (it is not an outage)', async () => {
    const { matchId, b } = await started('pistas');
    await duelService.absent(b);
    await db.sql`UPDATE duel_participants SET absence_deadline_at = clock_timestamp() - interval '2 seconds' WHERE match_id = ${matchId} AND user_id = ${b}`;
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '2 seconds' WHERE id = ${matchId}`;
    expect(await duelService.present(b)).toMatchObject({ status: 'completed' });
    expect((await matchRow(matchId)).result).toMatchObject({ reason: 'disconnect', leftSeat: 1, winnerSeat: 0 });
  });

  it('each seat keeps its own reconnect deadline: a second disconnect never extends the first one', async () => {
    const { matchId, a, b } = await started('pistas');
    await db.sql`UPDATE duel_participants SET absence_budget_ms = 4000 WHERE match_id = ${matchId} AND user_id = ${a}`;
    await duelService.absent(a);
    const both = await duelService.absent(b);
    expect(both!.timer!.dueAt.getTime() - Date.now()).toBeLessThan(4_500);
    const bBack = await duelService.present(b);
    expect(bBack).toMatchObject({ status: 'paused' });
    expect(bBack!.timer!.dueAt.getTime() - Date.now()).toBeLessThan(4_500);
    expect(await runOut(matchId)).toMatchObject({ status: 'completed' });
    expect((await matchRow(matchId)).result).toMatchObject({ reason: 'disconnect', leftSeat: 0, winnerSeat: 1 });
  });

  it('a seat that left after saying ready is not started into the game: the intro begins paused on its window', async () => {
    const r = await room('pistas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    await duelService.absent(r.a);
    const both = await duelService.ready(created.matchId, r.b, 'es');
    expect(both).toMatchObject({ status: 'paused' });
    expect((await db.sql`SELECT paused_from, paused_remaining_ms FROM duel_matches WHERE id = ${created.matchId}`)[0]).toMatchObject({ paused_from: 'countdown', paused_remaining_ms: DUEL_COUNTDOWN_MS });
    expect(await duelService.present(r.a)).toMatchObject({ status: 'countdown' });
  });

  it('pausing never shelters a phase that already expired: the clock is run first', async () => {
    const { matchId, b } = await started('pistas');
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${matchId}`;
    expect(await duelService.absent(b)).toMatchObject({ status: 'paused' });
    expect((await matchRow(matchId)).state).toMatchObject({ n: 2 });
  });

  it('a pause resolved long after its deadline is an outage: a fresh short window, no forfeit', async () => {
    const { matchId, b } = await started('pistas');
    await duelService.absent(b);
    await db.sql`UPDATE duel_participants SET absence_deadline_at = clock_timestamp() - interval '2 minutes' WHERE match_id = ${matchId} AND user_id = ${b}`;
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '2 minutes' WHERE id = ${matchId}`;
    const outage = await duelService.expire(matchId, null);
    expect(outage).toMatchObject({ status: 'paused' });
    expect(outage!.timer!.dueAt.getTime() - Date.now()).toBeGreaterThan(DUEL_OUTAGE_GRACE_MS - 3_000);
    expect(await duelService.present(b)).toMatchObject({ status: 'active' });
  });

  it('an outage never charges the budget: only the absence up to the old deadline counts, then it restarts', async () => {
    const { matchId, b } = await started('pistas');
    await duelService.absent(b);
    await db.sql`UPDATE duel_participants SET absent_since = clock_timestamp() - interval '150 seconds', absence_deadline_at = clock_timestamp() - interval '120 seconds' WHERE match_id = ${matchId} AND user_id = ${b}`;
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '120 seconds' WHERE id = ${matchId}`;
    expect(await duelService.expire(matchId, null)).toMatchObject({ status: 'paused' });
    expect(await duelService.present(b)).toMatchObject({ status: 'active' });
    const budget = (await db.sql`SELECT absence_budget_ms FROM duel_participants WHERE match_id = ${matchId} AND user_id = ${b}`)[0].absence_budget_ms;
    expect(budget).toBeGreaterThan(29_000);
    expect(budget).toBeLessThanOrEqual(30_000);
  });

  it('a presence change right after a pause deadline never changes the outcome already due', async () => {
    const { matchId, a, b } = await started('pistas');
    await db.sql`UPDATE duel_participants SET absence_budget_ms = 4000 WHERE match_id = ${matchId} AND user_id = ${a}`;
    await duelService.absent(a);
    await duelService.absent(b);
    // A's deadline passes (both away at that moment → no contest) and B comes back before any timer ran.
    await db.sql`UPDATE duel_participants SET absence_deadline_at = clock_timestamp() - interval '100 milliseconds' WHERE match_id = ${matchId} AND user_id = ${a}`;
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '100 milliseconds' WHERE id = ${matchId}`;
    expect(await duelService.present(b)).toMatchObject({ status: 'cancelled' });
    expect((await matchRow(matchId)).result).toMatchObject({ reason: 'cancelled' });
  });

  it('safety nets: a live match past the age cap is cancelled; ended matches lose their inbox and content after retention', async () => {
    const { matchId, a } = await started('pistas');
    await duelService.command(matchId, a, randomUUID(), { type: 'pass', round: 0, clue: 1 });
    await db.sql`UPDATE duel_matches SET created_at = clock_timestamp() - interval '4 hours' WHERE id = ${matchId}`;
    expect(await duelService.staleLiveMatches()).toContain(matchId);
    expect(await duelService.cancelStale(matchId)).toMatchObject({ status: 'cancelled' });
    expect(await duelService.staleLiveMatches()).not.toContain(matchId);
    await db.sql`UPDATE duel_matches SET ended_at = clock_timestamp() - interval '31 days' WHERE id = ${matchId}`;
    const purged = await duelService.purgeEnded();
    expect(purged.commands).toBeGreaterThan(0);
    expect(purged.contents).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM duel_matches WHERE id = ${matchId}`)[0].n).toBe(1);
  });

  it('a ready that arrives after the gate closed cancels the match instead of starting it', async () => {
    const r = await room('pistas');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'pistas', players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${created.matchId}`;
    const late = await duelService.ready(created.matchId, r.b, 'es');
    expect(late).toMatchObject({ status: 'cancelled', finished: true });
    expect((await matchRow(created.matchId)).result).toMatchObject({ reason: 'cancelled', leftSeat: 1 });
  });

  it('minuto: a guess stays hidden from the rival (snapshot and command result), is final, and the second one reveals both', async () => {
    const { matchId, a, b } = await started('minuto');
    const minuteOf = async (r: number) => {
      const m = ((await db.sql`SELECT content FROM duel_match_content WHERE match_id = ${matchId}`)[0].content as { rounds: Array<{ minute: { base: number; added: number } }> }).rounds[r].minute;
      return m.base + m.added;
    };
    const exact = await minuteOf(0);
    const id = randomUUID();
    const first = await duelService.command(matchId, a, id, { type: 'guess', round: 0, minute: exact });
    expect(first.result).toEqual({ ok: true });
    const rival = await duelService.snapshot(matchId, b);
    expect(rival!.view).toMatchObject({ phase: 'guess', me: { answered: false, guess: null }, rival: { answered: true }, settled: null, scores: [0, 0] });
    expect(JSON.stringify(rival)).not.toMatch(new RegExp(`"(guess|minute)":${exact}\\b`));
    expect(JSON.stringify(rival)).not.toContain('"minute"');
    expect((await duelService.snapshot(matchId, a))!.view).toMatchObject({ me: { answered: true, guess: exact } });
    // Replayed with the same id: same answer, nothing changes; a new id cannot change the guess.
    expect((await duelService.command(matchId, a, id, { type: 'guess', round: 0, minute: exact })).result).toEqual({ ok: true });
    expect((await duelService.command(matchId, a, randomUUID(), { type: 'guess', round: 0, minute: 1 })).result).toEqual({ ok: false, code: 'already_answered' });
    const second = await duelService.command(matchId, b, randomUUID(), { type: 'guess', round: 0, minute: exact + 4 });
    expect(second.result).toEqual({ ok: true });
    expect((await duelService.snapshot(matchId, b))!.view).toMatchObject({ phase: 'reveal', settled: { guesses: [exact, exact + 4], points: [3, 0] }, scores: [3, 0] });
    // The reveal runs out into goal 2; a late guess for goal 1 meets goal 2 and is stale.
    await runOut(matchId);
    expect((await duelService.command(matchId, b, randomUUID(), { type: 'guess', round: 0, minute: 10 })).result).toEqual({ ok: false, code: 'stale_round' });
    expect((await duelService.snapshot(matchId, a))!.view).toMatchObject({ phase: 'guess', round: 1, me: { answered: false } });
  });

  it('two private seat projections share three reads; outsiders and empty recipients never read content', async () => {
    const { matchId, a, b } = await started('minuto');
    await duelService.command(matchId, a, randomUUID(), { type: 'guess', round: 0, minute: 93 });
    const queries: string[] = [];
    const previous = db.sql.options.debug;
    db.sql.options.debug = (_connection, query) => { queries.push(query); };
    try {
      const views = await duelService.snapshots(matchId, [{ userId: a, locale: 'ka' }, { userId: b, locale: 'tr' }]);
      expect(queries).toHaveLength(3);
      expect(views.get(a)!.mySeat).toBe(0);
      expect(views.get(b)!.mySeat).toBe(1);
      expect(views.get(a)!.view).toMatchObject({ me: { guess: 93 } });
      expect(views.get(b)!.view).toMatchObject({ me: { guess: null }, rival: { answered: true } });
      expect(JSON.stringify(views.get(b))).not.toContain('"guess":93');
      expect(JSON.stringify(views.get(b))).not.toContain('"minute"');
      expect(JSON.stringify(views.get(b))).not.toContain('rounds');
      queries.length = 0;
      expect((await duelService.snapshots(matchId, [{ userId: randomUUID() }])).size).toBe(0);
      expect(queries).toHaveLength(2);
      queries.length = 0;
      expect((await duelService.snapshots(matchId, [])).size).toBe(0);
      expect(queries).toHaveLength(0);
    } finally { db.sql.options.debug = previous; }
  });

  it('an engine this build does not have leaves the match alone: no cancel on the clock, an unrecorded refusal', async () => {
    const { matchId, a } = await started('minuto');
    // A newer build's engine version stands in for a game an old replica does not know during a rolling deploy.
    const [{ engine_version: version }] = await db.sql<Array<{ engine_version: number }>>`SELECT engine_version FROM duel_matches WHERE id = ${matchId}`;
    await db.sql`UPDATE duel_matches SET engine_version = 999 WHERE id = ${matchId}`;
    const before = await matchRow(matchId);
    const effects = await runOut(matchId);
    expect(effects).toMatchObject({ status: 'active', timer: null, finished: false });
    expect(await matchRow(matchId)).toMatchObject({ status: 'active', state_version: before.state_version });
    const id = randomUUID();
    expect((await duelService.command(matchId, a, id, { type: 'guess', round: 0, minute: 30 })).result).toEqual({ ok: false, code: 'engine_unavailable' });
    expect((await db.sql`SELECT count(*)::int AS n FROM duel_commands WHERE match_id = ${matchId}`)[0].n).toBe(0);
    // Back on a build that has it, the same command is judged.
    await db.sql`UPDATE duel_matches SET engine_version = ${version}, phase_deadline_at = clock_timestamp() + interval '20 seconds' WHERE id = ${matchId}`;
    expect((await duelService.command(matchId, a, id, { type: 'guess', round: 0, minute: 30 })).result).toEqual({ ok: true });
  });

  it('a malformed pool goal refuses the start with a code only, never the goal', async () => {
    await db.sql`UPDATE duel_pool SET payload = jsonb_set(payload, '{comp}', '"private-minute-73"') WHERE game = 'minuto' AND item_id = (SELECT min(item_id) FROM duel_pool WHERE game = 'minuto')`;
    const r = await room('minuto');
    const error = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'minuto', players: r.players }).then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(error).toMatchObject({ code: 'duel_content_invalid' });
    expect(`${error!.message} ${JSON.stringify(error)}`).not.toContain('private-minute-73');
  });

  it('content that no longer parses fails with a code only, never the stored goal', async () => {
    const r = await room('minuto');
    const created = await duelService.createFromLobby({ lobbyId: r.lobbyId, game: 'minuto', players: r.players });
    await duelService.ready(created.matchId, r.a, 'es');
    await duelService.ready(created.matchId, r.b, 'es');
    await db.sql`UPDATE duel_match_content SET content = jsonb_set(content, '{rounds,0,minute,base}', '"secreto-77"') WHERE match_id = ${created.matchId}`;
    const error = await runOut(created.matchId).then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(error).toMatchObject({ code: 'duel_content_invalid' });
    expect(`${error!.message} ${JSON.stringify(error)}`).not.toContain('secreto-77');
  });

  it('buscaminas: turns alternate on the server, an out-of-turn pick is refused, a timeout pick is replayed identically', async () => {
    const { matchId, a, b } = await started('buscaminas');
    const snap = await duelService.snapshot(matchId, a);
    const view = snap!.view as { turn: 0 | 1; pickIndex: number };
    const [mover, waiter] = view.turn === 0 ? [a, b] : [b, a];
    expect((await duelService.command(matchId, waiter, randomUUID(), { type: 'pick', round: 0, at: 0, cardId: 'c0' })).result).toEqual({ ok: false, code: 'not_your_turn' });
    expect((await duelService.command(matchId, mover, randomUUID(), { type: 'pick', round: 0, at: 0, cardId: 'c0' })).result).toEqual({ ok: true });
    expect(((await duelService.snapshot(matchId, a))!.view as { turn: number }).turn).toBe(view.turn === 0 ? 1 : 0);
    const before = await matchRow(matchId);
    await db.sql`UPDATE duel_matches SET phase_deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${matchId}`;
    await duelService.expire(matchId, before.phase_token);
    const after = await matchRow(matchId);
    expect((after.state as { picks: Array<{ auto: boolean }> }).picks.at(-1)).toMatchObject({ auto: true });
  });
});
