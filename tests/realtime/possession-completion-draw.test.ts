import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// A level shootout completes as a DRAW: matches.winner_user_id NULL,
// winnerDecisionMethod 'draw', placement 1 for both, and match:final_results
// carries { winnerId: null, winnerDecisionMethod: 'draw', isDraw: true }.
// The pool-exhausted path (source 'penalty_question_pool_exhausted') goes
// through the same completion: level -> draw, ahead -> that side wins.

const getMatchMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const completeMatchMock = vi.fn();
const computeAvgTimesMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const setPlayerFinalTotalsMock = vi.fn();
const updatePlayerAvgTimeMock = vi.fn();
const getByIdsMock = vi.fn();
const trackMatchCompletedMock = vi.fn();
const emitFinalResultsMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/core/analytics.js', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackMatchCompleted: (...args: unknown[]) => trackMatchCompletedMock(...args),
}));
vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: { listAnswersForMatch: vi.fn(async () => []) },
}));
vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    setPlayerFinalTotals: (...args: unknown[]) => setPlayerFinalTotalsMock(...args),
    updatePlayerAvgTime: (...args: unknown[]) => updatePlayerAvgTimeMock(...args),
  },
}));
vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
  },
}));
vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...args: unknown[]) => getByIdsMock(...args) },
}));
vi.mock('../../src/modules/achievements/index.js', () => ({
  achievementsService: { evaluateForMatch: vi.fn(async () => ({})) },
}));
vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return {
    ...actual,
    matchesService: {
      completeMatch: (...args: unknown[]) => completeMatchMock(...args),
      computeAvgTimes: (...args: unknown[]) => computeAvgTimesMock(...args),
    },
  };
});
vi.mock('../../src/modules/objectives/index.js', () => ({
  objectivesService: { evaluateForMatchBestEffort: vi.fn(async () => undefined) },
}));
vi.mock('../../src/modules/progression/progression.service.js', () => ({
  progressionService: { awardCompletedMatchXp: vi.fn(async () => undefined) },
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { settleCompletedRankedMatch: vi.fn(), getMatchOutcome: vi.fn() },
}));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: { releaseIfSettled: vi.fn(async () => undefined) },
}));
vi.mock('../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: vi.fn(async () => undefined),
  getMatchCacheOrRebuild: vi.fn(),
  setMatchCache: vi.fn(async () => undefined),
}));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'tok' })),
  releaseLock: vi.fn(async () => true),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  clearAiMaps: vi.fn(),
  clearHalftimeTimer: vi.fn(),
  fireAndForget: vi.fn(),
}));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalQuestionResults: vi.fn(async () => undefined),
  buildFinalResultsPayload: vi.fn(),
  emitFinalResultsToMatchParticipants: (...args: unknown[]) => emitFinalResultsMock(...args),
}));
vi.mock('../../src/realtime/services/ranked-no-contest.service.js', () => ({
  finalizeRankedNoContest: vi.fn(),
}));
vi.mock('../../src/realtime/services/match-interaction.service.js', () => ({
  hasNoHumanInteraction: () => false,
  isNoContestHuman: () => true,
}));

import { completePossessionMatch } from '../../src/realtime/possession-completion.js';

const MATCH_ID = 'match-draw';

function makeCache(penaltyGoals: { seat1: number; seat2: number }, kicks = { seat1: 5, seat2: 5 }): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  state.phase = 'PENALTY_SHOOTOUT';
  state.goals = { seat1: 1, seat2: 1 };
  state.penaltyGoals = { ...penaltyGoals };
  state.penalty.round = 1;
  state.penalty.kicksTaken = { ...kicks };
  return {
    matchId: MATCH_ID,
    status: 'active',
    mode: 'friendly',
    totalQuestions: 12,
    categoryAId: 'cat-a',
    categoryBId: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    players: [
      { userId: 'u1', seat: 1, totalPoints: 900, correctAnswers: 9, goals: 1, penaltyGoals: penaltyGoals.seat1, avgTimeMs: null },
      { userId: 'u2', seat: 2, totalPoints: 700, correctAnswers: 7, goals: 1, penaltyGoals: penaltyGoals.seat2, avgTimeMs: null },
    ],
    currentQIndex: 20,
    statePayload: state,
    currentQuestion: null,
    answers: {},
    revealAcks: {},
    clueReveals: {},
  };
}

function createIo() {
  const emit = vi.fn();
  return { io: { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer, emit };
}

describe('completePossessionMatch: level shootout is a draw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMatchMock.mockResolvedValue({
      id: MATCH_ID, mode: 'friendly', status: 'active', total_questions: 12,
      started_at: new Date(Date.now() - 60_000).toISOString(), current_q_index: 20, state_payload: null,
    });
    completeMatchMock.mockResolvedValue(undefined);
    computeAvgTimesMock.mockResolvedValue(new Map());
    setPlayerFinalTotalsMock.mockResolvedValue(null);
    updatePlayerAvgTimeMock.mockResolvedValue(undefined);
    getByIdsMock.mockResolvedValue(new Map([
      ['u1', { id: 'u1', is_guest: false, is_ai: false }],
      ['u2', { id: 'u2', is_guest: false, is_ai: false }],
    ]));
  });

  it('level after the shootout: winner NULL, winnerDecisionMethod draw, placement 1 for both, isDraw on final_results', async () => {
    const cache = makeCache({ seat1: 3, seat2: 3 });
    const { io, emit } = createIo();

    const result = await completePossessionMatch(io, MATCH_ID, cache.statePayload, cache, {
      source: 'penalty_question_pool_exhausted',
    });

    expect(result).toMatchObject({ completed: true, winnerId: null });
    expect(cache.statePayload.winnerDecisionMethod).toBe('draw');
    // Placements are handed to completeMatch so they commit in the SAME
    // transaction as the status flip — never as a post-commit write.
    expect(completeMatchMock).toHaveBeenCalledWith(MATCH_ID, null, undefined, {
      placements: [{ userId: 'u1', placement: 1 }, { userId: 'u2', placement: 1 }],
    });
    expect(emit).toHaveBeenCalledWith('match:final_results', expect.objectContaining({
      matchId: MATCH_ID,
      winnerId: null,
      winnerDecisionMethod: 'draw',
      isDraw: true,
      totalPointsFallbackUsed: false,
    }));
    // The old fallback must not pick the points leader.
    expect(completeMatchMock).not.toHaveBeenCalledWith(MATCH_ID, 'u1');
    expect(trackMatchCompletedMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', won: false, winnerDecisionMethod: 'draw' }));
  });

  it('pool exhausted while a side is ahead: that side wins on penalty goals, no draw', async () => {
    const cache = makeCache({ seat1: 2, seat2: 3 }, { seat1: 4, seat2: 4 });
    const { io, emit } = createIo();

    const result = await completePossessionMatch(io, MATCH_ID, cache.statePayload, cache, {
      source: 'penalty_question_pool_exhausted',
    });

    expect(result).toMatchObject({ completed: true, winnerId: 'u2' });
    expect(cache.statePayload.winnerDecisionMethod).toBe('penalty_goals');
    expect(completeMatchMock).toHaveBeenCalledWith(MATCH_ID, 'u2');
    expect(completeMatchMock.mock.calls[0]?.[3]).toBeUndefined();
    const payload = emit.mock.calls.find((call) => call[0] === 'match:final_results')?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ winnerId: 'u2', winnerDecisionMethod: 'penalty_goals' });
    expect(payload).not.toHaveProperty('isDraw');
  });

  it('a placement write failure leaves the match active, and the retry completes AND settles the draw', async () => {
    // With placements inside the completion transaction, a failed write rolls
    // the status flip back too: nothing is durably completed, so the next
    // completion attempt (round-resolver retry / replay) runs the whole path,
    // including ranked settlement — no orphaned "completed, unsettled" match.
    getMatchMock.mockResolvedValue({
      id: MATCH_ID, mode: 'ranked', status: 'active', total_questions: 12,
      started_at: new Date(Date.now() - 60_000).toISOString(), current_q_index: 20, state_payload: null,
    });
    const { rankedService } = await import('../../src/modules/ranked/ranked.service.js');
    vi.mocked(rankedService.settleCompletedRankedMatch).mockResolvedValue(null);
    completeMatchMock.mockRejectedValueOnce(new Error('placement write failed'));
    const cache = makeCache({ seat1: 3, seat2: 3 });
    cache.mode = 'ranked';
    const { io, emit } = createIo();

    await expect(
      completePossessionMatch(io, MATCH_ID, cache.statePayload, cache, { source: 'round_resolver' })
    ).rejects.toThrow('placement write failed');
    expect(rankedService.settleCompletedRankedMatch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('match:final_results', expect.anything());

    // Retry: match is still active (completion rolled back).
    completeMatchMock.mockResolvedValueOnce(undefined);
    const retryCache = makeCache({ seat1: 3, seat2: 3 });
    retryCache.mode = 'ranked';
    const result = await completePossessionMatch(io, MATCH_ID, retryCache.statePayload, retryCache, { source: 'round_resolver' });

    expect(result).toMatchObject({ completed: true, winnerId: null });
    expect(completeMatchMock).toHaveBeenLastCalledWith(MATCH_ID, null, undefined, {
      placements: [{ userId: 'u1', placement: 1 }, { userId: 'u2', placement: 1 }],
    });
    expect(rankedService.settleCompletedRankedMatch).toHaveBeenCalledWith(MATCH_ID);
    expect(emit).toHaveBeenCalledWith('match:final_results', expect.objectContaining({ isDraw: true, winnerDecisionMethod: 'draw' }));
  });
});
