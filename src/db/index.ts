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
