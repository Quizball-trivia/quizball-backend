import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import {
  FRONTEND_GOAL_CELEBRATION_MS,
  FRONTEND_RESULT_HOLD_MS,
  FRONTEND_TRANSITION_DELAY_MS,
} from '../../src/realtime/possession-state.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// Contract test for the penalty ready-ack gate (follow-up to the 2026-08-30
// "no time to read the question" report): penalty rounds must be scheduled
// through the client ready-ack gate — exactly like goal rounds — with the
// penalty-specific ceiling and a DISTINCT timeout dispatch, while ordinary
// non-goal rounds keep the plain timer path.

const openMock = vi.fn();

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
    getRandomQuestionCandidatesForMatch: vi.fn(async () => []),
    getRandomImageMcqCandidatesForMatch: vi.fn(async () => []),
    getImageMcqCandidateForMatchById: vi.fn(async () => []),
    insertMatchQuestionIfMissing: vi.fn(),
    setQuestionTiming: vi.fn(),
  },
}));
vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: { getMatch: vi.fn(), touchMatchRound: vi.fn(), setMatchStatePayload: vi.fn() },
}));
vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return { ...actual, matchesService: { buildMatchQuestionPayload: vi.fn() } };
});
vi.mock('../../src/realtime/match-cache.js', () => ({
  countdownGetFound: vi.fn(async () => []),
  getMatchCacheOrRebuild: vi.fn(),
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
  completePossessionMatch: vi.fn(),
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
vi.mock('../../src/realtime/ready-gate.js', () => ({
  createReadyGateRegistry: () => ({
    open: (...args: unknown[]) => openMock(...args),
    acknowledge: vi.fn(),
    clear: vi.fn(),
    reset: vi.fn(),
  }),
}));

function createCache(phase: 'PENALTY_SHOOTOUT' | 'NORMAL_PLAY'): MatchCache {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = phase;
  return {
    matchId: 'match-gate',
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
    currentQIndex: 12,
    statePayload: state,
    currentQuestion: null,
    answers: {},
    revealAcks: {},
  } as unknown as MatchCache;
}

const io = {} as QuizballServer;

describe('penalty rounds and the ready-ack gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('opens the ready gate for a penalty round with the penalty ceiling and a distinct timeout dispatch', async () => {
    const { scheduleNextPossessionQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await scheduleNextPossessionQuestion(io, 'match-gate', createCache('PENALTY_SHOOTOUT'), {
      phase: 'PENALTY_SHOOTOUT',
      phaseKind: 'penalty',
      resolvedQIndex: 12,
      nextIndex: 13,
      goalScoredBySeat: null, // a MISSED kick still gates — it's the choreography, not the goal
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    const params = openMock.mock.calls[0][0] as {
      scopeId: string;
      token: number;
      waitingUserIds: Iterable<string>;
      ceilingMs: number;
      dispatch: () => void;
      dispatchOnTimeout?: () => void;
    };
    expect(params.scopeId).toBe('match-gate');
    expect(params.token).toBe(12);
    expect([...params.waitingUserIds].sort()).toEqual(['user-1', 'user-2']);
    expect(params.ceilingMs).toBe(10_000);
    expect(typeof params.dispatchOnTimeout).toBe('function');
    expect(params.dispatchOnTimeout).not.toBe(params.dispatch);
  });

  it('keeps the plain timer path for an ordinary non-goal round (no gate)', async () => {
    const { scheduleNextPossessionQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await scheduleNextPossessionQuestion(io, 'match-gate', createCache('NORMAL_PLAY'), {
      phase: 'NORMAL_PLAY',
      phaseKind: 'normal',
      resolvedQIndex: 3,
      nextIndex: 4,
      goalScoredBySeat: null,
    });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('still gates goal rounds (unchanged) with the goal ceiling', async () => {
    const { scheduleNextPossessionQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await scheduleNextPossessionQuestion(io, 'match-gate', createCache('NORMAL_PLAY'), {
      phase: 'NORMAL_PLAY',
      phaseKind: 'normal',
      resolvedQIndex: 5,
      nextIndex: 6,
      goalScoredBySeat: 1,
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    const params = openMock.mock.calls[0][0] as { ceilingMs: number };
    // Goal rounds keep their own ceiling (hold + transition + celebration + 2s slack).
    expect(params.ceilingMs).toBe(
      FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_GOAL_CELEBRATION_MS + 2000,
    );
  });
});
