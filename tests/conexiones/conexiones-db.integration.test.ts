import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the Conexiones migrations applied (an isolated local schema clone), e.g.
 *   CONEXIONES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_conexiones
 * Runs the daily service on the database clock against an INVENTED board. The calendar runs on a fixed app clock.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({
  get sql() { return db.sql; },
  withStatementTimeout: (run: (tx: unknown) => Promise<unknown>, ms = 30_000) =>
    db.sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL statement_timeout = ${Math.round(ms)}`); return run(tx); }),
}));

const url = process.env.CONEXIONES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

vi.setConfig({ testTimeout: 60_000 });

const L = (en: string) => ({ en, es: en, tr: en, ru: en, ka: en });
const tid = (i: number) => `tile${String(i).padStart(2, '0')}ab`;
const DAY = '2026-10-24';
const NOW = new Date('2026-10-24T18:00:00Z');
const board = {
  id: 'test-day-board', difficulty: 'medium',
  tiles: Array.from({ length: 16 }, (_, i) => ({ id: tid(i), player: `test-p-${i}`, name: { en: `Invented ${i}`, ka: `ka ${i}`, ru: `ru ${i}` }, portrait: null })),
  groups: [0, 1, 2, 3].map((g) => ({
    id: `g-${g}`, tier: g + 1, key: `club:invented-${g}`, link: L(`Link ${g}`), decoys: [1, 2, 3].map((d) => L(`Decoy ${g}-${d}`)),
    members: [0, 1, 2, 3].map((m) => tid(g * 4 + m)),
  })),
};
const group = (g: number) => [0, 1, 2, 3].map((m) => tid(g * 4 + m));
const MISSES = [[0, 8, 12, 13], [0, 8, 12, 14], [0, 8, 12, 15], [0, 8, 13, 14]].map((xs) => xs.map(tid));

describe.skipIf(!url)('Conexiones daily on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql`DELETE FROM conexiones_runs`;
    await db.sql`INSERT INTO conexiones_days (day, number, content_version, board) VALUES (${DAY}, 2, 41, ${db.sql.json({ board })})
      ON CONFLICT (day) DO UPDATE SET board = EXCLUDED.board, content_version = 41`;
  });
  afterAll(async () => {
    if (!db.sql) return;
    await db.sql`DELETE FROM conexiones_runs`;
    await db.sql`DELETE FROM conexiones_days WHERE day = ${DAY}`;
    await db.sql.end();
  });
  beforeEach(async () => { await db.sql`DELETE FROM conexiones_runs`; });

  async function service(now = NOW) {
    const { createConexionesService, conexionesRepo, indexDay } = await import('../../src/modules/conexiones/conexiones.service.js');
    const { createDailyContentStore } = await import('../../src/modules/daily/daily.content.js');
    const store = createDailyContentStore(
      { fingerprint: () => conexionesRepo.daysFingerprint(), load: () => conexionesRepo.loadDays() }, indexDay,
      { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined }, label: 'test' },
    );
    return createConexionesService({
      repo: { ...conexionesRepo, insertRun: (tx, data) => conexionesRepo.insertRun(tx, { ...data, closesAt: new Date(Date.now() + 60 * 60 * 1000) }) },
      content: () => store.get(), contentStale: () => store.invalidate(), now: () => now,
    });
  }
  const member = async (name: string) => {
    const [u] = await db.sql<Array<{ id: string }>>`INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`${name}-${randomUUID().slice(0, 6)}`}, false) RETURNING id`;
    return { kind: 'member' as const, userId: u.id };
  };
  const row = async (id: string) => (await db.sql`SELECT ranked, done, score, secs, state_version, completed_at FROM conexiones_runs WHERE id = ${id}`)[0];
  /** Opens the board `secondsAgo` before now (the database clock), then plays `misses` wrong fours and, if `win`, every group. */
  async function play(svc: Awaited<ReturnType<typeof service>>, who: Awaited<ReturnType<typeof member>>, misses: number, win: boolean, secondsAgo: number) {
    let r = await svc.start(DAY, who);
    r = await svc.open(who, r.run.id, r.run.version);
    await db.sql`UPDATE conexiones_runs SET state = jsonb_set(state, '{t0}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::float8 - ${secondsAgo * 1000})) WHERE id = ${r.run.id}`;
    for (let k = 0; k < misses; k += 1) r = await svc.guess(who, r.run.id, r.run.version, MISSES[k]);
    if (win) for (const g of [0, 1, 2, 3]) r = await svc.guess(who, r.run.id, r.run.version, group(g));
    return r;
  }

  it('the score and seconds bounds hold in the table', async () => {
    const who = await member('bounds');
    const insert = (score: number, secs: number, day: string) => db.sql`
      INSERT INTO conexiones_runs (user_id, day, content_version, state, closes_at, done, score, secs, completed_at)
      VALUES (${who.userId}, ${day}, 1, '{}'::jsonb, (${day}::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '3 hours', true, ${score}, ${secs}, now())`;
    await expect(insert(9, 10, '2099-01-01')).rejects.toMatchObject({ constraint_name: 'chk_conexiones_runs_score' });
    await expect(insert(4, 10, '2099-01-02')).rejects.toMatchObject({ constraint_name: 'chk_conexiones_runs_score' });
    await expect(insert(5, -1, '2099-01-03')).rejects.toMatchObject({ constraint_name: 'chk_conexiones_runs_secs' });
    await insert(8, 0, '2099-01-04');
    await insert(0, 172800, '2099-01-05');
  });

  it('a won run is ranked with its score and seconds; a repeat is refused without a write', async () => {
    const svc = await service();
    const who = await member('win');
    let r = await svc.start(DAY, who);
    expect(r.state.tiles).toEqual([]);
    r = await svc.open(who, r.run.id, r.run.version);
    r = await svc.guess(who, r.run.id, r.run.version, MISSES[0]);
    const before = await row(r.run.id);
    await expect(svc.guess(who, r.run.id, r.run.version, [...MISSES[0]].reverse())).rejects.toThrow(/repeat/);
    expect((await row(r.run.id)).state_version).toBe(before.state_version);
    for (const g of [0, 1, 2, 3]) r = await svc.guess(who, r.run.id, r.run.version, group(g));
    expect(r.state).toMatchObject({ done: true, won: true, score: 7, ranked: true });
    expect(await row(r.run.id)).toMatchObject({ ranked: true, done: true, score: 7 });
    expect((await svc.leaderboard(DAY, who.userId)).me).toMatchObject({ rank: 1, score: 7 });
  });

  it('the board orders score, then fewer seconds, then the earlier finish; rankOf agrees', async () => {
    const svc = await service();
    const slow = await member('slow');
    await play(svc, slow, 1, true, 300);
    const fast = await member('fast');
    await play(svc, fast, 1, true, 60);
    const perfect = await member('perfect');
    await play(svc, perfect, 0, true, 900);
    const lost = await member('lost');
    await play(svc, lost, 4, false, 10);
    const sameAsFast = await member('later');
    await play(svc, sameAsFast, 1, true, 60);
    const top = (await svc.leaderboard(DAY, null)).top.map((e) => e.userId);
    expect(top).toEqual([perfect.userId, fast.userId, sameAsFast.userId, slow.userId, lost.userId]);
    for (const [i, who] of [perfect, fast, sameAsFast, slow, lost].entries()) {
      expect((await svc.leaderboard(DAY, who.userId)).me?.rank).toBe(i + 1);
    }
  });

  it('midnight: a run finished before the close keeps its rank; one still open goes on as practice', async () => {
    const svc = await service();
    const early = await member('early');
    await play(svc, early, 0, true, 30);
    const late = await member('late');
    let r = await svc.start(DAY, late);
    r = await svc.open(late, r.run.id, r.run.version);
    for (const g of [0, 1, 2]) r = await svc.guess(late, r.run.id, r.run.version, group(g));
    // The day closes (database clock) before the last guess lands.
    await db.sql`UPDATE conexiones_runs SET closes_at = clock_timestamp() - interval '1 second' WHERE day = ${DAY}`;
    await expect(svc.guess(late, r.run.id, r.run.version, group(3))).rejects.toThrow(/day_over/);
    expect(await row(r.run.id)).toMatchObject({ ranked: true, done: false });
    // The next day: the run reopens as practice and the last guess finishes it, off the board.
    const tomorrow = await service(new Date('2026-10-25T04:00:00Z'));
    r = await tomorrow.start(DAY, late);
    expect(r.state).toMatchObject({ ranked: false, done: false });
    r = await tomorrow.guess(late, r.run.id, r.run.version, group(3));
    expect(r.state).toMatchObject({ done: true, ranked: false });
    const board = await svc.leaderboard(DAY, null);
    expect(board.top.map((e) => e.userId)).toEqual([early.userId]);
  });

  it('a guest cannot play the live day', async () => {
    const svc = await service();
    const [g] = await db.sql<Array<{ id: string }>>`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`;
    await expect(svc.start(DAY, { kind: 'guest', guestId: g.id })).rejects.toThrow();
  });
});
