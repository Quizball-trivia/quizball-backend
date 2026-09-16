import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getMatchCacheOrRebuildMock = vi.fn();
const getMatchMock = vi.fn();
const getRandomQuestionCandidatesForMatchMock = vi.fn();
const getRandomImageMcqCandidatesForMatchMock = vi.fn();
const getImageMcqCandidateForMatchByIdMock = vi.fn();
const getRecentlySeenQuestionIdsMock = vi.fn();
const insertMatchQuestionIfMissingMock = vi.fn();
const completePossessionMatchMock = vi.fn();
const finalizeNoContestMock = vi.fn();
const emitFinalResultsMock = vi.fn();
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: { listAllRankedEligibleCategories: vi.fn(async () => [{ id: 'other-category' }]) },
}));

vi.mock('../../src/realtime/services/ranked-no-contest.service.js', () => ({
  finalizeRankedMatchAsNoContest: (...args: unknown[]) => finalizeNoContestMock(...args),
}));
vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: vi.fn(async () => ({ cancelledNoContest: true, winnerId: null })),
  emitFinalResultsToMatchParticipants: (...args: unknown[]) => emitFinalResultsMock(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/core/metrics.js', () => ({
  appMetrics: { questionGenerationDuration: { record: vi.fn() } },
}));

vi.mock('../../src/core/tracing.js', () => ({
  withSpan: async (_name: string, _attributes: unknown, work: (span: unknown) => Promise<unknown>) =>
    work({ setAttribute: vi.fn(), setAttributes: vi.fn() }),
}));

vi.mock('../../src/modules/matches/match-questions.repo.js', () => ({
  matchQuestionsRepo: {
    getRandomQuestionCandidatesForMatch: (...args: unknown[]) => getRandomQuestionCandidatesForMatchMock(...args),
    getRecentlySeenQuestionIds: (...args: unknown[]) => getRecentlySeenQuestionIdsMock(...args),
    getRandomImageMcqCandidatesForMatch: (...args: unknown[]) => getRandomImageMcqCandidatesForMatchMock(...args),
    getImageMcqCandidateForMatchById: (...args: unknown[]) => getImageMcqCandidateForMatchByIdMock(...args),
    insertMatchQuestionIfMissing: (...args: unknown[]) => insertMatchQuestionIfMissingMock(...args),
    setQuestionTiming: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    touchMatchRound: vi.fn(),
    setMatchStatePayload: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return {
    ...actual,
    matchesService: { buildMatchQuestionPayload: vi.fn() },
  };
});

vi.mock('../../src/realtime/match-cache.js', () => ({
  countdownGetFound: vi.fn(async () => []),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  setMatchCache: vi.fn(),
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  cancelRealtimeTimer: vi.fn(async () => undefined),
  hasPendingRealtimeTimer: vi.fn(),
  scheduleRealtimeTimer: vi.fn(),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  ensureHalftimeCategories: vi.fn(),
  fireAndForget: vi.fn(),
  resolveAiUserIdForMatch: vi.fn(async () => null),
  resolvePossessionRound: vi.fn(),
  scheduleHalftimeTimeout: vi.fn(),
  schedulePossessionAiAnswer: vi.fn(),
  schedulePossessionAiHalftimeBan: vi.fn(),
}));

vi.mock('../../src/realtime/possession-completion.js', () => ({
  completePossessionMatch: (...args: unknown[]) => completePossessionMatchMock(...args),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isOpen: true, get: vi.fn(async () => null) }),
}));

vi.mock('../../src/realtime/services/dev-realtime.service.js', () => ({
  checkDevPauseAndDefer: vi.fn(async () => false),
}));

vi.mock('../../src/realtime/services/match-entry.service.js', () => ({
  markMatchEnteredForRoom: vi.fn(),
  markMatchEnteredForSocket: vi.fn(),
}));

function createCache(phase: 'PENALTY_SHOOTOUT' | 'NORMAL_PLAY' | 'LAST_ATTACK'): MatchCache {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = phase;
  state.penaltyCategoryId = 'category-penalty';
  return {
    matchId: 'match-exhausted',
    status: 'active',
    mode: 'ranked',
    totalQuestions: 12,
    categoryAId: 'category-a',
    categoryBId: 'category-b',
    startedAt: new Date().toISOString(),
    players: [
      { userId: 'user-1', seat: 1, totalPoints: 100, correctAnswers: 1, goals: 0, penaltyGoals: 0, avgTimeMs: null },
      { userId: 'user-2', seat: 2, totalPoints: 90, correctAnswers: 1, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    ],
    currentQIndex: 22,
    statePayload: state,
    currentQuestion: null,
    answers: {},
    revealAcks: {},
  };
}

function createIo(): QuizballServer {
  return { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as QuizballServer;
}

describe('possession question exhaustion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    finalizeNoContestMock.mockResolvedValue({ completed: true, resultVersion: 1 });
    getMatchMock.mockResolvedValue({ status: 'active' });
    getRandomQuestionCandidatesForMatchMock.mockResolvedValue([]);
    getRandomImageMcqCandidatesForMatchMock.mockResolvedValue([]);
    getImageMcqCandidateForMatchByIdMock.mockResolvedValue([]);
    insertMatchQuestionIfMissingMock.mockResolvedValue(null);
    completePossessionMatchMock.mockResolvedValue({
      matchId: 'match-exhausted',
      winnerId: 'user-1',
      resultVersion: 1,
      completed: true,
    });
  });

  it('completes an exhausted penalty shootout instead of freezing forever', async () => {
    const cache = createCache('PENALTY_SHOOTOUT');
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');

    await expect(sendPossessionMatchQuestion(createIo(), cache.matchId, 22)).resolves.toBeNull();

    expect(completePossessionMatchMock).toHaveBeenCalledWith(
      expect.anything(),
      cache.matchId,
      cache.statePayload,
      cache,
      { source: 'penalty_question_pool_exhausted' },
    );
  });

  it('does not invent a winner when normal-play content is missing', async () => {
    const cache = createCache('NORMAL_PLAY');
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');

    await expect(sendPossessionMatchQuestion(createIo(), cache.matchId, 6)).resolves.toBeNull();

    expect(completePossessionMatchMock).not.toHaveBeenCalled();
    expect(finalizeNoContestMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'question_pool_exhausted' }));
  });

  it('voids exhausted last attack, emits no-contest, and never awards a winner', async () => {
    const cache = createCache('LAST_ATTACK');
    cache.currentQIndex = 6;
    cache.statePayload.lastAttack.attackerSeat = 1;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await sendPossessionMatchQuestion(createIo(), cache.matchId, 6);
    expect(finalizeNoContestMock).toHaveBeenCalledWith(expect.objectContaining({
      matchId: cache.matchId, roundsPlayed: 6, reason: 'question_pool_exhausted',
    }));
    expect(emitFinalResultsMock).toHaveBeenCalledWith(expect.anything(), cache.matchId,
      expect.objectContaining({ cancelledNoContest: true, winnerId: null }));
    expect(completePossessionMatchMock).not.toHaveBeenCalled();
  });

  it('uses a globally eligible MCQ only after the last-attack category ladder is exhausted', async () => {
    const cache = createCache('LAST_ATTACK');
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { categoryIds: string[] }) =>
      params.categoryIds.includes('other-category') ? [{ id: 'global-mcq', category_id: 'other-category', payload: {
        type: 'mcq_single', options: [
          { id: 'a', text: { en: 'A' }, is_correct: true },
          { id: 'b', text: { en: 'B' }, is_correct: false },
          { id: 'c', text: { en: 'C' }, is_correct: false },
          { id: 'd', text: { en: 'D' }, is_correct: false },
        ],
      } }] : []);
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await sendPossessionMatchQuestion(createIo(), cache.matchId, 6);
    expect(getRandomQuestionCandidatesForMatchMock.mock.calls.slice(0, -1)
      .every(([params]) => !params.categoryIds.includes('other-category'))).toBe(true);
    expect(insertMatchQuestionIfMissingMock).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'global-mcq', phaseKind: 'last_attack' }));
    expect(finalizeNoContestMock).not.toHaveBeenCalled();
  });

  it('keeps a durable terminal-results retry when result delivery fails', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(createCache('LAST_ATTACK'));
    emitFinalResultsMock.mockRejectedValueOnce(new Error('temporary delivery failure'));
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    const { scheduleRealtimeTimer, cancelRealtimeTimer } = await import('../../src/realtime/realtime-timer-scheduler.js');
    await expect(sendPossessionMatchQuestion(createIo(), 'match-exhausted', 6))
      .rejects.toThrow('temporary delivery failure');
    expect(scheduleRealtimeTimer).toHaveBeenCalledWith('match_final_results', 'match-exhausted', expect.any(Date), {
      kind: 'match_final_results', matchId: 'match-exhausted', resultVersion: 1,
    });
    expect(cancelRealtimeTimer).not.toHaveBeenCalledWith('match_final_results', 'match-exhausted');
  });

  it('arms a durable retry when another finalizer holds the no-contest lock', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(createCache('LAST_ATTACK'));
    finalizeNoContestMock.mockResolvedValue({ completed: false });
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    const { scheduleRealtimeTimer } = await import('../../src/realtime/realtime-timer-scheduler.js');
    await sendPossessionMatchQuestion(createIo(), 'match-exhausted', 6);
    expect(scheduleRealtimeTimer).toHaveBeenCalledWith('possession_question', expect.any(String), expect.any(Date),
      expect.objectContaining({ matchId: 'match-exhausted', qIndex: 6 }));
    expect(emitFinalResultsMock).not.toHaveBeenCalled();
  });

  it('applies the history exclusion inside the pick query and only drops it for the repeat rung', async () => {
    const cache = createCache('NORMAL_PLAY');
    cache.currentQIndex = 0;
    cache.statePayload.normalQuestionsAnsweredInHalf = 0;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { leastRecentForUserIds?: string[] }) => (
      params.leastRecentForUserIds ? [{
          id: 'repeat-mcq',
          category_id: 'category-a',
          payload: {
            type: 'mcq_single',
            options: [
              { id: 'a', text: { en: 'Correct' }, is_correct: true },
              { id: 'b', text: { en: 'Wrong B' }, is_correct: false },
              { id: 'c', text: { en: 'Wrong C' }, is_correct: false },
              { id: 'd', text: { en: 'Wrong D' }, is_correct: false },
            ],
          },
        }] : []
    ));

    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await sendPossessionMatchQuestion(createIo(), cache.matchId, 0);

    // The seen set never round-trips through the app any more.
    expect(getRecentlySeenQuestionIdsMock).not.toHaveBeenCalled();
    const calls = getRandomQuestionCandidatesForMatchMock.mock.calls.map(([params]) => params as {
      excludeSeen?: { userIds: string[]; withinDays: number };
      leastRecentForUserIds?: string[];
      difficulties?: string[];
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].excludeSeen).toEqual({ userIds: ['user-1', 'user-2'], withinDays: 14 });
    expect(calls[0].leastRecentForUserIds).toBeUndefined();
    expect(calls[1].excludeSeen).toEqual({ userIds: ['user-1', 'user-2'], withinDays: 14 });
    expect(calls[1].difficulties).toEqual(['easy', 'medium', 'hard']);
    expect(calls[2].excludeSeen).toBeUndefined();
    expect(calls[2].leastRecentForUserIds).toEqual(['user-1', 'user-2']);
    expect(insertMatchQuestionIfMissingMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'repeat-mcq' })
    );
  });

  it('keeps history disabled for the rest of the pick after a failure, so the repeat rung cannot throw', async () => {
    const cache = createCache('NORMAL_PLAY');
    cache.currentQIndex = 0;
    cache.statePayload.normalQuestionsAnsweredInHalf = 0;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { excludeSeen?: unknown; leastRecentForUserIds?: string[] }) => {
      if (params.excludeSeen) throw new Error('statement timeout');
      if (params.leastRecentForUserIds) throw new Error('repeat ordering must not run once history failed');
      return [];
    });

    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await expect(sendPossessionMatchQuestion(createIo(), cache.matchId, 0)).resolves.toBeNull();

    const calls = getRandomQuestionCandidatesForMatchMock.mock.calls.map(([params]) => params as {
      excludeSeen?: unknown; leastRecentForUserIds?: string[]; allowImageMcqs?: boolean;
    });
    expect(calls.filter((c) => c.excludeSeen)).toHaveLength(1);
    expect(calls.some((c) => c.leastRecentForUserIds)).toBe(false);
    expect(calls.some((c) => c.allowImageMcqs)).toBe(true);
  });

  it('propagates a failure of the plain retry instead of looping', async () => {
    const cache = createCache('NORMAL_PLAY');
    cache.currentQIndex = 0;
    cache.statePayload.normalQuestionsAnsweredInHalf = 0;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    getRandomQuestionCandidatesForMatchMock.mockRejectedValue(new Error('database down'));

    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await expect(sendPossessionMatchQuestion(createIo(), cache.matchId, 0)).rejects.toThrow('database down');
    expect(getRandomQuestionCandidatesForMatchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a pick without history when the history-aware query fails', async () => {
    const cache = createCache('NORMAL_PLAY');
    cache.currentQIndex = 0;
    cache.statePayload.normalQuestionsAnsweredInHalf = 0;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { excludeSeen?: unknown }) => {
      if (params.excludeSeen) throw new Error('statement timeout');
      return [{
          id: 'repeat-mcq',
          category_id: 'category-a',
          payload: {
            type: 'mcq_single',
            options: [
              { id: 'a', text: { en: 'Correct' }, is_correct: true },
              { id: 'b', text: { en: 'Wrong B' }, is_correct: false },
              { id: 'c', text: { en: 'Wrong C' }, is_correct: false },
              { id: 'd', text: { en: 'Wrong D' }, is_correct: false },
            ],
          },
        }];
    });

    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await sendPossessionMatchQuestion(createIo(), cache.matchId, 0);

    expect(insertMatchQuestionIfMissingMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'repeat-mcq' })
    );
    expect(completePossessionMatchMock).not.toHaveBeenCalled();
  });

  it('uses the global ranked image pool when Q4 categories have no image MCQ', async () => {
    const cache = createCache('NORMAL_PLAY');
    cache.statePayload.normalQuestionsAnsweredInHalf = 3;
    cache.statePayload.imageMcq = { half1: null };
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const globalImageQuestion = {
      id: 'question-global-image',
      category_id: 'category-global',
      prompt: { en: 'Image question' },
      difficulty: 'medium',
      payload: {
        type: 'mcq_single',
        image: {
          url: 'https://cdn.example.com/q4.webp',
          width: 1200,
          height: 800,
        },
        options: [
          { id: 'a', text: { en: 'A' }, is_correct: true },
          { id: 'b', text: { en: 'B' }, is_correct: false },
          { id: 'c', text: { en: 'C' }, is_correct: false },
          { id: 'd', text: { en: 'D' }, is_correct: false },
        ],
      },
    };
    getRandomImageMcqCandidatesForMatchMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([globalImageQuestion]);
    getImageMcqCandidateForMatchByIdMock.mockResolvedValueOnce([globalImageQuestion]);
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');

    await expect(sendPossessionMatchQuestion(createIo(), cache.matchId, 3)).resolves.toBeNull();

    expect(getRandomImageMcqCandidatesForMatchMock).toHaveBeenNthCalledWith(1, {
      matchId: cache.matchId,
      categoryIds: expect.any(Array),
      limit: 50,
    });
    expect(getRandomImageMcqCandidatesForMatchMock).toHaveBeenNthCalledWith(2, {
      matchId: cache.matchId,
      limit: 50,
    });
    expect(insertMatchQuestionIfMissingMock).toHaveBeenCalledWith(expect.objectContaining({
      matchId: cache.matchId,
      qIndex: 3,
      questionId: 'question-global-image',
      categoryId: 'category-global',
    }));
  });
});
