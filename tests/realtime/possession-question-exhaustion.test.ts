import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getMatchCacheOrRebuildMock = vi.fn();
const getMatchMock = vi.fn();
const getRandomQuestionCandidatesForMatchMock = vi.fn();
const getRecentlySeenQuestionIdsMock = vi.fn();
const insertMatchQuestionIfMissingMock = vi.fn();
const completePossessionMatchMock = vi.fn();

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
    getRandomImageMcqCandidatesForMatch: vi.fn(async () => []),
    getImageMcqCandidateForMatchById: vi.fn(async () => []),
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
  cancelRealtimeTimer: vi.fn(),
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

function createCache(phase: 'PENALTY_SHOOTOUT' | 'NORMAL_PLAY'): MatchCache {
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
    getMatchMock.mockResolvedValue({ status: 'active' });
    getRandomQuestionCandidatesForMatchMock.mockResolvedValue([]);
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

  it('replaces an exhausted special slot with an MCQ instead of freezing normal play', async () => {
    const cache = createCache('NORMAL_PLAY');
    cache.currentQIndex = 4;
    cache.statePayload.normalQuestionsAnsweredInHalf = 4;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { questionTypes: string[] }) => (
      params.questionTypes[0] === 'mcq_single'
        ? [{
          id: 'fallback-mcq',
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
        }]
        : []
    ));

    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await expect(sendPossessionMatchQuestion(createIo(), cache.matchId, 4)).resolves.toBeNull();

    expect(getRandomQuestionCandidatesForMatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionTypes: ['put_in_order'] })
    );
    expect(getRandomQuestionCandidatesForMatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionTypes: ['mcq_single'], difficulties: ['easy', 'medium', 'hard'] })
    );
    expect(insertMatchQuestionIfMissingMock).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: cache.matchId, qIndex: 4, questionId: 'fallback-mcq' })
    );
    expect(completePossessionMatchMock).not.toHaveBeenCalled();
  });
});
