import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getMatchCacheOrRebuildMock = vi.fn();
const getMatchMock = vi.fn();
const getRecentlySeenQuestionIdsMock = vi.fn();
const getRandomQuestionCandidatesForMatchMock = vi.fn();
const insertMatchQuestionIfMissingMock = vi.fn();
const getMatchQuestionMock = vi.fn(async () => null as unknown);

// Unit test: no database. Stray reads (bookkeeping around the send) return nothing.
vi.mock('../../src/db/index.js', () => {
  const sql = Object.assign(vi.fn(async () => []), { begin: vi.fn(), unsafe: vi.fn(async () => []), json: (v: unknown) => v, array: (v: unknown) => v });
  return { sql, default: sql };
});
const releaseMock = vi.fn(async () => true);
vi.mock('../../src/realtime/locks.js', () => ({ releaseLock: (...a: unknown[]) => releaseMock(...(a as [])), acquireLock: vi.fn(), extendLock: vi.fn() }));
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
    getRecentlySeenQuestionIds: (...args: unknown[]) => getRecentlySeenQuestionIdsMock(...args),
    getRandomQuestionCandidatesForMatch: (...args: unknown[]) => getRandomQuestionCandidatesForMatchMock(...args),
    getRandomImageMcqCandidatesForMatch: vi.fn(async () => []),
    getMatchQuestion: (...args: unknown[]) => getMatchQuestionMock(...args),
    getImageMcqCandidateForMatchById: vi.fn(async () => []),
    insertMatchQuestionIfMissing: (...args: unknown[]) => insertMatchQuestionIfMissingMock(...args),
    setQuestionTiming: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    touchMatchRound: vi.fn(),
    setMatchStatePayload: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return {
    ...actual,
    matchesService: { buildMatchQuestionPayload: vi.fn() },
  };
});

const setMatchCacheMock = vi.fn(async () => undefined);
vi.mock('../../src/realtime/match-cache.js', () => ({
  countdownGetFound: vi.fn(async () => []),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  setMatchCache: (...args: unknown[]) => setMatchCacheMock(...(args as [])),
}));
vi.mock('../../src/realtime/question-compat.js', async (orig) => ({
  ...(await orig<object>()),
  normalizeMatchQuestionPayload: () => ({
    question: { id: 'q-mcq', kind: 'multipleChoice', prompt: { en: 'Q' }, options: [{ id: 'a', text: { en: 'A' } }, { id: 'b', text: { en: 'B' } }] },
    evaluation: { kind: 'multipleChoice', correctIndex: 0 },
    reveal: { kind: 'multipleChoice', correctIndex: 0 },
  }),
  getMultipleChoiceCorrectIndexFromPayload: () => 0,
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  cancelRealtimeTimer: vi.fn(async () => undefined),
  hasPendingRealtimeTimer: vi.fn(async () => false),
  scheduleRealtimeTimer: vi.fn(async () => undefined),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  ensureHalftimeCategories: vi.fn(),
  fireAndForget: vi.fn(),
  resolveAiUserIdForMatch: vi.fn(async () => null),
  resolvePossessionRound: vi.fn(),
  scheduleHalftimeTimeout: vi.fn(async () => undefined),
  schedulePossessionAiAnswer: vi.fn(async () => undefined),
  schedulePossessionAiHalftimeBan: vi.fn(async () => undefined),
}));

const redisSet = vi.fn(async () => 'OK' as string | null);
const redisDel = vi.fn(async () => 1);
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isOpen: true, get: vi.fn(async () => null), set: (...a: unknown[]) => redisSet(...(a as [])), del: (...a: unknown[]) => redisDel(...(a as [])) }),
}));

vi.mock('../../src/realtime/services/dev-realtime.service.js', () => ({
  checkDevPauseAndDefer: vi.fn(async () => false),
}));

vi.mock('../../src/realtime/services/match-entry.service.js', () => ({
  markMatchEnteredForRoom: vi.fn(async () => undefined),
  markMatchEnteredForSocket: vi.fn(),
}));

function createCache(): MatchCache {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'NORMAL_PLAY';
  state.normalQuestionsAnsweredInHalf = 4;
  return {
    matchId: 'match-exhausted-special',
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
    currentQIndex: 4,
    statePayload: state,
    currentQuestion: null,
    answers: {},
  };
}

function createIo() {
  const emit = vi.fn();
  return { io: { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer, emit };
}

const questionEmitted = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.some(([event]) => event === 'match:question');

// One publication per question (Astra v3): transition sends (live wait, durable backup, recovery) publish only if no
// other path already sent the question; deliberate re-sends mark it too; a failed commit unmarks it for the retry.
describe('possession question sent mark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMatchMock.mockResolvedValue({ status: 'active' });
    getRecentlySeenQuestionIdsMock.mockResolvedValue([]);
    insertMatchQuestionIfMissingMock.mockResolvedValue(true);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { questionTypes: string[] }) => (
      params.questionTypes[0] === 'mcq_single'
        ? [{
          id: 'q-mcq', category_id: 'category-a',
          payload: { type: 'mcq_single', options: [
            { id: 'a', text: { en: 'A' }, is_correct: true }, { id: 'b', text: { en: 'B' }, is_correct: false },
            { id: 'c', text: { en: 'C' }, is_correct: false }, { id: 'd', text: { en: 'D' }, is_correct: false },
          ] },
        }]
        : []
    ));
    redisSet.mockResolvedValue('OK');
    setMatchCacheMock.mockResolvedValue(undefined);
  });

  async function send(onlyIfUnsent?: boolean) {
    const cache = createCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { io, emit } = createIo();
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    const result = await sendPossessionMatchQuestion(io, cache.matchId, 4, onlyIfUnsent ? { onlyIfUnsent: true } : undefined);
    return { result, emit };
  }

  it('a transition send publishes once: it takes the mark only if unset', async () => {
    const { emit } = await send(true);
    expect(redisSet).toHaveBeenCalledWith('possession:sent:match-exhausted-special:4', expect.any(String), { NX: true, EX: 30 });
    expect(setMatchCacheMock).toHaveBeenCalled();
    expect(questionEmitted(emit)).toBe(true);
  });

  it('a transition send arriving after another path sent the question changes nothing', async () => {
    redisSet.mockResolvedValue(null);
    const { result, emit } = await send(true);
    expect(result).toBeNull();
    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(questionEmitted(emit)).toBe(false);
  });

  it('a deliberate re-send (resume, halftime, start) overwrites the mark and publishes', async () => {
    const { emit } = await send(false);
    expect(redisSet).toHaveBeenCalledWith('possession:sent:match-exhausted-special:4', expect.any(String), { EX: 30 });
    expect(questionEmitted(emit)).toBe(true);
  });

  it('a failed commit removes the mark so the retry can still send (Codex P1-1)', async () => {
    setMatchCacheMock.mockRejectedValueOnce(new Error('redis write failed'));
    await expect(send(true)).rejects.toThrow('redis write failed');
    // Owner-only release: the token this send wrote, never another send's mark.
    expect(releaseMock).toHaveBeenCalledWith('possession:sent:match-exhausted-special:4', redisSet.mock.calls[0]![1]);
  });

  it('reuses a question another send already stored instead of declaring the pool exhausted (Astra v4 P1-3)', async () => {
    getRandomQuestionCandidatesForMatchMock.mockResolvedValue([]);
    getMatchQuestionMock.mockResolvedValue({ question_id: 'stored-q', category_id: 'category-a', correct_index: 2 });
    insertMatchQuestionIfMissingMock.mockResolvedValue(false);
    const { emit } = await send(true);
    expect(insertMatchQuestionIfMissingMock).toHaveBeenCalledWith(expect.objectContaining({ qIndex: 4, questionId: 'stored-q' }));
    expect(questionEmitted(emit)).toBe(true);
  });

  it('a transition send that stalled past the mark re-checks the live match and does not rewind it (Astra v5 P2)', async () => {
    const snapshot = createCache();
    const live = { ...createCache(), currentQIndex: 5, currentQuestion: { qIndex: 5 } };
    getMatchCacheOrRebuildMock.mockResolvedValueOnce(snapshot).mockResolvedValue(live);
    const { io, emit } = createIo();
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await expect(sendPossessionMatchQuestion(io, snapshot.matchId, 4, { onlyIfUnsent: true })).resolves.toBeNull();
    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(questionEmitted(emit)).toBe(false);
  });

  it('releases the mark when the live state cannot be read, so the retry is not held off', async () => {
    const snapshot = createCache();
    getMatchCacheOrRebuildMock.mockResolvedValueOnce(snapshot).mockResolvedValue(null);
    const { io, emit } = createIo();
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    await expect(sendPossessionMatchQuestion(io, snapshot.matchId, 4, { onlyIfUnsent: true })).resolves.toBeNull();
    // Owner-only release: the token this send wrote, never another send's mark.
    expect(releaseMock).toHaveBeenCalledWith('possession:sent:match-exhausted-special:4', redisSet.mock.calls[0]![1]);
    expect(questionEmitted(emit)).toBe(false);
  });
});

// Codex review of #790: the real cache writer (not a rejecting mock) must make a failed commit a failed send.
describe('real Redis cache-write failure during question dispatch', () => {
  it('does not publish the question or replace its backup when the authoritative cache write fails', async () => {
    vi.clearAllMocks();
    getMatchMock.mockResolvedValue({ status: 'active' });
    getRecentlySeenQuestionIdsMock.mockResolvedValue([]);
    insertMatchQuestionIfMissingMock.mockResolvedValue(true);
    getRandomQuestionCandidatesForMatchMock.mockImplementation(async (params: { questionTypes: string[] }) => (
      params.questionTypes[0] === 'mcq_single' ? [{ id: 'q-mcq', category_id: 'category-a', payload: {
        type: 'mcq_single', options: [
          { id: 'a', text: { en: 'A' }, is_correct: true }, { id: 'b', text: { en: 'B' }, is_correct: false },
          { id: 'c', text: { en: 'C' }, is_correct: false }, { id: 'd', text: { en: 'D' }, is_correct: false },
        ],
      } }] : []
    ));
    // The sent mark succeeds; storing the question's cache fails.
    redisSet.mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('synthetic Redis cache write failure'));
    const realCache = await vi.importActual<typeof import('../../src/realtime/match-cache.js')>('../../src/realtime/match-cache.js');
    setMatchCacheMock.mockImplementationOnce(realCache.setMatchCache as never);
    const cache = createCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { io, emit } = createIo();
    const { sendPossessionMatchQuestion } = await import('../../src/realtime/possession-question-dispatch.js');
    const { scheduleRealtimeTimer } = await import('../../src/realtime/realtime-timer-scheduler.js');

    await expect(sendPossessionMatchQuestion(io, cache.matchId, 4, { onlyIfUnsent: true })).rejects.toThrow('synthetic Redis cache write failure');
    expect(questionEmitted(emit)).toBe(false);
    expect(vi.mocked(scheduleRealtimeTimer)).not.toHaveBeenCalledWith('possession_question', 'match-exhausted-special:4', expect.anything(), expect.anything());
    // Owner-only release: the token this send wrote, never another send's mark.
    expect(releaseMock).toHaveBeenCalledWith('possession:sent:match-exhausted-special:4', redisSet.mock.calls[0]![1]);
  });
});

