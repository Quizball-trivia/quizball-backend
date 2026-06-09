import postgres from 'postgres';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

export const DB_POOL_MAX = 30;

// Create postgres connection pool
export const sql = postgres(config.DATABASE_URL ?? '', {
  max: DB_POOL_MAX, // connection pool size (under the Supabase pooler size of 40)
  idle_timeout: 20,
  connect_timeout: 10,
  // Recycle connections every 2 minutes. A short lifetime means that after a
  // Supabase DB restart (e.g. compute upgrade / maintenance), any connection
  // left pointing at the old instance is dropped and re-established quickly,
  // instead of lingering and causing requests to hang on a dead connection.
  max_lifetime: 60 * 2, // 2 minutes
  // NOTE: these are delivered as Postgres *startup parameters*, which Supabase's
  // TRANSACTION-mode pooler (Supavisor, prod port 6543) does NOT forward — so
  // they are effectively a NO-OP on prod (verified: sessions still report 2min/0).
  // The real server-side timeouts are set per-transaction via `SET LOCAL` (see
  // withStatementTimeout) and on the `postgres` role GUC. Kept here only so a
  // session-mode (5432) connection still benefits; do NOT rely on it for 6543.
  connection: {
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 15_000,
  },
  onnotice: () => {}, // Suppress notices
  prepare: false, // Disable prepared statements to avoid cache invalidation errors
  debug: false,
});

// ── DB in-flight circuit breaker ─────────────────────────────────────────────
// Prevents the pool-exhaustion snowball (2026-06-09 incident): when too many DB
// operations are already checked out / queued, new work fails FAST with a 503
// instead of queueing behind an exhausted pool for 30-135s ("site down"). This
// does NOT cancel in-flight queries (postgres.js wouldn't truly cancel them) —
// it only refuses to *schedule* new DB work past a safe ceiling.
const DB_INFLIGHT_LIMIT = Math.round(DB_POOL_MAX * 1.5); // pool + a small queue (45)
let dbInflight = 0;
let dbRejections = 0;

export class DbOverloadedError extends Error {
  readonly statusCode = 503;
  readonly code = 'DB_OVERLOADED';
  constructor() {
    super('Database is busy, please retry shortly');
    this.name = 'DbOverloadedError';
  }
}

/** Current in-flight DB operations (for /health/db + metrics). */
export function dbPoolStats(): { inflight: number; limit: number; max: number; rejections: number } {
  return { inflight: dbInflight, limit: DB_INFLIGHT_LIMIT, max: DB_POOL_MAX, rejections: dbRejections };
}

/**
 * Run a DB operation through the in-flight circuit breaker. If the breaker is
 * tripped (too many concurrent DB ops), throws DbOverloadedError (503) so the
 * request fails fast instead of queueing behind an exhausted pool.
 */
export async function withDbBreaker<T>(op: () => Promise<T>): Promise<T> {
  if (dbInflight >= DB_INFLIGHT_LIMIT) {
    dbRejections++;
    if (dbRejections % 50 === 1) {
      logger.warn({ inflight: dbInflight, limit: DB_INFLIGHT_LIMIT, rejections: dbRejections }, 'DB circuit breaker tripped — shedding load');
    }
    throw new DbOverloadedError();
  }
  dbInflight++;
  try {
    return await op();
  } finally {
    dbInflight--;
  }
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

const rawBegin = sql.begin.bind(sql);
// Override sql.begin so every transaction gets the reaper automatically, with
// zero changes at the ~21 call sites. Preserves the original signature/overloads.
(sql as { begin: unknown }).begin = ((...args: unknown[]) => {
  const fn = args.pop() as (tx: postgres.TransactionSql) => unknown;
  const options = args; // optional isolation-level string, passed through
  const wrapped = async (tx: postgres.TransactionSql) => {
    await setLocalTimeouts(tx, STATEMENT_TIMEOUT_MS, IDLE_IN_TX_MS);
    return fn(tx);
  };
  return (rawBegin as (...a: unknown[]) => unknown)(...options, wrapped);
}) as typeof sql.begin;

/**
 * Run critical/at-risk DB work in a transaction with a CUSTOM statement timeout
 * (e.g. a tight 2s for the health probe). The default sql.begin already applies
 * 30s/15s; use this only when a different ceiling is needed.
 */
export async function withStatementTimeout<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
  statementMs = STATEMENT_TIMEOUT_MS,
): Promise<T> {
  return rawBegin<T>(async (tx) => {
    await setLocalTimeouts(tx, statementMs, IDLE_IN_TX_MS);
    return fn(tx);
  }) as Promise<T>;
}

// Re-export postgres types for use in repos
export type { TransactionSql } from 'postgres';

// Graceful shutdown helper
export async function disconnectDb(): Promise<void> {
  await sql.end();
}
