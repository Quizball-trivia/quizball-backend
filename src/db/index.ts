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

/**
 * Run a callback inside a transaction with a per-transaction statement +
 * idle-in-transaction timeout that ACTUALLY works through the Supavisor
 * transaction pooler (SET LOCAL is scoped to the tx and is honored on 6543,
 * unlike connection startup params). Use for critical/at-risk DB work.
 */
export async function withStatementTimeout<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
  ms = 30_000,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.round(ms)}`);
    await tx.unsafe(`SET LOCAL idle_in_transaction_session_timeout = 15000`);
    return fn(tx);
  }) as Promise<T>;
}

// Re-export postgres types for use in repos
export type { TransactionSql } from 'postgres';

// Graceful shutdown helper
export async function disconnectDb(): Promise<void> {
  await sql.end();
}
