import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const redisCounters = new Map<string, number>();
let redisMultiFails = false;
const fakeRedis = {
  isOpen: true,
  multi: vi.fn(() => {
    let pendingKey = '';
    const chain = {
      incr: (key: string) => {
        pendingKey = key;
        return chain;
      },
      expire: () => chain,
      exec: async () => {
        if (redisMultiFails) throw new Error('redis down');
        const next = (redisCounters.get(pendingKey) ?? 0) + 1;
        redisCounters.set(pendingKey, next);
        return [next, true];
      },
    };
    return chain;
  }),
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

let limiterRejects = false;
const limiterRunMock = vi.fn((task: () => Promise<void>) => {
  if (limiterRejects) return Promise.reject(new Error('queue_full'));
  return task();
});
vi.mock('../../src/realtime/socket-db-task-limiter.js', () => ({
  telemetryDbTaskLimiter: { run: (task: () => Promise<void>) => limiterRunMock(task) },
}));

function fakeSocket(userId: string | null, rooms: string[] = ['match:match-1']) {
  return { data: { user: userId ? { id: userId } : undefined }, rooms: new Set(rooms) } as never;
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

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('match-visibility.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisCounters.clear();
    redisMultiFails = false;
    limiterRejects = false;
    fakeRedis.isOpen = true;
  });

  it('persists a server-enriched event for an active participant', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });
    await flushMicrotasks();

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

  it('drops events before any Redis/DB work when the socket is not in the match room', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    await handleVisibilitySignal(fakeSocket('user-1', []), { matchId: 'match-1', signal: 'hidden' });
    await handleVisibilitySignal(fakeSocket('user-1', ['match:other']), { matchId: 'match-1', signal: 'hidden' });

    expect(fakeRedis.multi).not.toHaveBeenCalled();
    expect(getMatchCacheOrRebuildMock).not.toHaveBeenCalled();
    expect(insertVisibilityEventMock).not.toHaveBeenCalled();
  });

  it('drops events from non-participants and inactive matches', async () => {
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    await handleVisibilitySignal(fakeSocket('intruder'), { matchId: 'match-1', signal: 'hidden' });

    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache({ status: 'completed' }));
    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });

    getMatchCacheOrRebuildMock.mockResolvedValue(null);
    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });

    // A cache/DB failure drops the event instead of rejecting the handler.
    getMatchCacheOrRebuildMock.mockRejectedValue(new Error('redis lock lost'));
    await expect(
      handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' })
    ).resolves.toBeUndefined();

    await flushMicrotasks();
    expect(insertVisibilityEventMock).not.toHaveBeenCalled();
  });

  it('rate limits per user+match before touching the match cache', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    for (let i = 0; i < 35; i += 1) {
      await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });
    }
    await flushMicrotasks();

    expect(insertVisibilityEventMock).toHaveBeenCalledTimes(30);
    expect(getMatchCacheOrRebuildMock).toHaveBeenCalledTimes(30);
  });

  it('fails open when Redis errors and never rejects on repo or limiter failure', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache());
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    redisMultiFails = true;
    await handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'hidden' });
    await flushMicrotasks();
    expect(insertVisibilityEventMock).toHaveBeenCalledTimes(1);
    redisMultiFails = false;

    insertVisibilityEventMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'visible' })
    ).resolves.toBeUndefined();

    // Limiter admission rejection (queue full) must be swallowed — an
    // unhandled rejection here would trip the bootstrap restart guard.
    limiterRejects = true;
    await expect(
      handleVisibilitySignal(fakeSocket('user-1'), { matchId: 'match-1', signal: 'blur' })
    ).resolves.toBeUndefined();
    await flushMicrotasks();
  });

  it('records null question context when no question is open', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(activeCache({ currentQuestion: null }));
    const { handleVisibilitySignal } = await import('../../src/realtime/services/match-visibility.service.js');

    await handleVisibilitySignal(fakeSocket('user-2'), { matchId: 'match-1', signal: 'blur' });
    await flushMicrotasks();

    expect(insertVisibilityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionOpen: false, questionKind: null, questionId: null, qIndex: 7 })
    );
  });
});
