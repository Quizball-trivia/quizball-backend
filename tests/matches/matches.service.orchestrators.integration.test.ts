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
import { randomUUID } from 'node:crypto';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
let dbAvailable = false;

// Test fixtures created in beforeAll. Tracked here so afterAll can tear them
// down cleanly even if a test fails partway through.
let testCategoryId: string;
const testUserIds: string[] = [];
const testMatchIds: string[] = [];

async function seedUser(opts: {
  nickname: string;
  isAi?: boolean;
  aiKind?: 'ephemeral' | 'persistent' | 'auction';
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${opts.nickname}, ${opts.isAi ?? false}, ${opts.isAi ? opts.aiKind ?? 'ephemeral' : null}, true)
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
  // As a live Party match keeps it: question 0 open in the saved state, nobody dropped.
  await sql`UPDATE matches SET state_payload = ${sql.json({ variant: 'friendly_party_quiz', currentQuestion: { qIndex: 0 }, droppedUserIds: [] })} WHERE id = ${matchRow.id}`;

  await sql`
    INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    VALUES
      (${matchRow.id}, ${opts.hostUserId}, 1, 0, 0, 0, 0),
      (${matchRow.id}, ${opts.opponentUserId}, 2, 0, 0, 0, 0)
  `;
  return matchRow.id;
}

/** Moves a seeded match to question `q` the way a round transition does (index and open question together). */
async function openQuestion(matchId: string, q: number, droppedUserIds: string[] = []): Promise<void> {
  await sql`UPDATE matches SET current_q_index = ${q}, state_payload = ${sql.json({ variant: 'friendly_party_quiz', currentQuestion: { qIndex: q }, droppedUserIds })} WHERE id = ${matchId}`;
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
      INSERT INTO categories (name, slug, is_active)
      VALUES (${sql.json({ en: 'IntegrationTest_Matches' })}, ${`integration-test-matches-${randomUUID()}`}, true)
      RETURNING id
    `;
    testCategoryId = cat.id;
  } catch (error) {
    // A reachable DB with a broken fixture/schema must fail, not masquerade as
    // an unavailable DB and leave later tests using an undefined category.
    if (dbAvailable) throw error;
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
  it('concurrent conflicting retries return the first answer and score only once', async () => {
    if (!dbAvailable) return;
    const host = await seedUser({ nickname: 'party_race_host' });
    const opp = await seedUser({ nickname: 'party_race_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      matchesService.recordPartyQuizAnswerIfMissing({ matchId, qIndex: 0, userId: host,
        selectedIndex: i % 4, isCorrect: true, timeMs: 1000, pointsEarned: 10 + i })));
    const winner = results.find((r) => r.inserted)!;
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    for (const result of results) expect(result.answer).toEqual(winner.answer);
    const [player] = await sql`SELECT total_points, correct_answers FROM match_players WHERE match_id = ${matchId} AND user_id = ${host}`;
    expect(player.total_points).toBe(winner.answer!.points_earned);
    expect(player.correct_answers).toBe(1);
    const [answers] = await sql`SELECT count(*)::int AS n FROM match_answers WHERE match_id = ${matchId} AND user_id = ${host}`;
    expect(answers.n).toBe(1);
  });
  it('review 2026-10-06 B1: an answer admitted after its round closed is refused and scores nothing', async () => {
    if (!dbAvailable) return;
    const host = await seedUser({ nickname: 'party_late_host' });
    const opp = await seedUser({ nickname: 'party_late_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });
    // Round 0 closed while the answer waited (the close moves the match to question 1).
    await sql`UPDATE matches SET current_q_index = 1 WHERE id = ${matchId}`;
    const late = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId, qIndex: 0, userId: host, selectedIndex: 1, isCorrect: true, timeMs: 900, pointsEarned: 90,
    });
    expect(late).toMatchObject({ inserted: false, answer: null, roundClosed: true });
    const [player] = await sql<{ total_points: number; correct_answers: number }[]>`SELECT total_points, correct_answers FROM match_players WHERE match_id = ${matchId} AND user_id = ${host}`;
    expect(player).toMatchObject({ total_points: 0, correct_answers: 0 });
    const [answers] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_answers WHERE match_id = ${matchId}`;
    expect(answers.n).toBe(0);
  });

  it('review 2026-10-06 B1: a round close waits for an answer mid-write and counts it; after the close the round is shut', async () => {
    if (!dbAvailable) return;
    const { default: postgres } = await import('postgres');
    const writer = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const observer = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const host = await seedUser({ nickname: 'party_close_host' });
    const opp = await seedUser({ nickname: 'party_close_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    try {
      const [{ pid }] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      // An answer write in flight: the same share lock the answer statement takes, plus its rows, not yet committed.
      const answer = writer.begin(async (tx) => {
        await tx`SELECT id FROM matches WHERE id = ${matchId} AND status = 'active' AND current_q_index = 0 FOR SHARE`;
        await tx`INSERT INTO match_answers (match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answer_payload, phase_kind, phase_round)
                 VALUES (${matchId}, 0, ${host}, 1, true, 800, 40, '{}', 'normal', 1)`;
        held();
        await gate;
      });
      await holding;
      const closing = matchesService.closePartyQuizRound(matchId, 0, 1, () => ({ variant: 'friendly_party_quiz', currentQuestion: null, droppedUserIds: [] }));
      let blocked = false;
      for (let i = 0; i < 300 && !blocked; i += 1) {
        const [row] = await observer<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = row.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      release();
      await answer;
      const closed = await closing;
      expect(closed?.answers.map((a) => a.user_id)).toEqual([host]);
      const [match] = await observer<{ current_q_index: number }[]>`SELECT current_q_index FROM matches WHERE id = ${matchId}`;
      expect(match.current_q_index).toBe(1);
      const late = await matchesService.recordPartyQuizAnswerIfMissing({
        matchId, qIndex: 0, userId: opp, selectedIndex: 1, isCorrect: true, timeMs: 900, pointsEarned: 30,
      });
      expect(late.roundClosed).toBe(true);
      expect(await matchesService.closePartyQuizRound(matchId, 0, 1, () => ({}))).toBeNull();
    } finally {
      release();
      await Promise.all([writer.end(), observer.end()]);
    }
  });

  it('review round 4 (#1): a player dropped from the match cannot score with an answer still in the queue', async () => {
    if (!dbAvailable) return;
    const host = await seedUser({ nickname: 'party_dropped_host' });
    const opp = await seedUser({ nickname: 'party_dropped_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });
    await openQuestion(matchId, 0, [host]);
    const late = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId, qIndex: 0, userId: host, selectedIndex: 1, isCorrect: true, timeMs: 900, pointsEarned: 90,
    });
    expect(late).toMatchObject({ inserted: false, roundClosed: true });
    const [player] = await sql<{ total_points: number }[]>`SELECT total_points FROM match_players WHERE match_id = ${matchId} AND user_id = ${host}`;
    expect(player.total_points).toBe(0);
  });

  it('review round 4 (#1): once a dropout ending closed the question (still active, same index), no answer scores', async () => {
    if (!dbAvailable) return;
    const host = await seedUser({ nickname: 'party_dropend_host' });
    const opp = await seedUser({ nickname: 'party_dropend_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });
    await sql`UPDATE matches SET state_payload = ${sql.json({ variant: 'friendly_party_quiz', currentQuestion: null, droppedUserIds: [opp] })} WHERE id = ${matchId}`;
    const late = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId, qIndex: 0, userId: host, selectedIndex: 1, isCorrect: true, timeMs: 900, pointsEarned: 90,
    });
    expect(late).toMatchObject({ inserted: false, roundClosed: true });
  });

  it('review 2026-10-06 B1: a completed match takes no more answers', async () => {
    if (!dbAvailable) return;
    const host = await seedUser({ nickname: 'party_done_host' });
    const opp = await seedUser({ nickname: 'party_done_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp, status: 'completed' });
    const late = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId, qIndex: 0, userId: host, selectedIndex: 1, isCorrect: true, timeMs: 900, pointsEarned: 90,
    });
    expect(late).toMatchObject({ inserted: false, roundClosed: true });
    const [player] = await sql<{ total_points: number }[]>`SELECT total_points FROM match_players WHERE match_id = ${matchId} AND user_id = ${host}`;
    expect(player.total_points).toBe(0);
  });

  it('a conflicting insert committed WHILE this call waits: returns the original answer, scores once (forced, not timing-dependent)', async () => {
    if (!dbAvailable) return;
    // Review 2026-10-06: ON CONFLICT waits for the other writer but its READ COMMITTED snapshot cannot see the winning
    // row, so the statement returned no answer ("Party answer write returned incomplete state"). Hold a conflicting
    // insert open, start the call, prove it is blocked on that writer, then commit.
    const { default: postgres } = await import('postgres');
    const writer = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const observer = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const host = await seedUser({ nickname: 'party_forced_race_host' });
    const opp = await seedUser({ nickname: 'party_forced_race_opp' });
    const matchId = await seedMatch({ hostUserId: host, opponentUserId: opp });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    try {
      const [{ pid }] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const pendingWriter = writer.begin(async (tx) => {
        await tx`INSERT INTO match_answers (match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answer_payload, phase_kind, phase_round)
                 VALUES (${matchId}, 0, ${host}, 2, true, 1000, 17, '{}', 'normal', 1)`;
        await tx`UPDATE match_players SET total_points = 17, correct_answers = 1 WHERE match_id = ${matchId} AND user_id = ${host}`;
        held();
        await gate;
      });
      await holding;
      const competing = matchesService.recordPartyQuizAnswerIfMissing({
        matchId, qIndex: 0, userId: host, selectedIndex: 1, isCorrect: true, timeMs: 500, pointsEarned: 99,
      });
      let blocked = false;
      for (let i = 0; i < 300 && !blocked; i += 1) {
        const [row] = await observer<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = row.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      release();
      await pendingWriter;
      const result = await competing;
      expect(result.inserted).toBe(false);
      expect(result.answer).toMatchObject({ selected_index: 2, points_earned: 17 });
      const [player] = await observer<{ total_points: number; correct_answers: number }[]>`SELECT total_points, correct_answers FROM match_players WHERE match_id = ${matchId} AND user_id = ${host}`;
      expect(player).toMatchObject({ total_points: 17, correct_answers: 1 });
      const [answers] = await observer<{ n: number }[]>`SELECT count(*)::int AS n FROM match_answers WHERE match_id = ${matchId} AND user_id = ${host}`;
      expect(answers.n).toBe(1);
    } finally {
      release();
      await Promise.all([writer.end(), observer.end()]);
    }
  });

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

describe('matchesService.refreshPlayerAverageTimes — integration', () => {
  it('preserves averages, scores and seat order for six players, including missing answers, without touching another match', async () => {
    if (!dbAvailable) return;
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => seedUser({ nickname: `avg_batch_${i}` })));
    const matchId = await seedMatch({ hostUserId: ids[0], opponentUserId: ids[1] });
    for (let i = 2; i < 6; i += 1) {
      await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${matchId}, ${ids[i]}, ${i + 1})`;
    }
    const otherMatchId = await seedMatch({ hostUserId: ids[0], opponentUserId: ids[1] });
    await sql`UPDATE match_players SET avg_time_ms = 999 WHERE match_id IN (${matchId}, ${otherMatchId})`;
    await matchesService.recordPartyQuizAnswerIfMissing({ matchId, qIndex: 0, userId: ids[0], selectedIndex: 1, isCorrect: true, timeMs: 1000, pointsEarned: 30 });
    await matchesService.recordPartyQuizAnswerIfMissing({ matchId, qIndex: 0, userId: ids[2], selectedIndex: 1, isCorrect: true, timeMs: 1501, pointsEarned: 20 });
    await openQuestion(matchId, 1);
    await matchesService.recordPartyQuizAnswerIfMissing({ matchId, qIndex: 1, userId: ids[0], selectedIndex: 2, isCorrect: false, timeMs: 4000, pointsEarned: 0 });
    const originalAverages = await matchesService.computeAvgTimes(matchId);
    const players = await matchesService.refreshPlayerAverageTimes(matchId);
    expect(players.map((p) => p.user_id)).toEqual(ids);
    for (const player of players) expect(player.avg_time_ms).toBe(originalAverages.get(player.user_id) ?? null);
    expect(players[0]).toMatchObject({ avg_time_ms: 2500, total_points: 30, correct_answers: 1 });
    expect(players[1].avg_time_ms).toBeNull();
    expect(players[2]).toMatchObject({ avg_time_ms: 1501, total_points: 20, correct_answers: 1 });
    expect(await sql`SELECT avg_time_ms FROM match_players WHERE match_id = ${otherMatchId}`).toEqual([{ avg_time_ms: 999 }, { avg_time_ms: 999 }]);
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
  it('deletes the dev matches of an orphaned persistent bot but never the bot itself', async () => {
    if (!dbAvailable) return;

    const human = await seedUser({ nickname: 'cleanup_human_vs_roster' });
    const rosterBot = await seedUser({
      nickname: 'cleanup_roster_bot',
      isAi: true,
      aiKind: 'persistent',
    });
    // Twin ephemeral bot in the IDENTICAL orphan position: it must be deleted,
    // proving the orphan condition fires and only ai_kind spares the roster bot.
    const ephemeralBot = await seedUser({
      nickname: 'cleanup_ephemeral_twin',
      isAi: true,
      aiKind: 'ephemeral',
    });
    const fillerOpponent = await seedUser({ nickname: 'cleanup_filler_opp' });

    // Old dev matches where each bot appears ONLY here (genuinely orphaned).
    const oldDevRoster = await seedMatch({
      hostUserId: human,
      opponentUserId: rosterBot,
      isDev: true,
      status: 'completed',
      startedAt: new Date(Date.now() - 30 * 86_400_000),
    });
    const oldDevEphemeral = await seedMatch({
      hostUserId: human,
      opponentUserId: ephemeralBot,
      isDev: true,
      status: 'completed',
      startedAt: new Date(Date.now() - 29 * 86_400_000),
    });
    // A newer dev match (bot-free) fills the keep=1 slot so the old ones are
    // eligible even when this is the only suite that has seeded dev matches.
    // Kept 3 days old so it can never outrank the sibling test's "recent" fixture.
    await seedMatch({
      hostUserId: human,
      opponentUserId: fillerOpponent,
      isDev: true,
      status: 'completed',
      startedAt: new Date(Date.now() - 3 * 86_400_000),
    });

    await matchesService.cleanupOldDevMatches(1);

    const matches = await sql<{ id: string }[]>`
      SELECT id FROM matches WHERE id = ANY(${[oldDevRoster, oldDevEphemeral]}::uuid[])
    `;
    expect(matches).toEqual([]);

    const bots = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE id = ANY(${[rosterBot, ephemeralBot]}::uuid[])
    `;
    expect(bots.map((r) => r.id)).toEqual([rosterBot]);
  });

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
