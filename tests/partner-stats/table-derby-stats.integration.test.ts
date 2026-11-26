import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
const { syncTableDerbyStats, readTableDerbyDays, createTableDerbyClient } = await import('../../src/modules/partner-stats/table-derby-stats.js');

// One isolated local database: Quizball's partner_daily_stats in `public`, a Table Derby-shaped fixture (only the
// columns td_stats_reader may read) in schema `td`, reached through its own client as the sync reaches Table Derby.
const url = process.env.TD_STATS_TEST_DATABASE_URL;
if (url && !/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\/quizball_td_stats_[a-z0-9_]+$/.test(url)) {
  throw new Error('Isolated local database quizball_td_stats_* on 127.0.0.1 required');
}

const TD_SCHEMA = `
  DROP SCHEMA IF EXISTS td CASCADE;
  CREATE SCHEMA td;
  CREATE TABLE td.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL,
    status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL);
  CREATE TABLE td.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL,
    created_at timestamptz NOT NULL, settled_at timestamptz);
  CREATE TABLE td.match_players (match_id uuid NOT NULL, user_id uuid NOT NULL);
  CREATE TABLE td.daily_attempts (user_id uuid NOT NULL, georgia_date date NOT NULL);
  CREATE TABLE td.practice_runs (user_id uuid NOT NULL, started_at timestamptz NOT NULL);
`;

// 2026-11-26 20:30Z is 00:30 on 2026-11-27 in Tbilisi (UTC+4): "today" is the 27th, "yesterday" the 26th.
const NOW = new Date('2026-11-26T20:30:00Z');
const TODAY = '2026-11-27';
const YESTERDAY = '2026-11-26';
const LAST_SECOND_OF_YESTERDAY = '2026-11-26T19:59:59Z';
const FIRST_SECOND_OF_TODAY = '2026-11-26T20:00:00Z';
const MIDDAY_YESTERDAY = '2026-11-26T08:00:00Z';

describe.skipIf(!url)('Table Derby stats sync (real Postgres)', () => {
  let td: ReturnType<typeof postgres>;

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await db.sql.unsafe('DROP TABLE IF EXISTS public.partner_daily_stats');
    await db.sql.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.sql.unsafe(readFileSync(new URL('../../supabase/migrations/20261126150000_partner_daily_stats.sql', import.meta.url), 'utf8'));
    await db.sql.unsafe(TD_SCHEMA);
    td = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined, connection: { search_path: 'td' } });
  });
  afterAll(async () => {
    await td?.end();
    await db.sql?.end();
  });
  beforeEach(async () => {
    await db.sql.unsafe('TRUNCATE public.partner_daily_stats, td.users, td.matches, td.match_players, td.daily_attempts, td.practice_runs');
  });

  const user = async (provider: string, createdAt: string, status = 'active') => {
    const [u] = await td`INSERT INTO users (provider, status, created_at) VALUES (${provider}, ${status}, ${createdAt}) RETURNING id`;
    return u.id as string;
  };
  const match = async (players: string[], createdAt: string, status = 'settled', settledAt: string | null = createdAt) => {
    const [m] = await td`INSERT INTO matches (status, created_at, settled_at) VALUES (${status}, ${createdAt}, ${settledAt}) RETURNING id`;
    for (const p of players) await td`INSERT INTO match_players (match_id, user_id) VALUES (${m.id}, ${p})`;
  };
  const daily = (userId: string, day: string) => td`INSERT INTO daily_attempts (user_id, georgia_date) VALUES (${userId}, ${day})`;
  const practice = (userId: string, at: string) => td`INSERT INTO practice_runs (user_id, started_at) VALUES (${userId}, ${at})`;
  const stored = () => db.sql`SELECT partner, to_char(day, 'YYYY-MM-DD') AS day, total_users, new_users, active_users,
    active_7d, active_30d, matches FROM partner_daily_stats ORDER BY day`;

  it('counts real Betsson players only: no bots, load/QA-smoke, demo, dev or deleted accounts', async () => {
    const old = await user('betsson', '2026-10-01T10:00:00Z');
    const newYesterday = await user('betsson', MIDDAY_YESTERDAY);
    const newToday = await user('betsson', FIRST_SECOND_OF_TODAY);
    const bot = await user('bot', MIDDAY_YESTERDAY);
    const load = await user('load', MIDDAY_YESTERDAY);
    const load2 = await user('load', MIDDAY_YESTERDAY);
    const demo = await user('demo', MIDDAY_YESTERDAY);
    await user('dev', MIDDAY_YESTERDAY);
    const deleted = await user('betsson', MIDDAY_YESTERDAY, 'deleted');
    await user('betsson', MIDDAY_YESTERDAY, 'blocked');

    await match([old, bot], MIDDAY_YESTERDAY); // a person vs a bot: one active person, one match
    await match([load, load2], MIDDAY_YESTERDAY); // load test: nothing
    await match([newYesterday, deleted], MIDDAY_YESTERDAY, 'void'); // played, but not settled
    await match([demo, bot], MIDDAY_YESTERDAY); // demo only: nothing
    await daily(newYesterday, YESTERDAY);
    await daily(load, YESTERDAY);
    await practice(old, MIDDAY_YESTERDAY); // the same person again: counted once
    await practice(newToday, FIRST_SECOND_OF_TODAY);
    await daily(bot, TODAY);

    const rows = await syncTableDerbyStats(td, NOW);
    expect(rows).toEqual([
      { day: YESTERDAY, total_users: 3, new_users: 2, active_users: 2, active_7d: 2, active_30d: 2, matches: 1 },
      { day: TODAY, total_users: 4, new_users: 1, active_users: 1, active_7d: 3, active_30d: 3, matches: 0 },
    ]);
    expect(await stored()).toEqual(rows.map((r) => ({ partner: 'table-derby', ...r })));
  });

  it('splits days at Tbilisi midnight (20:00 UTC)', async () => {
    const a = await user('betsson', LAST_SECOND_OF_YESTERDAY);
    const b = await user('betsson', FIRST_SECOND_OF_TODAY);
    const bot = await user('bot', '2026-11-01T00:00:00Z');
    await match([a, bot], LAST_SECOND_OF_YESTERDAY, 'settled', LAST_SECOND_OF_YESTERDAY);
    await match([b, bot], LAST_SECOND_OF_YESTERDAY, 'settled', FIRST_SECOND_OF_TODAY); // created yesterday, settled today
    await practice(b, FIRST_SECOND_OF_TODAY);

    const [yesterday, today] = await syncTableDerbyStats(td, NOW);
    expect(yesterday).toMatchObject({ day: YESTERDAY, total_users: 1, new_users: 1, active_users: 2, matches: 1 });
    expect(today).toMatchObject({ day: TODAY, total_users: 2, new_users: 1, active_users: 1, matches: 1 });
  });

  it('counts distinct people over the 7 and 30 days ending each day', async () => {
    const a = await user('betsson', '2026-10-01T10:00:00Z');
    const b = await user('betsson', '2026-10-01T10:00:00Z');
    const c = await user('betsson', '2026-10-01T10:00:00Z');
    await daily(a, '2026-11-21'); // 6 days before today: in both of today's windows, both of yesterday's
    await daily(a, TODAY);
    await daily(b, '2026-11-20'); // 7 days before today: outside today's 7-day window, inside yesterday's
    await daily(c, '2026-10-28'); // 30 days before today: only in yesterday's 30-day window
    await daily(c, '2026-10-27'); // 31 days before today: in neither

    const [yesterday, today] = await syncTableDerbyStats(td, NOW);
    expect(yesterday).toMatchObject({ active_users: 0, active_7d: 2, active_30d: 3 });
    expect(today).toMatchObject({ active_users: 1, active_7d: 1, active_30d: 2 });
  });

  it('replaces a day on the next sync', async () => {
    const a = await user('betsson', MIDDAY_YESTERDAY);
    await syncTableDerbyStats(td, NOW);
    await practice(a, FIRST_SECOND_OF_TODAY);
    await user('betsson', FIRST_SECOND_OF_TODAY);
    await syncTableDerbyStats(td, NOW);
    expect((await stored()).map((r) => [r.day, r.total_users, r.active_users])).toEqual([
      [YESTERDAY, 1, 0],
      [TODAY, 2, 1],
    ]);
  });

  it('keeps the last numbers when Table Derby is unreachable', async () => {
    await user('betsson', MIDDAY_YESTERDAY);
    await syncTableDerbyStats(td, NOW);
    const before = await stored();

    const down = createTableDerbyClient('postgres://td_stats_reader:x@127.0.0.1:1/td');
    try {
      await expect(syncTableDerbyStats(down, NOW)).rejects.toThrow();
    } finally {
      await down.end({ timeout: 0 });
    }
    expect(await stored()).toEqual(before);
    expect(before).toHaveLength(2);
  });

  it('keeps the last numbers when Table Derby answers with an error', async () => {
    await user('betsson', MIDDAY_YESTERDAY);
    await syncTableDerbyStats(td, NOW);
    const before = await stored();
    await td.unsafe('ALTER TABLE practice_runs RENAME TO practice_runs_gone');
    try {
      await expect(readTableDerbyDays(td, [TODAY])).rejects.toThrow(/practice_runs/);
      await expect(syncTableDerbyStats(td, new Date('2026-11-27T12:00:00Z'))).rejects.toThrow();
    } finally {
      await td.unsafe('ALTER TABLE practice_runs_gone RENAME TO practice_runs');
    }
    expect(await stored()).toEqual(before);
  });
});
