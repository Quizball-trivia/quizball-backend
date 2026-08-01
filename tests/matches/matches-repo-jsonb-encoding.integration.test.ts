/**
 * Regression test for the ranked_context / state_payload jsonb DOUBLE-ENCODING bug.
 *
 * matchesRepo.createMatch has TWO write paths: a non-tx path (sql.json, correct)
 * and a TRANSACTION path (used for persistent-bot matches, because the reservation
 * transfer must commit atomically with the match row). The tx path used to bind
 * `JSON.stringify(rankedContext)` to a `$n::jsonb` param, which postgres.js
 * JSON-encodes AGAIN — storing a jsonb STRING scalar ("{\"...\"}") instead of a
 * jsonb OBJECT. Every reader (asRecord / parsePersistentBotModelPin /
 * aiSettingsFromRankedContext) then sees a string and bails to null, silently
 * dropping every persistent bot onto the ephemeral bridge: the entire calibrated
 * accuracy + timing model — computed correctly and pinned into ranked_context —
 * was never read in production.
 *
 * This test drives the REAL tx path and asserts the container is a jsonb OBJECT and
 * the pin parses. It is the guard that would have caught the bug.
 *
 * Self-skips when the test DB is unavailable (same pattern as the sibling
 * matches orchestrator integration test). Loopback DB only.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/matches/matches-repo-jsonb-encoding.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let matchesRepo: typeof import('../../src/modules/matches/matches.repo.js').matchesRepo;
let parsePersistentBotModelPin: typeof import('../../src/realtime/possession-ai.js').parsePersistentBotModelPin;
let dbAvailable = false;

let testCategoryId: string;
const testMatchIds: string[] = [];

/**
 * A minimal-but-structurally-valid ranked_context carrying a persistentBotModel
 * pin. parsePersistentBotModelPin validates every scalar field it reads, and
 * persistentModelFromPin runs the full zod params validation downstream, so the
 * fields present here are exactly the ones the runtime trusts. params is left as a
 * loose object: this test asserts the CONTAINER encodes as a jsonb object and the
 * pin's scalar fields survive the round-trip — the params-schema validity of the
 * frozen artifact is covered by its own suite.
 */
function buildRankedContextWithPin() {
  return {
    aiCorrectness: 0.56,
    aiDelayProfile: { minMs: 690, maxMs: 4316 },
    persistentBotModel: {
      paramsVersion: 2,
      tuningVersion: 1,
      params: { schemaVersion: 1 },
      botUserId: '8d251839-bd93-44a8-a822-cd0e3367244d',
      currentRp: 1491,
      personalOffset: 0.625,
      governorAdjustment: 0,
      categoryAffinities: { spain: 0.15 },
      dailyFormSeed: '2026-08-01',
      thetaCeilingBound: 4,
    },
  };
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    matchesRepo = (await import('../../src/modules/matches/matches.repo.js')).matchesRepo;
    parsePersistentBotModelPin = (await import('../../src/realtime/possession-ai.js')).parsePersistentBotModelPin;

    const [cat] = await sql<{ id: string }[]>`
      INSERT INTO categories (name, slug, is_active)
      VALUES (${sql.json({ en: 'IntegrationTest_JsonbEncoding' })}, 'integration-test-jsonb-encoding', true)
      RETURNING id
    `;
    testCategoryId = cat.id;
  } catch {
    console.warn(
      '\n⚠️  Skipping matches jsonb-encoding integration tests: DB unavailable.\n' +
      '   Run `npm run docker:start` to start the test database.\n',
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testCategoryId) {
    await sql`DELETE FROM categories WHERE id = ${testCategoryId}`;
  }
  await sql.end();
});

describe('matchesRepo.createMatch (tx path) — jsonb encoding', () => {
  it('stores ranked_context + state_payload as jsonb OBJECTS, and the pin parses', async (ctx) => {
    // Report a visible SKIP (not a false green) when the integration DB is down,
    // so CI cannot pass this guard vacuously.
    if (!dbAvailable) return ctx.skip();

    const rankedContext = buildRankedContextWithPin();
    const statePayload = { phase: 'draft', round: 1 };

    // Drive the REAL transaction path — the one persistent-bot matches use.
    const created = await sql.begin(async (tx) =>
      matchesRepo.createMatch(
        {
          lobbyId: null,
          mode: 'ranked',
          categoryAId: testCategoryId,
          categoryBId: testCategoryId,
          totalQuestions: 10,
          statePayload,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rankedContext: rankedContext as any,
          isDev: false,
        },
        tx as unknown as import('../../src/db/index.js').TransactionSql,
      ),
    );
    testMatchIds.push(created.id);

    // The DB-level proof: both columns must be jsonb OBJECTS, never string scalars.
    const [types] = await sql<{ rc_type: string; sp_type: string }[]>`
      SELECT jsonb_typeof(ranked_context) AS rc_type,
             jsonb_typeof(state_payload)  AS sp_type
      FROM matches WHERE id = ${created.id}
    `;
    expect(types.rc_type).toBe('object'); // was 'string' before the fix
    expect(types.sp_type).toBe('object');

    // The pin must parse (asRecord would return null on a string scalar → bridge).
    const pin = parsePersistentBotModelPin(created.ranked_context);
    expect(pin).not.toBeNull();
    expect(pin?.botUserId).toBe('8d251839-bd93-44a8-a822-cd0e3367244d');
    expect(pin?.currentRp).toBe(1491);
    expect(pin?.personalOffset).toBe(0.625);

    // And the same holds when the row is re-read fresh from the DB (not just the
    // RETURNING * value), since the runtime resolves the pin from a fresh getMatch.
    const [fresh] = await sql<{ ranked_context: unknown }[]>`
      SELECT ranked_context FROM matches WHERE id = ${created.id}
    `;
    const freshPin = parsePersistentBotModelPin(fresh.ranked_context);
    expect(freshPin).not.toBeNull();
    expect(freshPin?.dailyFormSeed).toBe('2026-08-01');
  });

  it('a null ranked_context on the tx path stays SQL NULL (not a "null" string scalar)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const created = await sql.begin(async (tx) =>
      matchesRepo.createMatch(
        {
          lobbyId: null,
          mode: 'ranked',
          categoryAId: testCategoryId,
          categoryBId: testCategoryId,
          totalQuestions: 10,
          statePayload: { phase: 'draft' },
          rankedContext: null,
          isDev: false,
        },
        tx as unknown as import('../../src/db/index.js').TransactionSql,
      ),
    );
    testMatchIds.push(created.id);

    const [row] = await sql<{ rc_is_null: boolean; sp_type: string }[]>`
      SELECT (ranked_context IS NULL) AS rc_is_null,
             jsonb_typeof(state_payload) AS sp_type
      FROM matches WHERE id = ${created.id}
    `;
    expect(row.rc_is_null).toBe(true);
    expect(row.sp_type).toBe('object');
    expect(parsePersistentBotModelPin(created.ranked_context)).toBeNull();
  });
});
