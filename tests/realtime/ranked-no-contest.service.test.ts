import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests the zero-interaction no-contest finalizer: a ghost ranked match where
// no human ever genuinely submitted an answer must be abandoned (no winner, no
// RP change) with every human's ranked ticket refunded.

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const startLockHeartbeatMock = vi.fn();
const getMatchMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const abandonMatchMock = vi.fn();
const completeMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const listAnswersForMatchMock = vi.fn();
const getByIdsMock = vi.fn();
const refundRankedTicketsMock = vi.fn();
const deleteMatchCacheMock = vi.fn();
const getMatchCacheOrRebuildMock = vi.fn();
const setMatchCacheMock = vi.fn();
const getRedisClientMock = vi.fn();
const buildFinalResultsPayloadMock = vi.fn();
const emitFinalResultsToMatchParticipantsMock = vi.fn();
const clearAiMapsMock = vi.fn();
const clearHalftimeTimerMock = vi.fn();

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  startLockHeartbeat: (...a: unknown[]) => startLockHeartbeatMock(...a),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...a: unknown[]) => getMatchMock(...a),
    setMatchStatePayload: (...a: unknown[]) => setMatchStatePayloadMock(...a),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    abandonMatch: (...a: unknown[]) => abandonMatchMock(...a),
    completeMatch: (...a: unknown[]) => completeMatchMock(...a),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...a: unknown[]) => listMatchPlayersMock(...a),
  },
}));

vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {
    listAnswersForMatch: (...a: unknown[]) => listAnswersForMatchMock(...a),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...a: unknown[]) => getByIdsMock(...a) },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: (...a: unknown[]) => refundRankedTicketsMock(...a) },
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: (...a: unknown[]) => deleteMatchCacheMock(...a),
  getMatchCacheOrRebuild: (...a: unknown[]) => getMatchCacheOrRebuildMock(...a),
  setMatchCache: (...a: unknown[]) => setMatchCacheMock(...a),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => getRedisClientMock(),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: (...a: unknown[]) => buildFinalResultsPayloadMock(...a),
  emitFinalResultsToMatchParticipants: (...a: unknown[]) => emitFinalResultsToMatchParticipantsMock(...a),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  clearAiMaps: (...a: unknown[]) => clearAiMapsMock(...a),
  clearHalftimeTimer: (...a: unknown[]) => clearHalftimeTimerMock(...a),
  fireAndForget: vi.fn(),
}));

vi.mock('../../src/realtime/match-keys.js', () => ({
  lastMatchKey: (id: string) => `last-match:${id}`,
}));

vi.mock('../../src/core/analytics.js', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackMatchCompleted: vi.fn(),
}));

vi.mock('../../src/modules/achievements/index.js', () => ({
  achievementsService: { evaluateForMatch: vi.fn() },
}));

vi.mock('../../src/modules/objectives/index.js', () => ({
  objectivesService: { evaluateForMatchBestEffort: vi.fn() },
}));

vi.mock('../../src/modules/progression/progression.service.js', () => ({
  progressionService: { awardCompletedMatchXp: vi.fn() },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { settleCompletedRankedMatch: vi.fn() },
}));

const MATCH_ID = 'match-uuid';
const HUMAN_A = 'human-a';
const HUMAN_B = 'human-b';

describe('finalizeRankedMatchAsNoContest — zero human interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(undefined);
    startLockHeartbeatMock.mockReturnValue({ stop: vi.fn() });
    getMatchMock.mockResolvedValue({
      id: MATCH_ID,
      mode: 'ranked',
      status: 'active',
      state_payload: { variant: 'ranked_sim' },
      current_q_index: 12,
    });
    setMatchStatePayloadMock.mockResolvedValue(undefined);
    abandonMatchMock.mockResolvedValue(undefined);
    deleteMatchCacheMock.mockResolvedValue(undefined);
    getMatchCacheOrRebuildMock.mockResolvedValue(null);
    setMatchCacheMock.mockResolvedValue(undefined);
    listMatchPlayersMock.mockResolvedValue([{ user_id: HUMAN_A }, { user_id: HUMAN_B }]);
    listAnswersForMatchMock.mockResolvedValue([]);
    getByIdsMock.mockResolvedValue(new Map([
      [HUMAN_A, { id: HUMAN_A, is_ai: false }],
      [HUMAN_B, { id: HUMAN_B, is_ai: false }],
    ]));
    refundRankedTicketsMock.mockResolvedValue({ wallets: {} });
    getRedisClientMock.mockReturnValue(null);
    buildFinalResultsPayloadMock.mockResolvedValue({
      matchId: MATCH_ID,
      winnerId: null,
      players: {},
      totalQuestions: 12,
      resultVersion: 123,
    });
    emitFinalResultsToMatchParticipantsMock.mockResolvedValue(undefined);
  });

  it('abandons the match and refunds both humans, never completing it (no winner/RP)', async () => {
    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    const result = await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(result.completed).toBe(true);
    expect(abandonMatchMock).toHaveBeenCalledWith(MATCH_ID);
    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([HUMAN_A, HUMAN_B]);
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      MATCH_ID,
      expect.objectContaining({ cancelledNoContest: true })
    );
  });

  it('only refunds the human when the opponent is an AI', async () => {
    listMatchPlayersMock.mockResolvedValue([{ user_id: HUMAN_A }, { user_id: 'ai-bot' }]);
    getByIdsMock.mockResolvedValue(new Map([
      [HUMAN_A, { id: HUMAN_A, is_ai: false }],
      ['ai-bot', { id: 'ai-bot', is_ai: true }],
    ]));

    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(refundRankedTicketsMock).toHaveBeenCalledWith([HUMAN_A]);
  });

  it('is a no-op when the match is no longer active (idempotent under lock races)', async () => {
    getMatchMock.mockResolvedValue({ id: MATCH_ID, status: 'completed' });

    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    const result = await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(result.completed).toBe(false);
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).not.toHaveBeenCalled();
  });

  it('reports not completed when the completion lock is already held', async () => {
    acquireLockMock.mockResolvedValue({ acquired: false, token: null });

    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    const result = await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(result.completed).toBe(false);
    expect(getMatchMock).not.toHaveBeenCalled();
  });

  it('voids zero-interaction possession completion without reacquiring the held completion lock', async () => {
    acquireLockMock
      .mockResolvedValueOnce({ acquired: true, token: 'completion-token' })
      .mockResolvedValue({ acquired: false, token: null });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: HUMAN_A, seat: 1, total_points: 0, correct_answers: 0 },
      { user_id: HUMAN_B, seat: 2, total_points: 0, correct_answers: 0 },
    ]);
    const finalPayload = {
      matchId: MATCH_ID,
      winnerId: null,
      players: {},
      totalQuestions: 12,
      resultVersion: 456,
    };
    buildFinalResultsPayloadMock.mockResolvedValue(finalPayload);
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };
    const state = {
      goals: { seat1: 1, seat2: 0 },
      penaltyGoals: { seat1: 0, seat2: 0 },
    };
    const { completePossessionMatch } = await import(
      '../../src/realtime/possession-completion.js'
    );

    const result = await completePossessionMatch(
      io as never,
      MATCH_ID,
      state as never
    );

    expect(result.completed).toBe(true);
    expect(result.winnerId).toBeNull();
    expect(acquireLockMock).toHaveBeenCalledTimes(1);
    expect(abandonMatchMock).toHaveBeenCalledWith(MATCH_ID);
    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([HUMAN_A, HUMAN_B]);
    expect(clearAiMapsMock).toHaveBeenCalledWith(MATCH_ID);
    expect(clearHalftimeTimerMock).toHaveBeenCalledWith(MATCH_ID);
    expect(buildFinalResultsPayloadMock).toHaveBeenCalledWith(MATCH_ID, result.resultVersion);
    expect(emitFinalResultsToMatchParticipantsMock).toHaveBeenCalledWith(
      io,
      MATCH_ID,
      finalPayload
    );
    expect(releaseLockMock).toHaveBeenCalledWith(
      `lock:match:${MATCH_ID}:complete`,
      'completion-token'
    );
  });
});
