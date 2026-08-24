import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const redisCounters = new Map<string, number>();
const fakeRedis = {
  isOpen: true,
  incr: vi.fn(async (key: string) => {
    const next = (redisCounters.get(key) ?? 0) + 1;
    redisCounters.set(key, next);
    return next;
  }),
  expire: vi.fn(async () => true),
};

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => fakeRedis,
}));

const insertVisibilityEventMock = vi.fn(async () => undefined);
vi.mock('../../src/modules/matches/match-visibility-events.repo.js', () => ({
  matchVisibilityEventsRepo: {
    insertVisibilityEvent: (...args: unknown[]) => insertVisibilityEventMock(...args),
  },
}));

const getMatchCacheOrRebuildMock = vi.fn();
vi.mock('../../src/realtime/match-cache.js', () => ({
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  getCachedPlayer: (cache: { players: Array<{ userId: string }> }, userId: string) =>
    cache.players.find((player) => player.userId === userId) ?? null,
}));

vi.mock('../../src/realtime/socket-db-task-limiter.js', () => ({
  socketDbTaskLimiter: { run: (task: () => Promise<void>) => task() },
}));

function fakeSocket(userId: string | null) {
  return { data: { user: userId ? { id: userId } : undefined } } as never;
}

function activeCache(overrides: Record<string, unknown> = {}) {
  return {
    matchId: 'match-1',
    status: 'active',
    mode: 'ranked',
    players: [{ userId: 'user-1' }, { userId: 'user-2' }],
    currentQIndex: 7,
    statePayload: { phase: 'NORMAL_PLAY' },
    currentQuestion: { qIndex: 7, kind: 'clues', questionId: 'q-abc' },
    ...overrides,
  };
}

describe('match-visibility.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisCounters.clear();
    fakeRedis.isOpen = true;
  });

  it('persists a server-enriched event for an active participant', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });

    expect(insertVisibilityEventMock).toHaveBeenCalledWith({
      matchId: 'match-1',
      userId: 'user-1',
      signal: 'hidden',
      qIndex: 7,
      questionId: 'q-abc',
      phase: 'NORMAL_PLAY',
      questionKind: 'clues',
      questionOpen: true,
      mode: 'ranked',
      occurredAt: expect.any(Date),
    });
  });

  it('drops events from non-participants and inactive matches', async () => {
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    await handleVisibilitySignal(fakeSocket('intruder'), { matchId: 'match-1', signal: 'hidden' });

    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache({ status: 'completed' }));
    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });

    getMatchCacheOrRebuildMock.mockResolvedValue(null);
    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });

    expect(insertVisibilityEventMock).not.toHaveBeenCalled();
  });

  it('rate limits per user+match and never throws when the repo fails', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    for (let i = 0; i < 35; i += 1) {
      await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });
    }
    expect(insertVisibilityEventMock).toHaveBeenCalledTimes(30);

    insertVisibilityEventMock.mockRejectedValueOnce(new Error('db down'));
    redisCounters.clear();
    await expect(
      handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'visible' })
    ).resolves.toBeUndefined();
  });

  it('records null question context when no question is open', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache({ currentQuestion: null }));
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    await handleVisibilitySignal(fakeSocket('user-2'), { matchId: 'match-1', signal: 'blur' });

    expect(insertVisibilityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionOpen: false, questionKind: null, questionId: null, qIndex: 7 })
    );
  });
});
