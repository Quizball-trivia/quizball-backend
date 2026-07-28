/**
 * Integration tests for the PR9 governor idempotency guard against the real test
 * DB. The unit tests in governor-service.test.ts mock the repo, so they can pin
 * the CONTROL FLOW but not the atomicity — the guard's whole value is that both
 * predicates live inside the single UPDATE:
 *
 *   WHERE user_id = $1
 *     AND winrate_samples = $expectedSamples
 *     AND governor_last_match_id IS DISTINCT FROM $matchId
 *
 * Settlement is replayed by several paths (final-results replay, forfeit
 * re-settle) and two replicas can settle the same match at once, so a match must
 * fold into a bot's win-rate EMA EXACTLY once no matter how the duplicates
 * interleave.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bots/governor-replay-safety.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let governorRepo: typeof import('../../src/modules/bots/governor/governor.repo.js').governorRepo;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];

async function seedBot(nickname: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${nickname}, true, 'persistent', true)
    RETURNING id
  `;
  testUserIds.push(user.id);
  await sql`
    INSERT INTO synthetic_player_profiles (user_id, base_skill, personality_seed, status, winrate_samples, governor_adjustment)
    VALUES (${user.id}, 0.5, 4242, 'active', 0, 0)
  `;
  return user.id;
}

async function seedMatchId(): Promise<string> {
  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, current_q_index, total_questions, started_at)
    VALUES ('ranked', 'completed', 10, 10, NOW())
    RETURNING id
  `;
  testMatchIds.push(match.id);
  return match.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    governorRepo = (await import('../../src/modules/bots/governor/governor.repo.js')).governorRepo;
  } catch {
    console.warn(
      '\n⚠️  Skipping governor replay-safety integration tests: DB unavailable.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
});

function stateAfterOneWin(samples: number) {
  return {
    adjustment: 0.1,
    winrateEma: 0.5,
    winrateSamples: samples,
    updatedAt: new Date(),
    samplesAtAdjustment: samples,
  };
}

describe('governor saveState idempotency under concurrent duplicate settlement', () => {
  it('folds a match into the EMA exactly once when three duplicates race', async () => {
    if (!dbAvailable) return;
    const bot = await seedBot(`gov-race-${Date.now()}`);
    const matchId = await seedMatchId();

    // Three concurrent settlements of the SAME match, all reading the same
    // pre-state (winrate_samples = 0) — the real two-replica shape.
    const results = await Promise.all([
      governorRepo.saveState(bot, stateAfterOneWin(1), 0, matchId),
      governorRepo.saveState(bot, stateAfterOneWin(1), 0, matchId),
      governorRepo.saveState(bot, stateAfterOneWin(1), 0, matchId),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const [row] = await sql<{ winrate_samples: number; governor_last_match_id: string }[]>`
      SELECT winrate_samples, governor_last_match_id
      FROM synthetic_player_profiles WHERE user_id = ${bot}
    `;
    expect(row?.winrate_samples).toBe(1);
    expect(row?.governor_last_match_id).toBe(matchId);
  });

  it('rejects a sequential replay of an already-folded match', async () => {
    if (!dbAvailable) return;
    const bot = await seedBot(`gov-replay-${Date.now()}`);
    const matchId = await seedMatchId();

    expect(await governorRepo.saveState(bot, stateAfterOneWin(1), 0, matchId)).toBe(true);
    // A later replay re-enters the governor after the ledger row already exists.
    // Even though it now presents the CORRECT expectedSamples, the match-id fence
    // must still reject it.
    expect(await governorRepo.saveState(bot, stateAfterOneWin(2), 1, matchId)).toBe(false);

    const [row] = await sql<{ winrate_samples: number }[]>`
      SELECT winrate_samples FROM synthetic_player_profiles WHERE user_id = ${bot}
    `;
    expect(row?.winrate_samples).toBe(1);
  });

  it('still accepts a genuinely different match after one is folded', async () => {
    if (!dbAvailable) return;
    const bot = await seedBot(`gov-next-${Date.now()}`);
    const firstMatch = await seedMatchId();
    const secondMatch = await seedMatchId();

    expect(await governorRepo.saveState(bot, stateAfterOneWin(1), 0, firstMatch)).toBe(true);
    expect(await governorRepo.saveState(bot, stateAfterOneWin(2), 1, secondMatch)).toBe(true);

    const [row] = await sql<{ winrate_samples: number; governor_last_match_id: string }[]>`
      SELECT winrate_samples, governor_last_match_id
      FROM synthetic_player_profiles WHERE user_id = ${bot}
    `;
    expect(row?.winrate_samples).toBe(2);
    expect(row?.governor_last_match_id).toBe(secondMatch);
  });
});
