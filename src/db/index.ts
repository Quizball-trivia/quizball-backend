import postgres from 'postgres';
import { config } from '../core/config.js';

// Create postgres connection pool
export const sql = postgres(config.DATABASE_URL ?? '', {
  max: 10, // connection pool size
  idle_timeout: 20,
  connect_timeout: 10,
});

// Re-export postgres types for use in repos
export type { TransactionSql } from 'postgres';

// Graceful shutdown helper
export async function disconnectDb(): Promise<void> {
  await sql.end();
}
