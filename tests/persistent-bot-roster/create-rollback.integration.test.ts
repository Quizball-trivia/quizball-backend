/**
 * Integration test for the roster creation + rollback scripts against the test
 * DB (postgresql://test:test@localhost:5432/test, set by tests/setup.ts).
 *
 * Flow: create a 20-bot sample -> assert invariants -> re-run (idempotency) ->
 * rollback -> assert exactly the batch is gone. Guarded so it skips cleanly when
 * the DB is unavailable. Uses a unique batch tag per run so parallel/shared-DB
 * runs don't collide (re-run solo before investigating a flake).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';

import { generateRoster } from '../../scripts/persistent-bot-roster/roster.js';
import { insertBatch, checkInvariants } from '../../scripts/persistent-bot-roster/create.js';
import { rollbackBatch } from '../../scripts/persistent-bot-roster/rollback.js';
import { makePatterns } from './fixtures.js';

let sql: postgres.Sql;
let dbAvailable = false;
const BATCH = `test-roster-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SEED = 4242;
const COUNT = 20;

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql as unknown as postgres.Sql;
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping roster create/rollback integration tests: DB unavailable. Run `npm run docker:start`.\n');
  }
});

afterAll(async () => {
  if (dbAvailable) {
    // Belt-and-suspenders cleanup in case an assertion aborted mid-flow.
    try {
      await rollbackBatch(sql, BATCH);
    } catch {
      /* ignore */
    }
    await sql.end();
  }
});

describe('roster create + rollback (test DB)', () => {
  it('creates 20 bots with correct rows and passing invariants', async ({ skip }) => {
    if (!dbAvailable) return skip();

    const bots = generateRoster({ seed: SEED, count: COUNT, patterns: makePatterns() });
    const { inserted, skipped } = await insertBatch(sql, bots, BATCH);
    expect(inserted).toBe(COUNT);
    expect(skipped).toBe(0);

    // Spot-check a row: persistent classification, zero balances, no identity,
    // unplaced ranked profile, synthetic profile fields present.
    const [row] = await sql<{
      is_ai: boolean; ai_kind: string; coins: number; tickets: number;
      refill: string | null; rp: number; placement_status: string;
      base_skill: number; daily_cap: number; personality_seed: string;
      batch: string; identities: number;
    }[]>`
      SELECT u.is_ai, u.ai_kind, u.coins, u.tickets, u.tickets_refill_started_at AS refill,
             rp.rp, rp.placement_status,
             spp.base_skill, spp.daily_cap, spp.personality_seed::text AS personality_seed,
             spp.schedule->>'batch' AS batch,
             (SELECT count(*)::int FROM user_identities ui WHERE ui.user_id = u.id) AS identities
      FROM synthetic_player_profiles spp
      JOIN users u ON u.id = spp.user_id
      JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE spp.schedule->>'batch' = ${BATCH}
      LIMIT 1
    `;
    expect(row!.is_ai).toBe(true);
    expect(row!.ai_kind).toBe('persistent');
    expect(row!.coins).toBe(0);
    expect(row!.tickets).toBe(0);
    expect(row!.refill).toBeNull();
    expect(row!.rp).toBe(450);
    expect(row!.placement_status).toBe('unplaced');
    expect(row!.identities).toBe(0);
    expect(Number(row!.personality_seed)).toBeLessThan(2 ** 53);

    const inv = await checkInvariants(sql, BATCH, COUNT);
    expect(inv.problems).toEqual([]);
    expect(inv.ok).toBe(true);
    expect(inv.counts.users).toBe(COUNT);
    expect(inv.counts.persistent).toBe(COUNT);
    expect(inv.counts.withIdentity).toBe(0);
    expect(inv.counts.nonzeroBalances).toBe(0);
  });

  it('is idempotent: re-running skips all existing nicknames', async ({ skip }) => {
    if (!dbAvailable) return skip();

    const bots = generateRoster({ seed: SEED, count: COUNT, patterns: makePatterns() });
    const { inserted, skipped } = await insertBatch(sql, bots, BATCH);
    expect(inserted).toBe(0);
    expect(skipped).toBe(COUNT);

    // Still exactly COUNT rows — no duplicates minted.
    const inv = await checkInvariants(sql, BATCH, COUNT);
    expect(inv.ok).toBe(true);
    expect(inv.counts.users).toBe(COUNT);
  });

  it('rollback removes exactly the batch (cascades profiles/ranked rows)', async ({ skip }) => {
    if (!dbAvailable) return skip();

    const result = await rollbackBatch(sql, BATCH);
    expect(result.refusedReason).toBeUndefined();
    expect(result.candidates).toBe(COUNT);
    expect(result.deleted).toBe(COUNT);

    // All traces gone.
    const [{ users, synth, profiles }] = await sql<{ users: number; synth: number; profiles: number }[]>`
      WITH b AS (SELECT user_id FROM synthetic_player_profiles WHERE schedule->>'batch' = ${BATCH})
      SELECT
        (SELECT count(*)::int FROM b) AS synth,
        (SELECT count(*)::int FROM users u JOIN b ON b.user_id = u.id) AS users,
        (SELECT count(*)::int FROM ranked_profiles rp JOIN b ON b.user_id = rp.user_id) AS profiles
    `;
    expect(synth).toBe(0);
    expect(users).toBe(0);
    expect(profiles).toBe(0);
  });

  it('rollback of an empty/unknown batch is a no-op', async ({ skip }) => {
    if (!dbAvailable) return skip();
    const result = await rollbackBatch(sql, `nonexistent-${Date.now()}`);
    expect(result.candidates).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.refusedReason).toBeUndefined();
  });
});
