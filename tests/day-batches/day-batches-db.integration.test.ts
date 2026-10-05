import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { calendar, makeDay } from '../buscaminas/fixtures.js';
import { addDays } from '../../src/modules/buscaminas/buscaminas.days.js';

/**
 * Opt-in, real PostgreSQL: CMS approval of a pipeline-built batch of Buscaminas days, end to end against the real
 * migrations (days table, content ledgers, agents.day_batches). Needs an isolated local database:
 *   DAY_BATCHES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_day_batches_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.DAY_BATCHES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_day_batches_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local day-batches test database required');

const MIGRATIONS = join(__dirname, '../../supabase/migrations');
const FIXTURE = `
  DROP SCHEMA IF EXISTS agents CASCADE;
  DROP TABLE IF EXISTS buscaminas_runs, buscaminas_days, buscaminas_content_ledger, pistas_content_ledger, pistas_days, ultimo_days,
    minuto_days, ranked_profiles, guest_sessions, users CASCADE;
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nickname text, avatar_url text, avatar_customization jsonb, country text,
    is_ai boolean NOT NULL DEFAULT false, is_guest boolean NOT NULL DEFAULT false, is_seed boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz, pending_deletion_at timestamptz
  );
  CREATE TABLE ranked_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), placement_status text, tier text);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, last_seen_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE pistas_days (day date PRIMARY KEY);
  CREATE TABLE ultimo_days (day date PRIMARY KEY);
  CREATE TABLE minuto_days (day date PRIMARY KEY);
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
  CREATE OR REPLACE FUNCTION public.trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE SCHEMA agents;
  CREATE TABLE agents.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, status text NOT NULL DEFAULT 'queued',
    params jsonb NOT NULL DEFAULT '{}'::jsonb, requested_by uuid, created_at timestamptz NOT NULL DEFAULT now());
`;

describe.skipIf(!url)('day batches on real Postgres', () => {
  const NOW = new Date('2026-12-20T15:00:00Z'); // Buenos Aires 2026-12-20
  const migration = (file: string) => db.sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')));

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 6, onnotice: () => undefined });
    await db.sql.unsafe(FIXTURE);
    await migration('20260926140000_buscaminas_runs.sql');
    await migration('20260928120000_buscaminas_days_and_guest_runs.sql');
    await migration('20261005120000_buscaminas_pistas_content_ledgers.sql');
    await migration('20261005120100_agents_day_batches.sql');
    // a second run of the batches migration is a no-op (the runner may replay it)
    await migration('20261005120100_agents_day_batches.sql');
  });
  afterAll(async () => { await db.sql?.end(); });

  beforeEach(async () => {
    await db.sql`DELETE FROM agents.day_batches`;
    await db.sql`DELETE FROM agents.daily_game_settings`;
    await db.sql`DELETE FROM agents.jobs`;
    await db.sql`DELETE FROM buscaminas_runs`;
    await db.sql`DELETE FROM buscaminas_days`;
    await db.sql`DELETE FROM buscaminas_content_ledger`;
  });

  async function service() {
    const { createDayBatchesService } = await import('../../src/modules/day-batches/day-batches.service.js');
    return createDayBatchesService({ sql: db.sql as never, now: () => NOW });
  }
  async function seedCalendar() {
    const { seedDays, toDayRow } = await import('../../src/modules/buscaminas/buscaminas.seed.js');
    await seedDays(db.sql, calendar().map(toDayRow), { dryRun: false, allowCorrection: false });
  }
  /** A batch as the pipeline stores it: the full day files, validated against the calendar as it is now. */
  async function insertBatch(days: ReturnType<typeof makeDay>[], over: Record<string, unknown> = {}) {
    const { GAMES } = await import('../../src/modules/day-batches/day-batches.games.js');
    const validation = { ok: true, calendar: { fingerprint: await GAMES.buscaminas.fingerprint(db.sql as never) }, ...over };
    const [job] = await db.sql`INSERT INTO agents.jobs (type, status, params) VALUES ('daily_days', 'completed', ${db.sql.json({ game: 'buscaminas', days: days.length })}) RETURNING id`;
    const [batch] = await db.sql`
      INSERT INTO agents.day_batches (job_id, game, first_day, last_day, days, validation)
      VALUES (${job.id}, 'buscaminas', ${days[0].day}, ${days[days.length - 1].day}, ${db.sql.json(days as never)}, ${db.sql.json(validation as never)})
      RETURNING id`;
    return batch.id as string;
  }
  const count = async () => (await db.sql`SELECT count(*)::int AS n FROM buscaminas_days`)[0].n as number;
  const LAST = '2026-12-24';
  const next = (n: number) => Array.from({ length: n }, (_, i) => makeDay(addDays(LAST, i + 1)));

  it('shows a dry run, then appends the batch and marks it seeded in one transaction; the ledger records it', async () => {
    await seedCalendar();
    const svc = await service();
    const id = await insertBatch(next(3));
    const detail = await svc.get(id);
    expect(detail.dryRun).toMatchObject({ plan: { entries: [{ day: '2026-12-25', number: 91, status: 'new' }, {}, {}], keptDays: 90 } });
    expect(await count()).toBe(90);
    const approved = await svc.approve(id, null);
    expect(approved).toMatchObject({ status: 'seeded', firstDay: '2026-12-25', lastDay: '2026-12-27', dayCount: 3 });
    expect(approved.plan?.entries.map((e) => e.status)).toEqual(['new', 'new', 'new']);
    expect(await count()).toBe(93);
    expect((await db.sql`SELECT count(*)::int AS n FROM buscaminas_content_ledger WHERE side = 'day' AND day >= '2026-12-25'`)[0].n).toBe(60);
    const buffers = await svc.buffers();
    expect(buffers.find((b) => b.game === 'buscaminas')).toMatchObject({ lastDay: '2026-12-27', daysLeft: 8, pendingBatchId: null });
  });

  it('a double click or a retry after a lost response appends once and returns the seeded batch', async () => {
    await seedCalendar();
    const svc = await service();
    const id = await insertBatch(next(2));
    const [a, b] = await Promise.all([svc.approve(id, null), svc.approve(id, null)]);
    expect(a.status).toBe('seeded');
    expect(b.status).toBe('seeded');
    expect(await count()).toBe(92);
    expect((await svc.approve(id, null)).status).toBe('seeded');
    expect(await count()).toBe(92);
  });

  it('refuses a stale batch (its dates were filled meanwhile) and leaves it pending with nothing written', async () => {
    await seedCalendar();
    const svc = await service();
    const id = await insertBatch(next(2));
    const { seedDays, toDayRow } = await import('../../src/modules/buscaminas/buscaminas.seed.js');
    await seedDays(db.sql, [toDayRow(makeDay('2026-12-25', 1))], { dryRun: false, allowCorrection: false });
    expect((await svc.get(id)).dryRun).toMatchObject({ error: expect.stringContaining('append only: already stored: 2026-12-25') });
    // the calendar it was validated on changed (a day was added), so approval refuses before trying to append
    await expect(svc.approve(id, null)).rejects.toThrow(/changed after this batch was validated/);
    expect((await svc.get(id)).status).toBe('pending');
    expect(await count()).toBe(91);
    // a batch that would leave a hole is refused the same way
    const gap = await insertBatch([makeDay('2026-12-30')]).catch(() => null);
    expect(gap).toBeNull(); // one pending batch per game
  });

  it('a day corrected after validation sends the batch back (the spacing was checked on the old calendar)', async () => {
    await seedCalendar();
    const svc = await service();
    const id = await insertBatch(next(2));
    const { seedDays, toDayRow } = await import('../../src/modules/buscaminas/buscaminas.seed.js');
    await seedDays(db.sql, [toDayRow(makeDay(LAST, 1))], { dryRun: false, allowCorrection: true });
    await expect(svc.approve(id, null)).rejects.toThrow(/changed after this batch was validated/);
    expect(await count()).toBe(90);
    // a prompt-only correction (same answers, same content version) is caught too
    await db.sql`UPDATE agents.day_batches SET validation = jsonb_set(validation, '{calendar,fingerprint}', to_jsonb(${await (await import('../../src/modules/day-batches/day-batches.games.js')).GAMES.buscaminas.fingerprint(db.sql as never)}::text)) WHERE id = ${id}`;
    await db.sql`UPDATE buscaminas_days SET board = jsonb_set(board, '{rounds,0,prompt,es}', '"Otra consigna"') WHERE day = '2026-10-01'`;
    await expect(svc.approve(id, null)).rejects.toThrow(/changed after this batch was validated/);
    // and a batch with no record of its calendar is never approved
    await db.sql`UPDATE agents.day_batches SET validation = '{"ok": true}'::jsonb WHERE id = ${id}`;
    await expect(svc.approve(id, null)).rejects.toThrow(/no record of the calendar/);
  });

  it('only a validated, pending batch can be approved; reject records who and why', async () => {
    await seedCalendar();
    const svc = await service();
    const failed = await insertBatch(next(1), { ok: false, problems: ['x'] });
    await expect(svc.approve(failed, null)).rejects.toMatchObject({ statusCode: 409 });
    const rejected = await svc.reject(failed, null, 'validator failed');
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'validator failed' });
    expect(rejected.decidedAt).not.toBeNull();
    await expect(svc.approve(failed, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(await count()).toBe(90);
  });

  it('appends a validated batch automatically unless its game is on hold; never one that failed validation', async () => {
    await seedCalendar();
    const svc = await service();
    await svc.setHold('buscaminas', true, null);
    const id = await insertBatch(next(2));
    expect(await svc.autoApprove()).toEqual({ seeded: [], failed: [] });
    expect((await svc.buffers()).find((b) => b.game === 'buscaminas')).toMatchObject({ holdForReview: true, pendingBatchId: id });
    await svc.setHold('buscaminas', false, null);
    expect(await svc.autoApprove()).toEqual({ seeded: [id], failed: [] });
    const done = await svc.get(id);
    expect(done).toMatchObject({ status: 'seeded', decidedBy: null });
    expect(await count()).toBe(92);
    // a batch that failed validation is never appended automatically
    const bad = await insertBatch([makeDay('2026-12-27')], { ok: false });
    expect(await svc.autoApprove()).toEqual({ seeded: [], failed: [] });
    expect((await svc.get(bad)).status).toBe('pending');
  });

  it('a batch the append refuses (calendar changed since validation) is marked failed, so a fresh build can start', async () => {
    await seedCalendar();
    const svc = await service();
    const id = await insertBatch(next(2));
    const { seedDays, toDayRow } = await import('../../src/modules/buscaminas/buscaminas.seed.js');
    await seedDays(db.sql, [toDayRow(makeDay(LAST, 1))], { dryRun: false, allowCorrection: true });
    expect(await svc.autoApprove()).toEqual({ seeded: [], failed: [id] });
    expect(await svc.get(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('changed after this batch was validated') });
    await db.sql`UPDATE agents.jobs SET status = 'completed'`;
    await expect(svc.spawn('buscaminas', 7, null)).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it('spawn: one build or pending batch per game at a time', async () => {
    await seedCalendar();
    const svc = await service();
    const { jobId } = await svc.spawn('buscaminas', 7, null);
    const [job] = await db.sql`SELECT type, status, params FROM agents.jobs WHERE id = ${jobId}`;
    expect(job).toMatchObject({ type: 'daily_days', status: 'queued', params: { game: 'buscaminas', days: 7 } });
    await expect(svc.spawn('buscaminas', 7, null)).rejects.toThrow(/already running/);
    await db.sql`UPDATE agents.jobs SET status = 'completed'`;
    await insertBatch(next(1));
    await expect(svc.spawn('buscaminas', 7, null)).rejects.toThrow(/waiting for review/);
    // other games are independent
    await expect(svc.spawn('pistas', 7, null)).resolves.toMatchObject({ jobId: expect.any(String) });
  });
});
