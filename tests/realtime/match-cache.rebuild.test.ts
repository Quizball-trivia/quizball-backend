import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisGetMock = vi.fn();
const redisSetMock = vi.fn();
const redisDelMock = vi.fn();
const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const buildMatchQuestionPayloadMock = vi.fn();

vi.mock('../../src/core/tracing.js', () => ({
  withSpan: async (_name: string, _attrs: Record<string, unknown>, work: (span: { setAttribute: (key: string, value: unknown) => void }) => Promise<unknown>) =>
    work({ setAttribute: vi.fn() }),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/core/metrics.js', () => ({
  appMetrics: {
    cacheRebuilds: { add: vi.fn() },
    questionGenerationDuration: { record: vi.fn() },
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    get: (...args: unknown[]) => redisGetMock(...args),
    set: (...args: unknown[]) => redisSetMock(...args),
    del: (...args: unknown[]) => redisDelMock(...args),
  }),
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    getMatchQuestionTiming: vi.fn(),
    listAnswersForQuestion: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  POSSESSION_QUESTIONS_PER_HALF: 6,
  createInitialPossessionState: (variant = 'friendly_possession') => ({
    version: 1,
    variant,
    half: 1,
    phase: 'NORMAL_PLAY',
    goals: { seat1: 0, seat2: 0 },
    penaltyGoals: { seat1: 0, seat2: 0 },
    possessionDiff: 0,
    kickOffSeat: 1,
    normalQuestionsPerHalf: 6,
    normalQuestionsAnsweredInHalf: 0,
    normalQuestionsAnsweredTotal: 0,
    halftime: {
      deadlineAt: null,
      categoryOptions: [],
      firstHalfShownCategoryIds: [],
      firstBanSeat: null,
      bans: { seat1: null, seat2: null },
    },
    lastAttack: { attackerSeat: null },
    penalty: {
      round: 0,
      shooterSeat: 1,
      suddenDeath: false,
      kicksTaken: { seat1: 0, seat2: 0 },
    },
    currentQuestion: null,
    winnerDecisionMethod: null,
  }),
  matchesService: {
    buildMatchQuestionPayload: (...args: unknown[]) => buildMatchQuestionPayloadMock(...args),
  },
}));

describe('match-cache rebuild locking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSetMock.mockResolvedValue('OK');
    redisDelMock.mockResolvedValue(1);
    releaseLockMock.mockResolvedValue(true);
    buildMatchQuestionPayloadMock.mockResolvedValue(null);
    getMatchMock.mockResolvedValue({
      id: 'm1',
      status: 'active',
      mode: 'ranked',
      total_questions: 12,
      category_a_id: 'cat-a',
      category_b_id: 'cat-b',
      started_at: new Date().toISOString(),
      current_q_index: 0,
      state_payload: {},
    });
    listMatchPlayersMock.mockResolvedValue([
      {
        user_id: 'u1',
        seat: 1,
        total_points: 0,
        correct_answers: 0,
        goals: 0,
        penalty_goals: 0,
        avg_time_ms: null,
      },
      {
        user_id: 'u2',
        seat: 2,
        total_points: 0,
        correct_answers: 0,
        goals: 0,
        penalty_goals: 0,
        avg_time_ms: null,
      },
    ]);
  });

  it('reuses cache from a retry when another worker owns the rebuild lock', async () => {
    const cached = {
      matchId: 'm1',
      status: 'active',
      mode: 'ranked',
      totalQuestions: 12,
      categoryAId: 'cat-a',
      categoryBId: 'cat-b',
      startedAt: new Date().toISOString(),
      players: [],
      currentQIndex: 0,
      statePayload: { variant: 'ranked_sim' },
      currentQuestion: null,
      answers: {},
      chanceCardUses: {},
    };
    redisGetMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(cached));
    acquireLockMock.mockResolvedValue({ acquired: false });

    const { getMatchCacheOrRebuild } = await import('../../src/realtime/match-cache.js');
    const result = await getMatchCacheOrRebuild('m1');

    expect(result?.matchId).toBe('m1');
    expect(acquireLockMock).toHaveBeenCalledWith('match:cache:rebuild:m1', 5000);
    expect(getMatchMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('rebuilds once under the cache rebuild lock and releases it', async () => {
    redisGetMock.mockResolvedValue(null);
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });

    const { getMatchCacheOrRebuild, matchCacheKey } = await import('../../src/realtime/match-cache.js');
    const result = await getMatchCacheOrRebuild('m1');

    expect(result?.matchId).toBe('m1');
    expect(getMatchMock).toHaveBeenCalledWith('m1');
    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledWith(
      matchCacheKey('m1'),
      expect.any(String),
      expect.objectContaining({ EX: 3600 })
    );
    expect(releaseLockMock).toHaveBeenCalledWith('match:cache:rebuild:m1', 'lock-token');
  });
});
