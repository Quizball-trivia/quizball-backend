import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the Dato falso migrations applied (an isolated local schema clone), e.g.
 *   DATO_FALSO_ROOM_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_dato_falso
 * Runs the daily service on the database clock against INVENTED cards. The calendar runs on a fixed app clock.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({
  get sql() { return db.sql; },
  withStatementTimeout: (run: (tx: unknown) => Promise<unknown>, ms = 30_000) =>
    db.sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL statement_timeout = ${Math.round(ms)}`); return run(tx); }),
}));

const url = process.env.DATO_FALSO_ROOM_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

// A run is thirty-odd transactions against a real database.
vi.setConfig({ testTimeout: 60_000 });

const L = (en: string) => ({ en, es: en, tr: en, ru: en, ka: en });
const CURVE = ['easy', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard', 'medium', 'hard'];
const DAY = '2026-10-19';
const NOW = new Date('2026-10-19T18:00:00Z');

describe.skipIf(!url)('Dato falso daily on real Postgres', () => {
  const fakes = Array.from({ length: 10 }, (_, i) => (i * 2) % 5);
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    const cards = fakes.map((fake, i) => ({
      id: `test-day-${i}`, category: 'clubs', difficulty: CURVE[i],
      player: { id: `test-day-player-${i}`, name: L(`Invented Player ${i}`), portrait: null },
      options: [0, 1, 2, 3, 4].map((o) => ({ label: L(`Club ${i}-${o}`), art: { kind: 'text' } })),
      fake, explain: L(`Invented reason ${i}.`),
    }));
    await db.sql`DELETE FROM dato_falso_runs`;
    await db.sql`INSERT INTO dato_falso_days (day, number, content_version, cards) VALUES (${DAY}, 8, 77, ${db.sql.json({ cards })})
      ON CONFLICT (day) DO UPDATE SET cards = EXCLUDED.cards, content_version = 77`;
  });
  afterAll(async () => {
    if (!db.sql) return;
    await db.sql`DELETE FROM dato_falso_runs`;
    await db.sql`DELETE FROM dato_falso_days WHERE day = ${DAY}`;
    await db.sql.end();
  });
  beforeEach(async () => { await db.sql`DELETE FROM dato_falso_runs`; });

  /** closesIn: how long before the run's day closes (the database clock), to stage a midnight. */
  async function service(closesInMs = 60 * 60 * 1000) {
    const { createDatoFalsoService, datoFalsoRepo, indexDay } = await import('../../src/modules/dato-falso/dato-falso.service.js');
    const { createDailyContentStore } = await import('../../src/modules/daily/daily.content.js');
    const store = createDailyContentStore(
      { fingerprint: () => datoFalsoRepo.daysFingerprint(), load: () => datoFalsoRepo.loadDays() }, indexDay,
      { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined }, label: 'test' },
    );
    return createDatoFalsoService({
      repo: { ...datoFalsoRepo, insertRun: (tx, data) => datoFalsoRepo.insertRun(tx, { ...data, closesAt: new Date(Date.now() + closesInMs) }) },
      content: () => store.get(), contentStale: () => store.invalidate(), now: () => NOW,
    });
  }
  const member = async (name: string) => {
    const [u] = await db.sql<Array<{ id: string }>>`INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`${name}-${randomUUID().slice(0, 6)}`}, false) RETURNING id`;
    return { kind: 'member' as const, userId: u.id };
  };
  /** Plays every card but the last; `right` decides each pick. */
  async function upToLast(svc: Awaited<ReturnType<typeof service>>, who: Awaited<ReturnType<typeof member>>, right: (i: number) => boolean) {
    let r = await svc.start(DAY, who);
    for (let i = 0; i < 9; i += 1) {
      r = await svc.next(who, r.run.id, r.run.version);
      r = await svc.pick(who, r.run.id, r.run.version, right(i) ? fakes[i] : (fakes[i] + 1) % 5);
    }
    return svc.next(who, r.run.id, r.run.version);
  }
  const row = async (id: string) => (await db.sql`SELECT ranked, done, score, rights, completed_at, state FROM dato_falso_runs WHERE id = ${id}`)[0];

  it('the score and right-answer bounds hold in the table', async () => {
    const who = await member('bounds');
    const insert = (score: number, rights: number, day: string) => db.sql`
      INSERT INTO dato_falso_runs (user_id, day, content_version, state, closes_at, done, score, rights, completed_at)
      VALUES (${who.userId}, ${day}, 1, '{}'::jsonb, (${day}::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '3 hours', true, ${score}, ${rights}, now())`;
    await expect(insert(12, 10, '2099-01-01')).rejects.toMatchObject({ constraint_name: 'chk_dato_falso_runs_score' });
    await expect(insert(-2, 0, '2099-01-02')).rejects.toMatchObject({ constraint_name: 'chk_dato_falso_runs_score' });
    await expect(insert(5, 11, '2099-01-03')).rejects.toMatchObject({ constraint_name: 'chk_dato_falso_runs_rights' });
    await insert(11, 10, '2099-01-04');
    await insert(-1, 0, '2099-01-05');
  });

  it('the settle sweep finishes a ranked run whose last card ran out with nobody there, at the clock instant', async () => {
    const svc = await service();
    const who = await member('away');
    const r = await upToLast(svc, who, () => true);
    expect(r.state.open).toBe(true);
    const dl = Date.now() - 5_000;
    await db.sql`UPDATE dato_falso_runs SET state = jsonb_set(state, '{dl}', to_jsonb(${dl}::float8)) WHERE id = ${r.run.id}`;
    expect(await svc.settleOverdue()).toBeGreaterThanOrEqual(1);
    const done = await row(r.run.id);
    expect(done).toMatchObject({ ranked: true, done: true, score: 9, rights: 9 });
    expect(Math.abs(done.completed_at.getTime() - (dl + 1_500))).toBeLessThan(1_000);
    expect((await svc.leaderboard(DAY, who.userId)).me).toMatchObject({ rank: 1, score: 9 });
  });

  it('a last card whose clock ran out after the day closed is not ranked', async () => {
    const svc = await service();
    const who = await member('midnight');
    const r = await upToLast(svc, who, () => true);
    // The day closed 3 s ago; the card's clock (with its 1.5 s grace) ran out 1 s ago: after the close.
    await db.sql`UPDATE dato_falso_runs SET closes_at = clock_timestamp() - interval '3 seconds',
      state = jsonb_set(state, '{dl}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::float8 - 2500)) WHERE id = ${r.run.id}`;
    // The sweep leaves it (a ranked settle after the close is not its to write); the player's next call records it as practice.
    await svc.settleOverdue();
    expect((await row(r.run.id)).ranked).toBe(true);
    await svc.start(DAY, who);
    const after = await row(r.run.id);
    expect(after).toMatchObject({ ranked: false, done: true });
  });

  it('the board orders points, then right answers, then the earlier finish', async () => {
    const svc = await service();
    const finish = async (name: string, right: (i: number) => boolean, doubleOn: number | null) => {
      const who = await member(name);
      let r = await svc.start(DAY, who);
      for (let i = 0; i < 10; i += 1) {
        r = await svc.next(who, r.run.id, r.run.version);
        if (i === doubleOn) r = await svc.joker(who, r.run.id, r.run.version, 'double');
        r = await svc.pick(who, r.run.id, r.run.version, right(i) ? fakes[i] : (fakes[i] + 1) % 5);
      }
      return who;
    };
    // a: 6 right with a doubled right = 7 points; b: 7 right = 7 points (more right: ahead); c: 7 points, 7 right, later.
    const a = await finish('a', (i) => i < 6, 0);
    const b = await finish('b', (i) => i < 7, null);
    const c = await finish('c', (i) => i < 7, null);
    const board = await svc.leaderboard(DAY, null);
    expect(board.top.map((e) => e.userId)).toEqual([b.userId, c.userId, a.userId]);
  });
});
