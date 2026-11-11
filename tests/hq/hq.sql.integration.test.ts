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
-- as on Supabase: the service role bypasses row-level security
ALTER ROLE service_role BYPASSRLS;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text DEFAULT 'user', is_deleted boolean DEFAULT false,
  nickname text, email text, is_ai boolean DEFAULT false, is_seed boolean DEFAULT false, is_guest boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), country text);
CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text, status text, started_at timestamptz,
  ended_at timestamptz, is_dev boolean DEFAULT false, created_at timestamptz DEFAULT now(), winner_user_id uuid, game_variant text);
CREATE TABLE public.match_players (match_id uuid, user_id uuid, seat int);
CREATE TABLE public.user_identities (id uuid DEFAULT gen_random_uuid(), user_id uuid, provider text, subject text, email text, created_at timestamptz DEFAULT now());
CREATE TABLE public.game_feedback (id uuid DEFAULT gen_random_uuid(), user_id uuid, game text, mode text, rating int, comment text,
  locale text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.daily_challenge_completions (user_id uuid, challenge_type text, completed_at timestamptz, score int);
CREATE TABLE public.guest_daily_completions (guest_id text, challenge_type text, completed_at timestamptz, created_at timestamptz);
CREATE TABLE public.wl_tournaments (id uuid, is_test boolean DEFAULT false, starts_at timestamptz);
CREATE TABLE public.wl_answers (tournament_id uuid, user_id uuid, answered_at timestamptz, created_at timestamptz);
CREATE TABLE public.duel_matches (id uuid, started_at timestamptz, created_at timestamptz, game text);
CREATE TABLE public.duel_participants (match_id uuid, user_id uuid);
CREATE TABLE public.room_matches (id uuid, started_at timestamptz, created_at timestamptz, room_id uuid, game text);
CREATE TABLE public.room_seats (match_id uuid, user_id uuid, room_id uuid, admitted boolean DEFAULT true);
CREATE TABLE public.pistas_days (day date PRIMARY KEY);
CREATE TABLE public.dato_falso_days (day date PRIMARY KEY);
CREATE TABLE public.football_grid_matches (id uuid DEFAULT gen_random_uuid(), status text, created_at timestamptz DEFAULT now());
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
      const at = (m: number) => new Date(Date.UTC(2026, 10, 10, 10, m)).toISOString();
      await sql`SELECT hq.provider_record_windows('claude', ${sql.json({ five_hour: { utilization: 0.2, seen_at: at(0) }, seven_day: { utilization: 0.1, seen_at: at(0) } })})`;
      const [{ w }] = await sql`SELECT hq.provider_record_windows('claude', ${sql.json({ five_hour: { utilization: 0.9, seen_at: at(5) } })}) AS w`;
      expect(w.five_hour.utilization).toBe(0.9);
      expect(w.seven_day.utilization).toBe(0.1);
      // a late run's older reading does not roll usage back
      const [{ w: after }] = await sql`SELECT hq.provider_record_windows('claude', ${sql.json({ five_hour: { utilization: 0.4, seen_at: at(2) } })}) AS w`;
      expect(after.five_hour.utilization).toBe(0.9);
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

    it("a run from an earlier claim doesn't count against the current one", async () => {
      await newTask(agentA);
      const t = (await claim())!;
      await sql`UPDATE hq.tasks SET claimed_at = now() - interval '30 minutes' WHERE id = ${t.id}`;
      await sql`INSERT INTO hq.runs (member_id, task_id, status, started_at) VALUES (${agentA}, ${t.id}, 'failed', now() - interval '30 minutes 20 seconds')`;
      await sql`SELECT hq.reconcile_stalled()`;
      expect((await sql`SELECT status, attempts FROM hq.tasks WHERE id = ${t.id}`)[0]).toMatchObject({ status: 'todo', attempts: 0 });
    });

    it('keeps the attempt of a run that started, and blocks after the third', async () => {
      await newTask(agentA);
      for (let i = 1; i <= 3; i++) {
        const t = (await claim())!;
        await sql`UPDATE hq.tasks SET claimed_at = now() - interval '30 minutes' WHERE id = ${t.id}`;
        await sql`INSERT INTO hq.runs (member_id, task_id, status, started_at) VALUES (${agentA}, ${t.id}, 'failed', now() - interval '29 minutes')`;
        await sql`SELECT hq.reconcile_stalled()`;
        const [row] = await sql`SELECT status, attempts FROM hq.tasks WHERE id = ${t.id}`;
        expect(row).toMatchObject({ status: i < 3 ? 'todo' : 'blocked', attempts: i });
      }
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

  describe('daily coverage', () => {
    it('reports days left and missing days per daily game, soonest first', async () => {
      await sql`DELETE FROM public.pistas_days`;
      await sql`DELETE FROM public.dato_falso_days`;
      await sql`INSERT INTO public.pistas_days SELECT d::date FROM generate_series((now() AT TIME ZONE 'Asia/Tbilisi')::date, (now() AT TIME ZONE 'Asia/Tbilisi')::date + 29, interval '1 day') d`;
      await sql`INSERT INTO public.dato_falso_days SELECT d::date FROM generate_series((now() AT TIME ZONE 'Asia/Tbilisi')::date, (now() AT TIME ZONE 'Asia/Tbilisi')::date + 4, interval '1 day') d`;
      const [{ c }] = await sql`SELECT hq.daily_coverage() AS c`;
      expect(c.map((r: any) => r.game)).toEqual(['dato_falso', 'pistas']);
      expect(c[0]).toMatchObject({ days_left: 5, missing_next_14_days: 9 });
      const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
      const inDays = (n: number) => new Date(Date.parse(today) + n * 86_400_000).toISOString().slice(0, 10);
      expect(c[0].runs_out_on).toBe(inDays(5));
      expect(c[1]).toMatchObject({ days_left: 30, missing_next_14_days: 0 });
      // a hole tomorrow is the date that matters, even with a month scheduled after it
      await sql`DELETE FROM public.pistas_days WHERE day = ${inDays(1)}::date`;
      const [{ c: again }] = await sql`SELECT hq.daily_coverage() AS c`;
      expect(again.find((r: any) => r.game === 'pistas').runs_out_on).toBe(inDays(1));
    });

    it('keeps a daily history of weekly active players (registered + guest)', async () => {
      await sql`DELETE FROM public.match_players`;
      await sql`DELETE FROM public.matches`;
      await sql`DELETE FROM public.guest_daily_completions`;
      await sql`DELETE FROM public.user_identities`;
      await sql`DELETE FROM public.users`;
      await sql`DELETE FROM hq.activity_days`;
      await sql`UPDATE hq.activity_rollup_state SET computed_from = NULL, complete_through = NULL, refreshed_at = NULL`;
      const [u1] = await sql`INSERT INTO public.users (nickname) VALUES ('u1') RETURNING id`;
      const [u2] = await sql`INSERT INTO public.users (nickname) VALUES ('u2') RETURNING id`;
      const play = async (user: string, daysAgo: number) => {
        const [m] = await sql`INSERT INTO public.matches (mode, status, started_at) VALUES ('ranked', 'completed', now() - make_interval(days => ${daysAgo})) RETURNING id`;
        await sql`INSERT INTO public.match_players (match_id, user_id, seat) VALUES (${m.id}, ${user}, 1)`;
      };
      await play(u1.id, 0);
      await play(u2.id, 9);
      await sql`INSERT INTO public.guest_daily_completions (guest_id, challenge_type, completed_at, created_at)
                VALUES ('guest-1', 'pistas', now() - interval '3 days', now() - interval '3 days')`;
      const [{ h }] = await sql`SELECT hq.wau_history(14) AS h`;
      expect(h.series).toHaveLength(14);
      const today = h.series[13];
      expect(today).toMatchObject({ wau_all: 2, wau_registered: 1 });
      expect(h.series[13 - 8]).toMatchObject({ wau_all: 1, wau_registered: 1 });
      expect(h.series[0]).toMatchObject({ wau_all: 0, wau_registered: 0 });

      // A guest who played a match as a guest account counts as a guest player.
      const [guest] = await sql`INSERT INTO public.users (nickname, is_guest) VALUES ('guest', true) RETURNING id`;
      await play(guest.id, 1);
      await sql`UPDATE hq.activity_rollup_state SET computed_from = NULL, complete_through = NULL, refreshed_at = NULL`;
      await sql`DELETE FROM hq.activity_days`;
      const [{ h: again }] = await sql`SELECT hq.wau_history(14) AS h`;
      expect(again.series[13]).toMatchObject({ wau_all: 3, wau_registered: 1 });

      // The same guest also played a daily as guest session 'guest-1': linked, it is one player, not two.
      await sql`INSERT INTO public.user_identities (user_id, provider, subject) VALUES (${guest.id}, 'guest', 'guest-1')`;
      await sql`UPDATE hq.activity_rollup_state SET computed_from = NULL, complete_through = NULL, refreshed_at = NULL`;
      await sql`DELETE FROM hq.activity_days`;
      const [{ h: linked }] = await sql`SELECT hq.wau_history(14) AS h`;
      expect(linked.series[13]).toMatchObject({ wau_all: 2, wau_registered: 1 });
    });

    it('the security and performance reports run read-only and the two engineers are seeded paused', async () => {
      await sql`CREATE TABLE IF NOT EXISTS public.open_table (id int)`;
      const [{ r: sec }] = await sql`SELECT hq.security_db_report() AS r`;
      expect(sec.public_tables_without_rls.map((t: any) => t.table)).toContain('open_table');
      expect(Array.isArray(sec.security_definer_functions_without_search_path)).toBe(true);
      const [{ r: perf }] = await sql`SELECT hq.perf_db_report(5) AS r`;
      expect(perf).toHaveProperty('largest_tables');
      expect(perf).toHaveProperty('top_statements_by_total_time');
      const rows = await sql`SELECT slug, status, tier, tools FROM hq.members WHERE slug IN ('security-engineer', 'performance-engineer') ORDER BY slug`;
      expect(rows.map((r: any) => [r.slug, r.status, r.tier])).toEqual([['performance-engineer', 'paused', 'read'], ['security-engineer', 'paused', 'read']]);
    });

    it('seeds the three new agents paused, with their schedules and standups', async () => {
      const rows = await sql`SELECT slug, status, tier FROM hq.members WHERE slug IN ('daily-games-checker','content-qa','community-manager') ORDER BY slug`;
      expect(rows).toEqual([
        { slug: 'community-manager', status: 'paused', tier: 'read' },
        { slug: 'content-qa', status: 'paused', tier: 'read' },
        { slug: 'daily-games-checker', status: 'paused', tier: 'read' },
      ]);
    });
  });

  describe('executive director', () => {
    let director: string;
    let founder: string;
    beforeEach(async () => {
      await sql`DELETE FROM hq.build_jobs`;
      await sql`DELETE FROM hq.build_requests`;
      await sql`DELETE FROM hq.members WHERE slug = 't-founder'`;
      [{ id: founder }] = await sql`INSERT INTO hq.members (slug, kind, name, runtime) VALUES ('t-founder', 'human', 'Founder', 'none') RETURNING id`;
      [{ id: director }] = await sql`UPDATE hq.members SET status = 'active' WHERE slug = 'director' RETURNING id`;
      await sql`UPDATE hq.members SET tier = 'read' WHERE id IN (${agentA}, ${agentB})`;
    });

    let ideaN = 0;
    const proposal = async (assignee: string, effort = 's') => {
      const [t] = await sql`
        INSERT INTO hq.tasks (title, status, kind, assignee_id, proposal)
        VALUES (${`idea ${++ideaN}`}, 'proposed', 'proposal', ${assignee}, ${sql.json({ effort })})
        RETURNING id, number, updated_at::text AS v`;
      return t as { id: string; number: string; v: string };
    };
    // The director's own running review task (its claim fences every decision).
    const directorRun = async () => {
      const [t] = await sql`
        INSERT INTO hq.tasks (title, status, kind, assignee_id, claim_token, claimed_by, claimed_at)
        VALUES ('review', 'in_progress', 'task', ${director}, gen_random_uuid(), 'w1', now())
        RETURNING id, claim_token`;
      return t as { id: string; claim_token: string };
    };
    const decide = (run: { id: string; claim_token: string }, p: { id: string; v: string }, decision: string, note: string | null = 'because') =>
      sql`SELECT hq.director_decide_proposal(${director}, ${run.id}, ${run.claim_token}, ${p.id}, ${p.v}::text::timestamptz, ${decision}, ${note}) AS s`
        .then((r) => r[0].s as string);

    it('a deployed worker never claims chats or briefs', async () => {
      await sql`INSERT INTO hq.tasks (title, kind, status, assignee_id, priority) VALUES ('c', 'chat', 'todo', ${director}, 0), ('b', 'brief', 'todo', ${director}, 2)`;
      expect(await claim()).toBeUndefined();
      const [c] = await sql`SELECT * FROM hq.claim_next_task('w2', false, ARRAY['task','standup','proposal','chat','brief'])`;
      expect(c.kind).toBe('chat');
    });

    it("never claims an 'act' agent's task without a person's approval", async () => {
      await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentA}`;
      const t = await newTask(agentA);
      expect(await claim()).toBeUndefined();
      await sql`UPDATE hq.tasks SET founder_approved_at = now() WHERE id = ${t.id}`;
      expect((await claim())?.id).toBe(t.id);
    });

    it('a chat runs beside a review sweep, one chat at a time', async () => {
      await directorRun();
      const kinds = sql`ARRAY['task','standup','proposal','chat','brief']`;
      await sql`INSERT INTO hq.tasks (title, kind, status, assignee_id, priority, created_by_id) VALUES ('c1', 'chat', 'todo', ${director}, 0, ${founder})`;
      const [c1] = await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`;
      expect(c1?.kind).toBe('chat');
      await sql`INSERT INTO hq.tasks (title, kind, status, assignee_id, priority, created_by_id) VALUES ('c2', 'chat', 'todo', ${director}, 0, ${founder})`;
      expect((await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`)[0]).toBeUndefined();
    });

    it('approves only small ideas for active research agents, on the version it read', async () => {
      const run = await directorRun();
      const big = await proposal(agentA, 'l');
      await expect(decide(run, big, 'approve')).rejects.toThrow(/large ideas need the founder/);
      await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentB}`;
      const risky = await proposal(agentB);
      await expect(decide(run, risky, 'approve')).rejects.toThrow(/only the founder approves/);
      const mine = await proposal(director);
      await expect(decide(run, mine, 'approve')).rejects.toThrow(/your own ideas/);

      const small = await proposal(agentA);
      await sql`UPDATE hq.tasks SET body = 'edited by the founder', updated_at = now() + interval '1 second' WHERE id = ${small.id}`;
      await expect(decide(run, small, 'approve')).rejects.toThrow(/changed since you read it/);
      const [{ v }] = await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${small.id}`;
      expect(await decide(run, { ...small, v }, 'approve', null)).toBe('todo');
      const [row] = await sql`SELECT status, director_decision FROM hq.tasks WHERE id = ${small.id}`;
      expect(row).toMatchObject({ status: 'todo', director_decision: 'approved' });
    });

    it('a cancelled director run decides nothing', async () => {
      const run = await directorRun();
      const p = await proposal(agentA);
      await sql`UPDATE hq.tasks SET status = 'cancelled', claim_token = NULL WHERE id = ${run.id}`;
      await expect(decide(run, p, 'approve')).rejects.toThrow(/no longer holds its task/);
      expect((await sql`SELECT status FROM hq.tasks WHERE id = ${p.id}`)[0].status).toBe('proposed');
    });

    it('decline tells the agent why; escalate hands the idea to the founder for good', async () => {
      const run = await directorRun();
      const p = await proposal(agentA);
      await expect(decide(run, p, 'decline', '  ')).rejects.toThrow(/say why/);
      expect(await decide(run, p, 'decline', 'duplicate of #3')).toBe('cancelled');
      const [m] = await sql`SELECT recipient_id, body FROM hq.messages WHERE task_id = ${p.id}`;
      expect(m).toMatchObject({ recipient_id: agentA, body: 'Not now: duplicate of #3' });

      const q = await proposal(agentB);
      expect(await decide(run, q, 'escalate', 'touches pricing')).toBe('proposed');
      const [{ v }] = await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${q.id}`;
      await expect(decide(run, { ...q, v }, 'approve')).rejects.toThrow(/only the founder decides/);
    });

    it('reviews finished work: accept, send back at most twice, fresh review after each new result', async () => {
      const run = await directorRun();
      const t = await newTask(agentA, { status: 'done' });
      const version = async () => (await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${t.id}`)[0].v as string;
      const review = async (verdict: string, note: string | null = 'numbers missing') =>
        (await sql`SELECT hq.director_review_work(${director}, ${run.id}, ${run.claim_token}, ${t.id}, ${await version()}::text::timestamptz, ${verdict}, ${note}) AS s`)[0].s;
      const redo = () => sql`UPDATE hq.tasks SET status = 'done', completed_at = now() WHERE id = ${t.id}`;

      expect(await review('reopen')).toBe('reopened');
      await redo();
      expect((await sql`SELECT review_state FROM hq.tasks WHERE id = ${t.id}`)[0].review_state).toBeNull();
      expect(await review('reopen')).toBe('reopened');
      await redo();
      await expect(review('reopen')).rejects.toThrow(/sent back twice/);
      expect(await review('accept', null)).toBe('accepted');
      await expect(review('accept', null)).rejects.toThrow(/not finished work waiting/);
    });

    it("reviews the quiz-page agent's pages and may send them back, unlike other 'act' agents' work", async () => {
      const run = await directorRun();
      const [qp] = await sql`UPDATE hq.members SET status = 'active' WHERE slug = 'quiz-pages' RETURNING id, tier`;
      expect(qp.tier).toBe('act');
      await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentA}`;
      const page = await newTask(qp.id, { status: 'done' });
      const other = await newTask(agentA, { status: 'done' });
      expect((await sql`SELECT id FROM hq.director_unreviewed_work(15)`).map((r) => r.id).sort()).toEqual([page.id, other.id].sort());
      const review = async (t: { id: string }, verdict: string, note: string | null) => {
        const [{ v }] = await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${t.id}`;
        return (await sql`SELECT hq.director_review_work(${director}, ${run.id}, ${run.claim_token}, ${t.id}, ${v}::text::timestamptz, ${verdict}, ${note}) AS s`)[0].s;
      };
      expect(await review(page, 'reopen', 'Fix the German lede')).toBe('reopened');
      await expect(review(other, 'reopen', 'numbers missing')).rejects.toThrow(/only work by an active research agent/);
      expect((await sql`SELECT status, review_state, reopen_count FROM hq.tasks WHERE id = ${page.id}`)[0])
        .toMatchObject({ status: 'todo', review_state: 'reopened', reopen_count: 1 });
      await sql`UPDATE hq.tasks SET status = 'done', completed_at = now() WHERE id = ${page.id}`;
      expect(await review(page, 'reopen', 'Still formal')).toBe('reopened');
      await sql`UPDATE hq.tasks SET status = 'done', completed_at = now() WHERE id = ${page.id}`;
      await expect(review(page, 'reopen', 'Once more')).rejects.toThrow(/sent back twice/);
      await sql`UPDATE hq.members SET status = 'paused' WHERE slug = 'quiz-pages'`;
    });

    it('chat: messages join the queued chat, a claimed one is never joined, the reply lands once', async () => {
      const send = async (body: string) => (await sql`SELECT * FROM hq.director_chat_send(${founder}, ${body})`)[0] as { message_id: string; task_id: string };
      const a = await send('hi');
      const b = await send('also this');
      expect(b.task_id).toBe(a.task_id);
      const kinds = sql`ARRAY['task','standup','proposal','chat','brief']`;
      const [run] = await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`;
      expect(run.id).toBe(a.task_id);
      const c = await send('one more');
      expect(c.task_id).not.toBe(a.task_id);

      const finish = async () => (await sql`SELECT hq.finish_chat(${run.id}, ${run.claim_token}, 'Here you go', ${b.message_id}) AS ok`)[0].ok;
      expect(await finish()).toBe(true);
      expect(await finish()).toBe(true);
      const replies = await sql`SELECT author_id, recipient_id FROM hq.messages WHERE task_id = ${run.id} AND kind = 'result'`;
      expect(replies).toEqual([{ author_id: director, recipient_id: founder }]);
      expect((await sql`SELECT chat_upto::text AS u FROM hq.tasks WHERE id = ${run.id}`)[0].u).toBe(String(b.message_id));
      expect((await sql`SELECT hq.finish_chat(${run.id}, gen_random_uuid(), 'x', 1) AS ok`)[0].ok).toBe(false);
    });

    it("lists only agents' unreviewed work, however much people's work is done", async () => {
      for (let i = 0; i < 60; i++) await newTask(founder, { status: 'done' });
      const mine = await newTask(agentA, { status: 'done' });
      await sql`UPDATE hq.tasks SET completed_at = now() WHERE id = ${mine.id}`;
      const rows = await sql`SELECT * FROM hq.director_unreviewed_work(15)`;
      expect(rows.map((r) => r.id)).toEqual([mine.id]);
    });

    it('decisions work for the service role the worker uses', async () => {
      const run = await directorRun();
      const p = await proposal(agentA);
      const status = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE service_role`;
        const [r] = await tx`SELECT hq.director_decide_proposal(${director}, ${run.id}, ${run.claim_token}, ${p.id}, ${p.v}::text::timestamptz, 'approve', null) AS s`;
        return r.s;
      });
      expect(status).toBe('todo');
    });

    it('a chat sent back to the queue merges into a newer queued chat', async () => {
      const kinds = sql`ARRAY['task','standup','proposal','chat','brief']`;
      await sql`SELECT * FROM hq.director_chat_send(${founder}, 'first')`;
      const [a] = await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`;
      const [{ task_id: b }] = await sql`SELECT * FROM hq.director_chat_send(${founder}, 'second')`;
      expect((await sql`SELECT hq.finish_task(${a.id}, ${a.claim_token}, 'todo', null, true) AS ok`)[0].ok).toBe(true);
      const rows = await sql`SELECT id, status FROM hq.tasks WHERE kind = 'chat' ORDER BY created_at`;
      expect(rows).toEqual([{ id: a.id, status: 'cancelled' }, { id: b, status: 'todo' }]);
      // a retried finish of the merged chat still reports success
      expect((await sql`SELECT hq.finish_task(${a.id}, ${a.claim_token}, 'todo', null, true) AS ok`)[0].ok).toBe(true);
      // with nothing else queued, a retry goes back to the queue as usual
      const [b2] = await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`;
      await sql`SELECT hq.finish_task(${b2.id}, ${b2.claim_token}, 'todo', null, true)`;
      expect((await sql`SELECT status FROM hq.tasks WHERE id = ${b2.id}`)[0].status).toBe('todo');
    });

    it("a person's approval of a result is not undone by the review reset", async () => {
      const t = await newTask(agentA, { status: 'needs_approval' });
      await sql`UPDATE hq.tasks SET status = 'done', review_state = 'accepted', reviewed_at = now() WHERE id = ${t.id}`;
      expect((await sql`SELECT review_state FROM hq.tasks WHERE id = ${t.id}`)[0].review_state).toBe('accepted');
    });

    it('escalates any open task to the founder, once, on the version it read', async () => {
      const run = await directorRun();
      const t = await newTask(agentA);
      const [{ v }] = await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${t.id}`;
      const esc = (note: string | null) =>
        sql`SELECT hq.director_escalate_task(${director}, ${run.id}, ${run.claim_token}, ${t.id}, ${v}::text::timestamptz, ${note}) AS s`;
      await expect(esc(null)).rejects.toThrow(/what the founder must decide/);
      expect((await esc('needs a budget call'))[0].s).toBe('todo');
      await expect(esc('again')).rejects.toThrow(/already sent|changed since/);
      const [row] = await sql`SELECT status, escalated_at IS NOT NULL AS up FROM hq.tasks WHERE id = ${t.id}`;
      expect(row).toEqual({ status: 'todo', up: true });
    });

    it("today's plan: items wait for the founder, the director can't approve them, max 8 a day", async () => {
      const run = await directorRun();
      const plan = (title: string) =>
        sql`SELECT * FROM hq.director_plan_item(${director}, ${run.id}, ${run.claim_token}, ${title}, 'do it', 'because', ${agentA})`;
      const [{ id }] = await plan('Fix the funnel copy');
      const [row] = await sql`SELECT status, kind, escalated_at IS NOT NULL AS up, updated_at::text AS v FROM hq.tasks WHERE id = ${id}`;
      expect(row).toMatchObject({ status: 'proposed', kind: 'proposal', up: true });
      await expect(decide(run, { id, v: row.v }, 'approve')).rejects.toThrow(/only the founder decides/);
      for (let i = 2; i <= 8; i++) await plan(`Plan item ${i}`);
      await expect(plan('Ninth')).rejects.toThrow(/already has 8 items/);
    });

    it("Romero starts his own plan items for himself or read-only agents, never for agents that change things", async () => {
      await sql`DELETE FROM hq.tasks WHERE created_by_id = ${director} AND kind = 'proposal'`;
      await sql`UPDATE hq.members SET status = 'active', role = 'agent', runtime = 'hq', tier = 'read' WHERE id = ${agentA}`;
      await sql`UPDATE hq.members SET status = 'active', role = 'agent', runtime = 'hq', tier = 'act' WHERE id = ${agentB}`;
      const run = await directorRun();
      const plan = (title: string, assignee: string | null, start: boolean) =>
        sql`SELECT * FROM hq.director_plan_item(${director}, ${run.id}, ${run.claim_token}, ${title}, 'do it', 'because', ${assignee}, ${start})`;
      const [a] = await plan('Check the Grid fix holds', agentA, true);
      expect(a.started).toBe(true);
      const [row] = await sql`SELECT status, escalated_at, director_decision FROM hq.tasks WHERE id = ${a.id}`;
      expect(row).toEqual({ status: 'todo', escalated_at: null, director_decision: 'approved' });
      const [own] = await plan('Watch D1 for a week', null, true);
      expect((await sql`SELECT status, assignee_id FROM hq.tasks WHERE id = ${own.id}`)[0]).toEqual({ status: 'todo', assignee_id: director });
      await expect(plan('Ship the new banner', agentB, true)).rejects.toThrow(/cannot start on your say alone/);
      await sql`UPDATE hq.members SET tools = ARRAY['metrics', 'content_fixer'] WHERE id = ${agentA}`;
      await expect(plan('Fix the content gaps', agentA, true)).rejects.toThrow(/cannot start on your say alone/);
      await sql`UPDATE hq.members SET tools = ARRAY['metrics'] WHERE id = ${agentA}`;
      await sql`UPDATE hq.members SET status = 'paused' WHERE id = ${agentA}`;
      await expect(plan('While it is off', agentA, true)).rejects.toThrow(/cannot start on your say alone/);
      await sql`UPDATE hq.members SET status = 'active' WHERE id = ${agentA}`;

      const [waiting] = await plan('Second-source check', agentA, false);
      const [actWaiting] = await plan('Publish the page', agentB, false);
      const ver = async (id: string) => (await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${id}`)[0].v as string;
      const start = (id: string, v: string, note: string) =>
        sql`SELECT hq.director_start_plan_item(${director}, ${run.id}, ${run.claim_token}, ${id}, ${v}::text::timestamptz, ${note}) AS n`;
      await expect(start(waiting.id, await ver(waiting.id), 'ok')).rejects.toThrow(/say why/);
      await expect(start(waiting.id, '2000-01-01', 'Worth it now: the Verifier reaches one publisher only.')).rejects.toThrow(/changed since/);
      expect(Number((await start(waiting.id, await ver(waiting.id), 'Worth it now: the Verifier reaches one publisher only.'))[0].n)).toBe(Number(waiting.number));
      expect((await sql`SELECT status, escalated_at FROM hq.tasks WHERE id = ${waiting.id}`)[0]).toEqual({ status: 'todo', escalated_at: null });
      await expect(start(actWaiting.id, await ver(actWaiting.id), 'Worth it now: the page is ready to go out.')).rejects.toThrow(/stays with the founder/);
      const other = await proposal(agentA);
      await expect(start(other.id, other.v, 'Not mine, but I would like to start it.')).rejects.toThrow(/only your own plan items/);
      await sql`UPDATE hq.members SET tier = 'read' WHERE id = ${agentB}`;
    });

    it('growth report: sign-ups by country, next-day comeback by first game, bot wins, daily actives', async () => {
      await sql`DELETE FROM public.match_players`;
      await sql`DELETE FROM public.matches`;
      // Tbilisi noon, N days ago
      const at = (n: number) => sql`SELECT ((((now() AT TIME ZONE 'Asia/Tbilisi')::date - ${n}::int) + time '12:00') AT TIME ZONE 'Asia/Tbilisi') AS t`.then((r) => r[0].t);
      const mk = async (country: string) => (await sql`INSERT INTO public.users (country, created_at) VALUES (${country}, now() - interval '5 days') RETURNING id`)[0].id;
      const [a, b, c, d2] = [await mk('BR'), await mk('BR'), await mk('BR'), await mk('BR')];
      const [{ id: bot }] = await sql`INSERT INTO public.users (is_ai, created_at) VALUES (true, now() - interval '30 days') RETURNING id`;
      const match = async (user: string, mode: string, daysAgo: number, extra: { winner?: string; variant?: string; dev?: boolean } = {}) => {
        const t = await at(daysAgo);
        const [m] = await sql`INSERT INTO public.matches (mode, status, started_at, ended_at, winner_user_id, game_variant, is_dev)
          VALUES (${mode}, 'completed', ${t}, ${t}::timestamptz + interval '12 minutes', ${extra.winner ?? null}, ${extra.variant ?? null}, ${extra.dev ?? false}) RETURNING id`;
        await sql`INSERT INTO public.match_players (match_id, user_id) VALUES (${m.id}, ${user})`;
      };
      await match(a, 'auction', 4, { winner: bot });  // first game auction, back next day (D1)
      await match(a, 'ranked', 3);
      await match(b, 'auction', 4);                    // back only on D2: not a comeback
      await match(b, 'ranked', 2);
      await match(c, 'auction', 4);                    // back on D1 but in a dev match: not a comeback
      await match(c, 'ranked', 3, { dev: true });
      await match(d2, 'friendly', 1, { variant: 'grid' }); // first played yesterday: next day not over, not in the cohort
      const [{ r }] = await sql`SELECT hq.growth_report(7) AS r`;
      expect(r.signups_by_country.find((x: any) => x.country === 'BR')).toMatchObject({ now: 4 });
      expect(r.first_game_comeback).toEqual([{ game: 'auction', new_players: 3, came_back_next_day_pct: 33, first_match_abandoned_pct: 0 }]);
      expect(r.games.find((g: any) => g.game === 'auction')).toMatchObject({ matches: 3, bot_wins_pct: 100, median_minutes: 12 });
      expect(r.games.find((g: any) => g.game === 'friendly:grid')).toMatchObject({ matches: 1 });
      expect(r.daily_active_players).toHaveLength(14);
      await sql`DELETE FROM public.match_players`;
      await sql`DELETE FROM public.matches`;
      await sql`DELETE FROM public.users WHERE id IN (${a}, ${b}, ${c}, ${d2}, ${bot})`;
    });

    it('health snapshot: aggregates only, against a week ago', async () => {
      await sql`DELETE FROM public.matches`;
      await sql`INSERT INTO public.matches (status, started_at) VALUES ('completed', now() - interval '5 minutes'), ('abandoned', now() - interval '10 minutes'), ('completed', now() - interval '7 days 10 minutes')`;
      const [{ h }] = await sql`SELECT hq.health_snapshot() AS h`;
      expect(h).toMatchObject({ matches_30m: 2, matches_30m_week_ago: 1, matches_abandoned_60m: 1 });
      expect(h.games).toMatchObject({ 'classic:?': [2, 1], grid: [0, 0] });
      await sql`INSERT INTO public.room_matches (started_at, game) VALUES (now() - interval '5 minutes', 'tenable'), (now() - interval '7 days 5 minutes', 'imposter')`;
      const [{ h: h2 }] = await sql`SELECT hq.health_snapshot() AS h`;
      expect(h2.games).toMatchObject({ 'rooms:tenable': [1, 0], 'rooms:imposter': [0, 1] });
      await sql`DELETE FROM public.room_matches`;
      expect(Object.keys(h)).toEqual(expect.arrayContaining(['connections', 'max_connections', 'idle_in_txn_over_60s', 'longest_active_query_s', 'waiting_on_locks', 'db', 'signups_60m']));
      const [sentinel] = await sql`SELECT status, tier, tools FROM hq.members WHERE slug = 'sentinel'`;
      expect(sentinel).toMatchObject({ status: 'paused', tier: 'read' });
      await sql`DELETE FROM public.matches`;
    });

    it('progress updates reach the people who chat with the director, capped per day', async () => {
      expect((await sql`SELECT hq.director_post_update(${director}, null, 'Started the review') AS n`)[0].n).toBe(0);
      await sql`SELECT * FROM hq.director_chat_send(${founder}, 'hi')`;
      expect((await sql`SELECT hq.director_post_update(${director}, null, 'Started the review') AS n`)[0].n).toBe(1);
      const [m] = await sql`SELECT recipient_id, kind, channel FROM hq.messages WHERE author_id = ${director} ORDER BY id DESC LIMIT 1`;
      expect(m).toEqual({ recipient_id: founder, kind: 'comment', channel: 'director' });
    });

    it('a follow-up joins the queued chat turn or starts one', async () => {
      const a = (await sql`SELECT hq.director_chat_followup(${founder}, 'GPT answered #12') AS t`)[0].t;
      const b = (await sql`SELECT hq.director_chat_followup(${founder}, '#13 finished') AS t`)[0].t;
      expect(b).toBe(a);
      expect((await sql`SELECT body FROM hq.tasks WHERE id = ${a}`)[0].body).toBe('GPT answered #12\n\n#13 finished');
    });

    it('a merged chat hands its pending notes and depth to the surviving one', async () => {
      const kinds = sql`ARRAY['task','standup','proposal','chat','brief']`;
      await sql`SELECT hq.director_chat_followup(${founder}, 'GPT answered #12', 2)`;
      const [a] = await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`;
      const [{ task_id: b }] = await sql`SELECT * FROM hq.director_chat_send(${founder}, 'and?')`;
      await sql`SELECT hq.finish_task(${a.id}, ${a.claim_token}, 'todo', null, true)`;
      const [row] = await sql`SELECT body, depth FROM hq.tasks WHERE id = ${b}`;
      expect(row).toEqual({ body: 'GPT answered #12', depth: 2 });
    });

    it('briefs reach the founder even after the daily update allowance is used', async () => {
      await sql`SELECT * FROM hq.director_chat_send(${founder}, 'hi')`;
      const [t] = await sql`INSERT INTO hq.tasks (title, kind, status, assignee_id) VALUES ('r', 'task', 'done', ${director}) RETURNING id`;
      const [b] = await sql`INSERT INTO hq.tasks (title, kind, status, assignee_id) VALUES ('Morning brief', 'brief', 'done', ${director}) RETURNING id`;
      for (let i = 0; i < 40; i++) await sql`SELECT hq.director_post_update(${director}, ${t.id}, ${`note ${i}`})`;
      expect((await sql`SELECT hq.director_post_update(${director}, ${t.id}, 'one more') AS n`)[0].n).toBe(0);
      expect((await sql`SELECT hq.director_post_update(${director}, ${b.id}, 'the brief', true) AS n`)[0].n).toBe(1);
    });

    it('automatic deliveries are idempotent per key', async () => {
      await sql`SELECT * FROM hq.director_chat_send(${founder}, 'hi')`;
      const [t] = await sql`INSERT INTO hq.tasks (title, kind, status, assignee_id) VALUES ('r', 'task', 'done', ${director}) RETURNING id`;
      const post = () => sql`SELECT hq.director_post_update(${director}, ${t.id}, 'Done: r', false, 'k1') AS n`.then((r) => r[0].n);
      expect(await post()).toBe(1);
      expect(await post()).toBe(0);
      const deliver = () => sql`SELECT hq.deliver_message(${t.id}, ${agentA}, ${director}, 'Answer', 'a1') AS ok`.then((r) => r[0].ok);
      expect(await deliver()).toBe(true);
      expect(await deliver()).toBe(false);
      const fu = () => sql`SELECT hq.director_chat_followup(${founder}, 'GPT answered #3', 0, 'f1') AS t`.then((r) => r[0].t);
      await fu();
      expect(await fu()).toBeNull();
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM hq.tasks WHERE kind = 'chat' AND body LIKE '%GPT answered #3%'`;
      expect(n).toBe(1);
    });

    it('a long backlog of founder messages gets another chat turn', async () => {
      const kinds = sql`ARRAY['task','standup','proposal','chat','brief']`;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await sql`SELECT * FROM hq.director_chat_send(${founder}, ${`m${i}`})`)[0].message_id);
      const [run] = await sql`SELECT * FROM hq.claim_next_task('w1', false, ${kinds})`;
      await sql`SELECT hq.finish_chat(${run.id}, ${run.claim_token}, 'answered the first two', ${ids[1]})`;
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM hq.tasks WHERE kind = 'chat' AND status = 'todo'`;
      expect(n).toBe(1);
    });

    it('notes keep the newest text when they outgrow the limit', async () => {
      await sql`SELECT hq.director_chat_followup(${founder}, ${'x'.repeat(7999)})`;
      await sql`SELECT hq.director_chat_followup(${founder}, 'NEWEST')`;
      const [{ body }] = await sql`SELECT body FROM hq.tasks WHERE kind = 'chat' AND status = 'todo'`;
      expect(body.endsWith('NEWEST')).toBe(true);
      expect(body.length).toBe(8000);
    });

    it('cancels open research work on the version it read, never founder items or act-agent work', async () => {
      const run = await directorRun();
      const version = async (id: string) => (await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${id}`)[0].v as string;
      const cancel = async (id: string, note: string | null = 'founder said drop it') =>
        (await sql`SELECT hq.director_cancel_task(${director}, ${run.id}, ${run.claim_token}, ${id}, ${await version(id)}::text::timestamptz, ${note}) AS s`)[0].s;
      const t = await newTask(agentA);
      await expect(cancel(t.id, ' ')).rejects.toThrow(/say why/);
      expect(await cancel(t.id)).toBe('cancelled');
      expect((await sql`SELECT body FROM hq.messages WHERE task_id = ${t.id}`)[0].body).toBe('Cancelled: founder said drop it');

      const up = await newTask(agentA);
      await sql`UPDATE hq.tasks SET escalated_at = now() WHERE id = ${up.id}`;
      await expect(cancel(up.id)).rejects.toThrow(/waiting for the founder/);
      await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentB}`;
      const act = await newTask(agentB);
      await expect(cancel(act.id)).rejects.toThrow(/only the founder cancels/);
      await expect(cancel(run.id)).rejects.toThrow(/task you are running/);
      const theirs = await newTask(founder);
      await expect(cancel(theirs.id)).rejects.toThrow(/people decide their own work/);
      const idea = await proposal(agentA);
      expect(await cancel(idea.id)).toBe('cancelled');
      expect((await sql`SELECT director_decision FROM hq.tasks WHERE id = ${idea.id}`)[0].director_decision).toBe('declined');
      await sql`UPDATE hq.tasks SET status = 'cancelled', claim_token = NULL WHERE id = ${run.id}`;
      const late = await newTask(agentA);
      await expect(cancel(late.id)).rejects.toThrow(/no longer holds its task/);
    });

    it('runs the board: reassign, park, resume, block, unblock and priority, within the same fences', async () => {
      const run = await directorRun();
      const version = async (id: string) => (await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${id}`)[0].v as string;
      const update = async (id: string, action: string, opts: { to?: string; priority?: number; note?: string } = {}) =>
        (await sql`SELECT hq.director_update_task(${director}, ${run.id}, ${run.claim_token}, ${id},
          ${await version(id)}::text::timestamptz, ${action}, ${opts.note ?? 'agent is off'},
          ${opts.to ?? null}::uuid, ${opts.priority ?? null}::smallint) AS s`)[0].s;
      const row = async (id: string) => (await sql`SELECT status, assignee_id, priority, attempts, claim_token FROM hq.tasks WHERE id = ${id}`)[0];

      const t = await newTask(agentA, { status: 'blocked' });
      await sql`UPDATE hq.tasks SET attempts = 3 WHERE id = ${t.id}`;
      expect(await update(t.id, 'unblock')).toBe('todo');
      expect((await row(t.id)).attempts).toBe(0);
      expect(await update(t.id, 'reassign', { to: agentB })).toBe('todo');
      expect((await row(t.id)).assignee_id).toBe(agentB);
      const [handoff] = await sql`SELECT body FROM hq.messages WHERE task_id = ${t.id} AND recipient_id = ${agentB}`;
      expect(handoff.body).toMatch(/^New for you: #\d+ t — agent is off/);
      await expect(update(t.id, 'reassign', { to: agentB })).rejects.toThrow(/already assigned/);
      expect(await update(t.id, 'park')).toBe('backlog');
      await expect(update(t.id, 'park')).rejects.toThrow(/already parked/);
      expect(await update(t.id, 'resume')).toBe('todo');
      expect(await update(t.id, 'priority', { priority: 1 })).toBe('todo');
      expect((await row(t.id)).priority).toBe(1);
      await expect(update(t.id, 'priority', { priority: 0 })).rejects.toThrow(/ask the founder for urgent/);
      expect(await update(t.id, 'block')).toBe('blocked');
      await expect(update(t.id, 'explode')).rejects.toThrow(/unknown action/);
      await expect(update(t.id, 'unblock', { note: ' ' })).rejects.toThrow(/say why/);

      // Taking running work away fences the run.
      const running = await newTask(agentA, { status: 'in_progress' });
      await sql`UPDATE hq.tasks SET claim_token = gen_random_uuid(), claimed_by = 'w1', claimed_at = now() WHERE id = ${running.id}`;
      expect(await update(running.id, 'reassign', { to: agentB })).toBe('todo');
      expect((await row(running.id)).claim_token).toBeNull();

      await expect(update(t.id, 'reassign', { to: founder })).rejects.toThrow(/not a person/);
      await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentA}`;
      await expect(update(t.id, 'reassign', { to: agentA })).rejects.toThrow(/only the founder gives it work/);
      const up = await newTask(agentB);
      await sql`UPDATE hq.tasks SET escalated_at = now() WHERE id = ${up.id}`;
      await expect(update(up.id, 'park')).rejects.toThrow(/waiting for the founder/);
      const theirs = await newTask(founder);
      await expect(update(theirs.id, 'park')).rejects.toThrow(/people decide their own work/);
      await expect(update(run.id, 'park')).rejects.toThrow(/task you are running/);
      const idea = await proposal(agentB);
      await expect(update(idea.id, 'park')).rejects.toThrow(/only open tasks/);
      const stale = await newTask(agentB);
      await expect(
        sql`SELECT hq.director_update_task(${director}, ${run.id}, ${run.claim_token}, ${stale.id}, now() - interval '1 day', 'park', 'x')`,
      ).rejects.toThrow(/changed since you read it/);
      const [ev] = await sql`SELECT count(*)::int AS n FROM hq.events WHERE type = 'director_updated'`;
      expect(ev.n).toBe(7);
    });

    it('never moves act-agent work, never restarts a safety stop, and manages approved ideas', async () => {
      const run = await directorRun();
      const version = async (id: string) => (await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${id}`)[0].v as string;
      const update = async (id: string, action: string, to: string | null = null) =>
        (await sql`SELECT hq.director_update_task(${director}, ${run.id}, ${run.claim_token}, ${id},
          ${await version(id)}::text::timestamptz, ${action}, 'why', ${to}::uuid, NULL::smallint) AS s`)[0].s;

      // Act-agent work (even parked and already approved) stays with the founder.
      await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentB}`;
      const act = await newTask(agentB, { status: 'backlog' });
      await sql`UPDATE hq.tasks SET founder_approved_at = now() WHERE id = ${act.id}`;
      await expect(update(act.id, 'resume')).rejects.toThrow(/only the founder moves its work/);
      await expect(update(act.id, 'reassign', agentA)).rejects.toThrow(/only the founder moves its work/);
      await sql`UPDATE hq.members SET tier = 'read' WHERE id = ${agentB}`;

      // Blocked by failing runs → only the founder restarts it.
      const crashed = await newTask(agentA, { status: 'blocked' });
      await sql`UPDATE hq.tasks SET attempts = 3 WHERE id = ${crashed.id}`;
      await sql`INSERT INTO hq.runs (member_id, task_id, status, started_at) VALUES
        (${agentA}, ${crashed.id}, 'succeeded', now() - interval '2 hours'),
        (${agentA}, ${crashed.id}, 'timeout', now() - interval '1 hour')`;
      await expect(update(crashed.id, 'unblock')).rejects.toThrow(/stopped itself after failed runs/);
      await expect(update(crashed.id, 'reassign', agentB)).rejects.toThrow(/stopped itself after failed runs/);
      await expect(update(crashed.id, 'park')).rejects.toThrow(/stopped itself after failed runs/);
      // Blocked because the agent said it is waiting on something → the Director may lift it.
      const waiting = await newTask(agentA, { status: 'blocked' });
      await sql`INSERT INTO hq.runs (member_id, task_id, status, started_at) VALUES (${agentA}, ${waiting.id}, 'succeeded', now())`;
      expect(await update(waiting.id, 'unblock')).toBe('todo');

      // Parked work handed to someone else starts with fresh attempts.
      const parked = await newTask(agentA, { status: 'backlog' });
      await sql`UPDATE hq.tasks SET attempts = 3 WHERE id = ${parked.id}`;
      expect(await update(parked.id, 'reassign', agentB)).toBe('backlog');
      expect((await sql`SELECT attempts FROM hq.tasks WHERE id = ${parked.id}`)[0].attempts).toBe(0);

      // An approved idea is ordinary work; a pending one is not.
      const idea = await proposal(agentA);
      await expect(update(idea.id, 'park')).rejects.toThrow(/only open tasks/);
      await sql`UPDATE hq.tasks SET status = 'todo' WHERE id = ${idea.id}`;
      expect(await update(idea.id, 'park')).toBe('backlog');

      // A run fenced by a park can no longer finish the task.
      const busy = await newTask(agentA, { status: 'in_progress' });
      const [{ claim_token: tok }] = await sql`UPDATE hq.tasks SET claim_token = gen_random_uuid(), claimed_by = 'w1', claimed_at = now()
        WHERE id = ${busy.id} RETURNING claim_token`;
      expect(await update(busy.id, 'park')).toBe('backlog');
      const [{ ok }] = await sql`SELECT hq.finish_task(${busy.id}, ${tok}, 'done', 'late result') AS ok`;
      expect(ok).toBe(false);
      expect((await sql`SELECT status FROM hq.tasks WHERE id = ${busy.id}`)[0].status).toBe('backlog');
    });

    describe('builds', () => {
      let builder: string;
      let alfred: string;
      beforeEach(async () => {
        await sql`DELETE FROM hq.build_jobs`;
        await sql`DELETE FROM hq.build_requests`;
        await sql`DELETE FROM hq.members WHERE slug = 't-alfred'`;
        [{ id: builder }] = await sql`UPDATE hq.members SET status = 'active' WHERE slug = 'builder' RETURNING id`;
        await sql`UPDATE hq.members SET is_founder = true WHERE id = ${founder}`;
        [{ id: alfred }] = await sql`INSERT INTO hq.members (slug, kind, name, runtime) VALUES ('t-alfred', 'human', 'Alfred', 'none') RETURNING id`;
      });
      const submit = async (human: string, title = 'New mode') =>
        (await sql`SELECT * FROM hq.submit_build_request(${human}, ${title}, 'Spec: build it', 'game_mode', ${['web', 'backend']})`)[0] as Record<string, any>;
      const version = async (id: string) => (await sql`SELECT updated_at::text AS v FROM hq.build_requests WHERE id = ${id}`)[0].v as string;
      const decide = async (run: { id: string; claim_token: string }, id: string, decision: string, spec: string | null = null) =>
        (await sql`SELECT hq.director_decide_build(${director}, ${run.id}, ${run.claim_token}, ${id}, ${await version(id)}::text::timestamptz, ${decision}, 'looks right', ${spec}) AS s`)[0].s;

      it('only the founder or an allowed teammate can ask; the Director gets a review task', async () => {
        await expect(submit(alfred)).rejects.toThrow(/only the founder/);
        await sql`UPDATE hq.members SET can_request_builds = true WHERE id = ${alfred}`;
        const r = await submit(alfred);
        expect(r).toMatchObject({ status: 'submitted', repos: ['backend', 'web'] });
        const [t] = await sql`SELECT assignee_id, status, ref FROM hq.tasks WHERE id = ${r.review_task_id}`;
        expect(t).toMatchObject({ assignee_id: director, status: 'todo' });
        expect(t.ref.build_request).toBe(r.id);
      });

      it('approving makes one job for the Builder with the edited spec; caps and requester checks hold', async () => {
        const run = await directorRun();
        const r = await submit(founder);
        expect(await decide(run, r.id, 'approve', 'Spec: build it, smaller')).toBe('approved');
        const [j] = await sql`SELECT * FROM hq.build_jobs WHERE request_id = ${r.id}`;
        expect(j).toMatchObject({ stage: 'queued', spec: 'Spec: build it, smaller' });
        const [bt] = await sql`SELECT assignee_id, status, founder_approved_at FROM hq.tasks WHERE id = ${j.task_id}`;
        expect(bt).toMatchObject({ assignee_id: builder, status: 'todo', founder_approved_at: null });
        // A builder task is never taken by the HQ worker: its runtime claims it.
        expect(await claim()).toBeUndefined();
        await expect(decide(run, r.id, 'approve')).rejects.toThrow(/not waiting for a decision/);
        // Seven more today are allowed, the ninth is not.
        for (const n of [2, 3, 4, 5, 6, 7, 8]) expect(await decide(run, (await submit(founder, `mode ${n}`)).id, 'approve')).toBe('approved');
        await expect(decide(run, (await submit(founder, 'mode 9')).id, 'approve')).rejects.toThrow(/eight builds were approved today/);
        // A requester who lost the right can't have a request approved.
        await sql`UPDATE hq.members SET can_request_builds = true WHERE id = ${alfred}`;
        const fromAlfred = await submit(alfred, 'alfred mode');
        await sql`UPDATE hq.members SET can_request_builds = false WHERE id = ${alfred}`;
        await sql`DELETE FROM hq.build_jobs`;
        await expect(decide(run, fromAlfred.id, 'approve')).rejects.toThrow(/may no longer ask/);
        expect(await decide(run, fromAlfred.id, 'decline')).toBe('declined');
      });

      it('the Builder holds one job by a lease; writes need the token; cancelling fences it', async () => {
        const run = await directorRun();
        const a = await submit(founder, 'first');
        const b = await submit(founder, 'second');
        await decide(run, a.id, 'approve');
        await decide(run, b.id, 'approve');
        const [j] = await sql`SELECT * FROM hq.build_claim('box-1')`;
        expect(j).toMatchObject({ stage: 'building', lease_owner: 'box-1' });
        // Only one build at a time, and a live lease is not taken.
        expect((await sql`SELECT id FROM hq.build_claim('box-2')`)[0].id).toBeNull();
        const step = await sql`SELECT * FROM hq.build_checkpoint(${j.id}, ${j.lease_token}, 'testing', '{"step":3}'::jsonb, '{"tests":"ok"}'::jsonb, 'tests pass', 2)`;
        expect(step[0]).toMatchObject({ stage: 'testing', runs_used: 2 });
        await expect(sql`SELECT hq.build_checkpoint(${j.id}, gen_random_uuid(), 'rating')`).rejects.toThrow(/no longer yours/);
        await expect(sql`SELECT hq.build_checkpoint(${j.id}, ${j.lease_token}, 'reviewing')`).rejects.toThrow(/moves forward/);
        // A lapsed lease is taken back with a new token.
        await sql`UPDATE hq.build_jobs SET lease_until = now() - interval '1 minute' WHERE id = ${j.id}`;
        const [again] = await sql`SELECT * FROM hq.build_claim('box-2')`;
        expect(again.id).toBe(j.id);
        expect(again.lease_token).not.toBe(j.lease_token);
        await expect(sql`SELECT hq.build_finish(${j.id}, ${j.lease_token}, 'ready_to_publish', 'done')`).rejects.toThrow(/no longer yours/);
        // Only the founder or the Director stops a build; then nothing can move it.
        await expect(sql`SELECT hq.cancel_build(${alfred}, ${j.id}, 'stop')`).rejects.toThrow(/only the founder or the Director/);
        await sql`SELECT hq.cancel_build(${founder}, ${j.id}, 'wrong idea')`;
        expect((await sql`SELECT id FROM hq.build_heartbeat(${j.id}, ${again.lease_token})`)[0].id).toBeNull();
        await expect(sql`SELECT hq.build_checkpoint(${j.id}, ${again.lease_token}, 'rating')`).rejects.toThrow(/no longer yours/);
        // The next queued build starts.
        const [next] = await sql`SELECT * FROM hq.build_claim('box-1')`;
        expect(next.request_id).toBe(b.id);
        const [done] = await sql`SELECT * FROM hq.build_finish(${next.id}, ${next.lease_token}, 'ready_to_publish', 'Built and tested')`;
        expect(done.stage).toBe('ready_to_publish');
        const [handed] = await sql`SELECT status, result, escalated_at FROM hq.tasks WHERE id = ${next.task_id}`;
        expect(handed).toMatchObject({ status: 'done', result: 'Built and tested' });
        expect(handed.escalated_at).not.toBeNull();
      });

      it('a handed-in build is published once (draft PRs recorded) or fails publishing; a cancelled one never', async () => {
        const run = await directorRun();
        await decide(run, (await submit(founder, 'pub')).id, 'approve');
        const [j] = await sql`SELECT * FROM hq.build_claim('box-1')`;
        await expect(sql`SELECT * FROM hq.build_published(${j.id}, ${sql.json([{ repo: 'web', url: 'https://x/1' }])})`).rejects.toThrow(/not waiting to be published/);
        await sql`SELECT * FROM hq.build_finish(${j.id}, ${j.lease_token}, 'ready_to_publish', 'built')`;
        const [p] = await sql`SELECT * FROM hq.build_published(${j.id}, ${sql.json([{ repo: 'web', url: 'https://github.com/x/pull/1' }])})`;
        expect(p.stage).toBe('published');
        expect(p.evidence.prs[0].url).toBe('https://github.com/x/pull/1');
        const [msg] = await sql`SELECT body FROM hq.messages WHERE task_id = ${j.task_id} ORDER BY id DESC LIMIT 1`;
        expect(msg.body).toMatch(/Draft PRs to staging[\s\S]*web: https:\/\/github.com\/x\/pull\/1/);
        await expect(sql`SELECT * FROM hq.build_published(${j.id}, ${sql.json([{ repo: 'web', url: 'u' }])})`).rejects.toThrow(/not waiting to be published/);
        await expect(sql`SELECT * FROM hq.build_publish_failed(${j.id}, 'x')`).rejects.toThrow(/not waiting to be published/);
      });

      it('the Director starts a build himself with what he verified, linked to the task it fixes; caps hold', async () => {
        const run = await directorRun();
        const source = await newTask(agentA);
        const start = (title: string, evidence = 'Reproduced on prod: 0 of 12 ratings have comments; the prompt never asks why after 1-3 stars.', src: string | null = null) =>
          sql`SELECT * FROM hq.director_start_build(${director}, ${run.id}, ${run.claim_token}, ${title}, 'Spec: ask what went wrong after 1-3 stars', 'feature', ${['web', 'backend']}, ${evidence}, ${src}::uuid)`;
        await expect(start('short evidence', 'trust me')).rejects.toThrow(/say what you verified/);
        const [j] = await start('Ask why after low ratings', undefined, source.id);
        expect(j.stage).toBe('queued');
        const [req] = await sql`SELECT requested_by, status, director_note FROM hq.build_requests WHERE id = ${j.request_id}`;
        expect(req).toMatchObject({ requested_by: director, status: 'approved' });
        expect(req.director_note).toBe('Started by the Director after verifying the problem (evidence in HQ).');
        expect((await sql`SELECT body FROM hq.messages WHERE task_id = ${j.task_id}`)[0].body).toMatch(/^Why: Reproduced on prod/);
        const [bt] = await sql`SELECT assignee_id, parent_id FROM hq.tasks WHERE id = ${j.task_id}`;
        expect(bt).toMatchObject({ assignee_id: builder, parent_id: source.id });
        expect((await sql`SELECT body FROM hq.messages WHERE task_id = ${source.id}`)[0].body).toMatch(/started by .* to fix this/);
        for (const n of ['two', 'three', 'four', 'five', 'six', 'seven', 'eight']) await start(n);
        await expect(start('nine')).rejects.toThrow(/eight builds were started today/);
        // Only the founder (or the Director) can stop it.
        await expect(sql`SELECT hq.cancel_build_request(${alfred}, ${j.request_id}, 'x')`).rejects.toThrow(/only the founder or the requester/);
      });

      it('the Director resolves a task he checked is done; never a person\'s, an act agent\'s or the founder\'s', async () => {
        const run = await directorRun();
        const version = async (id: string) => (await sql`SELECT updated_at::text AS v FROM hq.tasks WHERE id = ${id}`)[0].v as string;
        const resolve = async (id: string) =>
          (await sql`SELECT hq.director_update_task(${director}, ${run.id}, ${run.claim_token}, ${id}, ${await version(id)}::text::timestamptz, 'resolve', 'Checked the live page: it shows the new address.') AS s`)[0].s;
        const t = await newTask(agentA, { status: 'blocked' });
        await sql`INSERT INTO hq.runs (member_id, task_id, status, started_at) VALUES (${agentA}, ${t.id}, 'failed', now())`;
        expect(await resolve(t.id)).toBe('done');
        const [row] = await sql`SELECT status, result, review_state, completed_at FROM hq.tasks WHERE id = ${t.id}`;
        expect(row).toMatchObject({ status: 'done', review_state: 'accepted' });
        expect(row.result).toMatch(/^Resolved by .*: Checked the live page/);
        const unassigned = await sql`INSERT INTO hq.tasks (title, status, kind) VALUES ('open', 'todo', 'task') RETURNING id`;
        expect(await resolve(unassigned[0].id)).toBe('done');
        const theirs = await newTask(founder);
        await expect(resolve(theirs.id)).rejects.toThrow(/people decide their own work/);
        await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentB}`;
        const act = await newTask(agentB);
        await expect(resolve(act.id)).rejects.toThrow(/only the founder moves its work/);
        const up = await newTask(agentA);
        await sql`UPDATE hq.tasks SET escalated_at = now() WHERE id = ${up.id}`;
        await expect(resolve(up.id)).rejects.toThrow(/waiting for the founder/);
        // GPT's reviews can never be "resolved" into a fake approval.
        const review = await newTask(agentA);
        await sql`UPDATE hq.tasks SET ref = '{"review": true}'::jsonb WHERE id = ${review.id}`;
        await expect(resolve(review.id)).rejects.toThrow(/not resolved by hand/);
        const [{ id: advisor }] = await sql`UPDATE hq.members SET status = 'active' WHERE slug = 'gpt-advisor' RETURNING id`;
        const gptTask = await newTask(advisor);
        await expect(resolve(gptTask.id)).rejects.toThrow(/not resolved by hand/);
      });

      it('works as the service role (what the backend and the Builder use)', async () => {
        const run = await directorRun();
        await sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE service_role`;
          const [r] = await tx`SELECT * FROM hq.submit_build_request(${founder}, 'As service role', 'Spec: build it', 'bug_fix', ${['backend']})`;
          const [{ v }] = await tx`SELECT updated_at::text AS v FROM hq.build_requests WHERE id = ${r.id}`;
          await tx`SELECT hq.director_decide_build(${director}, ${run.id}, ${run.claim_token}, ${r.id}, ${v}::text::timestamptz, 'approve', 'ok')`;
          const [j] = await tx`SELECT * FROM hq.build_claim('box-1')`;
          expect(j.stage).toBe('building');
          await tx`SELECT * FROM hq.build_checkpoint(${j.id}, ${j.lease_token}, 'building', '{}'::jsonb, NULL, NULL, 1)`;
          await tx`SELECT * FROM hq.build_finish(${j.id}, ${j.lease_token}, 'failed', 'could not')`;
          // A released (or finished) lease no longer writes.
          expect((await tx`SELECT hq.build_release(${j.id}, ${j.lease_token}) AS ok`)[0].ok).toBe(false);
        });
      });

      it('a build that uses up its runs is stopped', async () => {
        const run = await directorRun();
        const r = await submit(founder);
        await decide(run, r.id, 'approve');
        const [j] = await sql`SELECT * FROM hq.build_claim('box-1')`;
        await sql`UPDATE hq.build_jobs SET run_limit = 3 WHERE id = ${j.id}`;
        const [stopped] = await sql`SELECT * FROM hq.build_checkpoint(${j.id}, ${j.lease_token}, 'building', NULL, NULL, NULL, 4)`;
        expect(stopped).toMatchObject({ stage: 'failed', lease_token: null });
        expect((await sql`SELECT stage FROM hq.build_jobs WHERE id = ${j.id}`)[0].stage).toBe('failed');
        const [t] = await sql`SELECT status, result, escalated_at FROM hq.tasks WHERE id = ${j.task_id}`;
        expect(t.status).toBe('done');
        expect(t.result).toMatch(/^Build failed: stopped at its run limit/);
        expect(t.escalated_at).not.toBeNull();
        // The slot is free for the next build.
        const r2 = await submit(founder, 'next');
        await decide(run, r2.id, 'approve');
        expect((await sql`SELECT stage FROM hq.build_claim('box-1')`)[0].stage).toBe('building');
      });

      it('the founder or the requester cancels a request before approval; after, only the founder, which stops the build', async () => {
        await sql`UPDATE hq.members SET can_request_builds = true WHERE id = ${alfred}`;
        const r = await submit(alfred, 'alfred idea');
        await expect(sql`SELECT hq.cancel_build_request(${director}, ${r.id}, 'x')`).rejects.toThrow(/only the founder or the requester/);
        expect((await sql`SELECT hq.cancel_build_request(${alfred}, ${r.id}, 'changed my mind') AS s`)[0].s).toBe('cancelled');
        expect((await sql`SELECT status FROM hq.tasks WHERE id = ${r.review_task_id}`)[0].status).toBe('cancelled');
        const run = await directorRun();
        await expect(decide(run, r.id, 'approve')).rejects.toThrow(/not waiting for a decision/);
        const r2 = await submit(alfred, 'alfred second');
        await decide(run, r2.id, 'approve');
        await expect(sql`SELECT hq.cancel_build_request(${alfred}, ${r2.id}, 'stop')`).rejects.toThrow(/ask the founder or the Director/);
        expect((await sql`SELECT hq.cancel_build_request(${founder}, ${r2.id}, 'not now') AS s`)[0].s).toBe('build_stopped');
        expect((await sql`SELECT stage FROM hq.build_jobs WHERE request_id = ${r2.id}`)[0].stage).toBe('cancelled');
      });

      it('an expired lease can no longer write, even before anyone takes it over', async () => {
        const run = await directorRun();
        await decide(run, (await submit(founder)).id, 'approve');
        const [j] = await sql`SELECT * FROM hq.build_claim('box-1')`;
        await sql`UPDATE hq.build_jobs SET lease_until = now() - interval '1 second' WHERE id = ${j.id}`;
        expect((await sql`SELECT id FROM hq.build_heartbeat(${j.id}, ${j.lease_token})`)[0].id).toBeNull();
        await expect(sql`SELECT hq.build_checkpoint(${j.id}, ${j.lease_token}, 'testing')`).rejects.toThrow(/no longer yours/);
        await expect(sql`SELECT hq.build_finish(${j.id}, ${j.lease_token}, 'failed', 'x')`).rejects.toThrow(/no longer yours/);
      });
    });

    describe('agent_create_task', () => {
      const create = (run: { id: string; claim_token: string }, title: string, assignee: string | null, creator = director) =>
        sql`SELECT * FROM hq.agent_create_task(${creator}, ${run.id}, ${run.claim_token}, ${title}, '', ${assignee}, 2::smallint, 4, 3)`
          .then((r) => r[0] as { id: string; waiting_for_founder: boolean });

      it('is fenced by the run claim and refuses an identical open task', async () => {
        const run = await directorRun();
        await create(run, 'Check the funnel', agentA);
        await expect(create(run, ' check the FUNNEL ', agentA)).rejects.toThrow(/already open/);
        await sql`UPDATE hq.tasks SET claim_token = NULL, status = 'cancelled' WHERE id = ${run.id}`;
        await expect(create(run, 'Something else', agentA)).rejects.toThrow(/no longer holds its task/);
      });

      it("holds the director's daily cap under concurrent calls", async () => {
        const run = await directorRun();
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => create(run, `Task number ${i}`, agentA)));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      });

      it("creates work for an 'act' agent waiting for the founder, and never parents it to a private chat", async () => {
        await sql`UPDATE hq.members SET tier = 'act' WHERE id = ${agentB}`;
        const [chat] = await sql`
          INSERT INTO hq.tasks (title, status, kind, assignee_id, created_by_id, claim_token, claimed_by, claimed_at)
          VALUES ('Chat', 'in_progress', 'chat', ${director}, ${founder}, gen_random_uuid(), 'w1', now())
          RETURNING id, claim_token`;
        const t = await create(chat as { id: string; claim_token: string }, 'Ship the fix', agentB);
        expect(t.waiting_for_founder).toBe(true);
        const [row] = await sql`SELECT parent_id, escalated_at IS NOT NULL AS waiting FROM hq.tasks WHERE id = ${t.id}`;
        expect(row).toEqual({ parent_id: null, waiting: true });
        expect(await claim()).toBeUndefined();
      });

      it('two different agents cannot both create the same open task', async () => {
        const runs = await Promise.all([agentA, agentB].map(async (who) => (await sql`
          INSERT INTO hq.tasks (title, status, kind, assignee_id, claim_token, claimed_by, claimed_at)
          VALUES ('work', 'in_progress', 'task', ${who}, gen_random_uuid(), 'w1', now()) RETURNING id, claim_token`)[0] as { id: string; claim_token: string }));
        const results = await Promise.allSettled([
          create(runs[0], 'Audit the leaderboard', null, agentA),
          create(runs[1], 'Audit the leaderboard', null, agentB),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      });

      it('other agents cannot hand work to the director', async () => {
        const [run] = await sql`
          INSERT INTO hq.tasks (title, status, kind, assignee_id, claim_token, claimed_by, claimed_at)
          VALUES ('work', 'in_progress', 'task', ${agentA}, gen_random_uuid(), 'w1', now()) RETURNING id, claim_token`;
        await expect(create(run as { id: string; claim_token: string }, 'Please review', director, agentA)).rejects.toThrow(/don't create tasks for/);
      });
    });

    it("stops claiming a member's work at its daily run cap, but not its chats", async () => {
      await sql`UPDATE hq.members SET daily_run_limit = 1 WHERE id = ${agentA}`;
      const done = await newTask(agentA, { status: 'done' });
      await sql`INSERT INTO hq.runs (task_id, member_id, status, started_at) VALUES (${done.id}, ${agentA}, 'succeeded', now())`;
      await newTask(agentA);
      expect(await claim()).toBeUndefined();
    });
  });
});
