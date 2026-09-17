import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const insertMatchAnswerIfMissingMock = vi.fn();
const updatePlayerTotalsMock = vi.fn();
const getUserByIdMock = vi.fn();
const getMatchCacheOrRebuildMock = vi.fn();
const setMatchCacheMock = vi.fn();

type FakeRedis = {
  isOpen: boolean;
  values: Map<string, string>;
  zsets: Map<string, Map<string, number>>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  zAdd: ReturnType<typeof vi.fn>;
  zRem: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  multi: () => {
    set: (key: string, value: string, options?: unknown) => unknown;
    zAdd: (key: string, entries: Array<{ score: number; value: string }>) => unknown;
    exec: () => Promise<unknown[]>;
  };
};

let redis: FakeRedis;

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {
    insertMatchAnswerIfMissing: (...args: unknown[]) => insertMatchAnswerIfMissingMock(...args),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getUserByIdMock(...args),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'lock-token' })),
  extendLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => true),
}));

import { acquireLock, releaseLock } from '../../src/realtime/locks.js';
import { getQuestionDurationMs } from '../../src/realtime/possession-state.js';
import { calculatePoints } from '../../src/realtime/scoring.js';

vi.mock('../../src/realtime/match-cache.js', () => ({
  answerCount: (cache: { answers: Record<string, unknown> }) => Object.keys(cache.answers).length,
  getCachedPlayer: (
    cache: { players: Array<{ userId: string }> },
    userId: string
  ) => cache.players.find((player) => player.userId === userId) ?? null,
  getExpectedUserIds: (cache: { players: Array<{ userId: string }> }) => cache.players.map((player) => player.userId),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  hasUserAnswered: (
    cache: { answers: Record<string, unknown> },
    userId: string
  ) => Boolean(cache.answers[userId]),
  setMatchCache: (...args: unknown[]) => setMatchCacheMock(...args),
}));

vi.mock('../../src/realtime/ai-ranked.constants.js', () => ({
  RANKED_AI_CORRECTNESS: 1,
  rankedAiMatchKey: (matchId: string) => `ranked:ai:match:${matchId}`,
}));

function createRedis(): FakeRedis {
  const values = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  return {
    isOpen: true,
    values,
    zsets,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    zAdd: vi.fn(async (key: string, entries: Array<{ score: number; value: string }>) => {
      const zset = zsets.get(key) ?? new Map<string, number>();
      for (const entry of entries) zset.set(entry.value, entry.score);
      zsets.set(key, zset);
      return entries.length;
    }),
    zRem: vi.fn(async (key: string, member: string) => zsets.get(key)?.delete(member) ? 1 : 0),
    del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
    multi(this: FakeRedis) {
      const ops: Array<() => Promise<unknown>> = [];
      const chain = {
        set: (key: string, value: string, options?: unknown) => {
          ops.push(() => this.set(key, value, options));
          return chain;
        },
        zAdd: (key: string, entries: Array<{ score: number; value: string }>) => {
          ops.push(() => this.zAdd(key, entries));
          return chain;
        },
        exec: async () => {
          const results: unknown[] = [];
          for (const op of ops) results.push(await op());
          return results;
        },
      };
      return chain;
    },
  };
}

function createCache() {
  return {
    matchId: 'm1',
    status: 'active',
    currentQIndex: 0,
    statePayload: { phase: 'NORMAL_PLAY' },
    players: [
      { userId: 'human-1', totalPoints: 0, correctAnswers: 0 },
      { userId: 'ai-1', totalPoints: 0, correctAnswers: 0 },
    ],
    currentQuestion: {
      qIndex: 0,
      kind: 'multipleChoice',
      phaseKind: 'normal',
      phaseRound: 1,
      shooterSeat: null,
      questionDTO: {
        kind: 'multipleChoice',
        options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      },
      evaluation: {
        kind: 'multipleChoice',
        correctIndex: 2,
      },
    },
    answers: {
      'human-1': { userId: 'human-1' },
    },
  };
}

describe('possession AI timer scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis = createRedis();
    redis.values.set('ranked:ai:match:m1', 'ai-1');
    getMatchMock.mockResolvedValue({ ranked_context: { aiCorrectness: 1 } });
    listMatchPlayersMock.mockResolvedValue([{ user_id: 'human-1' }, { user_id: 'ai-1' }]);
    getUserByIdMock.mockResolvedValue({ id: 'ai-1', is_ai: true });
    insertMatchAnswerIfMissingMock.mockResolvedValue(true);
    updatePlayerTotalsMock.mockResolvedValue(undefined);
  });

  it('schedules AI answers as Redis-backed realtime timers', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      getMatchCacheOrRebuildMock.mockResolvedValue(createCache());
      const { createPossessionAi } = await import('../../src/realtime/possession-ai.js');
      const ai = createPossessionAi(vi.fn());

      await ai.schedulePossessionAiAnswer({} as QuizballServer, 'm1', 0, {
        questionKind: 'multipleChoice',
        evaluation: { kind: 'multipleChoice', correctIndex: 2 },
        phaseKind: 'normal',
        phaseRound: 1,
        shooterSeat: null,
      });

      expect(redis.zAdd).toHaveBeenCalledWith(
        'realtime:timers',
        [expect.objectContaining({ value: 'possession_ai_answer:m1:0' })]
      );
      const payload = redis.values.get('realtime:timer:payload:possession_ai_answer:m1:0');
      expect(payload).toContain('"plannedAnswerTimeMs":1700');
      expect(payload).toContain('"plannedIsCorrect":true');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('clamps resumed AI answers before the resumed question deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T19:28:45.000Z'));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      getMatchCacheOrRebuildMock.mockResolvedValue(createCache());
      const { createPossessionAi } = await import('../../src/realtime/possession-ai.js');
      const ai = createPossessionAi(vi.fn());
      const playableAt = new Date(Date.now());
      const deadlineAt = new Date(Date.now() + 1500);

      await ai.schedulePossessionAiAnswer({} as QuizballServer, 'm1', 0, {
        questionKind: 'multipleChoice',
        evaluation: { kind: 'multipleChoice', correctIndex: 2 },
        phaseKind: 'normal',
        phaseRound: 1,
        shooterSeat: null,
        playableAt,
        deadlineAt,
      });

      const scheduledAt = redis.zsets.get('realtime:timers')?.get('possession_ai_answer:m1:0');
      expect(scheduledAt).toBeLessThanOrEqual(deadlineAt.getTime() - 250);
      const payload = redis.values.get('realtime:timer:payload:possession_ai_answer:m1:0');
      expect(payload).toContain('"plannedAnswerTimeMs":800');
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reloads current state before committing a due AI answer', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const cache = createCache();
      getMatchCacheOrRebuildMock.mockResolvedValue(cache);
      setMatchCacheMock.mockImplementation(async (nextCache) => {
        Object.assign(cache, nextCache);
      });
      const emit = vi.fn();
      const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
      const resolveRound = vi.fn();
      const { createPossessionAi } = await import('../../src/realtime/possession-ai.js');
      const ai = createPossessionAi(resolveRound);

      await ai.runPossessionAiAnswer(io, 'm1', 0, 2000, null);

      expect(cache.answers['ai-1']).toMatchObject({
        isCorrect: true,
        selectedIndex: 2,
        pointsEarned: expect.any(Number),
      });
      expect(setMatchCacheMock).toHaveBeenCalledWith(cache);
      expect(emit).toHaveBeenCalledWith('match:opponent_answered', expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
        selectedIndex: 2,
        isCorrect: true,
      }));
      expect(resolveRound).toHaveBeenCalledWith(io, 'm1', 0, false);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('broadcasts match:opponent_answered for a penalty answer exactly like the human handler', async () => {
    // Product decision: bots behave like humans, penalties included — the
    // human handler emits live in all phases, so the bot must too.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const cache = createCache();
      cache.statePayload = { phase: 'PENALTY_SHOOTOUT' };
      cache.currentQuestion.phaseKind = 'penalty';
      cache.currentQuestion.shooterSeat = 1;
      getMatchCacheOrRebuildMock.mockResolvedValue(cache);
      setMatchCacheMock.mockImplementation(async (nextCache) => {
        Object.assign(cache, nextCache);
      });
      const emit = vi.fn();
      const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
      const { createPossessionAi } = await import('../../src/realtime/possession-ai.js');
      const ai = createPossessionAi(vi.fn());

      await ai.runPossessionAiAnswer(io, 'm1', 0, 2000, null);

      expect(cache.answers['ai-1']).toMatchObject({ phaseKind: 'penalty', isCorrect: true });
      expect(io.to).toHaveBeenCalledWith('match:m1');
      expect(emit).toHaveBeenCalledWith('match:opponent_answered', expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
        questionKind: 'multipleChoice',
        isCorrect: true,
        selectedIndex: 2,
        pointsEarned: expect.any(Number),
        opponentTotalPoints: expect.any(Number),
      }));
    } finally {
      randomSpy.mockRestore();
    }
  });

  describe('bot time_ms charges the replica-local delay between timer fire and commit', () => {
    // Humans are scored on real elapsed time; the bot used to record its
    // PLANNED think time, so a bounded lock wait was never charged. Measuring
    // against the cache's shownAt would be wrong too: that stamp comes from
    // the dispatching replica and prod clocks skew by ~5s (see
    // possession-timing.ts). So the bot adds the delay measured on ITS OWN
    // clock between the timer firing and the commit inside the lock.
    const T0 = new Date('2026-09-17T10:00:00.000Z').getTime();
    const QUESTION_MS = getQuestionDurationMs('multipleChoice');

    async function commitWithLockDelay(lockDelayMs: number, plannedMs: number) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(T0));
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const cache = createCache();
        getMatchCacheOrRebuildMock.mockResolvedValue(cache);
        setMatchCacheMock.mockImplementation(async (nextCache) => {
          Object.assign(cache, nextCache);
        });
        // The lock is acquired inside withAnswerLock right before the commit
        // re-read; a slow acquisition advances the replica clock.
        vi.mocked(acquireLock).mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + lockDelayMs));
          return { acquired: true, token: 'lock-token' };
        });
        const io = { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as QuizballServer;
        const { createPossessionAi } = await import('../../src/realtime/possession-ai.js');
        const ai = createPossessionAi(vi.fn());
        await ai.runPossessionAiAnswer(io, 'm1', 0, plannedMs, null);
        return cache.answers['ai-1'] as { timeMs: number; pointsEarned: number; isCorrect: boolean };
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    }

    it('lock acquisition takes 300ms, planned 1500 -> time_ms 1800', async () => {
      const answer = await commitWithLockDelay(300, 1500);
      expect(answer.timeMs).toBe(1800);
      expect(answer.isCorrect).toBe(true);
      expect(answer.pointsEarned).toBe(calculatePoints(true, 1800, QUESTION_MS));
    });

    it('instant lock, planned 1500 -> time_ms 1500', async () => {
      const answer = await commitWithLockDelay(0, 1500);
      expect(answer.timeMs).toBe(1500);
      expect(answer.pointsEarned).toBe(calculatePoints(true, 1500, QUESTION_MS));
    });

    it('a delay that crosses a scoring bucket lowers pointsEarned accordingly', async () => {
      const instant = await commitWithLockDelay(0, 1500);
      const delayed = await commitWithLockDelay(1000, 1500);
      expect(delayed.timeMs).toBe(2500);
      expect(delayed.pointsEarned).toBe(calculatePoints(true, 2500, QUESTION_MS));
      expect(calculatePoints(true, 2500, QUESTION_MS)).toBeLessThan(calculatePoints(true, 1500, QUESTION_MS));
      expect(delayed.pointsEarned).toBeLessThan(instant.pointsEarned);
    });
  });

  it('waits out a briefly held round lock instead of dropping the bot answer', async () => {
    // A human answering inside the bot's commit window holds
    // `lock:match:{id}:round` for a few ms. A single NX attempt would drop
    // the bot's answer (later backfilled as wrong at timeout); the bot must
    // use the same bounded acquisition as the human path.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const cache = createCache();
      getMatchCacheOrRebuildMock.mockResolvedValue(cache);
      setMatchCacheMock.mockImplementation(async (nextCache) => {
        Object.assign(cache, nextCache);
      });
      vi.mocked(acquireLock).mockResolvedValueOnce({ acquired: false });
      const emit = vi.fn();
      const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
      const resolveRound = vi.fn();
      const { createPossessionAi } = await import('../../src/realtime/possession-ai.js');
      const ai = createPossessionAi(resolveRound);

      await ai.runPossessionAiAnswer(io, 'm1', 0, 2000, null);

      expect(vi.mocked(acquireLock).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(vi.mocked(acquireLock).mock.calls[0]?.[0]).toBe('lock:match:m1:round');
      expect(cache.answers['ai-1']).toMatchObject({ isCorrect: true, selectedIndex: 2 });
      expect(setMatchCacheMock).toHaveBeenCalledWith(cache);
      expect(releaseLock).toHaveBeenCalledWith('lock:match:m1:round', 'lock-token');
      expect(emit).toHaveBeenCalledWith('match:opponent_answered', expect.objectContaining({ selectedIndex: 2 }));
      expect(resolveRound).toHaveBeenCalledWith(io, 'm1', 0, false);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
