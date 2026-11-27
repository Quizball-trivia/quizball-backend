import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
const { syncTableDerbyStats, readTableDerbyDays, createTableDerbyClient, parseTableDerbyTarget, backfillTableDerbyDays, SYNC_DAYS } =
  await import('../../src/modules/partner-stats/table-derby-stats.js');

// One isolated local database: Quizball's partner_daily_stats in `public`, and in schema `td` a stand-in for Table
// Derby's td_partner_daily_stats() (its counting is tested in the Table Derby repo), reached through its own client
// as the sync reaches Table Derby.
const url = process.env.TD_STATS_TEST_DATABASE_URL;
if (url && !/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\/quizball_td_stats_[a-z0-9_]+$/.test(url)) {
  throw new Error('Isolated local database quizball_td_stats_* on 127.0.0.1 required');
}

const TD_SCHEMA = `
  DROP SCHEMA IF EXISTS td CASCADE;
  CREATE SCHEMA td;
  CREATE TABLE td.counts (day date PRIMARY KEY, total_users int, new_users int, active_users int, active_7d int,
    active_30d int, matches int);
  CREATE FUNCTION td.td_partner_daily_stats(p_from date, p_to date)
  RETURNS TABLE (day date, total_users int, new_users int, active_users int, active_7d int, active_30d int, matches int)
  LANGUAGE sql AS $$
    SELECT g::date, coalesce(c.total_users, 0), coalesce(c.new_users, 0), coalesce(c.active_users, 0),
           coalesce(c.active_7d, 0), coalesce(c.active_30d, 0), coalesce(c.matches, 0)
    FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
    LEFT JOIN td.counts c ON c.day = g::date ORDER BY 1
  $$;
`;

// 2026-11-26 20:30Z is 00:30 on 2026-11-27 in Tbilisi (UTC+4): today is the 27th.
const NOW = new Date('2026-11-26T20:30:00Z');
const TODAY = '2026-11-27';
const FIRST = '2026-10-24'; // 35 days, today included

describe.skipIf(!url)('Table Derby stats sync (real Postgres)', () => {
  let td: ReturnType<typeof postgres>;

  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await db.sql.unsafe('DROP TABLE IF EXISTS public.partner_daily_stats');
    await db.sql.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.sql.unsafe(readFileSync(new URL('../../supabase/migrations/20261127060000_partner_daily_stats.sql', import.meta.url), 'utf8'));
    await db.sql.unsafe(TD_SCHEMA);
    td = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined, connection: { search_path: 'td' } });
  });
  afterAll(async () => {
    await td?.end();
    await db.sql?.end();
  });
  beforeEach(async () => {
    await db.sql.unsafe('TRUNCATE public.partner_daily_stats, td.counts');
  });

  const counts = (day: string, total: number, active = 0) =>
    td`INSERT INTO counts VALUES (${day}, ${total}, 1, ${active}, ${active}, ${active}, 2)`;
  const stored = () => db.sql<{ day: string; total_users: number; active_users: number }[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, total_users, active_users FROM partner_daily_stats ORDER BY day`;

  it('asks Table Derby for the last 35 Tbilisi days and stores each of them, gaps included', async () => {
    await counts(TODAY, 120, 9);
    await counts('2026-11-01', 80, 4);
    const snapshot = await syncTableDerbyStats(td, NOW);

    expect(snapshot.rows).toHaveLength(SYNC_DAYS);
    const rows = await stored();
    expect(rows).toHaveLength(SYNC_DAYS);
    expect(rows[0]!.day).toBe(FIRST);
    expect(rows.find((r) => r.day === '2026-11-01')).toEqual({ day: '2026-11-01', total_users: 80, active_users: 4 });
    expect(rows.at(-1)).toEqual({ day: TODAY, total_users: 120, active_users: 9 });
  });

  it('re-reads earlier days on every run (backfill after an outage, later corrections)', async () => {
    await counts('2026-11-01', 80, 4);
    await syncTableDerbyStats(td, NOW);
    await td`UPDATE counts SET active_users = 5 WHERE day = '2026-11-01'`;
    await syncTableDerbyStats(td, new Date(NOW.getTime() + 60_000));
    expect((await stored()).find((r) => r.day === '2026-11-01')?.active_users).toBe(5);
  });

  it('never replaces a newer snapshot with an older one', async () => {
    await counts(TODAY, 120);
    await syncTableDerbyStats(td, NOW);
    await td`UPDATE counts SET total_users = 999`;
    const late = await readTableDerbyDays(td, FIRST, TODAY);
    late.sourceAt = new Date(late.sourceAt.getTime() - 3_600_000);
    const { upsertPartnerDays } = await import('../../src/modules/partner-stats/table-derby-stats.js');
    expect(await upsertPartnerDays('table-derby', late)).toBe(0);
    expect((await stored()).at(-1)?.total_users).toBe(120);
  });

  it('writes all days or none', async () => {
    await counts(TODAY, 120);
    await syncTableDerbyStats(td, NOW);
    const before = await stored();
    const snapshot = await readTableDerbyDays(td, FIRST, TODAY);
    snapshot.rows[10]!.total_users = -1; // the table's check rejects it: the whole statement fails
    snapshot.sourceAt = new Date(snapshot.sourceAt.getTime() + 60_000);
    const { upsertPartnerDays } = await import('../../src/modules/partner-stats/table-derby-stats.js');
    await expect(upsertPartnerDays('table-derby', snapshot)).rejects.toThrow();
    expect(await stored()).toEqual(before);
  });

  it('keeps the last numbers when Table Derby is unreachable', async () => {
    await counts(TODAY, 120);
    await syncTableDerbyStats(td, NOW);
    const before = await stored();
    const down = createTableDerbyClient(parseTableDerbyTarget('postgres://td_stats_reader:x@127.0.0.1:1/td', true));
    try {
      await expect(syncTableDerbyStats(down, NOW)).rejects.toMatchObject({ stage: 'read', code: 'ECONNREFUSED' });
    } finally {
      await down.end({ timeout: 0 });
    }
    expect(await stored()).toEqual(before);
  });

  it('keeps the last numbers when Table Derby answers with an error or the wrong days', async () => {
    await counts(TODAY, 120);
    await syncTableDerbyStats(td, NOW);
    const before = await stored();
    await td.unsafe('ALTER FUNCTION td_partner_daily_stats(date, date) RENAME TO gone');
    try {
      await expect(syncTableDerbyStats(td, NOW)).rejects.toMatchObject({ stage: 'read', code: '42883' });
    } finally {
      await td.unsafe('ALTER FUNCTION gone(date, date) RENAME TO td_partner_daily_stats');
    }
    await td`INSERT INTO counts VALUES ('2026-11-20', -3, 0, 0, 0, 0, 0)`;
    await expect(syncTableDerbyStats(td, NOW)).rejects.toMatchObject({ stage: 'read', code: 'not_a_count' });
    expect(await stored()).toEqual(before);
  });

  it('backfills an older range in windows Table Derby accepts, and a dry run writes nothing', async () => {
    await counts('2026-06-15', 40, 3);
    expect(await backfillTableDerbyDays(td, '2026-06-01', '2026-09-08', { dryRun: true })).toEqual({ read: 100, written: 0 });
    expect(await stored()).toEqual([]);
    expect(await backfillTableDerbyDays(td, '2026-06-01', '2026-09-08')).toEqual({ read: 100, written: 100 });
    const rows = await stored();
    expect(rows).toHaveLength(100);
    expect(rows.find((r) => r.day === '2026-06-15')).toEqual({ day: '2026-06-15', total_users: 40, active_users: 3 });
    await expect(backfillTableDerbyDays(td, '2026-09-08', '2026-06-01')).rejects.toMatchObject({ code: 'range_invalid' });
  });
});
