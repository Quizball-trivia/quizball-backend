import { defineConfig } from 'vitest/config';

/**
 * Mentalista's REAL-database runtime integration test. Unlike vitest.mentalista.config.ts (pure, no services), this one
 * drives roomService against an actual, test-owned PostgreSQL with the room migrations already applied, plus the owned
 * Redis. Both are loopback-only and dedicated to this rehearsal:
 *
 *   RELEASE_TEST_DATABASE_URL=postgresql://mentalista_local@127.0.0.1:55519/rehearsal_mentalista
 *   REDIS_URL=redis://127.0.0.1:55520/0           (set by tests/release/network-guard.ts)
 *
 * The run is SERIAL (one file, one fork, no concurrency): the single test file shares one database and truncates it
 * between cases, so parallelism would cross-contaminate. setupFiles run in order — the network guard first (it traps any
 * socket to a shared/cloud service or an ordinary DB/Redis port), then tests/setup.ts (which re-checks the rehearsal URL
 * shape and wires the test env). The test itself asserts the database's identity before it truncates anything.
 *
 *   RELEASE_TEST_DATABASE_URL=postgresql://mentalista_local@127.0.0.1:55519/rehearsal_mentalista \
 *     npx vitest run --config vitest.mentalista-db.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/room/mentalista-db.integration.test.ts'],
    setupFiles: ['tests/release/network-guard.ts', 'tests/setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
