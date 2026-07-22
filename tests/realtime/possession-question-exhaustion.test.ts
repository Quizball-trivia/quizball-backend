import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getMatchCacheOrRebuildMock = vi.fn();
const getMatchMock = vi.fn();
const getRecentlySeenQuestionIdsMock = vi.fn();
const getRandomQuestionCandidatesForMatchMock = vi.fn();
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
    getRecentlySeenQuestionIds: (...args: unknown[]) => getRecentlySeenQuestionIdsMock(...args),
    getRandomQuestionCandidatesForMatch: (...args: unknown[]) => getRandomQuestionCandidatesForMatchMock(...args),
    getRandomImageMcqCandidatesForMatch: vi.fn(async () => []),
    getImageMcqCandidateForMatchById: vi.fn(async () => []),
    insertMatchQuestionIfMissing: vi.fn(),
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
    getRecentlySeenQuestionIdsMock.mockResolvedValue([]);
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
});
