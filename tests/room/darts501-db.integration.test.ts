import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the room and Darts 501 migrations applied (an isolated local schema clone), e.g.
 *   DARTS501_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_darts501
 * Seeds its own INVENTED footballer release, coverage set, room pool and day; runs the room runtime and the daily service.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({
  get sql() { return db.sql; },
  withStatementTimeout: (run: (tx: unknown) => Promise<unknown>, ms = 30_000) =>
    db.sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL statement_timeout = ${Math.round(ms)}`); return run(tx); }),
}));

const url = process.env.DARTS501_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

vi.setConfig({ testTimeout: 60_000 });

const RELEASE = 'it-darts-release';
const COVERAGE = 'it-darts-cov';
// Invented footballers only: the repository is public.
const NAMED: Array<[string, number | null]> = [
  ['Aro Bandel', 180], ['Ceto Darrin', 141], ['Emil Fosk', 100], ['Gian Holt', 60], ['Ivo Jarrel', 20],
  ['Kemi Lund', 200], ['Quin Rask', 180], ['Udo Varn', null], ['Wim Xell', null],
];
const PADS = Array.from({ length: 45 }, (_, i) => `Pad ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}${'x'.repeat(1 + (i % 3))}rrow`);
const PLAYERS: Array<[string, number | null]> = [...NAMED, ...PADS.map((n): [string, number] => [n, 1])];
const pid = (i: number) => `it-p-${String(i).padStart(3, '0')}`;
const UNCOVERED = pid(8);
const L = (en: string) => ({ es: en, en, ka: en, tr: en, ru: en, pt: en, de: en });
const category = (id: string, tier: string) => ({
  id, kind: 'player', release: RELEASE, matcher: 1, coverage: COVERAGE, tier, topicKey: `IT:${id}:apps`,
  title: L(`Invented apps ${id}`), note: null, unit: 'apps', asOf: '2024-25',
  entries: PLAYERS.flatMap(([, value], i) => (value === null ? [] : [{ eid: pid(i), value }])),
});

type View = {
  phase: string; leg: number; turn: number | null; epoch: number; attempt: number; mySeat: number; outs: number | null;
  seats: Array<{ seat: number; status: string; benched: boolean; remaining: number; dartsUsed: number; legsWon: number }>;
  darts: Array<{ name: string | null; stat: number | null; verdict: string }>;
  last: { verdict: string } | null; legEnd: { winner: number | null; reason: string; missed: unknown[] } | null;
  standings: Array<{ seat: number; points: number; place: number }> | null;
};

describe.skipIf(!url)('Football Darts 501 on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql`DELETE FROM room_pool WHERE game = 'darts501'`;
    await db.sql`DELETE FROM darts501_coverage WHERE coverage_id = ${COVERAGE}`;
    await db.sql`DELETE FROM wordgame_releases WHERE id = ${RELEASE}`;
    await db.sql`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${RELEASE}, 'fp-it-darts', 1, ${PLAYERS.length})`;
    for (const [i, [name]] of PLAYERS.entries()) {
      await db.sql`INSERT INTO wordgame_players (release_id, pid, name, game_name, fame, aliases) VALUES (${RELEASE}, ${pid(i)}, ${name}, ${name.split(' ')[1]}, ${Math.max(1, 90 - i)}, '{}')`;
      if (pid(i) !== UNCOVERED) await db.sql`INSERT INTO darts501_coverage (coverage_id, pid) VALUES (${COVERAGE}, ${pid(i)})`;
    }
    for (const tier of ['easy', 'medium', 'hard']) {
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload) VALUES ('darts501', ${`it-d-${tier}`}, ${tier}, ${`fp-d-${tier}`}, ${db.sql.json(category(`it-d-${tier}`, tier))})`;
    }
  });
  afterAll(async () => {
    if (!db.sql) return;
    await db.sql`DELETE FROM room_pool WHERE game = 'darts501'`;
    await db.sql`DELETE FROM darts501_runs`;
    await db.sql`DELETE FROM darts501_days`;
    await db.sql`DELETE FROM darts501_coverage WHERE coverage_id = ${COVERAGE}`;
    await db.sql`DELETE FROM wordgame_releases WHERE id = ${RELEASE}`;
    await db.sql.end();
  });

  const user = async () => (await db.sql<Array<{ id: string }>>`
    INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`d-${randomUUID().slice(0, 8)}`}, false) RETURNING id`)[0].id;

  describe('room', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE room_commands, room_seats, room_match_content, room_matches`;
      await db.sql`DELETE FROM lobby_members WHERE lobby_id IN (SELECT id FROM lobbies WHERE room_game = 'darts501')`;
      await db.sql`DELETE FROM lobbies WHERE room_game = 'darts501'`;
    });

    const service = async () => (await import('../../src/modules/room/room.service.js')).roomService;

    async function started(n = 2) {
      const roomService = await service();
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) ids.push(await user());
      const [lobby] = await db.sql<Array<{ id: string }>>`
        INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
        VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'darts501') RETURNING id`;
      for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
      const { matchId } = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'darts501', players: ids.map((userId) => ({ userId, isGuest: false })) });
      for (const id of ids) await roomService.ready(matchId, id, 'en', ['darts501']);
      await runOut(matchId);
      return { ids, matchId, lobbyId: lobby.id };
    }
    const token = async (id: string) => (await db.sql<Array<{ phase_token: number }>>`SELECT phase_token FROM room_matches WHERE id = ${id}`)[0].phase_token;
    async function runOut(matchId: string) {
      await db.sql`
        UPDATE room_matches SET phase_deadline_at = clock_timestamp() - interval '10 milliseconds',
          state = jsonb_set(state, '{deadline}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 10))
        WHERE id = ${matchId}`;
      return (await service()).expire(matchId, await token(matchId));
    }
    const view = async (matchId: string, userId: string) => ((await (await service()).snapshot(matchId, userId)) as { view: View }).view;
    const throwDart = async (matchId: string, ids: string[], text: string, commandId = randomUUID()) => {
      const v = await view(matchId, ids[0]);
      return (await service()).command(matchId, ids[v.turn!], commandId, { type: 'throw', epoch: v.epoch, attempt: v.attempt, text });
    };
    const row = async (id: string) => (await db.sql`SELECT status, state FROM room_matches WHERE id = ${id}`)[0];

    it('a full 1v1: darts come off, a checkout wins each leg, two legs win the match, the room is free again', async () => {
      const r = await started();
      const won = [0, 0];
      for (let leg = 0; leg < 3 && (await row(r.matchId)).status === 'active'; leg += 1) {
        const opener = (await view(r.matchId, r.ids[0])).turn!;
        // The opener throws 180, 141, 180 = 501; the other seat throws ones.
        for (const text of ['Aro Bandel', PADS[leg * 4], 'Ceto Darrin', PADS[leg * 4 + 1], 'Quin Rask', PADS[leg * 4 + 2]]) {
          if ((await row(r.matchId)).state.phase !== 'turn') break;
          expect((await throwDart(r.matchId, r.ids, text)).result).toMatchObject({ ok: true });
        }
        const v = await view(r.matchId, r.ids[0]);
        expect(v.phase).toBe('legEnd');
        expect(v.legEnd).toMatchObject({ winner: opener, reason: 'checkout' });
        expect(v.seats[opener].remaining).toBe(0);
        won[opener] += 1;
        await runOut(r.matchId);
      }
      expect(Math.max(...won)).toBe(2);
      expect((await row(r.matchId)).status).toBe('completed');
      const final = await view(r.matchId, r.ids[0]);
      expect(final.standings?.find((s) => s.place === 1)?.points).toBe(2);
      expect((await db.sql`SELECT count(*)::int AS n FROM room_seats WHERE match_id = ${r.matchId} AND active`)[0].n).toBe(0);
      expect((await db.sql`SELECT status FROM lobbies WHERE id = ${r.lobbyId}`)[0].status).toBe('waiting');
    });

    it('free answers keep the turn; the same command id replays; a stale attempt is refused', async () => {
      const r = await started();
      const before = await view(r.matchId, r.ids[0]);
      const id = randomUUID();
      const first = await throwDart(r.matchId, r.ids, 'Nobody Atall Here', id);
      expect(first.result).toMatchObject({ ok: true });
      const again = await (await service()).command(r.matchId, r.ids[before.turn!], id, { type: 'throw', epoch: before.epoch, attempt: before.attempt, text: 'Nobody Atall Here' });
      expect(again.result).toEqual(first.result);
      const after = await view(r.matchId, r.ids[0]);
      expect(after).toMatchObject({ turn: before.turn, epoch: before.epoch, attempt: before.attempt + 1 });
      expect(after.last?.verdict).toBe('unknown');
      expect((await throwDart(r.matchId, r.ids, 'Wim Xell')).result).toMatchObject({ ok: true });
      expect((await view(r.matchId, r.ids[0])).last?.verdict).toBe('uncovered');
      const stale = await (await service()).command(r.matchId, r.ids[before.turn!], randomUUID(), { type: 'throw', epoch: before.epoch, attempt: 0, text: 'Aro Bandel' });
      expect(stale.result).toMatchObject({ ok: false });
    });

    it('nothing un-thrown leaves the server: no category number reaches either seat before it is thrown', async () => {
      const r = await started();
      await throwDart(r.matchId, r.ids, 'Aro Bandel');
      for (const id of r.ids) {
        const json = JSON.stringify(await (await service()).snapshot(r.matchId, id));
        expect(json).toContain('Aro Bandel');
        for (const name of ['Ceto Darrin', 'Emil Fosk', 'Gian Holt', 'Quin Rask']) expect(json).not.toContain(name);
        expect(json).not.toContain('"entries"');
      }
    });

    it('three run-outs in a row bench a party seat; it keeps its room seat and the others play on', async () => {
      const r = await started(3);
      const idler = (await view(r.matchId, r.ids[0])).turn!;
      for (let n = 0; n < 3; n += 1) {
        await runOut(r.matchId);
        for (let k = 0; (await view(r.matchId, r.ids[0])).turn !== idler && (await row(r.matchId)).state.phase === 'turn'; k += 1) {
          await throwDart(r.matchId, r.ids, PADS[n * 3 + k]);
        }
      }
      const v = await view(r.matchId, r.ids[0]);
      expect(v.seats[idler].benched).toBe(true);
      expect(v.turn).not.toBe(idler);
      expect((await row(r.matchId)).status).toBe('active');
      expect((await db.sql`SELECT active FROM room_seats WHERE match_id = ${r.matchId} AND seat = ${idler}`)[0].active).toBe(true);
    });

    it('a report on a leg that is still open is refused; once it is over, an unscored name is reportable', async () => {
      const r = await started();
      const roomService = await service();
      expect(await roomService.refusal(r.matchId, r.ids[0], 0, 'Udo Varn')).toBeNull();
      for (const text of ['Aro Bandel', PADS[30], 'Ceto Darrin', PADS[31], 'Quin Rask', PADS[32]]) {
        if ((await row(r.matchId)).state.phase !== 'turn') break;
        await throwDart(r.matchId, r.ids, text);
      }
      expect((await row(r.matchId)).state.phase).toBe('legEnd');
      expect(await roomService.refusal(r.matchId, r.ids[0], 0, 'Udo Varn')).toMatchObject({ game: 'darts501', subject: 'it-d-easy' });
      expect(await roomService.refusal(r.matchId, r.ids[0], 0, 'Emil Fosk')).toBeNull();
    });

    it('the janitor never lists the room of a live match, and lists it once the match is over and the room is old', async () => {
      const r = await started();
      await db.sql`UPDATE lobbies SET created_at = now() - interval '150 minutes' WHERE id = ${r.lobbyId}`;
      const { lobbyJanitorService } = await import('../../src/realtime/services/lobby-janitor.service.js');
      const listed = async () => (await lobbyJanitorService.__internals.listStrandedCandidates()).some((l) => l.id === r.lobbyId);
      expect(await listed()).toBe(false);
      await db.sql`UPDATE room_matches SET status = 'cancelled', result = ${db.sql.json({ reason: 'cancelled', standings: [] })} WHERE id = ${r.matchId}`;
      expect(await listed()).toBe(true);
    });
  });

  describe('daily', () => {
    const DAY = '2026-10-28';
    const NOW = new Date('2026-10-28T18:00:00Z');
    beforeAll(async () => {
      await db.sql`DELETE FROM darts501_runs`;
      await db.sql`INSERT INTO darts501_days (day, number, content_version, category) VALUES (${DAY}, 5, 77, ${db.sql.json(category('it-day', 'easy'))})
        ON CONFLICT (day) DO UPDATE SET category = EXCLUDED.category, content_version = 77`;
    });
    beforeEach(async () => { await db.sql`DELETE FROM darts501_runs`; });

    async function daily(closesInMs = 60 * 60 * 1000) {
      const mod = await import('../../src/modules/darts501-daily/darts501-daily.service.js');
      const { createDailyContentStore } = await import('../../src/modules/daily/daily.content.js');
      const store = createDailyContentStore(
        { fingerprint: () => mod.darts501DailyRepo.daysFingerprint(), load: () => mod.darts501DailyRepo.loadDays() }, mod.indexDay,
        { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined }, label: 'test' },
      );
      return mod.createDarts501DailyService({
        repo: { ...mod.darts501DailyRepo, insertRun: (tx, data) => mod.darts501DailyRepo.insertRun(tx, { ...data, closesAt: new Date(Date.now() + closesInMs) }) },
        content: mod.withBoards(() => store.get()),
        contentStale: () => store.invalidate(),
        now: () => NOW,
        reports: { file: async () => undefined },
      });
    }

    it('a member checks out in three darts: ranked, scored, on the board with darts and remaining', async () => {
      const svc = await daily();
      const me = { kind: 'member' as const, userId: await user() };
      let r = await svc.start(DAY, me, undefined, 'en');
      expect(r.state.ranked).toBe(true);
      for (const text of ['Nobody Atall Here', 'Aro Bandel', 'Ceto Darrin', 'Quin Rask']) r = await svc.say(me, r.run.id, r.run.version, text, null);
      expect(r.state).toMatchObject({ done: true, end: 'checkout', remaining: 0 });
      expect(r.state.darts).toHaveLength(3);
      const board = await svc.leaderboard(DAY, me.userId);
      expect(board.top[0]).toMatchObject({ userId: me.userId, darts: 3, checkedOut: true, remaining: 0 });
    });

    it('a stale version is refused and nothing is spent twice', async () => {
      const svc = await daily();
      const me = { kind: 'member' as const, userId: await user() };
      const r = await svc.start(DAY, me, undefined, 'en');
      await svc.say(me, r.run.id, r.run.version, 'Aro Bandel', null);
      await expect(svc.say(me, r.run.id, r.run.version, 'Ceto Darrin', null)).rejects.toThrow();
      const now = await svc.current(me, DAY);
      expect((now as { state: { darts: unknown[] } }).state.darts).toHaveLength(1);
    });

    it("a guest cannot start today's game", async () => {
      const svc = await daily();
      const [guest] = await db.sql<Array<{ id: string }>>`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`;
      await expect(svc.start(DAY, { kind: 'guest', guestId: guest.id }, undefined, 'en')).rejects.toThrow();
    });

    it("today's end screen counts the missed finishes and names none of them", async () => {
      const svc = await daily();
      const me = { kind: 'member' as const, userId: await user() };
      let r = await svc.start(DAY, me, undefined, 'en');
      // 501 − 180 − 141 − 100 − 20 = 60: Gian Holt would have finished.
      for (const text of ['Aro Bandel', 'Ceto Darrin', 'Emil Fosk', 'Ivo Jarrel']) r = await svc.say(me, r.run.id, r.run.version, text, null);
      r = await svc.giveUp(me, r.run.id, r.run.version);
      expect(r.state.finishes).toEqual({ count: 1, shown: null });
      expect(JSON.stringify(r)).not.toContain('Gian Holt');
    });

    it('a ranked dart after the day closed (database clock) is refused as day_over and nothing is written', async () => {
      const svc = await daily(1_500);
      const me = { kind: 'member' as const, userId: await user() };
      const r = await svc.start(DAY, me, undefined, 'en');
      expect(r.state.ranked).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await expect(svc.say(me, r.run.id, r.run.version, 'Aro Bandel', null)).rejects.toThrow('day_over');
      const stored = (await db.sql`SELECT state_version, state FROM darts501_runs WHERE id = ${r.run.id}`)[0];
      expect(stored.state_version).toBe(r.run.version);
      expect((stored.state as { d: unknown[] }).d).toHaveLength(0);
    });
  });
});
