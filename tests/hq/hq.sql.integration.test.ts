import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real-Postgres tests for the hq worker functions (claim / fire / finish /
// reconcile / provider status). Opt-in: set HQ_SQL_TEST_DB_URL to a superuser
// URL of a THROWAWAY server (e.g. a local initdb cluster). The test creates a
// fresh database, stubs the few public tables the hq migrations reference, and
// applies every hq migration in order.

const ADMIN_URL = process.env.HQ_SQL_TEST_DB_URL;
const DB_NAME = 'hq_sql_test';
const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations');

const STUBS = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text DEFAULT 'user', is_deleted boolean DEFAULT false,
  nickname text, email text, is_ai boolean DEFAULT false, is_seed boolean DEFAULT false, is_guest boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), country text);
CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text, status text, started_at timestamptz,
  ended_at timestamptz, is_dev boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE public.match_players (match_id uuid, user_id uuid, seat int);
CREATE TABLE public.game_feedback (id uuid DEFAULT gen_random_uuid(), user_id uuid, game text, mode text, rating int, comment text,
  locale text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.daily_challenge_completions (user_id uuid, challenge_type text, completed_at timestamptz, score int);
CREATE TABLE public.guest_daily_completions (guest_id text, challenge_type text, completed_at timestamptz, created_at timestamptz);
CREATE TABLE public.wl_tournaments (id uuid, is_test boolean DEFAULT false, starts_at timestamptz);
CREATE TABLE public.wl_answers (tournament_id uuid, user_id uuid, answered_at timestamptz, created_at timestamptz);
CREATE TABLE public.duel_matches (id uuid, started_at timestamptz, created_at timestamptz);
CREATE TABLE public.duel_participants (match_id uuid, user_id uuid);
CREATE TABLE public.room_matches (id uuid, started_at timestamptz, created_at timestamptz, room_id uuid);
CREATE TABLE public.room_seats (match_id uuid, user_id uuid, room_id uuid, admitted boolean DEFAULT true);
`;

type Sql = ReturnType<typeof postgres>;

describe.skipIf(!ADMIN_URL)('hq SQL functions (real Postgres)', () => {
  let admin: Sql;
  let sql: Sql;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;
    const loader = postgres(url.toString(), { max: 1, onnotice: () => {}, connection: { check_function_bodies: 'off' } as never });
    await loader.unsafe(STUBS);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_hq_.*\.sql$/.test(f)).sort();
    for (const f of files) await loader.unsafe(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await loader.end();
    sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin?.end();
  });

  let agentA: string;
  let agentB: string;

  beforeEach(async () => {
    await sql`DELETE FROM hq.runs`;
    await sql`DELETE FROM hq.messages`;
    await sql`UPDATE hq.schedules SET last_task_id = NULL`;
    await sql`DELETE FROM hq.tasks`;
    await sql`DELETE FROM hq.schedules`;
    await sql`DELETE FROM hq.provider_status`;
    await sql`UPDATE hq.members SET status = 'paused' WHERE kind = 'agent'`;
    await sql`DELETE FROM hq.members WHERE slug IN ('t-agent-a', 't-agent-b')`;
    [{ id: agentA }] = await sql`INSERT INTO hq.members (slug, kind, name) VALUES ('t-agent-a', 'agent', 'A') RETURNING id`;
    [{ id: agentB }] = await sql`INSERT INTO hq.members (slug, kind, name) VALUES ('t-agent-b', 'agent', 'B') RETURNING id`;
  });

  const newTask = async (assignee: string, extra: { kind?: string; createdAgo?: string; status?: string } = {}) => {
    const [t] = await sql`
      INSERT INTO hq.tasks (title, status, kind, assignee_id, created_at)
      VALUES ('t', ${extra.status ?? 'todo'}, ${extra.kind ?? 'task'}, ${assignee},
              now() - ${extra.createdAgo ?? '0 seconds'}::interval)
      RETURNING id, number`;
    return t as { id: string; number: string };
  };
  const claim = async () => (await sql`SELECT * FROM hq.claim_next_task('w1')`)[0] as Record<string, any> | undefined;

  describe('provider status', () => {
    it('opens an auth incident once and escalates only after the window ends', async () => {
      const [first] = await sql`SELECT * FROM hq.provider_trip('claude', 'auth', 'Invalid API key')`;
      expect(first.opened).toBe(true);
      expect(first.failures).toBe(1);
      const [again] = await sql`SELECT * FROM hq.provider_trip('claude', 'auth', 'Invalid API key')`;
      expect(again.opened).toBe(false);
      expect(again.failures).toBe(1);
      expect(new Date(again.until).getTime()).toBe(new Date(first.until).getTime());

      await sql`UPDATE hq.provider_status SET until = now() - interval '1 second' WHERE provider = 'claude'`;
      const [second] = await sql`
        SELECT t.*, extract(epoch FROM t.until - now()) AS wait_s FROM hq.provider_trip('claude', 'auth', 'x') t`;
      expect(second.opened).toBe(false);
      expect(second.failures).toBe(2);
      expect(Number(second.wait_s)).toBeGreaterThan(29 * 60);
      expect(Number(second.wait_s)).toBeLessThanOrEqual(30 * 60);

      for (let i = 0; i < 8; i++) {
        await sql`UPDATE hq.provider_status SET until = now() - interval '1 second' WHERE provider = 'claude'`;
        await sql`SELECT * FROM hq.provider_trip('claude', 'auth', 'x')`;
      }
      const [{ wait_s }] = await sql`SELECT extract(epoch FROM until - now()) AS wait_s FROM hq.provider_status WHERE provider = 'claude'`;
      expect(Number(wait_s)).toBeLessThanOrEqual(6 * 3600);
      expect(Number(wait_s)).toBeGreaterThan(6 * 3600 - 60);
    });

    it('waits a flat 15 minutes on a usage limit', async () => {
      await sql`SELECT * FROM hq.provider_trip('claude', 'limit', 'usage limit')`;
      await sql`UPDATE hq.provider_status SET until = now() - interval '1 second'`;
      const [r] = await sql`SELECT t.*, extract(epoch FROM t.until - now()) AS wait_s FROM hq.provider_trip('claude', 'limit', 'usage limit') t`;
      expect(r.failures).toBe(2);
      expect(Number(r.wait_s)).toBeLessThanOrEqual(15 * 60);
    });

    it('waits until the plan reset time when one is given (clamped to 8 days)', async () => {
      const [r] = await sql`
        SELECT t.*, extract(epoch FROM t.until - now()) AS wait_s
          FROM hq.provider_trip('claude', 'limit', 'usage limit', now() + interval '3 hours') t`;
      expect(Number(r.wait_s)).toBeGreaterThan(3 * 3600 - 60);
      expect(Number(r.wait_s)).toBeLessThanOrEqual(3 * 3600);
      await sql`UPDATE hq.provider_status SET until = now() - interval '1 second'`;
      const [far] = await sql`
        SELECT extract(epoch FROM t.until - now()) AS wait_s
          FROM hq.provider_trip('claude', 'limit', 'x', now() + interval '30 days') t`;
      expect(Number(far.wait_s)).toBeLessThanOrEqual(8 * 86400);
      // an auth failure ignores a reset time
      await sql`DELETE FROM hq.provider_status`;
      const [auth] = await sql`
        SELECT extract(epoch FROM t.until - now()) AS wait_s
          FROM hq.provider_trip('claude', 'auth', 'x', now() + interval '3 hours') t`;
      expect(Number(auth.wait_s)).toBeLessThanOrEqual(15 * 60);
    });

    it('merges plan usage windows, newest reading per window', async () => {
      await sql`SELECT hq.provider_record_windows('claude', ${sql.json({ five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.1 } })})`;
      const [{ w }] = await sql`SELECT hq.provider_record_windows('claude', ${sql.json({ five_hour: { utilization: 0.5 } })}) AS w`;
      expect(w).toEqual({ five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.1 } });
      const [{ state }] = await sql`SELECT state FROM hq.provider_status WHERE provider = 'claude'`;
      expect(state).toBe('ok');
    });

    it('clear reports whether it closed an incident', async () => {
      expect((await sql`SELECT hq.provider_clear('claude') AS c`)[0].c).toBe(false);
      await sql`SELECT * FROM hq.provider_trip('claude', 'auth', 'x')`;
      expect((await sql`SELECT hq.provider_clear('claude') AS c`)[0].c).toBe(true);
      expect((await sql`SELECT hq.provider_clear('claude') AS c`)[0].c).toBe(false);
      const [{ state, failures }] = await sql`SELECT state, failures FROM hq.provider_status WHERE provider = 'claude'`;
      expect(state).toBe('ok');
      expect(failures).toBe(0);
    });
  });

  describe('fire_schedule coalescing', () => {
    const makeSchedule = async (member: string, kind = 'task') => {
      const [s] = await sql`
        INSERT INTO hq.schedules (member_id, name, cron, task_title, task_kind, next_run_at)
        VALUES (${member}, 'nightly', '0 3 * * *', 'Nightly check', ${kind}, now() - interval '1 minute')
        RETURNING id, next_run_at`;
      return s as { id: string; next_run_at: Date };
    };
    const fire = async (id: string) => {
      // Sent as text: a timestamptz parameter goes through a JS Date, which
      // drops the microseconds the slot guard compares exactly.
      const [{ expected }] = await sql`SELECT next_run_at::text AS expected FROM hq.schedules WHERE id = ${id}`;
      const [{ t }] = await sql`
        SELECT hq.fire_schedule(${id}, ${expected}::text::timestamptz, ${expected}::text::timestamptz + interval '1 day', 'Nightly check') AS t`;
      return t as string | null;
    };

    it('skips a slot while the previous run is still queued, and fires again once it waits on a person', async () => {
      const s = await makeSchedule(agentA);
      const first = await fire(s.id);
      expect(first).toBeTruthy();

      expect(await fire(s.id)).toBeNull();
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM hq.tasks WHERE schedule_id = ${s.id}`;
      expect(n).toBe(1);
      const [ev] = await sql`SELECT data FROM hq.events WHERE type = 'schedule_coalesced' ORDER BY id DESC LIMIT 1`;
      expect(ev.data.schedule_id).toBe(s.id);
      const [{ next_run_at }] = await sql`SELECT next_run_at FROM hq.schedules WHERE id = ${s.id}`;
      expect(new Date(next_run_at).getTime()).toBeGreaterThan(new Date(s.next_run_at).getTime());

      await sql`UPDATE hq.tasks SET status = 'blocked' WHERE id = ${first}`;
      expect(await fire(s.id)).toBeTruthy();
    });

    it('counts a manual run-now task of the same schedule as queued', async () => {
      const s = await makeSchedule(agentA);
      await sql`INSERT INTO hq.tasks (title, status, assignee_id, schedule_id) VALUES ('manual', 'todo', ${agentA}, ${s.id})`;
      expect(await fire(s.id)).toBeNull();
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM hq.events WHERE type = 'schedule_coalesced' AND data->>'schedule_id' = ${s.id}`;
      expect(n).toBe(1);
    });
  });

  describe('claim_next_task', () => {
    it('expires an earlier day standup instead of running it, and still claims today’s', async () => {
      const old = await newTask(agentA, { kind: 'standup', createdAgo: '1 day' });
      expect(await claim()).toBeUndefined();
      const [{ status }] = await sql`SELECT status FROM hq.tasks WHERE id = ${old.id}`;
      expect(status).toBe('cancelled');
      expect((await sql`SELECT count(*)::int AS n FROM hq.events WHERE type = 'standup_expired' AND task_id = ${old.id}`)[0].n).toBe(1);

      const today = await newTask(agentA, { kind: 'standup' });
      expect((await claim())?.id).toBe(today.id);
    });

    it('a locked old standup does not stall claims of other tasks', async () => {
      const old = await newTask(agentA, { kind: 'standup', createdAgo: '1 day' });
      const other = await newTask(agentB);
      const result = await sql.begin(async (tx) => {
        await tx`SELECT 1 FROM hq.tasks WHERE id = ${old.id} FOR UPDATE`;
        const claimed = await Promise.race([
          claim(),
          new Promise((resolve) => setTimeout(() => resolve('stalled'), 3000)),
        ]);
        return claimed;
      });
      expect((result as Record<string, any>)?.id).toBe(other.id);
    });

    it('urgent-only mode claims priority 0 work and leaves the rest queued', async () => {
      const normal = await newTask(agentA);
      const urgent = await newTask(agentB);
      await sql`UPDATE hq.tasks SET priority = 0 WHERE id = ${urgent.id}`;
      const first = (await sql`SELECT * FROM hq.claim_next_task('w1', true)`)[0];
      expect(first?.id).toBe(urgent.id);
      expect((await sql`SELECT * FROM hq.claim_next_task('w1', true)`)[0]).toBeUndefined();
      expect((await claim())?.id).toBe(normal.id);
    });

    it('never gives the same agent two tasks under concurrent claims', async () => {
      await newTask(agentA);
      await newTask(agentA);
      const results = await Promise.all([claim(), claim(), claim()]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('finish_task', () => {
    it('returns true again for a retried finish, but not after a person changed the task', async () => {
      await newTask(agentA);
      const t = (await claim())!;
      const finish = async () =>
        (await sql`SELECT hq.finish_task(${t.id}, ${t.claim_token}, 'done', 'ok', false) AS ok`)[0].ok as boolean;
      expect(await finish()).toBe(true);
      expect(await finish()).toBe(true);

      await sql`UPDATE hq.tasks SET status = 'todo' WHERE id = ${t.id}`;
      expect(await finish()).toBe(false);
      await sql`UPDATE hq.tasks SET status = 'done' WHERE id = ${t.id}`;
      expect(await finish()).toBe(false);
    });

    it('a reassignment after the finish also invalidates a retry', async () => {
      await newTask(agentA);
      const t = (await claim())!;
      expect((await sql`SELECT hq.finish_task(${t.id}, ${t.claim_token}, 'done', 'ok', false) AS ok`)[0].ok).toBe(true);
      await sql`UPDATE hq.tasks SET assignee_id = ${agentB} WHERE id = ${t.id}`;
      expect((await sql`SELECT hq.finish_task(${t.id}, ${t.claim_token}, 'done', 'ok', false) AS ok`)[0].ok).toBe(false);
    });

    it('a wrong token never finishes a task', async () => {
      await newTask(agentA);
      const t = (await claim())!;
      expect((await sql`SELECT hq.finish_task(${t.id}, gen_random_uuid(), 'done', 'ok', false) AS ok`)[0].ok).toBe(false);
      const [{ status }] = await sql`SELECT status FROM hq.tasks WHERE id = ${t.id}`;
      expect(status).toBe('in_progress');
    });
  });

  describe('reconcile_stalled', () => {
    it('re-queues a task stuck in progress with no live run and refunds the attempt', async () => {
      await newTask(agentA);
      const t = (await claim())!;
      await sql`UPDATE hq.tasks SET claimed_at = now() - interval '30 minutes' WHERE id = ${t.id}`;
      const [{ r }] = await sql`SELECT hq.reconcile_stalled() AS r`;
      expect(r.map(Number)).toEqual([Number(t.number)]);
      const [row] = await sql`SELECT status, attempts, claim_token FROM hq.tasks WHERE id = ${t.id}`;
      expect(row).toMatchObject({ status: 'todo', attempts: 0, claim_token: null });
    });

    it('leaves a task with a live run alone, but closes a dead run and re-queues', async () => {
      await newTask(agentA);
      const t = (await claim())!;
      await sql`UPDATE hq.tasks SET claimed_at = now() - interval '30 minutes' WHERE id = ${t.id}`;
      const [run] = await sql`
        INSERT INTO hq.runs (member_id, task_id, status, started_at) VALUES (${agentA}, ${t.id}, 'running', now() - interval '5 minutes')
        RETURNING id`;
      expect((await sql`SELECT hq.reconcile_stalled() AS r`)[0].r).toEqual([]);

      await sql`UPDATE hq.runs SET started_at = now() - interval '25 minutes' WHERE id = ${run.id}`;
      expect((await sql`SELECT hq.reconcile_stalled() AS r`)[0].r.map(Number)).toEqual([Number(t.number)]);
      const [{ status }] = await sql`SELECT status FROM hq.runs WHERE id = ${run.id}`;
      expect(status).toBe('failed');
    });

    it('a locked stale task does not stall reconciliation or claims', async () => {
      await newTask(agentA);
      const t = (await claim())!;
      await sql`UPDATE hq.tasks SET claimed_at = now() - interval '1 hour' WHERE id = ${t.id}`;
      const other = await newTask(agentB);
      const result = await sql.begin(async (tx) => {
        await tx`SELECT 1 FROM hq.tasks WHERE id = ${t.id} FOR UPDATE`;
        const reconciled = await Promise.race([
          sql`SELECT hq.reconcile_stalled() AS n`.then((r) => r[0].n),
          new Promise((resolve) => setTimeout(() => resolve('stalled'), 3000)),
        ]);
        const claimed = await Promise.race([claim(), new Promise((resolve) => setTimeout(() => resolve('stalled'), 3000))]);
        return { reconciled, claimed };
      });
      expect(result.reconciled).not.toBe('stalled');
      expect((result.claimed as Record<string, any>)?.id).toBe(other.id);
      // once the lock is gone it is reconciled
      expect((await sql`SELECT hq.reconcile_stalled() AS n`)[0].n).toEqual([String(t.number)]);
    });

    it('ignores fresh claims and refuses a grace shorter than the run limit', async () => {
      await newTask(agentA);
      await claim();
      expect((await sql`SELECT hq.reconcile_stalled() AS r`)[0].r).toEqual([]);
      await expect(sql`SELECT hq.reconcile_stalled(interval '5 minutes')`).rejects.toThrow(/at least 15 minutes/);
    });
  });
});
