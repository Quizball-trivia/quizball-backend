import postgres from 'postgres';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  DbAdmissionController,
  DbOverloadedError,
  type DbAdmissionStats,
} from './admission.js';
import { readOnlyDbBreaker } from './readonly-breaker.js';

export const DB_POOL_MAX = config.DB_POOL_MAX ?? 12;
const DB_INFLIGHT_LIMIT = Math.min(config.DB_INFLIGHT_LIMIT ?? DB_POOL_MAX, DB_POOL_MAX);
const admission = new DbAdmissionController(
  DB_INFLIGHT_LIMIT,
  config.DB_QUEUE_LIMIT ?? DB_INFLIGHT_LIMIT,
  config.DB_ACQUIRE_TIMEOUT_MS ?? 1_500
);

// Keep the physical pool and the application admission budget aligned. This is
// a per-replica pool; aggregate it across every replica before choosing values.
const rawSql = postgres(config.DATABASE_URL ?? '', {
  max: DB_POOL_MAX,
  idle_timeout: 20,
  connect_timeout: 10,
  // Avoid synchronized two-minute reconnect churn during a traffic spike.
  // Bounded acquisition and the watchdog handle dead pools.
  max_lifetime: config.DB_MAX_LIFETIME_SECONDS ?? 1_800,
  // Supavisor transaction mode does not forward these startup parameters.
  // Per-transaction SET LOCAL below is the reliable server-side enforcement.
  connection: {
    application_name: 'quizball-api',
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 15_000,
  },
  onnotice: () => {},
  prepare: false,
  debug: false,
});

async function runWithAdmission<T>(operation: () => PromiseLike<T> | T): Promise<T> {
  try {
    return await admission.run(operation);
  } catch (error) {
    if (error instanceof DbOverloadedError) {
      const stats = admission.stats();
      if (stats.rejections % 50 === 1) {
        logger.warn({ ...stats, reason: error.reason }, 'DB admission gate shedding load');
      }
    }
    // Central 25006 hook: EVERY query, transaction and probe funnels through
    // admission, so this is the one place that sees all read-only write
    // failures regardless of which repo issued them.
    readOnlyDbBreaker.recordError(error);
    throw error;
  }
}

/** Current admission and physical-pool limits for health/metrics. */
export function dbPoolStats(): DbAdmissionStats & { inflight: number; max: number } {
  const stats = admission.stats();
  return { ...stats, inflight: stats.active, max: DB_POOL_MAX };
}

/** Preserve the existing opt-in API while routing it through full admission. */
export async function withDbBreaker<T>(op: () => PromiseLike<T> | T): Promise<T> {
  return runWithAdmission(op);
}

const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TX_MS = 15_000;

function setLocalTimeouts(
  tx: postgres.TransactionSql,
  statementMs: number,
  idleMs: number
): Promise<unknown> {
  const stmt = Math.max(0, Math.round(statementMs));
  const idle = Math.max(0, Math.round(idleMs));
  return Promise.all([
    tx.unsafe(`SET LOCAL statement_timeout = ${stmt}`),
    tx.unsafe(`SET LOCAL idle_in_transaction_session_timeout = ${idle}`),
  ]);
}

const rawBegin = rawSql.begin.bind(rawSql);

function gatedBegin(...args: unknown[]): Promise<unknown> {
  const fn = args.pop() as (tx: postgres.TransactionSql) => unknown;
  const options = args;
  const wrapped = async (tx: postgres.TransactionSql) => {
    await setLocalTimeouts(tx, STATEMENT_TIMEOUT_MS, IDLE_IN_TX_MS);
    return fn(tx);
  };
  return runWithAdmission(
    () => (rawBegin as (...a: unknown[]) => Promise<unknown>)(...options, wrapped)
  );
}

/**
 * Delay a postgres.js PendingQuery until admission grants a slot. Query
 * fragments remain synchronous so interpolation and sql.array/sql.json work.
 */
function gatePendingQuery<T extends object>(query: T): T {
  let execution: Promise<unknown> | undefined;
  const start = () => {
    execution ??= runWithAdmission(() => query as unknown as PromiseLike<unknown>);
    return execution;
  };
  let proxy: T;
  proxy = new Proxy(query, {
    get(target, property) {
      if (property === 'then') {
        return (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => start().then(onFulfilled, onRejected);
      }
      if (property === 'catch') {
        return (onRejected: (reason: unknown) => unknown) => start().catch(onRejected);
      }
      if (property === 'finally') {
        return (onFinally: () => void) => start().finally(onFinally);
      }
      if (property === 'execute') {
        return () => {
          void start();
          return proxy;
        };
      }

      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'simple' || property === 'values' || property === 'raw') {
        return (...args: unknown[]) =>
          gatePendingQuery(Reflect.apply(value, target, args) as object);
      }
      if (property === 'describe') {
        return (...args: unknown[]) =>
          runWithAdmission(() => Reflect.apply(value, target, args) as PromiseLike<unknown>);
      }
      return value.bind(target);
    },
  });
  return proxy;
}

const sqlProxy = new Proxy(rawSql, {
  apply(target, thisArg, args: unknown[]) {
    const result = Reflect.apply(target, thisArg, args);
    const first = args[0] as { raw?: unknown } | undefined;
    return Array.isArray(first) && Array.isArray(first.raw)
      ? gatePendingQuery(result as object)
      : result;
  },
  get(target, property) {
    if (property === 'begin') return gatedBegin;
    if (property === 'unsafe' || property === 'file') {
      const method = Reflect.get(target, property, target) as (...args: unknown[]) => object;
      return (...args: unknown[]) =>
        gatePendingQuery(Reflect.apply(method, target, args));
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export const sql = sqlProxy as typeof rawSql;

export async function withStatementTimeout<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
  statementMs = STATEMENT_TIMEOUT_MS,
): Promise<T> {
  return runWithAdmission(
    () => rawBegin<T>(async (tx) => {
      await setLocalTimeouts(tx, statementMs, IDLE_IN_TX_MS);
      return fn(tx);
    }) as Promise<T>
  );
}

/**
 * Probe the real pool ahead of the ordinary request backlog so load cannot
 * cause a false watchdog restart.
 */
export async function withDbWatchdogProbe<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
  statementMs = 2_000,
  acquireTimeoutMs = 3_500,
): Promise<T> {
  try {
    return await admission.runPriority(
      () => rawBegin<T>(async (tx) => {
        await setLocalTimeouts(tx, statementMs, IDLE_IN_TX_MS);
        return fn(tx);
      }) as Promise<T>,
      acquireTimeoutMs,
    );
  } catch (error) {
    // runPriority bypasses runWithAdmission, so the breaker is fed here too.
    readOnlyDbBreaker.recordError(error, { source: 'watchdog_probe' });
    throw error;
  }
}

/**
 * Rollback-only WRITE probe — the readiness check that a plain `SELECT 1`
 * cannot provide (INC-2026-07-29 contributing factor #1: read-only pooled
 * connections looked perfectly healthy).
 *
 * `CREATE TEMP TABLE ... ON COMMIT DROP` inside a transaction that always
 * rolls back was chosen after verifying the alternatives against the real
 * Supabase Supavisor TRANSACTION-mode pooler (port 6543):
 *
 *  - It DOES fail with SQLSTATE 25006 on a connection contaminated with
 *    `default_transaction_read_only=on` (empirically confirmed 2026-07-30) —
 *    which is exactly the detection we need.
 *  - It touches NO application table, so it cannot corrupt game data, needs no
 *    migration, and leaves zero footprint: the temp relation dies with the
 *    rolled-back transaction (verified: no residue in pg_tables or pg_temp*).
 *  - `SET LOCAL default_transaction_read_only = off` was tested and REJECTED:
 *    Postgres has already entered the transaction read-only, so the SET LOCAL
 *    is accepted but `transaction_read_only` stays `on` and the write still
 *    fails. It neither repairs nor detects anything, so it is not used.
 *
 * Resolves true when the pool can write, false otherwise. Never throws, so it
 * is safe to call from a health route and from the watchdog.
 */
export async function probeDbWritable(statementMs = 2_000): Promise<boolean> {
  const ROLLBACK = new Error('__probe_rollback__');
  try {
    await withDbWatchdogProbe(async (tx) => {
      await tx.unsafe('CREATE TEMP TABLE _quizball_write_probe (probe int) ON COMMIT DROP');
      // Always abort: the probe must never commit anything, not even a temp DDL.
      throw ROLLBACK;
    }, statementMs);
    return true;
  } catch (error) {
    if (error === ROLLBACK) {
      // The write was accepted by Postgres; only our own rollback ended the txn.
      readOnlyDbBreaker.recordProbeSuccess();
      return true;
    }
    readOnlyDbBreaker.recordProbeFailure(error);
    return false;
  }
}

export type { TransactionSql } from 'postgres';

export async function disconnectDb(): Promise<void> {
  await rawSql.end();
}

export { DbOverloadedError } from './admission.js';
export {
  readOnlyDbBreaker,
  isDbWriteOutage,
  isReadOnlyTransactionError,
  DbWriteOutageError,
  READ_ONLY_SQLSTATE,
  READ_ONLY_ALERT_MARKER,
} from './readonly-breaker.js';
