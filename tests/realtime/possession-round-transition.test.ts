import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import {
  FRONTEND_GOAL_CELEBRATION_MS,
  FRONTEND_RESULT_HOLD_MS,
  FRONTEND_TRANSITION_DELAY_MS,
} from '../../src/realtime/possession-state.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// Restart between rounds (staging 2026-10-07): a goal/penalty wait lived only in memory, so a restart in it froze the
// match. Each wait is backed by a durable question timer for the next index; a late in-memory gate never resends a
// question its backup already sent; recovery re-creates a backup that was lost.

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
const scheduleRealtimeTimerMock = vi.fn(async () => undefined);
const hasPendingMock = vi.fn(async () => false);
const cancelTimerMock = vi.fn(async () => undefined);
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  cancelRealtimeTimer: (...a: unknown[]) => cancelTimerMock(...(a as [])),
  hasPendingRealtimeTimer: (...a: unknown[]) => hasPendingMock(...(a as [])),
  scheduleRealtimeTimer: (...args: unknown[]) => scheduleRealtimeTimerMock(...(args as [])),
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
const redisGet = vi.fn(async () => null as string | null);
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isOpen: true, get: (...a: unknown[]) => redisGet(...(a as [])) }),
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

import { getMatchCacheOrRebuild } from '../../src/realtime/match-cache.js';
import { matchesRepo } from '../../src/modules/matches/matches.repo.js';

function betweenRounds(overrides: Partial<MatchCache> = {}): MatchCache {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'NORMAL_PLAY';
  return {
    matchId: 'm1', status: 'active', mode: 'ranked', totalQuestions: 12, categoryAId: 'a', categoryBId: 'b',
    startedAt: new Date().toISOString(),
    players: [
      { userId: 'user-1', seat: 1, totalPoints: 100, correctAnswers: 1, goals: 1, penaltyGoals: 0, avgTimeMs: null },
      { userId: 'user-2', seat: 2, totalPoints: 90, correctAnswers: 1, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    ],
    // Round 3 resolved (a goal), the index advanced, question 4 not out yet.
    currentQIndex: 4, statePayload: state, currentQuestion: null, answers: {}, revealAcks: {},
    ...overrides,
  } as unknown as MatchCache;
}

const io = {} as QuizballServer;
const dispatchAttempted = () => vi.mocked(matchesRepo.getMatch).mock.calls.some(([id]) => id === 'm1');

describe('in-memory ready gate after its durable backup already sent the question', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
    vi.mocked(matchesRepo.getMatch).mockResolvedValue(null as never);
  });

  async function openGoalGate() {
    const { scheduleNextPossessionQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    vi.mocked(getMatchCacheOrRebuild).mockResolvedValue(betweenRounds());
    await scheduleNextPossessionQuestion(io, 'm1', betweenRounds(), {
      phase: 'NORMAL_PLAY', phaseKind: 'normal', resolvedQIndex: 3, nextIndex: 4, goalScoredBySeat: 1,
    });
    return openMock.mock.calls.at(-1)![0] as { dispatch: () => void };
  }

  it('does not resend when the question is already out', async () => {
    const gate = await openGoalGate();
    vi.mocked(getMatchCacheOrRebuild).mockResolvedValue(betweenRounds({ currentQuestion: { qIndex: 4 } as never }));
    gate.dispatch();
    await vi.waitFor(() => expect(getMatchCacheOrRebuild).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchAttempted()).toBe(false);
  });

  it('a failed gate dispatch leaves its durable backup in place (Codex P1-2)', async () => {
    const gate = await openGoalGate();
    expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith('possession_question', 'm1:4', expect.any(Date), expect.anything(), { onlyIfAbsent: true });
    vi.mocked(matchesRepo.getMatch).mockRejectedValueOnce(new Error('transient database error'));
    gate.dispatch();
    await vi.waitFor(() => expect(dispatchAttempted()).toBe(true));
    await new Promise((r) => setTimeout(r, 10));
    // Only the saved question's own deadline timer replaces the backup; a failure never removes it.
    expect(cancelTimerMock).not.toHaveBeenCalledWith('possession_question', 'm1:4');
  });

  it('sends when the match is still waiting for it', async () => {
    const gate = await openGoalGate();
    gate.dispatch();
    await vi.waitFor(() => expect(dispatchAttempted()).toBe(true));
  });
});

describe('recovery of a match stuck between rounds (rejoin / boot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
    hasPendingMock.mockResolvedValue(false);
  });

  it('re-creates a lost transition instead of skipping "missing current question"', async () => {
    vi.mocked(getMatchCacheOrRebuild).mockResolvedValue(betweenRounds());
    const { ensurePossessionActiveTimers } = await import('../../src/realtime/possession-question-dispatch.js');
    const before = Date.now();
    await expect(ensurePossessionActiveTimers(io, 'm1')).resolves.toBe(true);
    expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
      'possession_question', 'm1:4', expect.any(Date),
      { kind: 'possession_question', matchId: 'm1', qIndex: 4 },
      { onlyIfAbsent: true },
    );
    const dueAt = (scheduleRealtimeTimerMock.mock.calls[0] as unknown as [string, string, Date])[2].getTime();
    // After any live in-memory wait elsewhere has fired (penalty ceiling 10 s + margin).
    expect(dueAt - before).toBeGreaterThanOrEqual(13_000);
  });

  it('keeps a transition that is still pending', async () => {
    vi.mocked(getMatchCacheOrRebuild).mockResolvedValue(betweenRounds());
    hasPendingMock.mockResolvedValue(true);
    const { ensurePossessionActiveTimers } = await import('../../src/realtime/possession-question-dispatch.js');
    await expect(ensurePossessionActiveTimers(io, 'm1')).resolves.toBe(true);
    expect(scheduleRealtimeTimerMock).not.toHaveBeenCalled();
  });

  it('leaves the first question to match start and a paused match to resume', async () => {
    const { ensurePossessionActiveTimers } = await import('../../src/realtime/possession-question-dispatch.js');
    vi.mocked(getMatchCacheOrRebuild).mockResolvedValue(betweenRounds({ currentQIndex: 0 }));
    await expect(ensurePossessionActiveTimers(io, 'm1')).resolves.toBe(false);
    vi.mocked(getMatchCacheOrRebuild).mockResolvedValue(betweenRounds());
    redisGet.mockResolvedValue(String(Date.now()));
    await expect(ensurePossessionActiveTimers(io, 'm1')).resolves.toBe(false);
    expect(scheduleRealtimeTimerMock).not.toHaveBeenCalled();
  });
});
