import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedAnswer, CachedQuestion, MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getMatchCacheOrRebuildMock = vi.fn();
const rebuildCacheFromDBMock = vi.fn();
const setMatchCacheMock = vi.fn();
const clearQuestionTimerMock = vi.fn();
const clearAiAnswerTimerMock = vi.fn();
const scheduleNextPossessionQuestionMock = vi.fn();
const emitMatchStateMock = vi.fn();
const completePossessionMatchMock = vi.fn();
const redisGetMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackPenaltyTaken: vi.fn(),
  trackPossessionPhaseEntered: vi.fn(),
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  answerCount: (cache: { answers: Record<string, unknown> }) => Object.keys(cache.answers).length,
  buildAnswerPayload: (answer: unknown) => answer,
  countdownGetFound: vi.fn(async () => []),
  deleteCountdownPlayerKeys: vi.fn(async () => undefined),
  getExpectedUserIds: (cache: { players: Array<{ userId: string }> }) =>
    cache.players.map((player) => player.userId),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  rebuildCacheFromDB: (...args: unknown[]) => rebuildCacheFromDBMock(...args),
  setMatchCache: (...args: unknown[]) => setMatchCacheMock(...args),
}));

vi.mock('../../src/realtime/possession-completion.js', () => ({
  completePossessionMatch: (...args: unknown[]) => completePossessionMatchMock(...args),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  clearAiAnswerTimer: (...args: unknown[]) => clearAiAnswerTimerMock(...args),
  ensureHalftimeCategories: vi.fn(async () => undefined),
  fireAndForget: (_label: string, work: () => Promise<void>) => {
    void work().catch(() => undefined);
  },
  scheduleHalftimeTimeout: vi.fn(),
  schedulePossessionAiHalftimeBan: vi.fn(),
}));

vi.mock('../../src/realtime/possession-question-dispatch.js', () => ({
  clearQuestionTimer: (...args: unknown[]) => clearQuestionTimerMock(...args),
  emitMatchState: (...args: unknown[]) => emitMatchStateMock(...args),
  scheduleNextPossessionQuestion: (...args: unknown[]) => scheduleNextPossessionQuestionMock(...args),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    get: (...args: unknown[]) => redisGetMock(...args),
  }),
}));

const setMatchStatePayloadMock = vi.fn(async () => undefined);
const touchMatchRoundMock = vi.fn(async () => undefined);
vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
    touchMatchRound: (...args: unknown[]) => touchMatchRoundMock(...args),
  },
}));

const insertMatchAnswerIfMissingMock = vi.fn(async () => undefined);
vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {
    insertMatchAnswerIfMissing: (...args: unknown[]) => insertMatchAnswerIfMissingMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    updatePlayerTotals: vi.fn(async () => undefined),
  },
}));

function createIo(): QuizballServer {
  return {
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as unknown as QuizballServer;
}

const MATCH_ID = 'match-penalty-1';
const Q_INDEX = 3;

function createQuestion(): CachedQuestion {
  return {
    qIndex: Q_INDEX,
    kind: 'multipleChoice',
    questionId: 'question-1',
    correctIndex: 1,
    phaseKind: 'normal',
    phaseRound: null,
    shooterSeat: null,
    attackerSeat: 1,
    shownAt: new Date(Date.now() - 10_000).toISOString(),
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    questionDTO: {
      id: 'question-1',
      type: 'multiple_choice',
      text: 'Question?',
      options: ['a', 'b', 'c', 'd'],
    } as unknown as CachedQuestion['questionDTO'],
    evaluation: { kind: 'multipleChoice', correctIndex: 1 } as CachedQuestion['evaluation'],
    reveal: { kind: 'multipleChoice', correctIndex: 1 } as unknown as CachedQuestion['reveal'],
  };
}

function createAnswer(userId: string): CachedAnswer {
  return {
    userId,
    questionKind: 'multipleChoice',
    selectedIndex: 0,
    isCorrect: false,
    timeMs: 4_000,
    pointsEarned: 0,
    phaseKind: 'normal',
    phaseRound: null,
    shooterSeat: null,
    answeredAt: new Date().toISOString(),
  };
}

function createCache(overrides: Partial<MatchCache> = {}): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  return {
    matchId: MATCH_ID,
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
    currentQIndex: Q_INDEX,
    statePayload: state,
    currentQuestion: createQuestion(),
    answers: {},
    ...overrides,
  };
}

async function resolveRound(fromTimeout = false): Promise<void> {
  const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');
  await resolvePossessionRound(createIo(), MATCH_ID, Q_INDEX, fromTimeout);
}

describe('possession round resolver durable-timer survival (penalty-freeze regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(true);
    redisGetMock.mockResolvedValue(null);
    rebuildCacheFromDBMock.mockResolvedValue(null);
  });

  it('leaves timers armed when waiting for more answers (the flapping freeze window)', async () => {
    // One of two expected answers committed: the durable timeout timer is the
    // ONLY mechanism that can still resolve this round if the second answer
    // never arrives. It must survive the no-op resolve.
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({ answers: { 'user-1': createAnswer('user-1') } })
    );

    await resolveRound(false);

    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
    expect(clearAiAnswerTimerMock).not.toHaveBeenCalled();
  });

  it('leaves timers armed when the match is paused', async () => {
    redisGetMock.mockResolvedValue(String(Date.now()));
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({ answers: { 'user-1': createAnswer('user-1') } })
    );

    await resolveRound(false);

    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
    expect(clearAiAnswerTimerMock).not.toHaveBeenCalled();
  });

  it('leaves timers armed when the cache is missing (transient failure)', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(null);

    await resolveRound(false);

    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
    expect(clearAiAnswerTimerMock).not.toHaveBeenCalled();
  });

  it('clears timers when the round actually resolves', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({
        answers: {
          'user-1': createAnswer('user-1'),
          'user-2': createAnswer('user-2'),
        },
      })
    );

    await resolveRound(false);

    expect(setMatchCacheMock).toHaveBeenCalled();
    expect(clearQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
    expect(clearAiAnswerTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
  });

  it('clears stale timers when the round already advanced past this qIndex', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(createCache({ currentQIndex: Q_INDEX + 1 }));

    await resolveRound(false);

    expect(clearQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
    expect(clearAiAnswerTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
  });

  it('clears timers when the match is terminally completed', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(createCache({ status: 'completed' }));

    await resolveRound(false);

    expect(clearQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
    expect(clearAiAnswerTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
  });

  it('leaves timers armed when resolution throws before the round result is committed', async () => {
    // An exception mid-resolution must not kill the fallback timer either:
    // the durable timer retries the resolve (lock-guarded) later.
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({
        answers: {
          'user-1': createAnswer('user-1'),
          'user-2': createAnswer('user-2'),
        },
      })
    );
    setMatchCacheMock.mockRejectedValueOnce(new Error('redis write failed'));

    await expect(resolveRound(false)).rejects.toThrow('redis write failed');

    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
    expect(clearAiAnswerTimerMock).not.toHaveBeenCalled();
  });

  it('routine no-goal normal round only touches the q-index heartbeat (state checkpoint skipped)', async () => {
    // db-optimize.md #7 checkpoint policy: a NORMAL_PLAY round with no goal
    // and no phase/half change must NOT rewrite the full state_payload JSONB.
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({
        answers: {
          'user-1': createAnswer('user-1'),
          'user-2': createAnswer('user-2'),
        },
      })
    );

    await resolveRound(false);

    expect(setMatchCacheMock).toHaveBeenCalled();
    expect(touchMatchRoundMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX + 1);
    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
  });

  it('checkpoints the full state when the round crosses a phase boundary (halftime)', async () => {
    const cache = createCache({
      answers: {
        'user-1': createAnswer('user-1'),
        'user-2': createAnswer('user-2'),
      },
    });
    // Last normal question of the half: resolution flips phase to HALFTIME.
    cache.statePayload.normalQuestionsAnsweredInHalf = cache.statePayload.normalQuestionsPerHalf - 1;
    cache.statePayload.normalQuestionsAnsweredTotal = cache.statePayload.normalQuestionsPerHalf - 1;
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await resolveRound(false);

    expect(setMatchStatePayloadMock).toHaveBeenCalled();
    expect(touchMatchRoundMock).not.toHaveBeenCalled();
  });

  it('timeout resolve with one missing answer backfills and still resolves the round', async () => {
    // The durable timer firing must conclude a half-answered round (this is
    // the fallback the freeze fix protects).
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({ answers: { 'user-1': createAnswer('user-1') } })
    );

    await resolveRound(true);

    expect(setMatchCacheMock).toHaveBeenCalled();
    expect(clearQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
  });
});

// G1/G2: the timeout backfill and per-player countdown read must stay isolated
// per question KIND and per USER. A putInOrder timeout backfill must not carry a
// countdown's foundAnswerIds (and vice versa), and each player's countdown
// found-set must come from their OWN per-user key — never bleed into the other
// seat or into a following put_in_order answer. These shape rules are what keep
// a mid-match disconnect from corrupting the next round's scoring.
describe('possession round resolver timeout backfill kind/user isolation', () => {
  function putInOrderQuestion(): CachedQuestion {
    return {
      ...createQuestion(),
      kind: 'putInOrder',
      evaluation: {
        kind: 'putInOrder',
        direction: 'asc',
        items: [
          { id: 'i1', label: { en: 'A' }, sortValue: 1 },
          { id: 'i2', label: { en: 'B' }, sortValue: 2 },
        ],
      } as unknown as CachedQuestion['evaluation'],
    };
  }

  function countdownQuestion(): CachedQuestion {
    return {
      ...createQuestion(),
      kind: 'countdown',
      evaluation: {
        kind: 'countdown',
        answerGroups: [
          { id: 'g1', displays: ['x'], accepted: ['x'] },
          { id: 'g2', displays: ['y'], accepted: ['y'] },
          { id: 'g3', displays: ['z'], accepted: ['z'] },
        ],
      } as unknown as CachedQuestion['evaluation'],
    };
  }

  // The resolver clears cache.answers right before committing, so the resolved
  // answer SHAPE is observed at the persistence seam (insertMatchAnswerIfMissing).
  // The first persisted call per user is the backfilled/scored answer; we read
  // its kind-specific fields (submittedOrderIds / foundAnswerIds) to prove no
  // cross-kind or cross-seat bleed.
  type PersistArg = { userId: string; answerPayload?: Record<string, unknown> };
  function persistedFor(userId: string): Record<string, unknown> | undefined {
    const call = insertMatchAnswerIfMissingMock.mock.calls.find(
      (args) => (args[0] as PersistArg).userId === userId
    );
    return (call?.[0] as PersistArg | undefined)?.answerPayload;
  }
  async function flushFireAndForget(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(true);
    redisGetMock.mockResolvedValue(null);
    rebuildCacheFromDBMock.mockResolvedValue(null);
  });

  it('G1: a put_in_order timeout backfill carries submittedOrderIds, not countdown found-ids', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({ currentQuestion: putInOrderQuestion(), answers: {} })
    );

    await resolveRound(true);
    await flushFireAndForget();

    for (const userId of ['user-1', 'user-2']) {
      const payload = persistedFor(userId);
      expect(payload, `${userId} persisted`).toBeDefined();
      // put_in_order backfill records an (empty) submitted order...
      expect(payload?.submittedOrderIds).toEqual([]);
      // ...and must NOT borrow the countdown shape (never an array of found ids).
      expect(payload?.foundAnswerIds == null).toBe(true);
    }
  });

  it('G2: each seat resolves from its OWN countdown found-set (no cross-seat leak)', async () => {
    // Distinct per-user found-sets: seat 1 found 2, seat 2 found 0.
    const { countdownGetFound } = await import('../../src/realtime/match-cache.js');
    (countdownGetFound as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_matchId: string, userId: string) => (userId === 'user-1' ? ['g1', 'g2'] : [])
    );
    getMatchCacheOrRebuildMock.mockResolvedValue(
      createCache({ currentQuestion: countdownQuestion(), answers: {} })
    );

    await resolveRound(true);
    await flushFireAndForget();

    const p1 = persistedFor('user-1');
    const p2 = persistedFor('user-2');
    // The crux: each seat's found-set is its OWN — seat 1's two finds never
    // bleed into seat 2, and vice versa.
    expect(p1?.foundAnswerIds).toEqual(['g1', 'g2']);
    expect(p2?.foundAnswerIds).toEqual([]);
    // Countdown answers must never carry the put_in_order shape.
    expect(p1?.submittedOrderIds == null).toBe(true);
    expect(p2?.submittedOrderIds == null).toBe(true);
  });
});
