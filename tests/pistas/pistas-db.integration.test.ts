import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { answerOf, calendar, CALENDAR_DAYS, makeDay, rawDay } from './fixtures.js';

/**
 * Opt-in, real PostgreSQL: applies the Pistas migration to a fresh schema and runs the repo, the
 * service and the seed against it. Needs an isolated local database:
 *   PISTAS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_pistas_test_1
 * The service runs on a fixed app clock; the database clock is real, so only days long closed
 * (PAST) or explicit closes_at instants are used where the database clock decides.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.PISTAS_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_pistas_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local pistas test database required');

const MIGRATION = join(__dirname, '../../supabase/migrations/20260929120000_pistas.sql');
const FIXTURE = `
  DROP TABLE IF EXISTS pistas_runs, pistas_days, buscaminas_content_ledger, pistas_content_ledger, ranked_profiles, guest_sessions, users CASCADE;
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
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  CREATE OR REPLACE FUNCTION public.trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
`;

describe.skipIf(!url)('pistas on real Postgres', () => {
  const NOW = new Date('2026-09-30T15:00:00Z');
  // Closed by the real database clock since 2026-09-29T03:00Z.
  const PAST = '2026-09-28';
  const PAST_CLOSES = new Date('2026-09-29T03:00:00Z');
  // Open by the real database clock for decades: rows whose ranked window must still be open.
  const FUTURE = '2099-01-01';
  const FUTURE_CLOSES = new Date('2099-01-02T03:00:00Z');
  const hour = 3_600_000;

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql.unsafe(FIXTURE);
    const body = readFileSync(MIGRATION, 'utf8');
    await db.sql.begin((tx) => tx.unsafe(body));
    // Safe to re-run (a ledger out of sync with the schema).
    await db.sql.begin((tx) => tx.unsafe(body));
    await db.sql.begin((tx) => tx.unsafe(readFileSync(join(__dirname, '../../supabase/migrations/20261005120000_buscaminas_pistas_content_ledgers.sql'), 'utf8')));
  });
  afterAll(async () => { await db.sql?.end(); });

  const user = async (nickname: string, extra: { is_guest?: boolean } = {}) =>
    (await db.sql`INSERT INTO users (nickname, is_guest) VALUES (${nickname}, ${extra.is_guest ?? false}) RETURNING id`)[0].id as string;
  const guestSession = async () => (await db.sql`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`)[0].id as string;
  const expectPgError = (p: Promise<unknown>, constraint: string) => expect(p).rejects.toMatchObject({ constraint_name: constraint });

  describe('migration', () => {
    it('both tables are server-only: RLS on, no policies, no client grants; anon and authenticated are refused', async () => {
      const rls = await db.sql`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('pistas_days', 'pistas_runs') ORDER BY relname`;
      expect(rls).toEqual([{ relname: 'pistas_days', relrowsecurity: true }, { relname: 'pistas_runs', relrowsecurity: true }]);
      expect(await db.sql`SELECT 1 FROM pg_policies WHERE tablename IN ('pistas_days', 'pistas_runs')`).toHaveLength(0);
      const [grants] = await db.sql`
        SELECT has_table_privilege('anon', 'public.pistas_days', 'SELECT') AS a, has_table_privilege('authenticated', 'public.pistas_days', 'SELECT') AS b,
               has_table_privilege('anon', 'public.pistas_runs', 'INSERT') AS c, has_table_privilege('authenticated', 'public.pistas_runs', 'SELECT') AS d`;
      expect(grants).toEqual({ a: false, b: false, c: false, d: false });
      for (const role of ['anon', 'authenticated']) {
        for (const table of ['pistas_days', 'pistas_runs']) {
          await expect(db.sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE ${role}`);
            await tx.unsafe(`SELECT 1 FROM public.${table}`);
          })).rejects.toMatchObject({ code: '42501' });
        }
      }
    });

    it('a run has exactly one owner, only members are ranked, one run per player per day; score and solved stay in range', async () => {
      const u = await user('owner-check');
      const g = await guestSession();
      const closes = new Date('2026-10-01T03:00:00Z');
      const insert = (userId: string | null, guestId: string | null, extra: { ranked?: boolean; day?: string; score?: number; solved?: number } = {}) => db.sql`
        INSERT INTO pistas_runs (user_id, guest_id, day, ranked, content_version, state, closes_at, done, score, solved, completed_at)
        VALUES (${userId}, ${guestId}, ${extra.day ?? '2026-09-30'}, ${extra.ranked ?? false}, 1, '{}', ${closes},
                ${extra.score !== undefined}, ${extra.score ?? null}, ${extra.solved ?? null}, ${extra.score !== undefined ? new Date() : null})`;
      await expectPgError(insert(null, null), 'chk_pistas_runs_owner');
      await expectPgError(insert(u, g), 'chk_pistas_runs_owner');
      await expectPgError(insert(null, g, { ranked: true }), 'chk_pistas_runs_ranked_member');
      await expectPgError(insert(null, g, { score: 101, solved: 10 }), 'chk_pistas_runs_score');
      await expectPgError(insert(null, g, { score: 100, solved: 11 }), 'chk_pistas_runs_solved');
      await expectPgError(insert(null, g, { score: -1, solved: 0 }), 'chk_pistas_runs_score');
      await insert(null, g, { score: 100, solved: 10 });
      await expectPgError(insert(null, g), 'uq_pistas_runs_guest_day');
      await insert(u, null, { ranked: true });
      await expectPgError(insert(u, null), 'uq_pistas_runs_user_day');
      await insert(null, await guestSession());
      await insert(null, g, { day: '2026-09-29' });
      await expectPgError(db.sql`UPDATE pistas_runs SET done = true WHERE user_id = ${u}`, 'chk_pistas_runs_done');
      await expectPgError(db.sql`UPDATE pistas_runs SET done = true, completed_at = now() WHERE user_id = ${u}`, 'chk_pistas_runs_done_result');
      await expectPgError(db.sql`UPDATE pistas_runs SET closes_at = '2026-09-29T00:00:00Z' WHERE user_id = ${u}`, 'chk_pistas_runs_closes_at');
    });

    it('guest runs go with their guest session; pistas_days rejects rows without the basic shape', async () => {
      const g = await guestSession();
      await db.sql`INSERT INTO pistas_runs (guest_id, day, content_version, state, closes_at) VALUES (${g}, '2026-09-27', 1, '{}', '2026-09-28T03:00:00Z')`;
      await db.sql`DELETE FROM guest_sessions WHERE id = ${g}`;
      expect(await db.sql`SELECT 1 FROM pistas_runs WHERE guest_id = ${g}`).toHaveLength(0);
      const insert = (number: number, cv: number, rounds: unknown) =>
        db.sql`INSERT INTO pistas_days (day, number, content_version, rounds) VALUES ('2030-01-01', ${number}, ${cv}, ${db.sql.json(rounds as never)})`;
      await expectPgError(insert(0, 1, []), 'chk_pistas_days_number');
      await expectPgError(insert(1, 0, []), 'chk_pistas_days_content_version');
      await expectPgError(insert(1, 1, {}), 'chk_pistas_days_rounds');
    });
  });

  describe('seed, repo and service', () => {
    beforeEach(async () => {
      await db.sql`DELETE FROM pistas_runs`;
      await db.sql`DELETE FROM pistas_days`;
      await db.sql`DELETE FROM pistas_content_ledger`;
    });

    // The synthetic fixture has the same ten answers on every day, so repeats are allowed unless a test says otherwise.
    const seed = async (days = calendar(), opts: { dryRun?: boolean; allowCorrection?: boolean; allowRepeats?: boolean } = {}) => {
      const { seedDays, toDayRow } = await import('../../src/modules/pistas/pistas.seed.js');
      return seedDays(db.sql, days.map(toDayRow), { dryRun: opts.dryRun ?? false, allowCorrection: opts.allowCorrection ?? false, allowRepeats: opts.allowRepeats ?? true });
    };

    async function service() {
      const { pistasRepo } = await import('../../src/modules/pistas/pistas.repo.js');
      const { createContentStore } = await import('../../src/modules/pistas/pistas.content.js');
      const { createPistasService } = await import('../../src/modules/pistas/pistas.service.js');
      const store = createContentStore(
        { fingerprint: () => pistasRepo.daysFingerprint(), load: () => pistasRepo.loadDays() },
        { refreshMs: 0, now: () => Date.now(), log: { warn: () => undefined, error: () => undefined } },
      );
      const svc = createPistasService({ repo: pistasRepo, content: () => store.get(), contentStale: () => store.invalidate(), now: () => NOW });
      return { store, repo: pistasRepo, svc };
    }
    const newState = () => ({ v: 1 as const, r: 0, n: 1, g: 0, c: null, s: null, res: [], done: false });

    it('seeds the calendar in one transaction: dry run writes nothing, a re-run changes nothing, provenance is never stored', async () => {
      const dry = await seed(calendar(), { dryRun: true });
      expect(dry.entries.filter((e) => e.status === 'new')).toHaveLength(CALENDAR_DAYS);
      expect(await db.sql`SELECT 1 FROM pistas_days`).toHaveLength(0);
      await seed();
      const rows = await db.sql`SELECT day::text AS day, number, content_version, rounds::text AS rounds FROM pistas_days ORDER BY day`;
      expect(rows.map((r) => [r.day, r.number, Number(r.content_version)])).toEqual(calendar().map((d) => [d.day, d.number, d.contentVersion]));
      expect(rows.every((r) => !/source|questionIds|playerId/.test(r.rounds))).toBe(true);
      expect((await seed()).entries.every((e) => e.status === 'unchanged')).toBe(true);
      const { store } = await service();
      expect((await store.get()).get(PAST)!.contentVersion).toBe(makeDay(PAST).contentVersion);
    });

    it('a daily answer may not be a duel pool player, and the pool may not take a daily one (each checked inside its write)', async () => {
      await db.sql`CREATE TABLE IF NOT EXISTS duel_pool (game text NOT NULL, item_id text NOT NULL, difficulty text NOT NULL,
        fingerprint text NOT NULL, payload jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (game, item_id))`;
      try {
        const { parsePoolFile, writePool } = await import('../../src/modules/duel/duel.seed.js');
        const { parseDayFile, seedDays, toDayRow } = await import('../../src/modules/pistas/pistas.seed.js');
        const withAnswer = <T extends { answer: unknown }>(round: T, name: string): T =>
          ({ ...round, answer: { display: { es: name, en: name, ka: name, tr: name }, accepted: [name] } });
        const poolItem = (name: string) => ({ ...withAnswer(rawDay('2026-09-27').rounds[0], name), id: `pool-${name.replace(/\W/g, '')}` });
        await seed(calendar().slice(0, 3));
        // A daily player cannot enter the pool…
        await expect(writePool(db.sql, 'pistas', parsePoolFile('pistas', { game: 'pistas', items: [poolItem(answerOf(3))] })))
          .rejects.toThrow(/share a player or category with a daily/);
        await writePool(db.sql, 'pistas', parsePoolFile('pistas', { game: 'pistas', items: [poolItem('Solo Duelo')] }));
        // …and a pool player cannot become a daily answer (the next day is refused whole, nothing written).
        const raw = rawDay('2026-09-30');
        raw.rounds[2] = withAnswer(raw.rounds[2], 'Solo Duelo');
        const next = toDayRow(parseDayFile('2026-09-30.json', raw));
        await expect(seed([parseDayFile('2026-09-30.json', raw)])).rejects.toThrow(/1 daily player\(s\) are in the duel pool/);
        expect((await db.sql`SELECT count(*)::int AS n FROM pistas_days`)[0].n).toBe(3);
        await seedDays(db.sql, [next], { dryRun: false, allowCorrection: false, allowRepeats: true, allowPoolOverlap: true });
        expect((await db.sql`SELECT count(*)::int AS n FROM pistas_days`)[0].n).toBe(4);
        // That day, re-supplied unchanged beside a new one, is not re-judged; the new day is still checked.
        const plan = await seed([parseDayFile('2026-09-30.json', raw), makeDay('2026-10-01')]);
        expect(plan.entries.map((e) => e.status)).toEqual(['unchanged', 'new']);
        // A disabled pool item still counts: its packs were already dealt.
        await db.sql`UPDATE duel_pool SET enabled = false`;
        const laterRaw = rawDay('2026-10-02');
        laterRaw.rounds[5] = withAnswer(laterRaw.rounds[5], 'Solo Duelo');
        await expect(seed([parseDayFile('2026-10-02.json', laterRaw)])).rejects.toThrow(/are in the duel pool/);
      } finally {
        await db.sql`DROP TABLE IF EXISTS duel_pool`;
      }
    });

    it('a correction cannot move a player stored before the ledger existed onto another day', async () => {
      const { parseDayFile } = await import('../../src/modules/pistas/pistas.seed.js');
      const named = (date: string, edits: Record<number, string>) => {
        const raw = rawDay(date);
        raw.rounds = raw.rounds.map((round, r) => {
          const name = edits[r] ?? `Jugador ${date.replace(/-/g, ' ')} ${r}`;
          return { ...round, answer: { display: { es: name, en: name, ka: name, tr: name }, accepted: [name] } };
        });
        return parseDayFile(`${date}.json`, raw);
      };
      await seed([named('2026-09-27', { 4: 'Movido Ahora' }), named('2026-09-28', {})], { allowRepeats: false });
      await db.sql`DELETE FROM pistas_content_ledger`; // as before the ledger existed
      // one import: the player leaves day 1 and appears on day 2
      await expect(seed([named('2026-09-27', {}), named('2026-09-28', { 6: 'Movido Ahora' })], { allowCorrection: true, allowRepeats: false }))
        .rejects.toThrow(/a player is the answer on two days/);
    });

    it('remembers published players: one corrected away from a day, or replaced in the pool, still counts', async () => {
      await db.sql`CREATE TABLE IF NOT EXISTS duel_pool (game text NOT NULL, item_id text NOT NULL, difficulty text NOT NULL,
        fingerprint text NOT NULL, payload jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (game, item_id))`;
      try {
        const { parsePoolFile, writePool } = await import('../../src/modules/duel/duel.seed.js');
        const { parseDayFile } = await import('../../src/modules/pistas/pistas.seed.js');
        const withAnswer = <T extends { answer: unknown }>(round: T, name: string): T =>
          ({ ...round, answer: { display: { es: name, en: name, ka: name, tr: name }, accepted: [name] } });
        // every player distinct per day (the synthetic fixture repeats its answers), then the test's own names
        const day = (date: string, edits: Record<number, string>) => {
          const raw = rawDay(date);
          raw.rounds = raw.rounds.map((round, r) => withAnswer(round, edits[r] ?? `Jugador ${date.replace(/-/g, ' ')} ${r}`));
          return parseDayFile(`${date}.json`, raw);
        };
        // a pool player published, then replaced under the same id
        const poolItem = (name: string) => ({ ...withAnswer(rawDay('2026-09-27').rounds[0], name), id: 'pool-1' });
        await writePool(db.sql, 'pistas', parsePoolFile('pistas', { game: 'pistas', items: [poolItem('Solo Duelo')] }));
        await writePool(db.sql, 'pistas', parsePoolFile('pistas', { game: 'pistas', items: [poolItem('Otro Duelo')] }));
        await seed([day('2026-09-27', { 4: 'Corregido Fuera' })], { allowRepeats: false });
        await expect(seed([day('2026-09-28', { 0: 'Solo Duelo' })])).rejects.toThrow(/are in the duel pool/);
        // a player corrected away from a day is still a daily answer: no other day may use it
        await seed([day('2026-09-27', { 4: 'Nuevo Jugador' })], { allowCorrection: true, allowRepeats: false });
        await expect(seed([day('2026-09-28', { 2: 'Corregido Fuera' })], { allowRepeats: false })).rejects.toThrow(/a player is the answer on two days/);
      } finally {
        await db.sql`DROP TABLE IF EXISTS duel_pool`;
      }
    });

    it('appends days to the stored calendar: the next day alone is accepted, a hole or a repeated player is refused', async () => {
      await seed();
      const next = makeDay('2026-10-27');
      // The append is one file; the 30 stored days are untouched and reported as kept.
      const plan = await seed([next]);
      expect(plan.entries).toMatchObject([{ day: '2026-10-27', number: 31, status: 'new' }]);
      expect(plan.extraDays).toHaveLength(CALENDAR_DAYS);
      expect((await db.sql`SELECT count(*)::int AS n FROM pistas_days`)[0].n).toBe(CALENDAR_DAYS + 1);
      // The served calendar follows the table: the appended day is the last one in the index, with no restart.
      const { store } = await service();
      expect([...(await store.get()).keys()].sort().at(-1)).toBe('2026-10-27');
      // A day that would leave a hole writes nothing.
      await expect(seed([makeDay('2026-10-29')])).rejects.toThrow(/2026-10-28 is missing/);
      // The synthetic days all share their ten answers: without the test's allowance that is a repeated player.
      await expect(seed([makeDay('2026-10-28')], { allowRepeats: false })).rejects.toThrow(/a player is the answer on two days/);
      expect((await db.sql`SELECT count(*)::int AS n FROM pistas_days`)[0].n).toBe(CALENDAR_DAYS + 1);
      // An empty table still needs the first content day.
      await db.sql`DELETE FROM pistas_days`;
      await expect(seed([next])).rejects.toThrow(/must start at 2026-09-27/);
    });

    it('a guest plays a closed day on real rows; the database clock discloses missed answers', async () => {
      await seed();
      const { svc } = await service();
      const ga = { kind: 'guest' as const, guestId: await guestSession() };
      const gb = { kind: 'guest' as const, guestId: await guestSession() };
      await expect(svc.start('2026-09-30', ga)).rejects.toMatchObject({ statusCode: 403, code: 'sign_in_for_today' });
      const run = await svc.start(PAST, ga, makeDay(PAST).contentVersion);
      expect((await svc.start(PAST, ga)).run).toEqual(run.run);
      const shown = await svc.reveal(ga, run.run.id, 0);
      expect(shown.state).toMatchObject({ revealed: 2, clues: [{ kind: 'confed' }, { kind: 'position' }] });
      await expect(svc.reveal(ga, run.run.id, 0)).rejects.toMatchObject({ statusCode: 409, code: 'stale_state' });
      await expect(svc.reveal(gb, run.run.id, 1)).rejects.toMatchObject({ statusCode: 403, message: 'run_not_yours' });
      const miss = await svc.guess(ga, run.run.id, 1, 'Nadie');
      expect(miss).toMatchObject({ correct: false, state: { wrongGuesses: 1, ceiling: 5 } });
      const won = await svc.guess(ga, run.run.id, 2, ` ${answerOf(0).toUpperCase()} `);
      expect(won).toMatchObject({ correct: true, state: { settled: { outcome: 'solved', points: 9, answer: { display: { en: 'Numero 0' } } }, score: 9 } });
      const next = await svc.next(ga, run.run.id, 3);
      const lost = await svc.giveUp(ga, next.run.id, next.run.version);
      expect(lost.state.settled).toMatchObject({ outcome: 'missed', answer: { display: { en: 'Numero 1' } } });
      const [row] = await db.sql`SELECT user_id, guest_id, ranked, state_version, state, closes_at FROM pistas_runs WHERE id = ${run.run.id}`;
      expect(row).toMatchObject({ user_id: null, guest_id: ga.guestId, ranked: false, state_version: 5, closes_at: new Date('2026-09-29T03:00:00Z') });
      expect(Object.keys(row.state).sort()).toEqual(['c', 'done', 'g', 'n', 'r', 'res', 's', 'v']);
      expect(await svc.current(ga, PAST)).toEqual(lost);
      expect(await svc.current(gb, PAST)).toEqual({ run: null });
      const review = await svc.review(PAST);
      expect(review.rounds.map((r) => r.answer.display.en)).toEqual(Array.from({ length: 10 }, (_, r) => answerOf(r)));
    });

    it('finishing writes score, solved and completed_at in the same update', async () => {
      await seed();
      const { svc } = await service();
      const g = { kind: 'guest' as const, guestId: await guestSession() };
      let cur = await svc.start(PAST, g);
      for (let r = 0; r < 10; r += 1) {
        cur = r % 2 ? await svc.giveUp(g, cur.run.id, cur.run.version) : await svc.guess(g, cur.run.id, cur.run.version, answerOf(r));
        if (r < 9) cur = await svc.next(g, cur.run.id, cur.run.version);
      }
      expect(cur.state).toMatchObject({ done: true, score: 50, solved: 5 });
      const [row] = await db.sql`SELECT done, score, solved, completed_at FROM pistas_runs WHERE id = ${cur.run.id}`;
      expect(row).toMatchObject({ done: true, score: 50, solved: 5 });
      expect(row.completed_at).toBeInstanceOf(Date);
    });

    it('a changed played day is refused without --allow-correction; the correction unranks the day\'s runs, keeps their state, and /start moves them onto it', async () => {
      await seed();
      const { svc, repo, store } = await service();
      const g = { kind: 'guest' as const, guestId: await guestSession() };
      const run = await svc.start(PAST, g);
      await svc.reveal(g, run.run.id, 0);
      const u = await user('ranked-before');
      const midRound = { ...newState(), n: 4, g: 1, c: 7 };
      const ranked = await repo.withTx((tx) => repo.insertRun(tx, {
        id: randomUUID(), player: { kind: 'member', userId: u }, day: PAST, ranked: true, contentVersion: makeDay(PAST).contentVersion,
        state: midRound, closesAt: new Date(Date.now() + hour),
      }));
      const corrected = calendar().map((d) => (d.day === PAST ? makeDay(PAST, 1) : d));
      await expect(seed(corrected)).rejects.toThrow(/2026-09-28 \(2 runs\): content changed; pass --allow-correction/);
      expect((await store.get()).get(PAST)!.contentVersion).toBe(makeDay(PAST).contentVersion);
      const plan = await seed(corrected, { allowCorrection: true });
      expect(plan.entries.find((e) => e.day === PAST)).toMatchObject({ status: 'changed', contentChanged: true, runs: 2, voids: 1 });
      const [voided] = await db.sql`SELECT ranked, state, state_version, content_version FROM pistas_runs WHERE id = ${ranked!.id}`;
      expect(voided).toMatchObject({ ranked: false, state: midRound, state_version: 0, content_version: String(makeDay(PAST).contentVersion) });
      // The guest's move on the old content is refused; /start moves the run onto the new content as it stands.
      await expect(svc.reveal(g, run.run.id, 1)).rejects.toMatchObject({ statusCode: 409, code: 'content_changed' });
      const rebased = await svc.start(PAST, g);
      expect(rebased).toMatchObject({ run: { id: run.run.id, version: 2 }, state: { revealed: 2, ranked: false } });
      expect(JSON.stringify(rebased.state.clues)).toContain('pista 0.1');
      const [row] = await db.sql`SELECT content_version FROM pistas_runs WHERE id = ${run.run.id}`;
      expect(Number(row.content_version)).toBe(makeDay(PAST, 1).contentVersion);
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

    it('a move waits for an in-flight correction of its day, then is content_changed instead of judged on the old content', async () => {
      await seed();
      const { svc } = await service();
      const g = { kind: 'guest' as const, guestId: await guestSession() };
      const run = await svc.start(PAST, g);
      const next = makeDay(PAST, 1);
      const locked = gate();
      const commit = gate();
      const correction = db.sql.begin(async (transaction) => {
        const tx = transaction as unknown as typeof db.sql;
        await tx`SELECT day FROM pistas_days WHERE day = ${PAST} FOR UPDATE`;
        await tx`UPDATE pistas_days SET content_version = ${next.contentVersion}, rounds = ${tx.json(next.rounds as never)} WHERE day = ${PAST}`;
        locked.open();
        await commit.opened;
      });
      await locked.opened;
      const guess = svc.guess(g, run.run.id, 0, answerOf(0));
      expect(await settledWithin(guess, 250)).toBe(false);
      commit.open();
      await correction;
      await expect(guess).rejects.toMatchObject({ statusCode: 409, code: 'content_changed' });
      const [row] = await db.sql`SELECT state_version, content_version FROM pistas_runs WHERE id = ${run.run.id}`;
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
          state: newState(), closesAt: new Date('2026-09-29T03:00:00Z'),
        });
        started.open();
        await commit.opened;
      });
      await started.opened;
      const seeding = seed(calendar().map((d) => (d.day === PAST ? makeDay(PAST, 1) : d)));
      expect(await settledWithin(seeding, 250)).toBe(false);
      commit.open();
      await start;
      await expect(seeding).rejects.toThrow(/2026-09-28 \(1 runs\): content changed/);
      const [day] = await db.sql`SELECT content_version FROM pistas_days WHERE day = ${PAST}`;
      expect(Number(day.content_version)).toBe(makeDay(PAST).contentVersion);
    });

    it('the ranked cutoff and the `closed` flag are the database clock against the row\'s closes_at; unranked rows never close', async () => {
      await db.sql`INSERT INTO pistas_days (day, number, content_version, rounds) VALUES (${FUTURE}, 9, 1, '[]'), (${PAST}, 2, 1, '[]')`;
      const { repo } = await service();
      const u = await user('cutoff');
      const g = await guestSession();
      const insert = (player: { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string }, day: string, ranked: boolean, closesAt: Date) =>
        repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player, day, ranked, contentVersion: 1, state: newState(), closesAt }));
      const open = await insert({ kind: 'member', userId: u }, FUTURE, true, FUTURE_CLOSES);
      const closed = await insert({ kind: 'member', userId: await user('late') }, PAST, true, PAST_CLOSES);
      const practice = await insert({ kind: 'guest', guestId: g }, PAST, false, PAST_CLOSES);
      expect([open!.closed, closed!.closed, practice!.closed]).toEqual([false, true, true]);
      const save = (id: string) => repo.withTx((tx) => repo.saveState(tx, id, { state: { ...newState(), n: 2 }, stateVersion: 1, contentVersion: 1, completion: null }));
      expect(await save(closed!.id)).toBeNull();
      expect(await save(open!.id)).toMatchObject({ state_version: 1, ranked: true, closed: false });
      expect(await save(practice!.id)).toMatchObject({ state_version: 1, closed: true });
      expect(await repo.withTx((tx) => repo.unrankClosedRun(tx, open!.id))).toBeNull();
      expect(await repo.withTx((tx) => repo.unrankClosedRun(tx, closed!.id))).toMatchObject({ ranked: false });
      expect(await repo.isClosed(new Date(Date.now() - 1000))).toBe(true);
      expect(await repo.isClosed(new Date(Date.now() + hour))).toBe(false);
    });

    it('a run write needs the day\'s stored content version to be the run\'s; a rebase only onto the stored one', async () => {
      await db.sql`INSERT INTO pistas_days (day, number, content_version, rounds) VALUES (${PAST}, 2, 1, '[]')`;
      const { repo } = await service();
      const g = await guestSession();
      const run = await repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player: { kind: 'guest', guestId: g }, day: PAST, ranked: false, contentVersion: 1, state: newState(), closesAt: new Date() }));
      const save = (contentVersion: number) => repo.withTx((tx) => repo.saveState(tx, run!.id, { state: newState(), stateVersion: 1, contentVersion, completion: null }));
      await db.sql`UPDATE pistas_days SET content_version = 2 WHERE day = ${PAST}`;
      expect(await save(1)).toBeNull();
      expect(await repo.withTx((tx) => repo.dayVersion(tx, PAST))).toBe(2);
      expect(await repo.withTx((tx) => repo.rebaseRun(tx, run!.id, 3, run!.state))).toBeNull();
      expect(await repo.withTx((tx) => repo.rebaseRun(tx, run!.id, 2, run!.state))).toMatchObject({ content_version: 2, state_version: 1, ranked: false });
      expect(await repo.withTx((tx) => repo.rebaseRun(tx, run!.id, 2, run!.state))).toBeNull();
    });

    it('the leaderboard ranks finished ranked member runs only, with `solved`', async () => {
      await db.sql`INSERT INTO pistas_days (day, number, content_version, rounds) VALUES (${FUTURE}, 9, 1, '[]')`;
      const { repo } = await service();
      const later = FUTURE_CLOSES;
      const finish = async (player: { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string }, ranked: boolean, score: number, done = true) => {
        const row = await repo.withTx((tx) => repo.insertRun(tx, { id: randomUUID(), player, day: FUTURE, ranked, contentVersion: 1, state: newState(), closesAt: later }));
        await repo.withTx((tx) => repo.saveState(tx, row!.id, { state: { ...newState(), done }, stateVersion: 1, contentVersion: 1, completion: done ? { score, solved: Math.floor(score / 10) } : null }));
      };
      const a = await user('Ana');
      const b = await user('Beto');
      await finish({ kind: 'member', userId: a }, true, 64);
      await finish({ kind: 'member', userId: b }, true, 81);
      await finish({ kind: 'member', userId: await user('Unfinished') }, true, 0, false);
      await finish({ kind: 'member', userId: await user('Practice') }, false, 100);
      await finish({ kind: 'member', userId: await user('Guest account', { is_guest: true }) }, true, 99);
      await finish({ kind: 'guest', guestId: await guestSession() }, false, 100);
      const board = await repo.leaderboard(FUTURE, 20);
      expect(board.players).toBe(2);
      expect(board.top.map((e) => [e.rank, e.username, e.score, e.solved])).toEqual([[1, 'Beto', 81, 8], [2, 'Ana', 64, 6]]);
      expect(await repo.rankOf(a, FUTURE)).toMatchObject({ rank: 2, score: 64, solved: 6 });
      expect(await repo.rankOf(await user('Nobody'), FUTURE)).toBeNull();
    });
  });
});
