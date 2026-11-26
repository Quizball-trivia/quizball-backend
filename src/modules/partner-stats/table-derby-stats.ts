import postgres from 'postgres';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../../realtime/locks.js';
import { getRedisClient } from '../../realtime/redis.js';
import { TABLE_DERBY, addDays, tbilisiDay } from './partner-days.js';

/**
 * Table Derby's players counted into Quizball's totals: every 30 minutes one
 * replica reads today's and yesterday's counts (Asia/Tbilisi days) from Table
 * Derby's database, as its read-only td_stats_reader role, and upserts them
 * into partner_daily_stats. Only integers cross: the counting runs on Table
 * Derby's side. A failed read writes nothing, so the last numbers stay.
 */

const TZ = 'Asia/Tbilisi';
const INTERVAL_MS = 30 * 60_000;
/** A replica that finds today's row younger than this skips (every replica ticks; one sync per interval is enough). */
const FRESH_MS = 25 * 60_000;
const STARTUP_MIN_DELAY_MS = 60_000;
const STARTUP_JITTER_MS = 60_000;
const LOCK_KEY = 'lock:partner_stats:table_derby';
const LOCK_TTL_MS = 60_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const RUN_DEADLINE_MS = 30_000;

export interface PartnerDayCounts {
  day: string;
  total_users: number;
  new_users: number;
  active_users: number;
  active_7d: number;
  active_30d: number;
  matches: number;
}

export type TableDerbySql = postgres.Sql;

/**
 * The counts of each given day, computed on Table Derby's database. Real
 * players are partner (Betsson) accounts that are not deleted: bots, load-test
 * and probe accounts (the QA smoke users were moved to 'load'), demo and dev
 * sign-ins are other providers. Active = played a ranked match (created that
 * day), a daily of that date or a practice run (started that day), as Table
 * Derby's own dashboard counts it. Matches = settled that day with a real
 * player in them. Reads only the columns td_stats_reader is granted.
 */
export async function readTableDerbyDays(td: TableDerbySql, days: readonly string[]): Promise<PartnerDayCounts[]> {
  const rows = await td.begin('read only', async (transaction) => {
    const tx = transaction as unknown as TableDerbySql;
    await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return tx<PartnerDayCounts[]>`
      WITH days AS (
        SELECT d::date AS day FROM unnest(${days as string[]}::date[]) AS d
      ), bounds AS (
        SELECT min(day) - 29 AS first, max(day) AS last FROM days
      ), people AS (
        SELECT u.id, u.created_at FROM users u WHERE u.provider = 'betsson' AND u.status <> 'deleted'
      ), activity AS (
        SELECT (m.created_at AT TIME ZONE ${TZ})::date AS day, mp.user_id
        FROM bounds b, matches m JOIN match_players mp ON mp.match_id = m.id
        WHERE m.created_at >= (b.first::timestamp AT TIME ZONE ${TZ})
          AND m.created_at < ((b.last + 1)::timestamp AT TIME ZONE ${TZ})
        UNION ALL
        SELECT d.georgia_date, d.user_id
        FROM bounds b, daily_attempts d WHERE d.georgia_date BETWEEN b.first AND b.last
        UNION ALL
        SELECT (p.started_at AT TIME ZONE ${TZ})::date, p.user_id
        FROM bounds b, practice_runs p
        WHERE p.started_at >= (b.first::timestamp AT TIME ZONE ${TZ})
          AND p.started_at < ((b.last + 1)::timestamp AT TIME ZONE ${TZ})
      ), real_activity AS (
        SELECT DISTINCT a.day, a.user_id FROM activity a JOIN people p ON p.id = a.user_id
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM people p
          WHERE p.created_at < ((d.day + 1)::timestamp AT TIME ZONE ${TZ})) AS total_users,
        (SELECT count(*)::int FROM people p
          WHERE p.created_at >= (d.day::timestamp AT TIME ZONE ${TZ})
            AND p.created_at < ((d.day + 1)::timestamp AT TIME ZONE ${TZ})) AS new_users,
        (SELECT count(DISTINCT r.user_id)::int FROM real_activity r WHERE r.day = d.day) AS active_users,
        (SELECT count(DISTINCT r.user_id)::int FROM real_activity r WHERE r.day BETWEEN d.day - 6 AND d.day) AS active_7d,
        (SELECT count(DISTINCT r.user_id)::int FROM real_activity r WHERE r.day BETWEEN d.day - 29 AND d.day) AS active_30d,
        (SELECT count(*)::int FROM matches m
          WHERE m.status = 'settled'
            AND m.settled_at >= (d.day::timestamp AT TIME ZONE ${TZ})
            AND m.settled_at < ((d.day + 1)::timestamp AT TIME ZONE ${TZ})
            AND EXISTS (SELECT 1 FROM match_players mp JOIN people p ON p.id = mp.user_id
                        WHERE mp.match_id = m.id)) AS matches
      FROM days d ORDER BY d.day
    `;
  });
  const counts = [...rows].map((r) => ({ ...r }));
  if (counts.length !== days.length) throw new Error(`Table Derby returned ${counts.length} days for ${days.length}`);
  for (const r of counts) {
    for (const k of ['total_users', 'new_users', 'active_users', 'active_7d', 'active_30d', 'matches'] as const) {
      if (!Number.isInteger(r[k]) || r[k] < 0) throw new Error(`Table Derby ${k} for ${r.day} is not a count`);
    }
  }
  return counts;
}

export async function upsertPartnerDays(partner: string, rows: readonly PartnerDayCounts[]): Promise<void> {
  for (const r of rows) {
    await sql`
      INSERT INTO partner_daily_stats
        (partner, day, total_users, new_users, active_users, active_7d, active_30d, matches, updated_at)
      VALUES (${partner}, ${r.day}::date, ${r.total_users}, ${r.new_users}, ${r.active_users},
              ${r.active_7d}, ${r.active_30d}, ${r.matches}, now())
      ON CONFLICT (partner, day) DO UPDATE SET
        total_users = EXCLUDED.total_users, new_users = EXCLUDED.new_users,
        active_users = EXCLUDED.active_users, active_7d = EXCLUDED.active_7d,
        active_30d = EXCLUDED.active_30d, matches = EXCLUDED.matches, updated_at = now()
    `;
  }
}

/** Read yesterday and today from Table Derby and store them. Throws (writing nothing) when Table Derby can't answer. */
export async function syncTableDerbyStats(td: TableDerbySql, now = new Date()): Promise<PartnerDayCounts[]> {
  const today = tbilisiDay(now);
  const rows = await readTableDerbyDays(td, [addDays(today, -1), today]);
  await upsertPartnerDays(TABLE_DERBY, rows);
  return rows;
}

const isLocalHost = (url: string) => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function createTableDerbyClient(url: string): TableDerbySql {
  return postgres(url, {
    max: 1,
    ssl: isLocalHost(url) ? false : 'require',
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    connection: { application_name: 'quizball-partner-stats' },
    onnotice: () => {},
  });
}

async function todayIsFresh(now: Date): Promise<boolean> {
  const [row] = await sql<{ fresh: boolean }[]>`
    SELECT COALESCE(max(updated_at) > now() - make_interval(secs => ${FRESH_MS / 1_000}), false) AS fresh
    FROM partner_daily_stats WHERE partner = ${TABLE_DERBY} AND day = ${tbilisiDay(now)}::date`;
  return Boolean(row?.fresh);
}

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Table Derby stats sync exceeded ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** One leased sync: skipped without the URL, without Redis (every replica would run it), or when another replica just did it. */
export async function runTableDerbyStatsSync(now = new Date()): Promise<'done' | 'skipped'> {
  const url = config.TD_STATS_DATABASE_URL;
  if (!url) return 'skipped';
  if (!getRedisClient()?.isOpen) return 'skipped';
  const lock = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return 'skipped';
  const heartbeat = startLockHeartbeat(LOCK_KEY, lock.token, LOCK_TTL_MS);
  try {
    if (await todayIsFresh(now)) return 'skipped';
    const td = createTableDerbyClient(url);
    try {
      const rows = await withDeadline(syncTableDerbyStats(td, now), RUN_DEADLINE_MS, () => {
        void td.end({ timeout: 0 });
      });
      logger.info({ partner: TABLE_DERBY, days: rows }, 'Partner daily stats synced');
      return 'done';
    } finally {
      await td.end({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    heartbeat.stop();
    await releaseLock(LOCK_KEY, lock.token).catch(() => false);
  }
}

let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let running: Promise<unknown> | null = null;

function tick(): void {
  if (running) return;
  running = runTableDerbyStatsSync()
    .catch((error: unknown) => logger.warn({ error }, 'Table Derby stats sync failed; keeping the last numbers'))
    .finally(() => { running = null; });
}

export function startTableDerbyStatsSync(): void {
  if (startupTimer || intervalTimer || !config.TD_STATS_DATABASE_URL) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
  }, STARTUP_MIN_DELAY_MS + Math.floor(Math.random() * STARTUP_JITTER_MS));
  startupTimer.unref?.();
  intervalTimer = setInterval(tick, INTERVAL_MS);
  intervalTimer.unref?.();
}

export async function stopTableDerbyStatsSync(): Promise<void> {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
  await running;
}
