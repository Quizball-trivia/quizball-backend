import postgres from 'postgres';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../../realtime/locks.js';
import { getRedisClient } from '../../realtime/redis.js';
import { TABLE_DERBY, addDays, tbilisiDay } from './partner-days.js';

/**
 * Table Derby's players counted into Quizball's totals: every 30 minutes one
 * replica asks Table Derby's database, as its td_stats_reader role, for the
 * counts of the last SYNC_DAYS Tbilisi days and stores them in
 * partner_daily_stats. The reader may only call td_partner_daily_stats(),
 * which returns integers per day: no player row or id ever reaches Quizball.
 * Re-reading the whole window each run fills days missed during an outage and
 * picks up later corrections of settled matches. A failed run writes nothing,
 * so the last numbers stay.
 */

/** Days re-read each run, today included (Table Derby answers at most 41). */
export const SYNC_DAYS = 35;
const INTERVAL_MS = 30 * 60_000;
/** A replica that finds today's row younger than this skips (every replica ticks; one sync per interval is enough). */
const FRESH_MS = 25 * 60_000;
const STARTUP_MIN_DELAY_MS = 60_000;
const STARTUP_JITTER_MS = 60_000;
const LOCK_KEY = 'lock:partner_stats:table_derby';
const LOCK_TTL_MS = 60_000;
const STATEMENT_TIMEOUT_MS = 10_000;
/** The whole run, from the freshness check to the write. */
const RUN_DEADLINE_MS = 45_000;

export interface PartnerDayCounts {
  day: string;
  total_users: number;
  new_users: number;
  active_users: number;
  active_7d: number;
  active_30d: number;
  matches: number;
}

export interface TableDerbySnapshot {
  rows: PartnerDayCounts[];
  /** When Table Derby's database computed them. */
  sourceAt: Date;
}

export type TableDerbySql = postgres.Sql;

export type SyncStage = 'config' | 'freshness' | 'read' | 'write' | 'deadline';

/**
 * A failed step, carrying only what is safe to log: the step and an error
 * code. Driver errors can include the connection string (error.input) or the
 * query; they are never logged.
 */
export class TableDerbyStatsError extends Error {
  constructor(readonly stage: SyncStage, readonly code: string) {
    super(`Table Derby stats ${stage} failed (${code})`);
    this.name = 'TableDerbyStatsError';
  }
}

const safeCode = (error: unknown): string => {
  if (error instanceof TableDerbyStatsError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'unknown';
};

async function stage<T>(name: SyncStage, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TableDerbyStatsError) throw error;
    throw new TableDerbyStatsError(name, safeCode(error));
  }
}

const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const POOLER_USER = /^td_stats_reader\.[a-z0-9]{20}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface TableDerbyTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  local: boolean;
}

/**
 * The connection the sync may use: Supabase's transaction pooler as
 * td_stats_reader of the Table Derby project named by TD_STATS_PROJECT_REF
 * (set per environment, so staging cannot read production), or (local runs only) a database on
 * this machine as td_stats_reader. Anything else, an owner login included, is
 * refused. Errors name the rule broken, never the value.
 */
export function parseTableDerbyTarget(raw: string, allowLocal: boolean, projectRef?: string): TableDerbyTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TableDerbyStatsError('config', 'url_malformed');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new TableDerbyStatsError('config', 'url_protocol');
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  const local = LOCAL_HOSTS.has(url.hostname);
  if (local) {
    if (!allowLocal) throw new TableDerbyStatsError('config', 'url_local_host');
    if (username !== 'td_stats_reader') throw new TableDerbyStatsError('config', 'url_user');
  } else {
    if (!POOLER_HOST.test(url.hostname)) throw new TableDerbyStatsError('config', 'url_host');
    if (url.port !== '6543') throw new TableDerbyStatsError('config', 'url_port');
    if (!POOLER_USER.test(username)) throw new TableDerbyStatsError('config', 'url_user');
    if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) throw new TableDerbyStatsError('config', 'project_ref_missing');
    if (username !== `td_stats_reader.${projectRef}`) throw new TableDerbyStatsError('config', 'url_project_ref');
    if (database !== 'postgres') throw new TableDerbyStatsError('config', 'url_database');
    if (!password) throw new TableDerbyStatsError('config', 'url_password');
  }
  return { host: url.hostname, port: Number(url.port || 5432), database, username, password, local };
}

/**
 * Verified TLS for the pooler: Supabase's own CA signs its certificate (it is
 * not in the system store), so the PEM comes from TD_STATS_DATABASE_CA; the
 * host name is checked against the certificate. Local databases use no TLS.
 */
export function createTableDerbyClient(target: TableDerbyTarget, caPem?: string): TableDerbySql {
  let ssl: false | { ca: string; rejectUnauthorized: true };
  if (target.local) ssl = false;
  else {
    const ca = caPem?.replace(/\\n/g, '\n').trim();
    if (!ca || !ca.includes('-----BEGIN CERTIFICATE-----')) throw new TableDerbyStatsError('config', 'ca_missing');
    ssl = { ca, rejectUnauthorized: true };
  }
  return postgres({
    host: target.host,
    port: target.port,
    database: target.database,
    username: target.username,
    password: target.password,
    max: 1,
    ssl,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    connection: { application_name: 'quizball-partner-stats' },
    onnotice: () => {},
  });
}

const COUNT_KEYS = ['total_users', 'new_users', 'active_users', 'active_7d', 'active_30d', 'matches'] as const;

/** The counts of each day from `from` to `to`, computed by Table Derby's td_partner_daily_stats(). */
export async function readTableDerbyDays(td: TableDerbySql, from: string, to: string): Promise<TableDerbySnapshot> {
  const result = await td.begin('read only', async (transaction) => {
    const tx = transaction as unknown as TableDerbySql;
    await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    // The time of the statement that counts (its snapshot), not of the transaction's start.
    const rows = await tx<(PartnerDayCounts & { source_at: Date })[]>`
      SELECT to_char(s.day, 'YYYY-MM-DD') AS day, s.total_users, s.new_users, s.active_users, s.active_7d,
             s.active_30d, s.matches, statement_timestamp() AS source_at
      FROM td_partner_daily_stats(${from}::date, ${to}::date) AS s
      ORDER BY s.day`;
    const sourceAt = rows[0]?.source_at;
    if (!sourceAt) throw new TableDerbyStatsError('read', 'missing_days');
    return { rows: [...rows].map(({ source_at: _at, ...r }) => ({ ...r })), sourceAt };
  });
  let expected = from;
  for (const r of result.rows) {
    if (r.day !== expected) throw new TableDerbyStatsError('read', 'unexpected_day');
    for (const k of COUNT_KEYS) {
      if (!Number.isInteger(r[k]) || r[k] < 0) throw new TableDerbyStatsError('read', 'not_a_count');
    }
    expected = addDays(expected, 1);
  }
  if (expected !== addDays(to, 1)) throw new TableDerbyStatsError('read', 'missing_days');
  return result;
}

/** Quizball-side bounds: no statement of the sync may wait or run past these. */
const QB_STATEMENT_TIMEOUT_MS = 10_000;
const QB_LOCK_TIMEOUT_MS = 5_000;

type QbTx = typeof sql;

/** A Quizball transaction whose statements and lock waits are bounded (SET LOCAL only: never a session setting). */
async function bounded<T>(work: (tx: QbTx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (transaction) => {
    const tx = transaction as unknown as QbTx;
    await tx.unsafe(`SET LOCAL statement_timeout = ${QB_STATEMENT_TIMEOUT_MS}`);
    await tx.unsafe(`SET LOCAL lock_timeout = ${QB_LOCK_TIMEOUT_MS}`);
    return work(tx);
  })) as T;
}

/** Every day in one statement: all or none. Rows already written from a newer snapshot are kept. */
export async function upsertPartnerDays(partner: string, snapshot: TableDerbySnapshot): Promise<number> {
  const { rows, sourceAt } = snapshot;
  const column = (k: keyof PartnerDayCounts) => rows.map((r) => r[k]);
  const written = await bounded((sql) => sql<{ day: string }[]>`
    INSERT INTO partner_daily_stats
      (partner, day, total_users, new_users, active_users, active_7d, active_30d, matches, source_at, updated_at)
    SELECT ${partner}, d.day, d.total_users, d.new_users, d.active_users, d.active_7d, d.active_30d, d.matches,
           ${sourceAt}::timestamptz, now()
    FROM unnest(
      ${sql.array(column('day') as string[])}::date[], ${sql.array(column('total_users') as number[])}::int[],
      ${sql.array(column('new_users') as number[])}::int[], ${sql.array(column('active_users') as number[])}::int[],
      ${sql.array(column('active_7d') as number[])}::int[], ${sql.array(column('active_30d') as number[])}::int[],
      ${sql.array(column('matches') as number[])}::int[]
    ) AS d(day, total_users, new_users, active_users, active_7d, active_30d, matches)
    ON CONFLICT (partner, day) DO UPDATE SET
      total_users = EXCLUDED.total_users, new_users = EXCLUDED.new_users,
      active_users = EXCLUDED.active_users, active_7d = EXCLUDED.active_7d,
      active_30d = EXCLUDED.active_30d, matches = EXCLUDED.matches,
      source_at = EXCLUDED.source_at, updated_at = now()
    WHERE partner_daily_stats.source_at < EXCLUDED.source_at
    RETURNING day
  `);
  return written.length;
}

/** Read the last SYNC_DAYS days from Table Derby and store them. Throws (writing nothing) when Table Derby can't answer. */
export async function syncTableDerbyStats(td: TableDerbySql, now = new Date()): Promise<TableDerbySnapshot> {
  const today = tbilisiDay(now);
  const snapshot = await stage('read', () => readTableDerbyDays(td, addDays(today, -(SYNC_DAYS - 1)), today));
  await stage('write', () => upsertPartnerDays(TABLE_DERBY, snapshot));
  return snapshot;
}

/** Table Derby answers at most this many days per call. */
const MAX_DAYS_PER_READ = 41;

/**
 * One-off backfill of an older range (the 30-minute sync re-reads only the
 * last SYNC_DAYS days): read in windows Table Derby accepts, each written in
 * one statement. Returns the days read and written (an older snapshot never
 * replaces a newer row, so a later sync wins).
 */
export async function backfillTableDerbyDays(
  td: TableDerbySql,
  from: string,
  to: string,
  options: { dryRun?: boolean } = {},
): Promise<{ read: number; written: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new TableDerbyStatsError('config', 'range_invalid');
  }
  let read = 0;
  let written = 0;
  for (let first = from; first <= to; first = addDays(first, MAX_DAYS_PER_READ)) {
    const last = addDays(first, MAX_DAYS_PER_READ - 1) < to ? addDays(first, MAX_DAYS_PER_READ - 1) : to;
    const snapshot = await stage('read', () => readTableDerbyDays(td, first, last));
    read += snapshot.rows.length;
    if (!options.dryRun) written += await stage('write', () => upsertPartnerDays(TABLE_DERBY, snapshot));
  }
  return { read, written };
}

/** The configured client for a one-off run (the backfill script); the caller ends it. */
export function configuredTableDerbyClient(): TableDerbySql {
  const target = configuredTarget();
  if (!target) throw new TableDerbyStatsError('config', 'url_missing');
  return createTableDerbyClient(target, config.TD_STATS_DATABASE_CA);
}

async function todayIsFresh(now: Date): Promise<boolean> {
  const [row] = await bounded((sql) => sql<{ fresh: boolean }[]>`
    SELECT COALESCE(max(updated_at) > now() - make_interval(secs => ${FRESH_MS / 1_000}), false) AS fresh
    FROM partner_daily_stats WHERE partner = ${TABLE_DERBY} AND day = ${tbilisiDay(now)}::date`);
  return Boolean(row?.fresh);
}

const allowLocalTarget = () => config.NODE_ENV === 'local';

/** The configured target, or null when the sync is off. Throws a config error when it is set but not allowed. */
function configuredTarget(): TableDerbyTarget | null {
  const raw = config.TD_STATS_DATABASE_URL;
  if (!raw) return null;
  const target = parseTableDerbyTarget(raw, allowLocalTarget(), config.TD_STATS_PROJECT_REF);
  if (!target.local && !config.TD_STATS_DATABASE_CA?.includes('-----BEGIN CERTIFICATE-----')) {
    throw new TableDerbyStatsError('config', 'ca_missing');
  }
  return target;
}

/**
 * One leased sync, bounded as a whole: skipped without the URL, without Redis
 * (every replica would run it), or when another replica just did it. The
 * lease is released only once the run has settled, so a late write cannot
 * overlap the next holder's (and an older snapshot never replaces a newer).
 */
export async function runTableDerbyStatsSync(now = new Date()): Promise<'done' | 'skipped'> {
  const target = configuredTarget();
  if (!target) return 'skipped';
  if (!getRedisClient()?.isOpen) return 'skipped';
  const lock = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return 'skipped';
  const heartbeat = startLockHeartbeat(LOCK_KEY, lock.token, LOCK_TTL_MS);
  let td: TableDerbySql | null = null;
  const work = (async (): Promise<'done' | 'skipped'> => {
    if (await stage('freshness', () => todayIsFresh(now))) return 'skipped';
    td = await stage('config', async () => createTableDerbyClient(target, config.TD_STATS_DATABASE_CA));
    try {
      const snapshot = await syncTableDerbyStats(td, now);
      const today = snapshot.rows[snapshot.rows.length - 1];
      logger.info({ partner: TABLE_DERBY, days: snapshot.rows.length, today }, 'Partner daily stats synced');
      return 'done';
    } finally {
      await (td as TableDerbySql).end({ timeout: 5 }).catch(() => undefined);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Past the deadline the lease is no longer renewed: it lapses on its own even if Quizball's side were still
      // waiting (each of its statements is bounded by QB_STATEMENT_TIMEOUT_MS anyway).
      heartbeat.stop();
      void (td as TableDerbySql | null)?.end({ timeout: 0 }).catch(() => undefined);
      reject(new TableDerbyStatsError('deadline', 'timeout'));
    }, RUN_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    await work.catch(() => undefined);
    heartbeat.stop();
    await releaseLock(LOCK_KEY, lock.token).catch(() => false);
  }
}

let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let running: Promise<unknown> | null = null;

const logFailure = (error: unknown) => {
  const stageName = error instanceof TableDerbyStatsError ? error.stage : 'unknown';
  logger.warn({ operation: stageName, code: safeCode(error) }, 'Table Derby stats sync failed; keeping the last numbers');
};

function tick(): void {
  if (running) return;
  running = runTableDerbyStatsSync()
    .catch(logFailure)
    .finally(() => { running = null; });
}

export function startTableDerbyStatsSync(): void {
  if (startupTimer || intervalTimer) return;
  try {
    if (!configuredTarget()) return;
  } catch (error) {
    logFailure(error);
    return;
  }
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
