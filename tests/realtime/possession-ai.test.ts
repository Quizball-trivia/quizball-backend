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
};

let redis: FakeRedis;

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    insertMatchAnswerIfMissing: (...args: unknown[]) => insertMatchAnswerIfMissingMock(...args),
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
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
  releaseLock: vi.fn(async () => true),
}));

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
      expect(redis.values.get('realtime:timer:payload:possession_ai_answer:m1:0')).toContain('"plannedAnswerTimeMs":2000');
    } finally {
      randomSpy.mockRestore();
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
});
