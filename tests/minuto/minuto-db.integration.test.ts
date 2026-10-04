import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { calendar, goalIdOf, makeDay, minuteOf, rawGoal } from './fixtures.js';
import { PUBLISHED_DAYS } from '../../src/modules/minuto/minuto.days.js';

/**
 * Opt-in, real PostgreSQL: applies the Minuto migration to a fresh schema and runs the seed, the repo and the service
 * against it. Needs an isolated local database:
 *   MINUTO_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_minuto_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.MINUTO_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_minuto_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local minuto test database required');

const MIGRATIONS = ['20261003120000_minuto.sql', '20261003120001_minuto_validate.sql', '20261003120002_minuto_swap_checks.sql']
  .map((f) => join(__dirname, '../../supabase/migrations', f));
const FIXTURE = `
  DROP TABLE IF EXISTS minuto_runs, minuto_days, minuto_content_ledger, duel_matches, duel_pool, lobbies, ranked_profiles, guest_sessions, users CASCADE;
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nickname text, avatar_url text, avatar_customization jsonb, country text,
    is_ai boolean NOT NULL DEFAULT false, is_guest boolean NOT NULL DEFAULT false, is_seed boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz, pending_deletion_at timestamptz
  );
  CREATE TABLE ranked_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), placement_status text, tier text);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, last_seen_at timestamptz NOT NULL DEFAULT now());
  -- The duel tables as they stand before this migration (the three game checks without 'minuto').
  CREATE TABLE lobbies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_mode text, duel_game text,
    CONSTRAINT lobbies_duel_game_check CHECK ((game_mode IS DISTINCT FROM 'duel' AND duel_game IS NULL)
      OR (game_mode IS NOT DISTINCT FROM 'duel' AND duel_game IS NOT NULL AND duel_game IN ('buscaminas', 'pistas', 'ultimo'))));
  CREATE TABLE duel_pool (game text NOT NULL, item_id text NOT NULL, difficulty text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game, item_id), CONSTRAINT chk_duel_pool_game CHECK (game IN ('buscaminas', 'pistas', 'ultimo')));
  CREATE TABLE duel_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game text NOT NULL, paused_at timestamptz,
    CONSTRAINT chk_duel_matches_game CHECK (game IN ('buscaminas', 'pistas', 'ultimo')));
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  CREATE OR REPLACE FUNCTION public.trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
`;

describe.skipIf(!url)('minuto on real Postgres', () => {
  const NOW = new Date('2026-10-03T15:00:00Z');
  // Closed by the real database clock long ago.
  const PAST = '2026-10-01';
  const value = (r: number) => minuteOf(r).base + minuteOf(r).added;

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
    // The first migration is safe to re-run.
    await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATIONS[0], 'utf8')));
  });
  afterAll(async () => { await db.sql?.end(); });

  const user = async (nickname: string) => (await db.sql`INSERT INTO users (nickname) VALUES (${nickname}) RETURNING id`)[0].id as string;
  const guestSession = async () => (await db.sql`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`)[0].id as string;

  it('migration: server-only tables, run constraints, and the duel checks now allow minuto under their old names', async () => {
    const rls = await db.sql`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('minuto_days', 'minuto_runs', 'minuto_content_ledger') ORDER BY relname`;
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    const [grants] = await db.sql`SELECT has_table_privilege('anon', 'public.minuto_days', 'SELECT') AS a, has_table_privilege('authenticated', 'public.minuto_runs', 'SELECT') AS b`;
    expect(grants).toEqual({ a: false, b: false });
    const g = await guestSession();
    await expect(db.sql`INSERT INTO minuto_runs (guest_id, day, content_version, state, closes_at, done, score, exact, completed_at)
      VALUES (${g}, ${PAST}, 1, '{}', '2026-10-02T03:00:00Z', true, 31, 0, now())`).rejects.toMatchObject({ constraint_name: 'chk_minuto_runs_score' });
    await db.sql`INSERT INTO duel_pool (game, item_id, difficulty, fingerprint, payload) VALUES ('minuto', 'x', 'easy', 'f', '{}')`;
    await db.sql`INSERT INTO lobbies (game_mode, duel_game) VALUES ('duel', 'minuto')`;
    await expect(db.sql`INSERT INTO lobbies (game_mode, duel_game) VALUES ('duel', 'chess')`).rejects.toMatchObject({ constraint_name: 'lobbies_duel_game_check' });
    await db.sql`DELETE FROM duel_pool`;
    await db.sql`DELETE FROM lobbies`;
  });

  describe('seed, repo and service', () => {
    beforeEach(async () => {
      await db.sql`DELETE FROM minuto_runs`;
      await db.sql`DELETE FROM minuto_days`;
      await db.sql`DELETE FROM minuto_content_ledger`;
      await db.sql`DELETE FROM duel_pool`;
    });

    const seed = async (days = calendar(), opts: { dryRun?: boolean; allowCorrection?: boolean } = {}) => {
      const { seedDays } = await import('../../src/modules/minuto/minuto.seed.js');
      return seedDays(db.sql, days, { dryRun: opts.dryRun ?? false, allowCorrection: opts.allowCorrection ?? false, allowPoolOverlap: false });
    };

    async function service() {
      const { minutoRepo } = await import('../../src/modules/minuto/minuto.repo.js');
      const { createContentStore } = await import('../../src/modules/minuto/minuto.content.js');
      const { createMinutoService } = await import('../../src/modules/minuto/minuto.service.js');
      const store = createContentStore(
        { fingerprint: () => minutoRepo.daysFingerprint(), load: () => minutoRepo.loadDays() },
        { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined } },
      );
      return { repo: minutoRepo, svc: createMinutoService({ repo: minutoRepo, content: () => store.get(), contentStale: () => store.invalidate(), now: () => NOW }) };
    }

    it('seeds the calendar once (a re-run changes nothing) and records every goal in the ledger', async () => {
      const dry = await seed(calendar(), { dryRun: true });
      expect(dry.entries.filter((e) => e.status === 'new')).toHaveLength(PUBLISHED_DAYS);
      expect(await db.sql`SELECT 1 FROM minuto_days`).toHaveLength(0);
      await seed();
      expect((await db.sql`SELECT count(*)::int AS n FROM minuto_days`)[0].n).toBe(PUBLISHED_DAYS);
      expect((await db.sql`SELECT count(*)::int AS n FROM minuto_content_ledger WHERE side = 'day'`)[0].n).toBe(PUBLISHED_DAYS * 10);
      expect((await seed()).entries.every((e) => e.status === 'unchanged')).toBe(true);
      expect((await db.sql`SELECT count(*)::int AS n FROM minuto_content_ledger`)[0].n).toBe(PUBLISHED_DAYS * 10);
    });

    it('a guest plays a closed day: no minute before the guess, the real minute with the result, the whole day in the review', async () => {
      await seed();
      const { svc } = await service();
      const ga = { kind: 'guest' as const, guestId: await guestSession() };
      await expect(svc.start('2026-10-03', ga)).rejects.toMatchObject({ statusCode: 403, code: 'sign_in_for_today' });
      let cur = await svc.start(PAST, ga, makeDay(PAST).contentVersion);
      expect(JSON.stringify(cur.state)).not.toMatch(/"minute"|"answer"/);
      cur = await svc.guess(ga, cur.run.id, cur.run.version, value(0) + 1);
      expect(cur.state.settled).toMatchObject({ guess: value(0) + 1, answer: minuteOf(0), points: 2 });
      await expect(svc.guess(ga, cur.run.id, cur.run.version, 5)).rejects.toMatchObject({ statusCode: 400 });
      cur = await svc.next(ga, cur.run.id, cur.run.version);
      expect(cur.state).toMatchObject({ round: 1, settled: null, goal: { id: goalIdOf(PAST, 1) } });
      const review = await svc.review(PAST);
      expect(review.goals.map((g) => g.minute)).toEqual(Array.from({ length: 10 }, (_, r) => minuteOf(r)));
    });

    it('ranks equal scores by exact minutes before the finish time', async () => {
      await seed();
      const { repo } = await service();
      const run = async (nickname: string, score: number, exact: number, finishedAt: string) => {
        const id = await user(nickname);
        await db.sql`INSERT INTO minuto_runs (user_id, day, ranked, content_version, state, closes_at, done, score, exact, completed_at)
          VALUES (${id}, ${PAST}, true, 1, '{}', '2026-10-02T03:00:00Z', true, ${score}, ${exact}, ${finishedAt})`;
        return id;
      };
      const early = await run('early', 20, 2, '2026-10-01T10:00:00Z');
      const exact = await run('exact', 20, 5, '2026-10-01T11:00:00Z');
      const best = await run('best', 24, 1, '2026-10-01T12:00:00Z');
      const board = await repo.leaderboard(PAST, 10);
      expect(board.top.map((e) => e.userId)).toEqual([best, exact, early]);
      expect((await repo.rankOf(exact, PAST))?.rank).toBe(2);
      expect((await repo.rankOf(early, PAST))?.rank).toBe(3);
    });

    it('a pool goal can never be a daily goal: either seed refuses the other side, by id or by fingerprint', async () => {
      await seed();
      const { parsePoolFile, findDailyOverlap, writePool } = await import('../../src/modules/duel/duel.seed.js');
      const clash = { ...rawGoal('2099-01-01', 0), id: 'g20990101-0000000000', fingerprint: makeDay(PAST).goals[3].fingerprint };
      const rows = parsePoolFile('minuto', { game: 'minuto', items: [rawGoal('2099-01-01', 1), clash] });
      expect((await findDailyOverlap(db.sql, 'minuto', rows)).overlapping).toEqual([1]);
      await expect(writePool(db.sql, 'minuto', rows)).rejects.toThrow(/1 pool goal\(s\) are on a daily day/);
      await writePool(db.sql, 'minuto', rows.slice(0, 1));
      // And the other way: a day repeating that pool goal is refused.
      const days = calendar();
      days[10] = { ...days[10], goals: [{ ...days[10].goals[0], id: rows[0].itemId }, ...days[10].goals.slice(1)] };
      await expect(seed(days)).rejects.toThrow(/daily goal\(s\) are in the duel pool/);
      // The same goal under another id cannot enter the pool twice (it could be dealt twice and answer itself).
      const twin = parsePoolFile('minuto', { game: 'minuto', items: [{ ...rawGoal('2099-01-01', 1), id: 'g20990101-1111111111' }] });
      await expect(writePool(db.sql, 'minuto', twin)).rejects.toThrow(/already in the pool under another id/);
    });

    it('a correction may not move a goal another day already published (its minute is in that day\'s review)', async () => {
      await seed();
      const days = calendar();
      const moved = days[3].goals[0];
      days[3] = { ...days[3], goals: [{ ...days[3].goals[0], id: 'g20261002-2222222222', fingerprint: 'abababababababab' }, ...days[3].goals.slice(1)] };
      days[20] = { ...days[20], goals: [moved, ...days[20].goals.slice(1)] };
      await expect(seed(days, { allowCorrection: true })).rejects.toThrow(/already published on another day/);
      // Re-seeding the original calendar is still fine.
      expect((await seed()).entries.every((e) => e.status === 'unchanged')).toBe(true);
    });
  });
});
