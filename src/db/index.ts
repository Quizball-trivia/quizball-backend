import postgres from 'postgres';
import { config } from '../core/config.js';

// Create postgres connection pool
export const sql = postgres(config.DATABASE_URL ?? '', {
  max: 30, // connection pool size (under the Supabase pooler size of 40)
  idle_timeout: 20,
  connect_timeout: 10,
  // Recycle connections every 2 minutes. A short lifetime means that after a
  // Supabase DB restart (e.g. compute upgrade / maintenance), any connection
  // left pointing at the old instance is dropped and re-established quickly,
  // instead of lingering and causing requests to hang on a dead connection.
  max_lifetime: 60 * 2, // 2 minutes
  // Server-side timeouts so the DATABASE itself kills stuck/runaway sessions.
  // Without these, a connection stuck in ClientRead (DB finished, but the Node
  // process never read the result) holds a pool slot FOREVER — slots leak, the
  // pool exhausts, and every request queues for 30-130s ("site down", the
  // 2026-06-09 incident). 30s is well above any healthy query.
  connection: {
    statement_timeout: 30_000, // abort any query running > 30s
    idle_in_transaction_session_timeout: 15_000, // kill txns left open > 15s
  },
  onnotice: () => {}, // Suppress notices
  prepare: false, // Disable prepared statements to avoid cache invalidation errors
  debug: false,
});

// Re-export postgres types for use in repos
export type { TransactionSql } from 'postgres';

// Graceful shutdown helper
export async function disconnectDb(): Promise<void> {
  await sql.end();
}
