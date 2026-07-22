import postgres from 'postgres';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  DbAdmissionController,
  DbOverloadedError,
  type DbAdmissionStats,
} from './admission.js';

// Runtime fallbacks also keep unit tests with intentionally partial config
// mocks safe; the real parsed config always supplies these values.
export const DB_POOL_MAX = config.DB_POOL_MAX ?? 12;
const DB_INFLIGHT_LIMIT = Math.min(config.DB_INFLIGHT_LIMIT ?? DB_POOL_MAX, DB_POOL_MAX);
const admission = new DbAdmissionController(
  DB_INFLIGHT_LIMIT,
  config.DB_QUEUE_LIMIT ?? DB_INFLIGHT_LIMIT,
  config.DB_ACQUIRE_TIMEOUT_MS ?? 1_500
);

// Create postgres connection pool
const rawSql = postgres(config.DATABASE_URL ?? '', {
  // This is a PER-REPLICA budget. It must be sized against Postgres
  // max_connections after reserving capacity for every Supabase service, not
  // merely kept below Supavisor's backend pool size.
  max: DB_POOL_MAX,
  idle_timeout: 20,
  connect_timeout: 10,
  // Avoid synchronised two-minute reconnect churn during a traffic spike. Dead
  // pools are handled by bounded acquisition + the process watchdog below.
  max_lifetime: config.DB_MAX_LIFETIME_SECONDS ?? 1_800,
  // NOTE on `fetch_types` (db-optimize.md #3): do NOT disable it. It was tried
  // (2026-06-10) to kill the per-connection pg_catalog.pg_type introspection
  // query, but postgres.js needs the fetched OID map to serialize ARRAY
  // parameters — with fetch_types:false EVERY array-sending pattern breaks
  // ("malformed array literal"), including sql.array() with explicit ::uuid[]
  // casts and sql.unsafe positional arrays (empirically verified against the
  // staging DB). Array params are used on hot paths (question picker, lobby
  // categories, nickname checks), so the introspection query (~1ms per new
  // connection) is the cost of keeping them.
  // NOTE: these are delivered as Postgres *startup parameters*, which Supabase's
  // TRANSACTION-mode pooler (Supavisor, prod port 6543) does NOT forward — so
  // they are effectively a NO-OP on prod (verified: sessions still report 2min/0).
  // The real server-side timeouts are set per-transaction via `SET LOCAL` (see
  // withStatementTimeout) and on the `postgres` role GUC. Kept here only so a
  // session-mode (5432) connection still benefits; do NOT rely on it for 6543.
  connection: {
    application_name: 'quizball-api',
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 15_000,
  },
  onnotice: () => {}, // Suppress notices
  prepare: false, // Disable prepared statements to avoid cache invalidation errors
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
    throw error;
  }
}

/** Current in-flight DB operations (for /health/db + metrics). */
export function dbPoolStats(): DbAdmissionStats & { inflight: number; max: number } {
  const stats = admission.stats();
  return { ...stats, inflight: stats.active, max: DB_POOL_MAX };
}

/**
 * Run a DB operation through the in-flight circuit breaker. If the breaker is
 * tripped (too many concurrent DB ops), throws DbOverloadedError (503) so the
 * request fails fast instead of queueing behind an exhausted pool.
 */
export async function withDbBreaker<T>(op: () => PromiseLike<T> | T): Promise<T> {
  return runWithAdmission(op);
}

// ── Per-transaction server-side timeouts (the ONLY reliable reaper on 6543) ───
// VERIFIED on the prod Supavisor transaction pooler:
//  - connection startup params  -> ignored (stays 2min/0)
//  - ALTER ROLE ... SET (GUC)    -> reset to default by the pooler between txns
//  - SET LOCAL inside the txn     -> WORKS (source=session, reaps an idle txn)
// So we wrap sql.begin to inject SET LOCAL at the start of EVERY transaction.
// SET LOCAL is scoped to the txn and cannot leak; it only kills a txn that
// runs a single statement >STATEMENT_TIMEOUT_MS or sits idle >IDLE_IN_TX_MS —
// normal millisecond transactions are never affected.
const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TX_MS = 15_000;

function setLocalTimeouts(tx: postgres.TransactionSql, statementMs: number, idleMs: number): Promise<unknown> {
  // Math.round + clamp so we only ever interpolate a safe non-negative integer
  // into the SET LOCAL statement (never untrusted input).
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
  const options = args; // optional isolation-level string, passed through
  const wrapped = async (tx: postgres.TransactionSql) => {
    await setLocalTimeouts(tx, STATEMENT_TIMEOUT_MS, IDLE_IN_TX_MS);
    return fn(tx);
  };
  return runWithAdmission(
    () => (rawBegin as (...a: unknown[]) => Promise<unknown>)(...options, wrapped)
  );
}

/**
 * Delay execution of a postgres.js PendingQuery until the admission controller
 * grants a slot. The Proxy preserves query-fragment identity, so fragments can
 * still be interpolated into larger tagged-template queries without executing.
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
        return (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          start().then(onFulfilled, onRejected);
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
      // These modifiers return another PendingQuery view over the same query.
      if (property === 'simple' || property === 'values' || property === 'raw') {
        return (...args: unknown[]) => gatePendingQuery(Reflect.apply(value, target, args) as object);
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
    // Only tagged-template calls create a query. Helper calls such as sql.array,
    // sql.json, and sql(object) must remain synchronous query fragments.
    return Array.isArray(first) && Array.isArray(first.raw)
      ? gatePendingQuery(result as object)
      : result;
  },
  get(target, property) {
    if (property === 'begin') return gatedBegin;
    if (property === 'unsafe' || property === 'file') {
      const method = Reflect.get(target, property, target) as (...args: unknown[]) => object;
      return (...args: unknown[]) => gatePendingQuery(Reflect.apply(method, target, args));
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export const sql = sqlProxy as typeof rawSql;

/**
 * Run critical/at-risk DB work in a transaction with a CUSTOM statement timeout
 * (e.g. a tight 2s for the health probe). The default sql.begin already applies
 * 30s/15s; use this only when a different ceiling is needed.
 */
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
 * Probe the same postgres.js pool as application traffic, but jump ahead of
 * the bounded request backlog. This distinguishes a genuinely stuck pool from
 * a healthy pool that is merely busy and prevents load from causing a false
 * watchdog restart.
 */
export async function withDbWatchdogProbe<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
  statementMs = 2_000,
  acquireTimeoutMs = 3_500,
): Promise<T> {
  return admission.runPriority(
    () => rawBegin<T>(async (tx) => {
      await setLocalTimeouts(tx, statementMs, IDLE_IN_TX_MS);
      return fn(tx);
    }) as Promise<T>,
    acquireTimeoutMs,
  );
}

// Re-export postgres types for use in repos
export type { TransactionSql } from 'postgres';

// Graceful shutdown helper
export async function disconnectDb(): Promise<void> {
  await rawSql.end();
}

export { DbOverloadedError } from './admission.js';
