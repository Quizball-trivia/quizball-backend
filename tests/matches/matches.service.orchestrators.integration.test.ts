/**
 * Integration tests for the matchesService cross-entity orchestrators
 * extracted in the matches.repo split:
 *
 *   - recordPartyQuizAnswerIfMissing  (match_answers + match_players)
 *   - incrementGoalsAndInsertEventIfMissing  (match_goal_events + match_players)
 *   - cleanupOldDevMatches  (5-table CTE delete)
 *
 * Goal of these tests: prove the real DB behavior we care about, not just
 * the orchestration call shape (which the unit tests in
 * matches.service.test.ts already cover). Specifically:
 *
 *   - idempotency: a retry doesn't double-score / double-count goals
 *   - cleanup actually removes the expected rows and only those rows
 *
 * Hard rollback semantics (forcing a mid-tx failure and asserting the
 * earlier write rolled back) are intentionally NOT brittle-mocked here.
 * If a future test harness gets a clean knob for that, we add it.
 *
 * Skip gracefully when the test database isn't available — same pattern
 * as tests/questions/questions-repo.integration.test.ts.
 *
 * Run with:
 *   npm run docker:start   # start the test DB
 *   npx vitest run tests/matches/matches.service.orchestrators.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
let dbAvailable = false;

// Test fixtures created in beforeAll. Tracked here so afterAll can tear them
// down cleanly even if a test fails partway through.
let testCategoryId: string;
const testUserIds: string[] = [];
const testMatchIds: string[] = [];

async function seedUser(opts: { nickname: string; isAi?: boolean }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, onboarding_complete)
    VALUES (${opts.nickname}, ${opts.isAi ?? false}, true)
    RETURNING id
  `;
  testUserIds.push(row.id);
  return row.id;
}

async function seedMatch(opts: {
  hostUserId: string;
  opponentUserId: string;
  isDev?: boolean;
  status?: 'active' | 'completed' | 'abandoned';
  startedAt?: Date;
}): Promise<string> {
  const [matchRow] = await sql<{ id: string }[]>`
    INSERT INTO matches (
      mode, status, category_a_id, category_b_id,
      current_q_index, total_questions, is_dev, started_at
    )
    VALUES (
      'friendly',
      ${opts.status ?? 'active'},
      ${testCategoryId},
      ${testCategoryId},
      0, 10,
      ${opts.isDev ?? false},
      ${opts.startedAt ?? new Date()}
    )
    RETURNING id
  `;
  testMatchIds.push(matchRow.id);

  await sql`
    INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    VALUES
      (${matchRow.id}, ${opts.hostUserId}, 1, 0, 0, 0, 0),
      (${matchRow.id}, ${opts.opponentUserId}, 2, 0, 0, 0, 0)
  `;
  return matchRow.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    const svc = await import('../../src/modules/matches/matches.service.js');
    matchesService = svc.matchesService;

    // Create a shared test category for all seeded matches.
    const [cat] = await sql<{ id: string }[]>`
      INSERT INTO categories (name, is_active)
      VALUES (${{ en: 'IntegrationTest_Matches' }}::jsonb, true)
      RETURNING id
    `;
    testCategoryId = cat.id;
  } catch {
    console.warn(
      '\n⚠️  Skipping matches orchestrator integration tests: DB unavailable.\n' +
      '   Run `npm run docker:start` to start the test database.\n',
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;

  // Cascade order: match-* rows are deleted via FK ON DELETE CASCADE when
  // matches go. user_mode_match_stats has its own FK; nothing in these tests
  // writes to it. Goal events also cascade with matches.
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  if (testCategoryId) {
    await sql`DELETE FROM categories WHERE id = ${testCategoryId}`;
  }
  await sql.end();
});

describe('matchesService.recordPartyQuizAnswerIfMissing — integration', () => {
  it('inserts the answer and updates player totals on first call', async () => {
    if (!dbAvailable) return;

    const host = await seedUser({ nickname: 'party_host' });
    const opp = await seedUser({ nickname: 'party_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });

    const result = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId,
      qIndex: 0,
      userId: host,
      selectedIndex: 1,
      isCorrect: true,
      timeMs: 1234,
      pointsEarned: 42,
    });

    expect(result.inserted).toBe(true);
    expect(result.answer?.user_id).toBe(host);
    expect(result.player?.total_points).toBe(42);
    expect(result.player?.correct_answers).toBe(1);

    const [stored] = await sql<{ total_points: number; correct_answers: number }[]>`
      SELECT total_points, correct_answers FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${host}
    `;
    expect(stored.total_points).toBe(42);
    expect(stored.correct_answers).toBe(1);
  });

  it('does NOT double-score on a duplicate call (same matchId+qIndex+userId)', async () => {
    if (!dbAvailable) return;

    const host = await seedUser({ nickname: 'party_dup_host' });
    const opp = await seedUser({ nickname: 'party_dup_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });

    // First call: scores.
    const first = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId, qIndex: 0, userId: host, selectedIndex: 2, isCorrect: true, timeMs: 1000, pointsEarned: 50,
    });
    expect(first.inserted).toBe(true);

    // Second call with identical args (a retry).
    const second = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId, qIndex: 0, userId: host, selectedIndex: 2, isCorrect: true, timeMs: 1000, pointsEarned: 50,
    });
    expect(second.inserted).toBe(false);
    expect(second.answer?.user_id).toBe(host);
    expect(second.player?.total_points).toBe(50); // NOT 100

    const [stored] = await sql<{ total_points: number; correct_answers: number }[]>`
      SELECT total_points, correct_answers FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${host}
    `;
    expect(stored.total_points).toBe(50);
    expect(stored.correct_answers).toBe(1);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM match_answers
      WHERE match_id = ${matchId} AND q_index = 0 AND user_id = ${host}
    `;
    expect(count).toBe(1);
  });
});

describe('matchesService.incrementGoalsAndInsertEventIfMissing — integration', () => {
  it('inserts the event and bumps the goal counter on first call', async () => {
    if (!dbAvailable) return;

    const host = await seedUser({ nickname: 'goal_host' });
    const opp = await seedUser({ nickname: 'goal_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });

    const result = await matchesService.incrementGoalsAndInsertEventIfMissing({
      matchId,
      userId: host,
      seat: 1,
      half: 1,
      phaseKind: 'normal',
      qIndex: 2,
      isPenalty: false,
      delta: { goals: 1 },
    });

    expect(result.inserted).toBe(true);
    expect(result.player?.goals).toBe(1);
    expect(result.player?.penalty_goals).toBe(0);

    const [stored] = await sql<{ goals: number; penalty_goals: number }[]>`
      SELECT goals, penalty_goals FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${host}
    `;
    expect(stored.goals).toBe(1);
    expect(stored.penalty_goals).toBe(0);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM match_goal_events WHERE match_id = ${matchId}
    `;
    expect(count).toBe(1);
  });

  it('does NOT double-count goals on a duplicate idempotency key', async () => {
    if (!dbAvailable) return;

    const host = await seedUser({ nickname: 'goal_dup_host' });
    const opp = await seedUser({ nickname: 'goal_dup_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });

    const args = {
      matchId,
      userId: host,
      seat: 1 as const,
      half: 2 as const,
      phaseKind: 'penalty' as const,
      qIndex: 5,
      isPenalty: true,
      delta: { penaltyGoals: 1 },
    };

    const first = await matchesService.incrementGoalsAndInsertEventIfMissing(args);
    expect(first.inserted).toBe(true);
    expect(first.player?.penalty_goals).toBe(1);

    // Same idempotency key (matchId + userId + phaseKind + qIndex + isPenalty).
    const second = await matchesService.incrementGoalsAndInsertEventIfMissing(args);
    expect(second.inserted).toBe(false);
    expect(second.player).toBeNull(); // service short-circuits before reading

    const [stored] = await sql<{ goals: number; penalty_goals: number }[]>`
      SELECT goals, penalty_goals FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${host}
    `;
    expect(stored.penalty_goals).toBe(1); // NOT 2
    expect(stored.goals).toBe(0);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM match_goal_events WHERE match_id = ${matchId}
    `;
    expect(count).toBe(1);
  });
});

describe('matchesService.cleanupOldDevMatches — integration', () => {
  it('removes old dev matches (and their child rows) but spares non-dev and recent dev', async () => {
    if (!dbAvailable) return;

    // Two human users — these must never be deleted, no matter what.
    const human1 = await seedUser({ nickname: 'cleanup_human_1' });
    const human2 = await seedUser({ nickname: 'cleanup_human_2' });

    // AI opponent that's ONLY in cleanable matches — should get deleted.
    const orphanAi = await seedUser({ nickname: 'cleanup_orphan_ai', isAi: true });

    // AI opponent that's also in a kept match — should be spared.
    const keptAi = await seedUser({ nickname: 'cleanup_kept_ai', isAi: true });

    const now = Date.now();
    // 3 old completed dev matches with the orphan AI (these should be cleaned)
    const oldDev1 = await seedMatch({
      hostUserId: human1, opponentUserId: orphanAi,
      isDev: true, status: 'completed', startedAt: new Date(now - 10 * 86_400_000),
    });
    const oldDev2 = await seedMatch({
      hostUserId: human1, opponentUserId: orphanAi,
      isDev: true, status: 'completed', startedAt: new Date(now - 9 * 86_400_000),
    });
    const oldDev3 = await seedMatch({
      hostUserId: human2, opponentUserId: orphanAi,
      isDev: true, status: 'completed', startedAt: new Date(now - 8 * 86_400_000),
    });

    // 1 recent dev match (within the keep window) with the keptAi
    const recentDev = await seedMatch({
      hostUserId: human1, opponentUserId: keptAi,
      isDev: true, status: 'completed', startedAt: new Date(now - 1000),
    });

    // 1 non-dev completed match — must be untouched.
    const nonDev = await seedMatch({
      hostUserId: human1, opponentUserId: keptAi,
      isDev: false, status: 'completed', startedAt: new Date(now - 86_400_000),
    });

    // Add an answer + goal event to one of the cleanable matches so we can
    // verify the cascade actually removes child rows.
    await sql`
      INSERT INTO match_answers (
        match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned
      )
      VALUES (${oldDev1}, 0, ${human1}, 1, true, 1000, 10)
    `;
    await sql`
      INSERT INTO match_goal_events (
        match_id, user_id, seat, half, phase_kind, q_index, is_penalty
      )
      VALUES (${oldDev2}, ${human1}, 1, 1, 'normal', 0, false)
    `;

    // keep=1 means "keep the 1 most recent dev match" — so recentDev stays,
    // oldDev1/2/3 should all be cleaned. Non-dev matches are out of scope.
    const deletedCount = await matchesService.cleanupOldDevMatches(1);
    expect(deletedCount).toBeGreaterThanOrEqual(3); // tolerate other tests' rows; ours = 3

    // Verify the 3 old dev matches are gone.
    const remainingOldDev = await sql<{ id: string }[]>`
      SELECT id FROM matches WHERE id = ANY(${[oldDev1, oldDev2, oldDev3]}::uuid[])
    `;
    expect(remainingOldDev).toEqual([]);

    // recentDev (recent dev) and nonDev (non-dev) should still be there.
    const survivors = await sql<{ id: string }[]>`
      SELECT id FROM matches WHERE id = ANY(${[recentDev, nonDev]}::uuid[]) ORDER BY id
    `;
    expect(survivors.map((r) => r.id).sort()).toEqual([recentDev, nonDev].sort());

    // Child rows for the cleaned matches must also be gone (cascade).
    const [{ count: answerCount }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM match_answers
      WHERE match_id = ANY(${[oldDev1, oldDev2, oldDev3]}::uuid[])
    `;
    expect(answerCount).toBe(0);

    const [{ count: goalCount }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM match_goal_events
      WHERE match_id = ANY(${[oldDev1, oldDev2, oldDev3]}::uuid[])
    `;
    expect(goalCount).toBe(0);

    // Humans untouched.
    const [{ count: humanCount }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM users
      WHERE id = ANY(${[human1, human2]}::uuid[])
    `;
    expect(humanCount).toBe(2);

    // Orphan AI (only in cleaned matches) — DELETED.
    const orphanRows = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${orphanAi}
    `;
    expect(orphanRows).toEqual([]);

    // Kept AI (also in a non-cleaned match) — SPARED.
    const keptRows = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${keptAi}
    `;
    expect(keptRows).toHaveLength(1);

    // Remove the now-deleted match ids from the tracking list so afterAll
    // doesn't try to delete them again.
    for (const id of [oldDev1, oldDev2, oldDev3]) {
      const idx = testMatchIds.indexOf(id);
      if (idx >= 0) testMatchIds.splice(idx, 1);
    }
    // Same for orphanAi — already deleted by the service.
    const orphanIdx = testUserIds.indexOf(orphanAi);
    if (orphanIdx >= 0) testUserIds.splice(orphanIdx, 1);
  });
});
