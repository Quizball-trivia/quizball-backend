import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { retryRolledBackReadOnlyTransaction } from '../../src/db/read-only-recovery.js';

// Explicit isolated local database only. No fallback to shared/staging/prod URLs.
const url = process.env.READ_ONLY_RECOVERY_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.port !== '55519'
    || !/^\/rehearsal_[a-z0-9_]+$/.test(target.pathname)) {
    throw new Error('Read-only recovery tests require the isolated local rehearsal database');
  }
}

describe.skipIf(!url)('real PostgreSQL read-only rollback and reward atomicity', () => {
  const db = postgres(url ?? '', { max: 2, onnotice: () => {} });
  const schema = `readonly_recovery_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    await db`CREATE SCHEMA ${db(schema)}`;
    await db`CREATE TABLE ${db(schema)}.completions (player text, day date, score int, UNIQUE (player, day))`;
    await db`CREATE TABLE ${db(schema)}.wallet (player text PRIMARY KEY, coins int NOT NULL, xp int NOT NULL)`;
    await db`INSERT INTO ${db(schema)}.wallet VALUES ('player', 0, 0)`;
  });

  beforeEach(async () => {
    await db`DELETE FROM ${db(schema)}.completions`;
    await db`UPDATE ${db(schema)}.wallet SET coins = 0, xp = 0`;
  });

  afterAll(async () => {
    // Only this uniquely named test schema is removed; never a shared schema.
    await db`DROP SCHEMA IF EXISTS ${db(schema)} CASCADE`;
    await db.end({ timeout: 5 });
  });

  it('replays a rolled-back read-only save and awards the result exactly once', async () => {
    let attempts = 0;
    await retryRolledBackReadOnlyTransaction(() => db.begin(
      attempts++ === 0 ? 'read only' : '',
      async (tx) => {
        await tx`INSERT INTO ${tx(schema)}.completions VALUES ('player', '2026-10-16', 5)`;
        await tx`UPDATE ${tx(schema)}.wallet SET coins = coins + 30, xp = xp + 20 WHERE player = 'player'`;
      },
    ), () => {});
    expect(attempts).toBe(2);
    expect(await db`SELECT * FROM ${db(schema)}.wallet`).toEqual([{ player: 'player', coins: 30, xp: 20 }]);
    expect(await db`SELECT * FROM ${db(schema)}.completions`).toHaveLength(1);
  });

  it('retains duplicate-completion protection instead of retrying/re-awarding', async () => {
    await db`INSERT INTO ${db(schema)}.completions VALUES ('player', '2026-10-16', 5)`;
    await db`UPDATE ${db(schema)}.wallet SET coins = 30, xp = 20`;
    let attempts = 0;
    await expect(retryRolledBackReadOnlyTransaction(() => {
      attempts++;
      return db.begin(async (tx) => {
        await tx`INSERT INTO ${tx(schema)}.completions VALUES ('player', '2026-10-16', 5)`;
        await tx`UPDATE ${tx(schema)}.wallet SET coins = coins + 30, xp = xp + 20 WHERE player = 'player'`;
      });
    }, () => {})).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(1);
    expect(await db`SELECT coins, xp FROM ${db(schema)}.wallet`).toEqual([{ coins: 30, xp: 20 }]);
  });

  it('rolls back partial wallet changes before a later read-only error and full retry', async () => {
    let attempts = 0;
    await retryRolledBackReadOnlyTransaction(() => db.begin(async (tx) => {
      await tx`UPDATE ${tx(schema)}.wallet SET coins = coins + 5, xp = xp + 3 WHERE player = 'player'`;
      if (attempts++ === 0) {
        // Inject the SQLSTATE after a write to verify the complete transaction is rolled back.
        await tx.unsafe("DO $$ BEGIN RAISE EXCEPTION 'injected read-only failure' USING ERRCODE = '25006'; END $$");
      }
      await tx`INSERT INTO ${tx(schema)}.completions VALUES ('player', '2026-10-17', 1)`;
    }), () => {});
    expect(attempts).toBe(2);
    expect(await db`SELECT coins, xp FROM ${db(schema)}.wallet`).toEqual([{ coins: 5, xp: 3 }]);
    expect(await db`SELECT * FROM ${db(schema)}.completions`).toHaveLength(1);
  });
});
