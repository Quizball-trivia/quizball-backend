import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

// A stalled Quizball write against real Postgres: at the run's deadline the statement is cancelled on the server,
// the lease stops being renewed and is released, and nothing is written.
const h = vi.hoisted(() => ({
  sql: null as unknown as ReturnType<typeof postgres>,
  heartbeatStop: vi.fn(),
  releaseLock: vi.fn(async () => true),
}));
vi.mock('../../src/db/index.js', () => ({ get sql() { return h.sql; } }));
vi.mock('../../src/core/config.js', async (original) => {
  const actual = await original<typeof import('../../src/core/config.js')>();
  return { config: { ...actual.config, NODE_ENV: 'local', TD_STATS_DATABASE_URL: 'postgres://td_stats_reader:x@127.0.0.1:1/td' } };
});
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => ({ isOpen: true }) }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: async () => ({ acquired: true, token: 't' }),
  releaseLock: h.releaseLock,
  startLockHeartbeat: () => ({ stop: h.heartbeatStop }),
}));
const { runTableDerbyStatsSync } = await import('../../src/modules/partner-stats/table-derby-stats.js');

const url = process.env.TD_STATS_DEADLINE_TEST_DATABASE_URL;
if (url && !/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\/quizball_td_stats_[a-z0-9_]+$/.test(url)) {
  throw new Error('Isolated local database quizball_td_stats_* on 127.0.0.1 required');
}

describe.skipIf(!url)('Table Derby stats sync deadline (real Postgres)', () => {
  let td: ReturnType<typeof postgres>;
  let blocker: ReturnType<typeof postgres>;

  beforeAll(async () => {
    h.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await h.sql.unsafe(`DROP SCHEMA IF EXISTS td CASCADE; DROP TABLE IF EXISTS public.partner_daily_stats;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await h.sql.unsafe(readFileSync(new URL('../../supabase/migrations/20261126150000_partner_daily_stats.sql', import.meta.url), 'utf8'));
    await h.sql.unsafe(`CREATE SCHEMA td;
      CREATE FUNCTION td.td_partner_daily_stats(p_from date, p_to date)
      RETURNS TABLE (day date, total_users int, new_users int, active_users int, active_7d int, active_30d int, matches int)
      LANGUAGE sql AS $$ SELECT g::date, 1, 0, 0, 0, 0, 0 FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g $$;`);
    td = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined, connection: { search_path: 'td' } });
    blocker = postgres(url!, { max: 1, onnotice: () => undefined });
  });
  afterAll(async () => {
    await td?.end();
    await blocker?.end();
    await h.sql?.end();
  });

  it('cancels a stalled write at the deadline and releases the lease', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Reads go on; the write waits for this lock (well inside its 5 s lock_timeout).
    const blocking = blocker.begin(async (tx) => {
      await tx.unsafe('LOCK TABLE partner_daily_stats IN SHARE MODE');
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const started = Date.now();
      const outcome = await runTableDerbyStatsSync(new Date(), { deadlineMs: 1_500, createClient: () => td }).catch((e: unknown) => e);
      const took = Date.now() - started;

      expect(outcome).toMatchObject({ stage: 'deadline', code: 'timeout' });
      expect(took).toBeLessThan(3_000); // cancelled, not left to its timeouts or the 5 s cleanup grace
      expect(h.heartbeatStop).toHaveBeenCalled();
      expect(h.releaseLock).toHaveBeenCalledWith('lock:partner_stats:table_derby', 't');
      const waiting = await h.sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO partner_daily_stats%'`;
      expect(waiting[0]!.n).toBe(0);
    } finally {
      release();
      await blocking;
    }
    expect((await h.sql`SELECT count(*)::int AS n FROM partner_daily_stats`)[0]!.n).toBe(0);
  });
});
