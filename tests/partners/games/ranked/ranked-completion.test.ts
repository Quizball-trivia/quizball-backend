import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../setup.js';
import { createInitialPossessionState } from '../../../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../../../src/realtime/socket-server.js';

// Freecroco: a partner match that timers played out with no human connected (a crash nobody came back from) is
// settled as "both dropped", never as a natural result; with a human connected it is a natural result.

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

vi.mock('../../../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/core/analytics.js', () => ({ trackEvent: vi.fn() }));
vi.mock('../../../../src/core/analytics/game-events.js', () => ({
  trackMatchCompleted: (...args: unknown[]) => trackMatchCompletedMock(...args),
}));
vi.mock('../../../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: { listAnswersForMatch: vi.fn(async () => []) },
}));
vi.mock('../../../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    setPlayerFinalTotals: (...args: unknown[]) => setPlayerFinalTotalsMock(...args),
    updatePlayerAvgTime: (...args: unknown[]) => updatePlayerAvgTimeMock(...args),
  },
}));
vi.mock('../../../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
  },
}));
vi.mock('../../../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...args: unknown[]) => getByIdsMock(...args) },
}));
vi.mock('../../../../src/modules/achievements/index.js', () => ({
  achievementsService: { evaluateForMatch: vi.fn(async () => ({})) },
}));
vi.mock('../../../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/modules/matches/matches.service.js')>();
  return {
    ...actual,
    matchesService: {
      completeMatch: (...args: unknown[]) => completeMatchMock(...args),
      computeAvgTimes: (...args: unknown[]) => computeAvgTimesMock(...args),
    },
  };
});
vi.mock('../../../../src/modules/objectives/index.js', () => ({
  objectivesService: { evaluateForMatchBestEffort: vi.fn(async () => undefined) },
}));
vi.mock('../../../../src/modules/progression/progression.service.js', () => ({
  progressionService: { awardCompletedMatchXp: vi.fn(async () => undefined) },
}));
vi.mock('../../../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { settleCompletedRankedMatch: vi.fn(), getMatchOutcome: vi.fn() },
}));
vi.mock('../../../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: { releaseIfSettled: vi.fn(async () => undefined) },
}));
vi.mock('../../../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: vi.fn(async () => undefined),
  getMatchCacheOrRebuild: vi.fn(),
  setMatchCache: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'tok' })),
  releaseLock: vi.fn(async () => true),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../../../src/realtime/possession-match-flow.js', () => ({
  clearAiMaps: vi.fn(),
  clearHalftimeTimer: vi.fn(),
  fireAndForget: vi.fn(),
}));
vi.mock('../../../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalQuestionResults: vi.fn(async () => undefined),
  buildFinalResultsPayload: vi.fn(),
  emitFinalResultsToMatchParticipants: (...args: unknown[]) => emitFinalResultsMock(...args),
}));
vi.mock('../../../../src/realtime/services/ranked-no-contest.service.js', () => ({
  finalizeRankedNoContest: vi.fn(),
}));
vi.mock('../../../../src/realtime/services/match-interaction.service.js', () => ({
  hasNoHumanInteraction: () => false,
  isNoContestHuman: () => true,
}));

const presenceMock = vi.fn();
vi.mock('../../../../src/realtime/services/match-presence.service.js', () => ({
  resolveMatchPresence: (...args: unknown[]) => presenceMock(...args),
}));

import { completePossessionMatch } from '../../../../src/realtime/possession-completion.js';

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


describe('partner ranked natural completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMatchMock.mockResolvedValue({
      id: MATCH_ID, mode: 'ranked', status: 'active', total_questions: 12, partner_pool: 'freecroco-test',
      started_at: new Date(Date.now() - 60_000).toISOString(), current_q_index: 20, state_payload: null,
    });
    completeMatchMock.mockResolvedValue(undefined);
    computeAvgTimesMock.mockResolvedValue(new Map());
    setPlayerFinalTotalsMock.mockResolvedValue(null);
    updatePlayerAvgTimeMock.mockResolvedValue(undefined);
    getByIdsMock.mockResolvedValue(new Map([
      ['u1', { id: 'u1', is_guest: false, is_ai: false }],
      ['u2', { id: 'u2', is_guest: false, is_ai: true }],
    ]));
  });

  it('no human connected: both dropped (level → both plays returned by the settlement)', async () => {
    presenceMock.mockResolvedValue({ playerStates: [
      { player: { user_id: 'u1' }, present: false, reasons: [] },
      { player: { user_id: 'u2' }, present: true, reasons: ['ai'] },
    ] });
    const cache = makeCache({ seat1: 3, seat2: 3 });
    await completePossessionMatch(createIo().io, MATCH_ID, cache.statePayload, cache);
    expect(completeMatchMock).toHaveBeenCalledWith(MATCH_ID, null, undefined, expect.objectContaining({
      partnerCause: { kind: 'both_dropped' },
    }));
  });

  it('a human still connected (an excused exit does not count): a played, natural result', async () => {
    presenceMock.mockResolvedValue({ playerStates: [
      { player: { user_id: 'u1' }, present: true, reasons: ['room_socket'] },
      { player: { user_id: 'u2' }, present: true, reasons: ['ai'] },
    ] });
    const cache = makeCache({ seat1: 4, seat2: 3 });
    await completePossessionMatch(createIo().io, MATCH_ID, cache.statePayload, cache);
    expect(completeMatchMock).toHaveBeenCalledWith(MATCH_ID, 'u1', undefined, { partnerCause: { kind: 'natural' } });

    presenceMock.mockResolvedValue({ playerStates: [
      { player: { user_id: 'u1' }, present: true, reasons: ['exit_pending'] },
      { player: { user_id: 'u2' }, present: true, reasons: ['ai'] },
    ] });
    getMatchMock.mockResolvedValue({ ...(await getMatchMock()), status: 'active' });
    const again = makeCache({ seat1: 4, seat2: 3 });
    await completePossessionMatch(createIo().io, MATCH_ID, again.statePayload, again);
    expect(completeMatchMock).toHaveBeenLastCalledWith(MATCH_ID, 'u1', undefined, { partnerCause: { kind: 'both_dropped' } });
  });

  it('an explicit cause from the caller wins even with a human connected (content exhaustion = server failure)', async () => {
    presenceMock.mockResolvedValue({ playerStates: [
      { player: { user_id: 'u1' }, present: true, reasons: ['room_socket'] },
      { player: { user_id: 'u2' }, present: true, reasons: ['ai'] },
    ] });
    const cache = makeCache({ seat1: 3, seat2: 3 });
    await completePossessionMatch(createIo().io, MATCH_ID, cache.statePayload, cache, {
      source: 'penalty_question_pool_exhausted',
      partnerCause: { kind: 'server_failure' },
    });
    expect(completeMatchMock).toHaveBeenCalledWith(MATCH_ID, null, undefined, expect.objectContaining({
      partnerCause: { kind: 'server_failure' },
    }));
    expect(presenceMock).not.toHaveBeenCalled();
  });
});
