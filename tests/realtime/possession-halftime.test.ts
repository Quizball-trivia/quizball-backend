import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getMatchCacheOrRebuildMock = vi.fn();
const setMatchCacheMock = vi.fn();
const cancelRealtimeTimerMock = vi.fn();
const scheduleRealtimeTimerMock = vi.fn();
const getRedisClientMock = vi.fn();
const setMatchCategoryBMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  getCachedPlayer: (
    cache: { players: Array<{ userId: string }> },
    userId: string
  ) => cache.players.find((player) => player.userId === userId) ?? null,
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  setMatchCache: (...args: unknown[]) => setMatchCacheMock(...args),
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  cancelRealtimeTimer: (...args: unknown[]) => cancelRealtimeTimerMock(...args),
  scheduleRealtimeTimer: (...args: unknown[]) => scheduleRealtimeTimerMock(...args),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: vi.fn(),
    setMatchCategoryB: (...args: unknown[]) => setMatchCategoryBMock(...args),
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    getLobbyCategories: vi.fn(),
    selectRandomCategories: vi.fn(),
    selectRandomCategoriesExcluding: vi.fn(),
    selectRandomRankedCategories: vi.fn(),
    selectRandomRankedCategoriesExcluding: vi.fn(),
  },
}));

function createIo(): QuizballServer {
  return {
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as unknown as QuizballServer;
}

function createHalftimeCache(): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  state.phase = 'HALFTIME';
  state.half = 1;
  state.normalQuestionsAnsweredInHalf = 6;
  state.normalQuestionsAnsweredTotal = 6;
  state.halftime.deadlineAt = new Date(Date.now() - 1000).toISOString();
  state.halftime.uiReadyAt = null;
  state.halftime.categoryOptions = [
    { id: 'cat-a', name: 'A', icon: null },
    { id: 'cat-b', name: 'B', icon: null },
    { id: 'cat-c', name: 'C', icon: null },
  ];
  state.halftime.bans = { seat1: null, seat2: null };

  return {
    matchId: 'match-1',
    status: 'active',
    mode: 'friendly',
    totalQuestions: 12,
    categoryAId: 'cat-a',
    categoryBId: null,
    startedAt: new Date().toISOString(),
    players: [
      {
        userId: 'user-1',
        seat: 1,
        totalPoints: 0,
        correctAnswers: 0,
        goals: 0,
        penaltyGoals: 0,
        avgTimeMs: null,
      },
      {
        userId: 'user-2',
        seat: 2,
        totalPoints: 0,
        correctAnswers: 0,
        goals: 0,
        penaltyGoals: 0,
        avgTimeMs: null,
      },
    ],
    currentQIndex: 6,
    statePayload: state,
    currentQuestion: null,
    answers: {},
  };
}

describe('possession halftime finalize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(true);
    cancelRealtimeTimerMock.mockResolvedValue(1);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    getRedisClientMock.mockReturnValue(null);
    setMatchCacheMock.mockResolvedValue(undefined);
    setMatchCategoryBMock.mockResolvedValue(undefined);
    setMatchStatePayloadMock.mockResolvedValue(undefined);
  });

  it('auto-resolves missing bans on first timeout for human-only friendly possession matches', async () => {
    const cache = createHalftimeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => null);
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    await halftime.finalizeHalftime(createIo(), 'match-1');

    expect(resolveAiUserId).toHaveBeenCalledWith('match-1');
    expect(scheduleRealtimeTimerMock).not.toHaveBeenCalled();
    expect(sendQuestion).toHaveBeenCalledWith(
      expect.anything(),
      'match-1',
      6,
      { cache }
    );
    expect(cache.statePayload.phase).toBe('NORMAL_PLAY');
    expect(cache.statePayload.half).toBe(2);
    expect(cache.statePayload.halftime.deadlineAt).toBeNull();
    expect(cache.statePayload.halftime.uiReadyAt).toBeNull();
    expect(cache.statePayload.halftime.bans.seat1).toBeTruthy();
    expect(cache.statePayload.halftime.bans.seat2).toBeTruthy();
    expect(cache.categoryBId).toBeTruthy();
    expect(releaseLockMock).toHaveBeenCalledWith('lock:match:match-1:halftime', 'lock-token');
  });

  it('defers AI possession halftime WITHOUT forging ui_ready when no client has signalled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    const cache = createHalftimeCache();
    const originalDeadlineAt = cache.statePayload.halftime.deadlineAt;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2');
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    try {
      await halftime.finalizeHalftime(createIo(), 'match-1');

      await vi.waitFor(() => {
        expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
          'possession_halftime',
          'match-1',
          new Date(cache.statePayload.halftime.deadlineAt ?? 0),
          { kind: 'possession_halftime', matchId: 'match-1' }
        );
      });
      expect(sendQuestion).not.toHaveBeenCalled();
      expect(cache.statePayload.phase).toBe('HALFTIME');
      expect(cache.statePayload.halftime.deadlineAt).not.toBe(originalDeadlineAt);
      // THE fix: the defer must NOT pretend the client is ready — previously
      // uiReadyAt was forged to equal deadlineAt here, force-opening the ban
      // window and letting the AI ban before the player saw the cards.
      expect(cache.statePayload.halftime.uiReadyAt).toBeNull();
      expect(cache.statePayload.halftime.readyDeferCount).toBe(1);
      // No bans written during the defer.
      expect(cache.statePayload.halftime.bans).toEqual({ seat1: null, seat2: null });
    } finally {
      halftime.clearHalftimeAiBanTimer('match-1');
      vi.useRealTimers();
    }
  });

  it('force-opens the ban window after the defer cap so a silent client cannot stall the match', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    const cache = createHalftimeCache();
    cache.statePayload.halftime.readyDeferCount = 3; // HALFTIME_READY_DEFER_MAX
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2');
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    try {
      await halftime.finalizeHalftime(createIo(), 'match-1');

      await vi.waitFor(() => {
        expect(scheduleRealtimeTimerMock).toHaveBeenCalled();
      });
      // Cap exhausted → window force-opens (uiReadyAt = deadlineAt) so the AI
      // can ban and the match keeps moving even if no client ever signals.
      expect(cache.statePayload.phase).toBe('HALFTIME');
      expect(cache.statePayload.halftime.uiReadyAt).toBe(cache.statePayload.halftime.deadlineAt);
      expect(sendQuestion).not.toHaveBeenCalled();
    } finally {
      halftime.clearHalftimeAiBanTimer('match-1');
      vi.useRealTimers();
    }
  });

  it('never schedules the AI first ban before the client signals UI ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    const cache = createHalftimeCache();
    cache.statePayload.halftime.deadlineAt = new Date(Date.now() + 20000).toISOString();
    cache.statePayload.halftime.uiReadyAt = null;
    cache.statePayload.halftime.firstBanSeat = 2; // AI (seat 2) bans first
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2');
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    try {
      halftime.schedulePossessionAiHalftimeBan(createIo(), 'match-1');
      // Advance well past the 3500ms no-ui-ready fallback — nothing may fire.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(setMatchCacheMock).not.toHaveBeenCalled();
      expect(cache.statePayload.halftime.bans).toEqual({ seat1: null, seat2: null });
    } finally {
      halftime.clearHalftimeAiBanTimer('match-1');
      vi.useRealTimers();
    }
  });

  it('schedules the AI ban once the client has signalled UI ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    const cache = createHalftimeCache();
    const deadlineAt = new Date(Date.now() + 20000).toISOString();
    cache.statePayload.halftime.deadlineAt = deadlineAt;
    cache.statePayload.halftime.uiReadyAt = deadlineAt; // client confirmed cards visible
    cache.statePayload.halftime.firstBanSeat = 2;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2');
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    try {
      halftime.schedulePossessionAiHalftimeBan(createIo(), 'match-1');
      await vi.advanceTimersByTimeAsync(5_000);

      await vi.waitFor(() => {
        // AI banned after its think delay (700–1800ms post ui_ready).
        expect(cache.statePayload.halftime.bans.seat2).toBeTruthy();
      });
      expect(cache.statePayload.halftime.bans.seat1).toBeNull();
    } finally {
      halftime.clearHalftimeAiBanTimer('match-1');
      vi.useRealTimers();
    }
  });

  it('rebases a visible halftime ban deadline after disconnect pause resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:12.000Z'));
    const cache = createHalftimeCache();
    const originalDeadlineAt = '2026-06-03T12:00:20.000Z';
    cache.statePayload.halftime.deadlineAt = originalDeadlineAt;
    cache.statePayload.halftime.uiReadyAt = originalDeadlineAt;
    cache.statePayload.halftime.firstBanSeat = 1;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2');
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    try {
      const resumed = await halftime.resumePossessionHalftimeAfterPause(
        createIo(),
        'match-1',
        new Date('2026-06-03T12:00:05.000Z').getTime()
      );

      expect(resumed).toBe(true);
      expect(cache.statePayload.phase).toBe('HALFTIME');
      expect(cache.statePayload.halftime.deadlineAt).toBe('2026-06-03T12:00:27.000Z');
      expect(cache.statePayload.halftime.uiReadyAt).toBe('2026-06-03T12:00:27.000Z');
      expect(setMatchCacheMock).toHaveBeenCalledWith(cache);
      expect(setMatchStatePayloadMock).toHaveBeenCalledWith('match-1', cache.statePayload, cache.currentQIndex);
      await vi.waitFor(() => {
        expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
          'possession_halftime',
          'match-1',
          new Date('2026-06-03T12:00:27.000Z'),
          { kind: 'possession_halftime', matchId: 'match-1' }
        );
      });
    } finally {
      halftime.clearHalftimeAiBanTimer('match-1');
      vi.useRealTimers();
    }
  });

  it('defaults the first halftime ban turn to the human (seat 1) when firstBanSeat is unset', async () => {
    const cache = createHalftimeCache();
    cache.statePayload.halftime.firstBanSeat = undefined;
    cache.statePayload.halftime.bans = { seat1: null, seat2: null };
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2');
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    // Before any ban, with no firstBanSeat assigned yet (the round-resolver
    // entry path), the turn must be the human's — NOT the AI's. A `?? 2`
    // default here let the AI ban before the player saw the cards.
    expect(halftime.getHalftimeTurnSeat(cache.statePayload)).toBe(1);
  });

  it('does not let the AI ban first when firstBanSeat is unset (ui_ready signalled)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    const cache = createHalftimeCache();
    const deadlineAt = new Date(Date.now() + 20000).toISOString();
    cache.statePayload.halftime.deadlineAt = deadlineAt;
    cache.statePayload.halftime.uiReadyAt = deadlineAt; // client confirmed cards visible
    cache.statePayload.halftime.firstBanSeat = undefined; // not assigned yet
    cache.statePayload.halftime.bans = { seat1: null, seat2: null };
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const sendQuestion = vi.fn(async () => ({ correctIndex: 1 }));
    const resolveAiUserId = vi.fn(async () => 'user-2'); // AI is seat 2
    const { createPossessionHalftime } = await import('../../src/realtime/possession-halftime.js');
    const halftime = createPossessionHalftime({ sendQuestion, resolveAiUserId });

    try {
      halftime.schedulePossessionAiHalftimeBan(createIo(), 'match-1');
      await vi.advanceTimersByTimeAsync(5_000);

      // Human (seat 1) goes first by default → the AI must NOT have banned.
      expect(cache.statePayload.halftime.bans.seat2).toBeNull();
    } finally {
      halftime.clearHalftimeAiBanTimer('match-1');
      vi.useRealTimers();
    }
  });
});
