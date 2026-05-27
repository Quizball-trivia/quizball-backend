import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '../setup.js';

const listMembersWithUserMock = vi.fn();
const createMatchMock = vi.fn();
const insertMatchPlayersMock = vi.fn();
const getUserByIdMock = vi.fn();
const ensureProfileMock = vi.fn();
const buildAiMatchContextMock = vi.fn();
const markMatchCompletedMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const recordUserModeStatsMock = vi.fn();

// Entity-repo mocks for the new cross-entity service orchestrators
// (incrementGoalsAndInsertEventIfMissing, recordPartyQuizAnswerIfMissing).
const insertGoalEventIfMissingInTxMock = vi.fn();
const updatePlayerGoalTotalsInTxMock = vi.fn();
const insertMatchAnswerIfMissingInTxMock = vi.fn();
const updatePlayerTotalsInTxMock = vi.fn();
const getAnswerForUserInTxMock = vi.fn();

// sql.begin's callback often does an inline `tx.unsafe(...)` read
// (recordPartyQuizAnswerIfMissing reads the existing match_players row on
// ON CONFLICT). The sentinel tx returned by sqlBeginMock needs `.unsafe`
// so those reads don't throw.
const txUnsafeMock = vi.fn();

/**
 * Stand-in for `sql.begin(cb)`. Just invokes the callback with a sentinel
 * `tx` value and resolves with whatever it returns — the repo mocks below
 * don't actually need a postgres transaction handle.
 */
const sqlBeginMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
  const tx = { unsafe: (...args: unknown[]) => txUnsafeMock(...args) };
  return cb(tx);
});

vi.mock('../../src/db/index.js', () => ({
  sql: Object.assign((..._args: unknown[]) => undefined, {
    begin: (cb: (tx: unknown) => Promise<unknown>) => sqlBeginMock(cb),
    json: (v: unknown) => v,
  }),
}));

vi.mock('../../src/core/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    createMatch: (...args: unknown[]) => createMatchMock(...args),
    markMatchCompleted: (...args: unknown[]) => markMatchCompletedMock(...args),
    recordUserModeStats: (...args: unknown[]) => recordUserModeStatsMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-events.repo.js', () => ({
  matchEventsRepo: {
    insertGoalEventIfMissingInTx: (...args: unknown[]) =>
      insertGoalEventIfMissingInTxMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    insertMatchPlayers: (...args: unknown[]) => insertMatchPlayersMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    updatePlayerGoalTotalsInTx: (...args: unknown[]) =>
      updatePlayerGoalTotalsInTxMock(...args),
    updatePlayerTotalsInTx: (...args: unknown[]) =>
      updatePlayerTotalsInTxMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {
    insertMatchAnswerIfMissingInTx: (...args: unknown[]) =>
      insertMatchAnswerIfMissingInTxMock(...args),
    getAnswerForUserInTx: (...args: unknown[]) =>
      getAnswerForUserInTxMock(...args),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getUserByIdMock(...args),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: (...args: unknown[]) => ensureProfileMock(...args),
    buildAiMatchContext: (...args: unknown[]) => buildAiMatchContextMock(...args),
  },
}));

describe('matches.service friendly-party-quiz variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMembersWithUserMock.mockResolvedValue([]);
    createMatchMock.mockResolvedValue({ id: 'match-1' });
    insertMatchPlayersMock.mockResolvedValue(undefined);
    getUserByIdMock.mockResolvedValue({ id: 'user-1', is_ai: false });
    ensureProfileMock.mockResolvedValue({ placementStatus: 'placed' });
    buildAiMatchContextMock.mockReturnValue(null);
  });

  it('creates the initial party quiz state with the default v1 question count', async () => {
    const {
      PARTY_QUIZ_TOTAL_QUESTIONS,
      createInitialPartyQuizState,
    } = await import('../../src/modules/matches/matches.service.js');

    expect(createInitialPartyQuizState()).toEqual({
      version: 1,
      variant: 'friendly_party_quiz',
      totalQuestions: PARTY_QUIZ_TOTAL_QUESTIONS,
      currentQuestion: null,
      answeredUserIds: [],
      winnerDecisionMethod: null,
      stateVersionCounter: 0,
    });
  });

  it('resolves explicit and fallback match variants correctly', async () => {
    const { resolveMatchVariant } = await import('../../src/modules/matches/matches.service.js');

    expect(resolveMatchVariant({ variant: 'friendly_party_quiz' }, 'friendly')).toBe('friendly_party_quiz');
    expect(resolveMatchVariant({ variant: 'friendly_possession' }, 'friendly')).toBe('friendly_possession');
    expect(resolveMatchVariant(null, 'friendly')).toBe('friendly_possession');
    expect(resolveMatchVariant(null, 'ranked')).toBe('ranked_sim');
  });

  it('creates party quiz matches with host-first player ordering and sequential seats', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'guest-a' },
      { user_id: 'host-user' },
      { user_id: 'guest-b' },
      { user_id: 'guest-c' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const result = await matchesService.createMatchFromLobby({
      lobbyId: 'lobby-party',
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      hostUserId: 'host-user',
      categoryAId: 'cat-party',
      categoryBId: null,
    });

    expect(createMatchMock).toHaveBeenCalledWith({
      lobbyId: 'lobby-party',
      mode: 'friendly',
      categoryAId: 'cat-party',
      categoryBId: null,
      totalQuestions: 10,
      statePayload: expect.objectContaining({
        variant: 'friendly_party_quiz',
        totalQuestions: 10,
      }),
      rankedContext: null,
      isDev: undefined,
    });
    expect(insertMatchPlayersMock).toHaveBeenCalledWith('match-1', [
      { userId: 'host-user', seat: 1 },
      { userId: 'guest-a', seat: 2 },
      { userId: 'guest-b', seat: 3 },
      { userId: 'guest-c', seat: 4 },
    ]);
    expect(result.playerIds).toEqual(['host-user', 'guest-a', 'guest-b', 'guest-c']);
    expect(result.variant).toBe('friendly_party_quiz');
  });

  it('creates 2-player party quiz matches when the host selects that variant', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'host-user' },
      { user_id: 'guest-a' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const result = await matchesService.createMatchFromLobby({
      lobbyId: 'lobby-party-duel',
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      hostUserId: 'host-user',
      categoryAId: 'cat-party',
      categoryBId: null,
    });

    expect(createMatchMock).toHaveBeenCalledWith({
      lobbyId: 'lobby-party-duel',
      mode: 'friendly',
      categoryAId: 'cat-party',
      categoryBId: null,
      totalQuestions: 10,
      statePayload: expect.objectContaining({
        variant: 'friendly_party_quiz',
        totalQuestions: 10,
      }),
      rankedContext: null,
      isDev: undefined,
    });
    expect(insertMatchPlayersMock).toHaveBeenCalledWith('match-1', [
      { userId: 'host-user', seat: 1 },
      { userId: 'guest-a', seat: 2 },
    ]);
    expect(result.playerIds).toEqual(['host-user', 'guest-a']);
    expect(result.variant).toBe('friendly_party_quiz');
  });

  it('rejects party quiz creation when the lobby has fewer than 2 members', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'host-user' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(
      matchesService.createMatchFromLobby({
        lobbyId: 'lobby-too-small',
        mode: 'friendly',
        variant: 'friendly_party_quiz',
        hostUserId: 'host-user',
        categoryAId: 'cat-party',
        categoryBId: null,
      })
    ).rejects.toMatchObject({
      message: 'Party quiz requires between 2 and 6 members',
    });
    expect(createMatchMock).not.toHaveBeenCalled();
  });

  // ── completeMatch tests are in their own describe block below ──

  it('keeps two-player friendly creation on the possession variant', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'host-user' },
      { user_id: 'guest-a' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const result = await matchesService.createMatchFromLobby({
      lobbyId: 'lobby-duel',
      mode: 'friendly',
      variant: 'friendly_possession',
      hostUserId: 'host-user',
      categoryAId: 'cat-duel',
      categoryBId: null,
    });

    expect(createMatchMock).toHaveBeenCalledWith({
      lobbyId: 'lobby-duel',
      mode: 'friendly',
      categoryAId: 'cat-duel',
      categoryBId: null,
      totalQuestions: 12,
      statePayload: expect.objectContaining({
        variant: 'friendly_possession',
        normalQuestionsPerHalf: 6,
      }),
      rankedContext: null,
      isDev: undefined,
    });
    expect(insertMatchPlayersMock).toHaveBeenCalledWith('match-1', [
      { userId: 'host-user', seat: 1 },
      { userId: 'guest-a', seat: 2 },
    ]);
    expect(result.playerIds).toEqual(['host-user', 'guest-a']);
    expect(result.variant).toBe('friendly_possession');
  });
});

describe('matches.service completeMatch', () => {
  const matchId = 'match-99';
  const userA = 'user-a';
  const userB = 'user-b';

  beforeEach(() => {
    vi.clearAllMocks();
    sqlBeginMock.mockImplementation(async (cb) => cb('tx'));
    markMatchCompletedMock.mockResolvedValue({
      id: matchId,
      mode: 'friendly',
      ended_at: '2026-01-01T00:00:00.000Z',
      is_dev: false,
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: userA, seat: 1 },
      { user_id: userB, seat: 2 },
    ]);
    recordUserModeStatsMock.mockResolvedValue(undefined);
  });

  it('increments wins/losses for the winning player and their opponent', async () => {
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await matchesService.completeMatch(matchId, userA);

    expect(markMatchCompletedMock).toHaveBeenCalledWith('tx', matchId, userA);
    expect(listMatchPlayersMock).toHaveBeenCalledWith(matchId, 'tx');
    expect(recordUserModeStatsMock).toHaveBeenCalledTimes(1);
    const [, statRows] = (recordUserModeStatsMock.mock.calls[0] as [unknown, Array<Record<string, unknown>>]);
    expect(statRows).toEqual([
      { userId: userA, mode: 'friendly', wins: 1, losses: 0, draws: 0, lastMatchAt: '2026-01-01T00:00:00.000Z' },
      { userId: userB, mode: 'friendly', wins: 0, losses: 1, draws: 0, lastMatchAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('increments draws for both players when winnerId is null', async () => {
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await matchesService.completeMatch(matchId, null);

    expect(markMatchCompletedMock).toHaveBeenCalledWith('tx', matchId, null);
    const [, statRows] = (recordUserModeStatsMock.mock.calls[0] as [unknown, Array<Record<string, unknown>>]);
    expect(statRows).toEqual([
      { userId: userA, mode: 'friendly', wins: 0, losses: 0, draws: 1, lastMatchAt: '2026-01-01T00:00:00.000Z' },
      { userId: userB, mode: 'friendly', wins: 0, losses: 0, draws: 1, lastMatchAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('skips the stats upsert entirely on dev matches', async () => {
    markMatchCompletedMock.mockResolvedValue({
      id: matchId,
      mode: 'friendly',
      ended_at: '2026-01-01T00:00:00.000Z',
      is_dev: true,
    });

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    await matchesService.completeMatch(matchId, userA);

    expect(markMatchCompletedMock).toHaveBeenCalledOnce();
    // Crucially: no roster read, no stats write — dev matches don't pollute
    // aggregate stats.
    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(recordUserModeStatsMock).not.toHaveBeenCalled();
  });

  it('is idempotent on a double-call (markMatchCompleted returns null the second time)', async () => {
    markMatchCompletedMock
      .mockResolvedValueOnce({
        id: matchId,
        mode: 'friendly',
        ended_at: '2026-01-01T00:00:00.000Z',
        is_dev: false,
      })
      .mockResolvedValueOnce(null); // 2nd call hits the `WHERE status = 'active'` guard

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await matchesService.completeMatch(matchId, userA);
    await matchesService.completeMatch(matchId, userA);

    expect(markMatchCompletedMock).toHaveBeenCalledTimes(2);
    expect(recordUserModeStatsMock).toHaveBeenCalledTimes(1); // not twice
  });

  it('does not write stats when the roster is empty (defensive guard)', async () => {
    listMatchPlayersMock.mockResolvedValue([]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    await matchesService.completeMatch(matchId, userA);

    expect(recordUserModeStatsMock).not.toHaveBeenCalled();
  });

  it('rolls the whole transaction back when the stats upsert throws', async () => {
    // Atomicity smoke: when the repo's stats upsert throws, completeMatch
    // should propagate the error (which causes sql.begin to roll back the
    // markMatchCompleted UPDATE in production — the match stays 'active'
    // and a retry will work).
    recordUserModeStatsMock.mockRejectedValueOnce(new Error('boom'));

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(matchesService.completeMatch(matchId, userA)).rejects.toThrow('boom');
    expect(markMatchCompletedMock).toHaveBeenCalledOnce();
  });
});

// ─── Cross-entity orchestrators added in the matches.repo split ──────────
// These tests are service-orchestration smoke. They prove the service calls
// the right repo methods in the right order with the right args, and
// short-circuits correctly on the idempotency path. They do NOT prove DB
// rollback — the mocked sql.begin in this file just invokes the callback
// synchronously, so a thrown step doesn't actually undo a previous step's
// write. Real rollback semantics rely on postgres + sql.begin in
// production and would need a DB-backed integration test to pin.

describe('matches.service incrementGoalsAndInsertEventIfMissing', () => {
  const matchId = 'match-goal-1';
  const userId = 'user-goal-1';
  const goalEventInput = {
    matchId,
    userId,
    seat: 1 as const,
    half: 1 as const,
    phaseKind: 'normal' as const,
    qIndex: 3,
    isPenalty: false,
    delta: { goals: 1 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sqlBeginMock.mockImplementation(async (cb) => {
      const tx = { unsafe: (...args: unknown[]) => txUnsafeMock(...args) };
      return cb(tx);
    });
  });

  it('inserts the event then updates the player counter on first write', async () => {
    insertGoalEventIfMissingInTxMock.mockResolvedValue({ id: 'ge-1' });
    updatePlayerGoalTotalsInTxMock.mockResolvedValue({ id: 'mp-1', goals: 1, penalty_goals: 0 });

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const result = await matchesService.incrementGoalsAndInsertEventIfMissing(goalEventInput);

    expect(insertGoalEventIfMissingInTxMock).toHaveBeenCalledTimes(1);
    expect(updatePlayerGoalTotalsInTxMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ inserted: true, player: { id: 'mp-1', goals: 1, penalty_goals: 0 } });
  });

  it('skips the player update on duplicate (ON CONFLICT returned null)', async () => {
    insertGoalEventIfMissingInTxMock.mockResolvedValue(null);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const result = await matchesService.incrementGoalsAndInsertEventIfMissing(goalEventInput);

    expect(insertGoalEventIfMissingInTxMock).toHaveBeenCalledTimes(1);
    expect(updatePlayerGoalTotalsInTxMock).not.toHaveBeenCalled(); // no double-count
    expect(result).toEqual({ inserted: false, player: null });
  });

  it('propagates errors from the player update so sql.begin can roll back', async () => {
    insertGoalEventIfMissingInTxMock.mockResolvedValue({ id: 'ge-1' });
    updatePlayerGoalTotalsInTxMock.mockRejectedValue(new Error('player update failed'));

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(
      matchesService.incrementGoalsAndInsertEventIfMissing(goalEventInput),
    ).rejects.toThrow('player update failed');
    expect(insertGoalEventIfMissingInTxMock).toHaveBeenCalledOnce();
  });
});

describe('matches.service recordPartyQuizAnswerIfMissing', () => {
  const matchId = 'match-party-1';
  const userId = 'user-party-1';
  const answerInput = {
    matchId,
    qIndex: 5,
    userId,
    selectedIndex: 2,
    isCorrect: true,
    timeMs: 1234,
    pointsEarned: 10,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sqlBeginMock.mockImplementation(async (cb) => {
      const tx = { unsafe: (...args: unknown[]) => txUnsafeMock(...args) };
      return cb(tx);
    });
  });

  it('inserts the answer and updates player totals on first write', async () => {
    insertMatchAnswerIfMissingInTxMock.mockResolvedValue({ id: 'ma-1', is_correct: true, points_earned: 10 });
    updatePlayerTotalsInTxMock.mockResolvedValue({ id: 'mp-1', total_points: 10, correct_answers: 1 });

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const result = await matchesService.recordPartyQuizAnswerIfMissing(answerInput);

    expect(insertMatchAnswerIfMissingInTxMock).toHaveBeenCalledTimes(1);
    expect(updatePlayerTotalsInTxMock).toHaveBeenCalledWith(
      expect.anything(), // the tx sentinel
      matchId,
      userId,
      10,
      true,
    );
    expect(result.inserted).toBe(true);
    expect(result.answer).toEqual({ id: 'ma-1', is_correct: true, points_earned: 10 });
    expect(result.player).toEqual({ id: 'mp-1', total_points: 10, correct_answers: 1 });
  });

  it('reads back existing rows on duplicate without scoring again (no double-count)', async () => {
    insertMatchAnswerIfMissingInTxMock.mockResolvedValue(null); // ON CONFLICT path
    getAnswerForUserInTxMock.mockResolvedValue({ id: 'ma-existing', is_correct: true });
    // The service's existing-player read uses tx.unsafe directly. Mock the
    // SELECT to return one row.
    txUnsafeMock.mockResolvedValue([{ id: 'mp-existing', total_points: 10 }]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const result = await matchesService.recordPartyQuizAnswerIfMissing(answerInput);

    expect(insertMatchAnswerIfMissingInTxMock).toHaveBeenCalledTimes(1);
    expect(updatePlayerTotalsInTxMock).not.toHaveBeenCalled(); // crucial: no double-score
    expect(result.inserted).toBe(false);
    expect(result.answer).toEqual({ id: 'ma-existing', is_correct: true });
    expect(result.player).toEqual({ id: 'mp-existing', total_points: 10 });
  });

  it('throws (rolling back) if match_players row is missing during first write', async () => {
    insertMatchAnswerIfMissingInTxMock.mockResolvedValue({ id: 'ma-1' });
    updatePlayerTotalsInTxMock.mockResolvedValue(null); // FK violation analog

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(
      matchesService.recordPartyQuizAnswerIfMissing(answerInput),
    ).rejects.toThrow(/match_players row missing/);
  });

  it('propagates other errors from the player update so sql.begin can roll back', async () => {
    insertMatchAnswerIfMissingInTxMock.mockResolvedValue({ id: 'ma-1' });
    updatePlayerTotalsInTxMock.mockRejectedValue(new Error('player update failed'));

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(
      matchesService.recordPartyQuizAnswerIfMissing(answerInput),
    ).rejects.toThrow(/Failed to record party quiz answer/);
  });
});

describe('matches.service cleanupOldDevMatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a single tagged-template SQL call (atomicity is the single statement)', async () => {
    // The cleanup is a single sql\`...\` CTE statement, not a sql.begin block.
    // It atomically deletes from 5 tables in one round trip. Here we just
    // verify the service surfaces the right call shape — the SQL itself
    // is not unit-testable without a real DB, but a follow-up integration
    // test should pin the guarantees called out in the service docstring:
    //
    //   - Non-dev matches are never touched.
    //   - Non-AI users are never touched.
    //   - AI users that still have non-dev matches are kept.
    //   - Orphan AI users (only in cleaned matches) ARE deleted.
    //   - Dev match rows ARE cleaned across all 4 match tables.
    //
    // Mock sql as a tagged-template callable that returns an empty array
    // (no matches deleted) for this smoke check.
    vi.resetModules();
    const dbMock = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/db/index.js', () => ({
      sql: Object.assign(dbMock, { begin: vi.fn(), json: (v: unknown) => v }),
    }));

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const callsBefore = dbMock.mock.calls.length;
    const count = await matchesService.cleanupOldDevMatches(50);

    // The cleanup itself is exactly one tagged-template invocation. Other
    // modules pulled in by the dynamic import (e.g. src/db/sql-fragments.ts)
    // call sql\`...\` at module load — those happen before this assertion,
    // so we measure the delta caused by cleanupOldDevMatches.
    const callsDuringCleanup = dbMock.mock.calls.length - callsBefore;
    expect(callsDuringCleanup).toBe(1);
    const cleanupCallArgs = dbMock.mock.calls[dbMock.mock.calls.length - 1];
    const strings = cleanupCallArgs[0] as TemplateStringsArray;
    expect(strings[0]).toContain('matches_to_delete');
    expect(count).toBe(0);
  });
});
