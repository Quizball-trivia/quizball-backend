import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { category, makeDay, nameOf, plainCategory } from './fixtures.js';

/**
 * Opt-in, real PostgreSQL: applies the Último migrations to a fresh schema (with the duel and lobby tables they
 * extend, in their pre-Último shape) and runs the repo, the service (on the database clock), the settling sweep and
 * both seeds against it. Needs an isolated local database:
 *   ULTIMO_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_ultimo_test_1
 * The service's calendar runs on a fixed app clock; answer clocks and day closes use the real database clock.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.ULTIMO_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_ultimo_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local ultimo test database required');

const MIGRATIONS = ['20260930120000_ultimo.sql', '20260930120001_ultimo_validate.sql'].map((f) => join(__dirname, '../../supabase/migrations', f));
const FIXTURE = `
  DROP TABLE IF EXISTS ultimo_runs, ultimo_days, duel_matches, duel_pool, lobbies, ranked_profiles, guest_sessions, users CASCADE;
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nickname text, avatar_url text, avatar_customization jsonb, country text,
    is_ai boolean NOT NULL DEFAULT false, is_guest boolean NOT NULL DEFAULT false, is_seed boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz, pending_deletion_at timestamptz
  );
  CREATE TABLE ranked_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), placement_status text, tier text);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, last_seen_at timestamptz NOT NULL DEFAULT now());
  -- The tables the migration extends, as they were before it.
  CREATE TABLE lobbies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_mode text, duel_game text,
    CONSTRAINT lobbies_duel_game_check CHECK ((game_mode IS DISTINCT FROM 'duel' AND duel_game IS NULL)
      OR (game_mode IS NOT DISTINCT FROM 'duel' AND duel_game IS NOT NULL AND duel_game IN ('buscaminas', 'pistas'))));
  CREATE TABLE duel_pool (game text NOT NULL, item_id text NOT NULL, difficulty text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (game, item_id),
    CONSTRAINT chk_duel_pool_game CHECK (game IN ('buscaminas', 'pistas')));
  CREATE TABLE duel_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game text NOT NULL,
    CONSTRAINT chk_duel_matches_game CHECK (game IN ('buscaminas', 'pistas')));
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  CREATE OR REPLACE FUNCTION public.trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
`;

const expectPgError = async (promise: Promise<unknown>, constraint: string) => {
  await expect(promise).rejects.toMatchObject({ constraint_name: constraint });
};

describe.skipIf(!url)('Último en pie on real Postgres', () => {
  // App clock: 2026-10-01 afternoon in Buenos Aires (the ranked day). The real database clock decides answer clocks and
  // closes: 2026-09-28 has long closed; 2026-10-01 closes 2026-10-02T03:00Z.
  const NOW = new Date('2026-10-01T18:00:00Z');
  const TODAY = '2026-10-01';
  const CLOSED_DAY = '2026-09-28';

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) {
      const body = readFileSync(file, 'utf8');
      await db.sql.begin((tx) => tx.unsafe(body));
    }
  });
  afterAll(async () => { await db.sql?.end(); });

  async function service() {
    const { createUltimoService } = await import('../../src/modules/ultimo/ultimo.service.js');
    const { ultimoRepo } = await import('../../src/modules/ultimo/ultimo.repo.js');
    const { createContentStore } = await import('../../src/modules/ultimo/ultimo.content.js');
    const store = createContentStore(
      { fingerprint: () => ultimoRepo.daysFingerprint(), load: () => ultimoRepo.loadDays() },
      { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined } },
    );
    return createUltimoService({ repo: ultimoRepo, content: () => store.get(), contentStale: () => store.invalidate(), now: () => NOW });
  }

  const member = async (name: string) => {
    const [u] = await db.sql<Array<{ id: string }>>`INSERT INTO users (nickname) VALUES (${name}) RETURNING id`;
    return { kind: 'member' as const, userId: u.id };
  };

  it('the migrations add Último to all three duel game checks, NULL-safe as before, and bound Último scores', async () => {
    await db.sql`INSERT INTO lobbies (game_mode, duel_game) VALUES ('duel', 'ultimo'), ('ranked_sim', NULL), (NULL, NULL)`;
    await expectPgError(db.sql`INSERT INTO lobbies (game_mode, duel_game) VALUES ('duel', NULL)`, 'lobbies_duel_game_check');
    await expectPgError(db.sql`INSERT INTO lobbies (game_mode, duel_game) VALUES ('ranked_sim', 'ultimo')`, 'lobbies_duel_game_check');
    await expectPgError(db.sql`INSERT INTO lobbies (game_mode, duel_game) VALUES ('duel', 'other')`, 'lobbies_duel_game_check');
    await db.sql`INSERT INTO duel_matches (game) VALUES ('ultimo')`;
    await expectPgError(db.sql`INSERT INTO duel_matches (game) VALUES ('other')`, 'chk_duel_matches_game');
    const [{ col }] = await db.sql`SELECT count(*)::int AS col FROM information_schema.columns WHERE table_name = 'duel_matches' AND column_name = 'paused_at'`;
    expect(col).toBe(1);
    const { userId } = await member('bounds');
    const insert = (score: number, answers: number, day: string) => db.sql`
      INSERT INTO ultimo_runs (user_id, day, content_version, state, closes_at, done, score, answers, completed_at)
      VALUES (${userId}, ${day}, 1, '{}'::jsonb, (${day}::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '3 hours', true, ${score}, ${answers}, now())`;
    await expectPgError(insert(326, 10, '2099-01-01'), 'chk_ultimo_runs_score');
    await expectPgError(insert(100, 301, '2099-01-02'), 'chk_ultimo_runs_answers');
    await insert(325, 300, '2099-01-03');
    await db.sql`DELETE FROM ultimo_runs`;
  });

  it('seeds refuse a day category that repeats a duel pool one, and the pool refuses a daily one, inside their locked writes', async () => {
    const { seedDays } = await import('../../src/modules/ultimo/ultimo.seed.js');
    const { parsePoolFile, writePool } = await import('../../src/modules/duel/duel.seed.js');
    const { contentHash } = await import('../../src/modules/ultimo/ultimo.seed.js');
    const days = [makeDay(0), makeDay(3)].map((d) => ({ ...d, contentVersion: contentHash(d.categories) }));
    // A pool item that is the same list as a day category under another id and title.
    const copy = { ...days[0].categories[2], id: 'pool-copy', title: { es: 'Otro título', en: 'Other', ka: 'სხვა', tr: 'Başka' } };
    const pool = parsePoolFile('ultimo', { game: 'ultimo', items: [copy] });
    await writePool(db.sql, 'ultimo', pool);
    await expect(seedDays(db.sql, days, { dryRun: false, allowCorrection: false, allowPoolOverlap: false })).rejects.toThrow(/repeat a duel pool category/);
    await db.sql`DELETE FROM duel_pool`;
    await seedDays(db.sql, days, { dryRun: false, allowCorrection: false, allowPoolOverlap: false });
    await expect(writePool(db.sql, 'ultimo', pool)).rejects.toThrow(/repeat a daily category/);
    const fresh = parsePoolFile('ultimo', { game: 'ultimo', items: [plainCategory('pool-new', 9)] });
    await writePool(db.sql, 'ultimo', fresh);
  });

  it('a ranked run on the database clock: begin, hits, a miss, a whole list, and a finish on the board', async () => {
    const { seedDays, contentHash } = await import('../../src/modules/ultimo/ultimo.seed.js');
    const cats = [category('t0'), plainCategory('t1', 8, 'medium'), plainCategory('t2', 8), plainCategory('t3', 8), plainCategory('t4', 8)];
    const today = makeDay(3, cats);
    await seedDays(db.sql, [{ ...today, contentVersion: contentHash(cats) }], { dryRun: false, allowCorrection: false, allowPoolOverlap: false });
    const svc = await service();
    const me = await member('runner');
    let r = await svc.start(TODAY, me);
    expect(r.state).toMatchObject({ ranked: true, title: null, open: false });
    r = await svc.begin(me, r.run.id, r.run.version);
    expect(r.state.title?.es).toBe(cats[0].title.es);
    const deadline = Date.parse(r.state.deadline!);
    expect(Math.abs(deadline - Date.now() - 23_500)).toBeLessThan(5_000);
    let a = await svc.answer(me, r.run.id, r.run.version, 'Martel');
    expect(a.result).toBe('ambiguous');
    a = await svc.answer(me, a.run.id, a.run.version, 'Emilio Varga');
    expect(a.result).toBe('ok');
    a = await svc.answer(me, a.run.id, a.run.version, 'Nadie');
    expect(a.result).toBe('wrong');
    expect(a.state.misses).toBe(1);
    for (const t of ['Nadie dos', 'Nadie tres']) a = await svc.answer(me, a.run.id, a.run.version, t);
    expect(a.state.settled).toMatchObject({ reason: 'misses', named: 1, missing: null });
    for (let c = 1; c < 5; c += 1) {
      a = await svc.next(me, a.run.id, a.run.version);
      a = await svc.begin(me, a.run.id, a.run.version);
      for (let i = 0; i < 8; i += 1) a = await svc.answer(me, a.run.id, a.run.version, nameOf(cats[c], i));
      expect(a.state.settled).toMatchObject({ reason: 'complete', named: 8 });
    }
    expect(a.state).toMatchObject({ done: true, score: 1 + 4 * (8 + 5), answers: 33, rank: 1 });
    const board = await svc.leaderboard(TODAY, me.userId);
    expect(board.top[0]).toMatchObject({ userId: me.userId, score: 53, answers: 33 });
    await expect(svc.answer(me, a.run.id, a.run.version, 'x')).rejects.toThrow();
  });

  it('an answer after the clock (past the grace) does not count and ends the category; /start writes an expiry down', async () => {
    const svc = await service();
    const me = await member('late');
    let r = await svc.start(TODAY, me);
    r = await svc.begin(me, r.run.id, r.run.version);
    await db.sql`UPDATE ultimo_runs SET state = jsonb_set(state, '{dl}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000 - 5000)::float8)) WHERE id = ${r.run.id}`;
    const late = await svc.answer(me, r.run.id, r.run.version, 'Emilio Varga');
    expect(late.result).toBe('late');
    expect(late.state.settled).toMatchObject({ reason: 'time', named: 0 });
    const other = await member('away');
    let o = await svc.start(TODAY, other);
    o = await svc.begin(other, o.run.id, o.run.version);
    await db.sql`UPDATE ultimo_runs SET state = jsonb_set(state, '{dl}', to_jsonb((extract(epoch FROM clock_timestamp()) * 1000 - 5000)::float8)) WHERE id = ${o.run.id}`;
    const back = await svc.start(TODAY, other);
    expect(back.run.version).toBe(o.run.version + 1);
    const [row] = await db.sql`SELECT state->>'end' AS end FROM ultimo_runs WHERE id = ${o.run.id}`;
    expect(row.end).toBe('time');
  });

  it('the settling sweep finishes an abandoned last category, even after midnight when its clock ran out before it', async () => {
    const svc = await service();
    const { newState } = await import('../../src/modules/ultimo/ultimo.rules.js');
    const { userId } = await member('sweep');
    const { userId: lateUser } = await member('sweep-late');
    // A day the database clock closed (Buenos Aires midnight 2026-09-29T03:00Z), seeded by the seed test.
    const [day] = await db.sql<Array<{ content_version: string }>>`SELECT content_version FROM ultimo_days WHERE day = ${CLOSED_DAY}`;
    const closes = new Date('2026-09-29T03:00:00Z');
    const four = [0, 1, 2, 3].map(() => ({ named: 2, complete: false, reason: 'time' }));
    const state = (dl: number) => ({ ...newState(), c: 4, open: true, said: [0, 1, 2], dl, res: four });
    const insert = (user: string, dl: number) => db.sql`
      INSERT INTO ultimo_runs (user_id, day, ranked, content_version, state, closes_at)
      VALUES (${user}, ${CLOSED_DAY}, true, ${Number(day.content_version)}, ${db.sql.json(state(dl) as never)}, ${closes}) RETURNING id`;
    const [inTime] = await insert(userId, closes.getTime() - 10_000);
    const [afterClose] = await insert(lateUser, closes.getTime() + 10_000);
    expect(await svc.settleOverdue()).toBeGreaterThanOrEqual(2);
    const rows = await db.sql`SELECT id, done, score, answers FROM ultimo_runs WHERE id IN (${inTime.id}, ${afterClose.id})`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(inTime.id)).toMatchObject({ done: true, score: 8 + 3, answers: 11 });
    expect(byId.get(afterClose.id)).toMatchObject({ done: false });
  });

  it('guests play closed days only; a guest run of a closed day discloses what nobody said', async () => {
    const { seedDays, contentHash } = await import('../../src/modules/ultimo/ultimo.seed.js');
    const past = makeDay(0);
    await seedDays(db.sql, [{ ...past, contentVersion: contentHash(past.categories) }], { dryRun: false, allowCorrection: true, allowPoolOverlap: false });
    const svc = await service();
    const [g] = await db.sql<Array<{ id: string }>>`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`;
    const guest = { kind: 'guest' as const, guestId: g.id };
    await expect(svc.start(TODAY, guest)).rejects.toMatchObject({ statusCode: 403 });
    let r = await svc.start(CLOSED_DAY, guest);
    expect(r.state.ranked).toBe(false);
    r = await svc.begin(guest, r.run.id, r.run.version);
    for (const t of ['Nadie', 'Nadie dos', 'Nadie tres']) r = await svc.answer(guest, r.run.id, r.run.version, t);
    expect(r.state.settled?.missing).toHaveLength(past.categories[0].answers.length);
  });
});
