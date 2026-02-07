import postgres from 'postgres';
import { config } from '../core/config.js';

// Create postgres connection pool
export const sql = postgres(config.DATABASE_URL ?? '', {
  max: 10, // connection pool size
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 60 * 10, // 10 minutes - recycle connections to avoid stale prepared statements
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
