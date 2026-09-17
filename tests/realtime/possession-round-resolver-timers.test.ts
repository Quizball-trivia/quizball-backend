import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedAnswer, CachedQuestion, MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const acquireLockMock = vi.fn();
const extendLockMock = vi.fn();
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
const redisValues = new Map<string, string>();
const redisSetMock = vi.fn();
const redisDelMock = vi.fn();
const sendQuestionMock = vi.fn();
const deferQuestionTimerMock = vi.fn();
const getMatchMock = vi.fn();
const deleteCountdownPlayerKeysMock = vi.fn(async () => undefined);
const updatePlayerTotalsMock = vi.fn(async () => undefined);

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
  extendLock: (...args: unknown[]) => extendLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  answerCount: (cache: { answers: Record<string, unknown> }) => Object.keys(cache.answers).length,
  buildAnswerPayload: (answer: unknown) => answer,
  countdownGetFound: vi.fn(async () => []),
  deleteCountdownPlayerKeys: (...args: unknown[]) => deleteCountdownPlayerKeysMock(...args),
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
  sendPossessionMatchQuestion: (...args: unknown[]) => sendQuestionMock(...args),
  deferQuestionTimer: (...args: unknown[]) => deferQuestionTimerMock(...args),
  clearQuestionTimer: (...args: unknown[]) => clearQuestionTimerMock(...args),
  emitMatchState: (...args: unknown[]) => emitMatchStateMock(...args),
  scheduleNextPossessionQuestion: (...args: unknown[]) => scheduleNextPossessionQuestionMock(...args),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    get: (...args: unknown[]) => redisGetMock(...args),
    set: (...args: unknown[]) => redisSetMock(...args),
    del: (...args: unknown[]) => redisDelMock(...args),
  }),
}));

const setMatchStatePayloadMock = vi.fn(async () => undefined);
const touchMatchRoundMock = vi.fn(async () => undefined);
vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
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
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
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

const FENCE_KEY = `resolve:inprogress:${MATCH_ID}:${Q_INDEX}`;

function installFenceRedis(): void {
  redisValues.clear();
  // releaseLock is the compare-and-delete helper (Lua: delete only if the
  // stored value equals the caller's token); mirror it over the fence map.
  releaseLockMock.mockImplementation(async (key: string, token: string) => {
    if (redisValues.get(key) === token) { redisValues.delete(key); return true; }
    return false;
  });
  redisSetMock.mockImplementation(async (key: string, value: string, options?: { NX?: boolean; PX?: number; EX?: number }) => {
    if (options?.NX && redisValues.has(key)) return null;
    redisValues.set(key, value);
    return 'OK';
  });
  redisDelMock.mockImplementation(async (keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    let n = 0;
    for (const key of list) if (redisValues.delete(key)) n += 1;
    return n;
  });
}

// Every describe gets a fresh, deterministic fence redis (SET NX / DEL over a map).
beforeEach(() => {
  installFenceRedis();
});

describe('possession round resolver durable-timer survival (penalty-freeze regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    redisGetMock.mockResolvedValue(null);
    rebuildCacheFromDBMock.mockResolvedValue(null);
    getMatchMock.mockResolvedValue({ status: 'active' });
  });

  it('redispatches a missing ranked last-attack question without replacing its new deadline', async () => {
    const cache = createCache({ mode: 'ranked', currentQuestion: null });
    cache.statePayload.phase = 'LAST_ATTACK';
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    sendQuestionMock.mockResolvedValue({ correctIndex: 1 });
    await resolveRound(true);
    expect(sendQuestionMock).toHaveBeenCalledWith(expect.anything(), MATCH_ID, Q_INDEX);
    expect(deferQuestionTimerMock).not.toHaveBeenCalled();
    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
  });

  it('clears the old timer when missing-question recovery cancels the match', async () => {
    const cache = createCache({ mode: 'ranked', currentQuestion: null });
    cache.statePayload.phase = 'LAST_ATTACK';
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    sendQuestionMock.mockResolvedValue(null);
    getMatchMock.mockResolvedValue({ status: 'abandoned' });
    await resolveRound(true);
    expect(clearQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
    expect(deferQuestionTimerMock).not.toHaveBeenCalled();
  });

  it('keeps recovery armed if redispatch is paused or a finalization lock is busy', async () => {
    const cache = createCache({ mode: 'ranked', currentQuestion: null });
    cache.statePayload.phase = 'LAST_ATTACK';
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    sendQuestionMock.mockResolvedValue(null);
    await resolveRound(true);
    expect(deferQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX, 5000);
    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
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
describe('possession round resolver lease loss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    redisGetMock.mockResolvedValue(null);
    rebuildCacheFromDBMock.mockResolvedValue(null);
    getMatchMock.mockResolvedValue({ status: 'active' });
    installFenceRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts before any cache write, DB persist or publish once extendLock reports the lease lost', async () => {
    vi.useFakeTimers();
    extendLockMock.mockResolvedValue(false);
    const cache = createCache({
      answers: { 'user-1': createAnswer('user-1'), 'user-2': createAnswer('user-2') },
    });
    // While the resolver waits for the cache read, the renewal interval fires
    // and the lease is reported lost.
    getMatchCacheOrRebuildMock.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      return cache;
    });
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(io, MATCH_ID, Q_INDEX, true);

    expect(extendLockMock).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('match:round_result', expect.anything());
    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
    expect(touchMatchRoundMock).not.toHaveBeenCalled();
    expect(emitMatchStateMock).not.toHaveBeenCalled();
    expect(scheduleNextPossessionQuestionMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalled();
    // Not concluded: the round keeps its timers so a fresh resolve retries.
    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
    expect(deferQuestionTimerMock).toHaveBeenCalled();
    // (d) the in-progress fence never outlives a pre-side-effect abort.
    expect(redisValues.has(FENCE_KEY)).toBe(false);
  });

  it('lease lost AFTER the first mutating side effect (countdown keys deleted): the round still commits, once', async () => {
    // Aborting after deleteCountdownPlayerKeys / the non-MCQ totals increment
    // would leave a retry with no countdown answers and double-incremented
    // totals. Past the first side effect the round is committed-in-progress.
    vi.useFakeTimers();
    extendLockMock.mockResolvedValue(false);
    const cache = createCache({
      currentQuestion: {
        ...createQuestion(),
        kind: 'countdown',
        evaluation: {
          kind: 'countdown',
          answerGroups: [
            { id: 'g1', displays: ['x'], accepted: ['x'] },
            { id: 'g2', displays: ['y'], accepted: ['y'] },
          ],
        } as unknown as CachedQuestion['evaluation'],
      },
      answers: {},
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    // The renewal interval fires (and reports the lease lost) while the
    // countdown keys are being deleted — i.e. after the first side effect.
    deleteCountdownPlayerKeysMock.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(io, MATCH_ID, Q_INDEX, true);
    await Promise.resolve(); await Promise.resolve();

    expect(deleteCountdownPlayerKeysMock).toHaveBeenCalledTimes(1);
    expect(extendLockMock).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('match:round_result', expect.objectContaining({ qIndex: Q_INDEX }));
    expect(setMatchCacheMock).toHaveBeenCalledWith(cache);
    expect(cache.currentQIndex).toBe(Q_INDEX + 1);
    // Each player's totals were applied exactly once.
    const totalsCalls = updatePlayerTotalsMock.mock.calls.map((call) => call[1]);
    expect(totalsCalls.sort()).toEqual(['user-1', 'user-2']);
    expect(scheduleNextPossessionQuestionMock).toHaveBeenCalled();
    // Concluded: no retry is armed, the round's timers are cleared.
    expect(clearQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX);
    expect(deferQuestionTimerMock).not.toHaveBeenCalled();
    // (c) the fence was taken for the commit and cleared afterwards.
    expect(redisSetMock).toHaveBeenCalledWith(FENCE_KEY, expect.any(String), expect.objectContaining({ NX: true }));
    expect(redisValues.has(FENCE_KEY)).toBe(false);
  });
});

describe('possession round resolver in-progress fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    redisGetMock.mockResolvedValue(null);
    rebuildCacheFromDBMock.mockResolvedValue(null);
    getMatchMock.mockResolvedValue({ status: 'active' });
    installFenceRedis();
  });

  it('(a) marker already present (another holder mid-resolve): no-ops with no side effects and re-arms the timeout', async () => {
    redisValues.set(FENCE_KEY, 'other-replica');
    const cache = createCache({
      answers: { 'user-1': createAnswer('user-1'), 'user-2': createAnswer('user-2') },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(io, MATCH_ID, Q_INDEX, true);

    expect(emit).not.toHaveBeenCalledWith('match:round_result', expect.anything());
    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(updatePlayerTotalsMock).not.toHaveBeenCalled();
    expect(deleteCountdownPlayerKeysMock).not.toHaveBeenCalled();
    expect(cache.currentQIndex).toBe(Q_INDEX);
    expect(deferQuestionTimerMock).toHaveBeenCalledWith(MATCH_ID, Q_INDEX, expect.any(Number));
    expect(clearQuestionTimerMock).not.toHaveBeenCalled();
    // The other holder's marker is left alone.
    expect(redisValues.get(FENCE_KEY)).toBe('other-replica');
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it('(b) a normal resolve SETs the marker NX with a TTL before the first side effect and clears it after the cache commit', async () => {
    const cache = createCache({
      answers: { 'user-1': createAnswer('user-1'), 'user-2': createAnswer('user-2') },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    let fencePresentAtCommit: boolean | null = null;
    setMatchCacheMock.mockImplementation(async () => {
      fencePresentAtCommit = redisValues.has(FENCE_KEY);
    });
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(io, MATCH_ID, Q_INDEX, false);

    const setCall = redisSetMock.mock.calls.find((call) => call[0] === FENCE_KEY);
    expect(setCall).toBeDefined();
    const options = setCall![2] as { NX?: boolean; PX?: number; EX?: number };
    expect(options.NX).toBe(true);
    const ttlMs = options.PX ?? (options.EX ?? 0) * 1000;
    expect(ttlMs).toBeGreaterThanOrEqual(10_000);
    expect(ttlMs).toBeLessThanOrEqual(60_000);
    expect(emit).toHaveBeenCalledWith('match:round_result', expect.anything());
    expect(fencePresentAtCommit).toBe(true);
    expect(releaseLockMock).toHaveBeenCalledWith(FENCE_KEY, 'lock-token');
    expect(redisDelMock).not.toHaveBeenCalledWith(FENCE_KEY);
    expect(redisValues.has(FENCE_KEY)).toBe(false);
  });

  it('acquires the fence right after the round lock — BEFORE the cache-refresh write and the redispatch', async () => {
    // No write of any kind may precede the fence: a competitor mid-resolve
    // must be observed before this resolver touches the cache or dispatches.
    redisValues.set(FENCE_KEY, 'other-replica');
    const cache = createCache({ currentQIndex: Q_INDEX - 1, currentQuestion: null });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const rebuilt = createCache({ mode: 'ranked', currentQuestion: null });
    rebuilt.statePayload.phase = 'LAST_ATTACK';
    rebuildCacheFromDBMock.mockResolvedValue(rebuilt);
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(createIo(), MATCH_ID, Q_INDEX, true);

    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(sendQuestionMock).not.toHaveBeenCalled();
    expect(redisSetMock).toHaveBeenCalledWith(FENCE_KEY, expect.any(String), expect.objectContaining({ NX: true }));
    expect(redisValues.get(FENCE_KEY)).toBe('other-replica');
    expect(deferQuestionTimerMock).toHaveBeenCalled();
  });

  it('orders the fence SET before every write on the happy path (cache refresh included)', async () => {
    const order: string[] = [];
    redisSetMock.mockImplementation(async (key: string, value: string, options?: { NX?: boolean }) => {
      order.push(`set:${key}`);
      if (options?.NX && redisValues.has(key)) return null;
      redisValues.set(key, value);
      return 'OK';
    });
    setMatchCacheMock.mockImplementation(async () => { order.push('setMatchCache'); });
    const cache = createCache({ currentQIndex: Q_INDEX - 1, currentQuestion: null });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    rebuildCacheFromDBMock.mockResolvedValue(createCache({
      answers: { 'user-1': createAnswer('user-1'), 'user-2': createAnswer('user-2') },
    }));
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(createIo(), MATCH_ID, Q_INDEX, true);

    expect(order.indexOf(`set:${FENCE_KEY}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`set:${FENCE_KEY}`)).toBeLessThan(order.indexOf('setMatchCache'));
  });

  it('releases the fence with a token check: holder A\'s expired fence re-taken by B is NOT deleted by A', async () => {
    // releaseLock is the compare-and-delete helper (Lua: delete only if the
    // value matches). The mock mirrors that over the fence map.
    const cache = createCache({
      answers: { 'user-1': createAnswer('user-1'), 'user-2': createAnswer('user-2') },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    // A's marker expires and B takes a fresh one while A is committing.
    setMatchCacheMock.mockImplementationOnce(async () => {
      redisValues.set(FENCE_KEY, 'holder-b-token');
    });
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(createIo(), MATCH_ID, Q_INDEX, false);

    expect(releaseLockMock).toHaveBeenCalledWith(FENCE_KEY, 'lock-token');
    expect(redisDelMock).not.toHaveBeenCalledWith(FENCE_KEY);
    expect(redisDelMock).not.toHaveBeenCalledWith([FENCE_KEY]);
    expect(redisValues.get(FENCE_KEY)).toBe('holder-b-token');
  });

  it('a stale marker never blocks resolution: the SET NX is the only gate, so an expired key lets the next resolve through', async () => {
    // Simulate TTL expiry: the previous holder crashed, Redis dropped the key.
    redisValues.set(FENCE_KEY, 'crashed-replica');
    redisValues.delete(FENCE_KEY);
    const cache = createCache({
      answers: { 'user-1': createAnswer('user-1'), 'user-2': createAnswer('user-2') },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
    const { resolvePossessionRound } = await import('../../src/realtime/possession-round-resolver.js');

    await resolvePossessionRound(io, MATCH_ID, Q_INDEX, true);

    expect(emit).toHaveBeenCalledWith('match:round_result', expect.anything());
    expect(redisValues.has(FENCE_KEY)).toBe(false);
  });
});

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
