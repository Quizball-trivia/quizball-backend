import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { calendar, makeDay, okCards } from './fixtures.js';
import { addDays } from '../../src/modules/buscaminas/buscaminas.days.js';

/**
 * Opt-in, real PostgreSQL: applies BOTH Buscaminas migrations in order to a fresh schema (the prod
 * path, with a pre-existing member run as on staging) and runs the repo, the service and the seed
 * against it. Needs an isolated local database:
 *   BUSCAMINAS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_buscaminas_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.BUSCAMINAS_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_buscaminas_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local buscaminas test database required');

const MIGRATIONS = join(__dirname, '../../supabase/migrations');
const FIXTURE = `
  DROP TABLE IF EXISTS buscaminas_runs, buscaminas_days, ranked_profiles, guest_sessions, users CASCADE;
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nickname text, avatar_url text, avatar_customization jsonb, country text,
    is_ai boolean NOT NULL DEFAULT false, is_guest boolean NOT NULL DEFAULT false, is_seed boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz, pending_deletion_at timestamptz
  );
  CREATE TABLE ranked_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), placement_status text, tier text);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, last_seen_at timestamptz NOT NULL DEFAULT now());
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
  CREATE OR REPLACE FUNCTION public.trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
`;
const LEGACY_STATE = { v: 1, rid: 'x', d: '2026-09-26', cv: 1, u: null, r: 0, p: [], m: null, s: null, res: [], done: false, sv: 0 };

describe.skipIf(!url)('buscaminas on real Postgres', () => {
  const NOW = new Date('2026-10-05T15:00:00Z');
  const PAST = '2026-10-04';
  const LIVE = '2026-10-05';
  let legacyRunId = '';

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql.unsafe(FIXTURE);
    await db.sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, '20260926140000_buscaminas_runs.sql'), 'utf8')));
    // What staging holds before the new migration: a member's ranked run in the token design.
    const [u] = await db.sql`INSERT INTO users (nickname) VALUES ('legacy') RETURNING id`;
    [{ id: legacyRunId }] = await db.sql`INSERT INTO buscaminas_runs (user_id, day, content_version, state) VALUES (${u.id}, '2026-09-26', 1, ${db.sql.json(LEGACY_STATE)}) RETURNING id`;
    await db.sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, '20260928120000_buscaminas_days_and_guest_runs.sql'), 'utf8')));
  });
  afterAll(async () => { await db.sql?.end(); });

  const user = async (nickname: string, extra: { is_guest?: boolean } = {}) =>
    (await db.sql`INSERT INTO users (nickname, is_guest) VALUES (${nickname}, ${extra.is_guest ?? false}) RETURNING id`)[0].id as string;
  const guestSession = async () => (await db.sql`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`)[0].id as string;
  const expectPgError = (p: Promise<unknown>, constraint: string) => expect(p).rejects.toMatchObject({ constraint_name: constraint });

  describe('migration', () => {
    it('keeps the staging member runs as ranked; new runs default to unranked', async () => {
      const [legacy] = await db.sql`SELECT ranked, guest_id FROM buscaminas_runs WHERE id = ${legacyRunId}`;
      expect(legacy).toEqual({ ranked: true, guest_id: null });
      const [{ column_default: rankedDefault }] = await db.sql`
        SELECT column_default FROM information_schema.columns WHERE table_name = 'buscaminas_runs' AND column_name = 'ranked'`;
      expect(rankedDefault).toBe('false');
      const [{ relrowsecurity }] = await db.sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'buscaminas_days'`;
      expect(relrowsecurity).toBe(true);
      const [grants] = await db.sql`
        SELECT has_table_privilege('anon', 'public.buscaminas_days', 'SELECT') AS anon, has_table_privilege('authenticated', 'public.buscaminas_days', 'SELECT') AS authenticated`;
      expect(grants).toEqual({ anon: false, authenticated: false });
    });

    it('a run has exactly one owner, only members are ranked, one run per player per day', async () => {
      const u = await user('owner-check');
      const g = await guestSession();
      const insert = (userId: string | null, guestId: string | null, ranked = false, day = '2026-09-30') =>
        db.sql`INSERT INTO buscaminas_runs (user_id, guest_id, day, ranked, content_version, state) VALUES (${userId}, ${guestId}, ${day}, ${ranked}, 1, '{}')`;
      await expectPgError(insert(null, null), 'chk_buscaminas_runs_owner');
      await expectPgError(insert(u, g), 'chk_buscaminas_runs_owner');
      await expectPgError(insert(null, g, true), 'chk_buscaminas_runs_ranked_member');
      await insert(null, g);
      await expectPgError(insert(null, g), 'uq_buscaminas_runs_guest_day');
      await insert(u, null, true);
      await expectPgError(insert(u, null), 'uq_buscaminas_runs_user_day');
      // Different guests and different days are independent.
      await insert(null, await guestSession());
      await insert(null, g, false, '2026-09-29');
    });

    it('guest runs go with their guest session', async () => {
      const g = await guestSession();
      await db.sql`INSERT INTO buscaminas_runs (guest_id, day, content_version, state) VALUES (${g}, '2026-09-27', 1, '{}')`;
      await db.sql`DELETE FROM guest_sessions WHERE id = ${g}`;
      expect(await db.sql`SELECT 1 FROM buscaminas_runs WHERE guest_id = ${g}`).toHaveLength(0);
    });

    it('buscaminas_days rejects rows without the basic shape', async () => {
      const insert = (number: number, cv: number, board: unknown, answers: unknown) =>
        db.sql`INSERT INTO buscaminas_days (day, number, content_version, board, answers) VALUES ('2030-01-01', ${number}, ${cv}, ${db.sql.json(board as never)}, ${db.sql.json(answers as never)})`;
      await expectPgError(insert(0, 1, { rounds: [] }, {}), 'chk_buscaminas_days_number');
      await expectPgError(insert(1, 0, { rounds: [] }, {}), 'chk_buscaminas_days_content_version');
      await expectPgError(insert(1, 1, { rounds: {} }, {}), 'chk_buscaminas_days_board');
      await expectPgError(insert(1, 1, { rounds: [] }, []), 'chk_buscaminas_days_answers');
    });
  });

  describe('seed, repo and service', () => {
    beforeEach(async () => {
      await db.sql`DELETE FROM buscaminas_runs WHERE id <> ${legacyRunId}`;
      await db.sql`DELETE FROM buscaminas_days`;
    });

    const seed = async (days = calendar(), opts: { dryRun?: boolean; allowCorrection?: boolean } = {}) => {
      const { seedDays, toDayRow } = await import('../../src/modules/buscaminas/buscaminas.seed.js');
      return seedDays(db.sql, days.map(toDayRow), { dryRun: opts.dryRun ?? false, allowCorrection: opts.allowCorrection ?? false });
    };

    async function service() {
      const { buscaminasRepo } = await import('../../src/modules/buscaminas/buscaminas.repo.js');
      const { createContentStore } = await import('../../src/modules/buscaminas/buscaminas.content.js');
      const { createBuscaminasService } = await import('../../src/modules/buscaminas/buscaminas.service.js');
      const store = createContentStore(
        { fingerprint: () => buscaminasRepo.daysFingerprint(), load: () => buscaminasRepo.loadDays() },
        { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined } },
      );
      const svc = createBuscaminasService({ repo: buscaminasRepo, content: () => store.get(), contentStale: () => store.invalidate(), now: () => NOW });
      return { store, repo: buscaminasRepo, svc };
    }

    it('seeds the calendar in one transaction: dry run writes nothing, a re-run changes nothing', async () => {
      const dry = await seed(calendar(), { dryRun: true });
      expect(dry.entries.filter((e) => e.status === 'new')).toHaveLength(90);
      expect(await db.sql`SELECT 1 FROM buscaminas_days`).toHaveLength(0);
      await seed();
      const [{ count, answers }] = await db.sql`SELECT count(*)::int AS count, (SELECT answers -> 'r0' FROM buscaminas_days WHERE day = ${PAST}) AS answers FROM buscaminas_days`;
      expect(count).toBe(90);
      expect(answers).toEqual(okCards(0));
      const again = await seed();
      expect(again.entries.every((e) => e.status === 'unchanged')).toBe(true);
    });

    it('appends days to the stored calendar: the next day alone is accepted, a hole is refused', async () => {
      await seed();
      const plan = await seed([makeDay('2026-12-25')]);
      expect(plan.entries).toMatchObject([{ day: '2026-12-25', number: 91, status: 'new' }]);
      expect(plan.extraDays).toHaveLength(90);
      expect((await db.sql`SELECT count(*)::int AS n FROM buscaminas_days`)[0].n).toBe(91);
      const { store } = await service();
      expect([...(await store.get()).keys()].sort().at(-1)).toBe('2026-12-25');
      await expect(seed([makeDay('2026-12-27')])).rejects.toThrow(/2026-12-26 is missing/);
      expect((await db.sql`SELECT count(*)::int AS n FROM buscaminas_days`)[0].n).toBe(91);
      await db.sql`DELETE FROM buscaminas_days`;
      await expect(seed([makeDay('2026-12-25')])).rejects.toThrow(/must start at 2026-09-26/);
    });

    it('a daily round may not use a duel pool category, and the pool may not take a daily one (each checked inside its write)', async () => {
      await db.sql`CREATE TABLE IF NOT EXISTS duel_pool (game text NOT NULL, item_id text NOT NULL, difficulty text NOT NULL,
        fingerprint text NOT NULL, payload jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (game, item_id))`;
      try {
        const { parsePoolFile, writePool } = await import('../../src/modules/duel/duel.seed.js');
        const poolRound = (es: string) => ({
          id: `pool-${es.replace(/\W/g, '')}`, difficulty: 'easy',
          prompt: { es, en: es, ka: es, tr: es },
          cards: Array.from({ length: 16 }, (_, c) => ({ id: `p${c}`, name: `Pool ${c}`, img: `/buscaminas/v1/p/p${c}.webp` })),
          ok: Array.from({ length: 12 }, (_, c) => `p${c}`),
        });
        await seed(calendar().slice(0, 3));
        // A daily category cannot enter the pool…
        await expect(writePool(db.sql, 'buscaminas', parsePoolFile('buscaminas', { game: 'buscaminas', items: [poolRound('Pista 3')] })))
          .rejects.toThrow(/share a player or category with a daily/);
        await writePool(db.sql, 'buscaminas', parsePoolFile('buscaminas', { game: 'buscaminas', items: [poolRound('Solo duelos')] }));
        // …and a pool category cannot become a daily round (the next day is refused whole, nothing written).
        const next = makeDay(addDays(calendar()[2].day, 1));
        next.rounds[4] = { ...next.rounds[4], prompt: { ...next.rounds[4].prompt, es: 'solo  DUELOS' } };
        await expect(seed([next])).rejects.toThrow(/1 daily round\(s\) use a duel pool category/);
        expect((await db.sql`SELECT count(*)::int AS n FROM buscaminas_days`)[0].n).toBe(3);
        const { seedDays, toDayRow } = await import('../../src/modules/buscaminas/buscaminas.seed.js');
        await seedDays(db.sql, [toDayRow(next)], { dryRun: false, allowCorrection: false, allowPoolOverlap: true });
        expect((await db.sql`SELECT count(*)::int AS n FROM buscaminas_days`)[0].n).toBe(4);
        // That day, re-supplied unchanged beside a new one, is not re-judged; the new day is still checked.
        const after = makeDay(addDays(next.day, 1));
        expect((await seed([next, after])).entries.map((e) => e.status)).toEqual(['unchanged', 'new']);
        // A disabled pool item still counts: its packs were already dealt.
        await db.sql`UPDATE duel_pool SET enabled = false`;
        const later = makeDay(addDays(after.day, 1));
        later.rounds[0] = { ...later.rounds[0], prompt: { ...later.rounds[0].prompt, es: 'Solo duelos' } };
        await expect(seed([later])).rejects.toThrow(/use a duel pool category/);
      } finally {
        await db.sql`DROP TABLE IF EXISTS duel_pool`;
      }
    });

    it('refuses to change a played day\'s answers without --allow-correction; a correction reloads the served content', async () => {
      await seed();
      const { svc, store } = await service();
      const g = await guestSession();
      await svc.start(PAST, { kind: 'guest', guestId: g });
      const before = (await store.get()).get(PAST)!.contentVersion;
      const corrected = calendar().map((d) => (d.day === PAST ? makeDay(PAST, 1) : d));
      await expect(seed(corrected)).rejects.toThrow(/2026-10-04 \(1 runs\): answers changed/);
      expect((await store.get()).get(PAST)!.contentVersion).toBe(before);
      const plan = await seed(corrected, { allowCorrection: true });
      expect(plan.entries.find((e) => e.day === PAST)).toMatchObject({ status: 'changed', answersChanged: true, runs: 1 });
      expect((await store.get()).get(PAST)!.contentVersion).toBe(makeDay(PAST, 1).contentVersion);
    });

    it('a guest plays a past day on real rows; the live day, other players and old versions are refused', async () => {
      await seed();
      const { svc } = await service();
      const ga = { kind: 'guest' as const, guestId: await guestSession() };
      const gb = { kind: 'guest' as const, guestId: await guestSession() };
      await expect(svc.start(LIVE, ga)).rejects.toMatchObject({ statusCode: 403, code: 'sign_in_for_today' });
      const run = await svc.start(PAST, ga, makeDay(PAST).contentVersion);
      expect((await svc.start(PAST, ga)).run).toEqual(run.run);
      const hit = await svc.tap(ga, run.run.id, 0, 'r0c0');
      expect(hit).toMatchObject({ ok: true, run: { version: 1 } });
      await expect(svc.tap(ga, run.run.id, 0, 'r0c1')).rejects.toMatchObject({ statusCode: 409, code: 'stale_state' });
      await expect(svc.tap(gb, run.run.id, 1, 'r0c1')).rejects.toMatchObject({ statusCode: 403, message: 'run_not_yours' });
      const banked = await svc.bank(ga, run.run.id, 1);
      expect(banked.state.settled).toMatchObject({ outcome: 'banked', found: 1, reveal: { ok: okCards(0) } });
      const next = await svc.next(ga, run.run.id, 2);
      expect(next.state).toMatchObject({ round: 1, score: 1, ranked: false });
      const [row] = await db.sql`SELECT user_id, guest_id, ranked, state_version, state FROM buscaminas_runs WHERE id = ${run.run.id}`;
      expect(row).toMatchObject({ user_id: null, guest_id: ga.guestId, ranked: false, state_version: 3 });
      expect(Object.keys(row.state).sort()).toEqual(['done', 'm', 'p', 'r', 'res', 's', 'v']);
      expect(await svc.current(ga, PAST)).toEqual(next);
      expect(await svc.current(gb, PAST)).toEqual({ run: null });
    });

    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { open, opened };
    };
    const settledWithin = async (p: Promise<unknown>, ms: number) => {
      let settled = false;
      p.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, ms));
      return settled;
    };

    it('a move waits for an in-flight correction of its day, then is content_changed instead of scored on the old answers', async () => {
      await seed();
      const { svc } = await service();
      const ga = { kind: 'guest' as const, guestId: await guestSession() };
      const run = await svc.start(PAST, ga);
      const corrected = (await import('../../src/modules/buscaminas/buscaminas.seed.js')).toDayRow(makeDay(PAST, 1));
      const locked = gate();
      const commit = gate();
      // What the seed does for a correction: FOR UPDATE on the day, then the new answers, then commit.
      const correction = db.sql.begin(async (tx) => {
        await tx`SELECT day FROM buscaminas_days WHERE day = ${PAST} FOR UPDATE`;
        await tx`UPDATE buscaminas_days SET content_version = ${corrected.contentVersion}, answers = ${tx.json(corrected.answers as never)} WHERE day = ${PAST}`;
        locked.open();
        await commit.opened;
      });
      await locked.opened;
      // r0c15 is a mine in the served (old) answers and fits the corrected ones.
      const tap = svc.tap(ga, run.run.id, 0, 'r0c15');
      expect(await settledWithin(tap, 250)).toBe(false);
      commit.open();
      await correction;
      await expect(tap).rejects.toMatchObject({ statusCode: 409, code: 'content_changed' });
      const [row] = await db.sql`SELECT state_version, content_version FROM buscaminas_runs WHERE id = ${run.run.id}`;
      expect(row).toEqual({ state_version: 0, content_version: String(makeDay(PAST).contentVersion) });
    });

    it('a correction waits for an in-flight start on its day, then counts that run and refuses without --allow-correction', async () => {
      await seed();
      const { repo } = await service();
      const g = await guestSession();
      const started = gate();
      const commit = gate();
      const start = repo.withTx(async (tx) => {
        await repo.lockDay(tx, PAST);
        await repo.insertRun(tx, {
          id: randomUUID(), player: { kind: 'guest', guestId: g }, day: PAST, ranked: false, contentVersion: makeDay(PAST).contentVersion,
          state: { v: 1, r: 0, p: [], m: null, s: null, res: [], done: false },
        });
        started.open();
        await commit.opened;
      });
      await started.opened;
      const seeding = seed(calendar().map((d) => (d.day === PAST ? makeDay(PAST, 1) : d)));
      expect(await settledWithin(seeding, 250)).toBe(false);
      commit.open();
      await start;
      await expect(seeding).rejects.toThrow(/2026-10-04 \(1 runs\): answers changed/);
      const [day] = await db.sql`SELECT content_version FROM buscaminas_days WHERE day = ${PAST}`;
      expect(Number(day.content_version)).toBe(makeDay(PAST).contentVersion);
    });

    it('the ranked cutoff is the database clock; unranked rows never close', async () => {
      await db.sql`INSERT INTO buscaminas_days (day, number, content_version, board, answers) VALUES (${LIVE}, 10, 1, '{"rounds": []}', '{}'), (${PAST}, 9, 1, '{"rounds": []}', '{}')`;
      const { repo } = await service();
      const u = await user('cutoff');
      const g = await guestSession();
      const state = { v: 1 as const, r: 0, p: [], m: null, s: null, res: [], done: false };
      const ranked = await repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player: { kind: 'member', userId: u }, day: LIVE, ranked: true, contentVersion: 1, state }));
      const practice = await repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player: { kind: 'guest', guestId: g }, day: PAST, ranked: false, contentVersion: 1, state }));
      const save = (id: string, closesAt: Date) => repo.withTx((tx) => repo.saveState(tx, id, { state: { ...state, p: ['a'] }, stateVersion: 1, contentVersion: 1, completion: null, closesAt }));
      const closed = new Date(Date.now() - 60_000);
      expect(await save(ranked!.id, closed)).toBeNull();
      expect(await save(ranked!.id, new Date(Date.now() + 3_600_000))).toMatchObject({ state_version: 1, ranked: true });
      expect(await save(practice!.id, closed)).toMatchObject({ state_version: 1 });
      // Once closed, the unfinished ranked run becomes practice; while open it stays ranked.
      expect(await repo.withTx((tx) => repo.unrankClosedRun(tx, ranked!.id, new Date(Date.now() + 3_600_000)))).toBeNull();
      expect(await repo.withTx((tx) => repo.unrankClosedRun(tx, ranked!.id, closed))).toMatchObject({ ranked: false });
    });

    it('a run write needs the day\'s stored content version to be the run\'s', async () => {
      await db.sql`INSERT INTO buscaminas_days (day, number, content_version, board, answers) VALUES (${PAST}, 9, 1, '{"rounds": []}', '{}')`;
      const { repo } = await service();
      const g = await guestSession();
      const state = { v: 1 as const, r: 0, p: [], m: null, s: null, res: [], done: false };
      const run = await repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player: { kind: 'guest', guestId: g }, day: PAST, ranked: false, contentVersion: 1, state }));
      const save = (contentVersion: number) => repo.withTx((tx) => repo.saveState(tx, run!.id, { state, stateVersion: 1, contentVersion, completion: null, closesAt: new Date(Date.now() + 3_600_000) }));
      await db.sql`UPDATE buscaminas_days SET content_version = 2 WHERE day = ${PAST}`;
      expect(await save(1)).toBeNull();
      expect(await repo.withTx((tx) => repo.dayVersion(tx, PAST))).toBe(2);
      expect(await save(2)).toMatchObject({ content_version: 2, state_version: 1 });
    });

    it('the leaderboard ranks finished ranked member runs only', async () => {
      await db.sql`INSERT INTO buscaminas_days (day, number, content_version, board, answers) VALUES (${LIVE}, 10, 1, '{"rounds": []}', '{}')`;
      const { repo } = await service();
      const later = new Date(Date.now() + 3_600_000);
      const state = { v: 1 as const, r: 0, p: [], m: null, s: null, res: [], done: true };
      const finish = async (player: { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string }, ranked: boolean, score: number, done = true) => {
        const row = await repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player, day: LIVE, ranked, contentVersion: 1, state }));
        await repo.withTx((tx) => repo.saveState(tx, row!.id, { state, stateVersion: 1, contentVersion: 1, completion: done ? { score, perfects: 1 } : null, closesAt: later }));
      };
      const a = await user('Ana');
      const b = await user('Beto');
      await finish({ kind: 'member', userId: a }, true, 120);
      await finish({ kind: 'member', userId: b }, true, 200);
      await finish({ kind: 'member', userId: await user('Unfinished') }, true, 0, false);
      await finish({ kind: 'member', userId: await user('Practice') }, false, 300);
      await finish({ kind: 'member', userId: await user('Guest account', { is_guest: true }) }, true, 290);
      await finish({ kind: 'guest', guestId: await guestSession() }, false, 300);
      const board = await repo.leaderboard(LIVE, 20);
      expect(board.players).toBe(2);
      expect(board.top.map((e) => [e.rank, e.username, e.score])).toEqual([[1, 'Beto', 200], [2, 'Ana', 120]]);
      expect(await repo.rankOf(a, LIVE)).toMatchObject({ rank: 2, score: 120 });
      expect(await repo.rankOf(await user('Nobody'), LIVE)).toBeNull();
    });
  });
});
