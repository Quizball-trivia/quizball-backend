import { defineConfig } from 'vitest/config';

/**
 * Mentalista's pure unit tests only. These touch no database, no Redis, no network and no filesystem, so this config
 * deliberately does NOT load the default tests/setup.ts (which points at the shared localhost:5432 test database).
 * Instead it loads only tests/release/network-guard.ts, which traps any socket connect to a cloud/shared service or a
 * database/Redis port (5432/6379/6543/54322) and fails the run before it can reach one. Run:
 *
 *   npx vitest run --config vitest.mentalista.config.ts
 *
 * Every file it includes imports only the pure engine/rules modules (plus the room.types enum and read-only source
 * assertions for registry/lobby wiring) — no module here reads .env, opens a connection or touches the filesystem for
 * anything but reading committed source. Safe to run anywhere, including an isolated release rehearsal.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/room/mentalista.engine.test.ts', 'tests/room/mentalista.registration.test.ts'],
    setupFiles: ['tests/release/network-guard.ts'],
  },
});
