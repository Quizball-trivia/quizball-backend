import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `npm run test:hq-sql`: the real-Postgres HQ SQL suite. It alters cluster-wide roles, so it runs against
// HQ_SQL_TEST_DB_URL or, by default, a throwaway local cluster on its own port
// (initdb -D <dir> && pg_ctl -D <dir> -o "-p 55436 -c listen_addresses=127.0.0.1" start), never a game database.
export default defineConfig({
  root: resolve(__dirname, '../..'),
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/hq/hq.sql.integration.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { HQ_SQL_TEST_DB_URL: process.env.HQ_SQL_TEST_DB_URL ?? 'postgresql://127.0.0.1:55436/postgres' },
  },
});
