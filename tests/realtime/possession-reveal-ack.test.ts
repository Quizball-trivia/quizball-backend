import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballSocket } from '../../src/realtime/socket-server.js';

const getMatchCacheOrRebuildMock = vi.hoisted(() => vi.fn());
const commitCachedRevealAckMock = vi.hoisted(() => vi.fn());
const redisValues = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    get: async (key: string) => redisValues.get(key) ?? null,
  }),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  getCachedPlayer: (cache: MatchCache, userId: string) =>
    cache.players.find((player) => player.userId === userId) ?? null,
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  commitCachedRevealAck: (...args: unknown[]) => commitCachedRevealAckMock(...args),
}));

import { handlePossessionQuestionRevealed } from '../../src/realtime/possession-reveal-ack.js';
import { matchPauseKey } from '../../src/realtime/match-keys.js';
import { logger } from '../../src/core/logger.js';

const MATCH_ID = 'match-1';
const SHOWN_AT_MS = new Date('2026-07-04T12:00:00.000Z').getTime();

function makeCache(overrides: Partial<MatchCache> = {}): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  return {
    matchId: MATCH_ID,
    status: 'active',
    mode: 'friendly',
    totalQuestions: 12,
    categoryAId: 'cat-a',
    categoryBId: null,
    startedAt: '2026-07-04T11:59:00.000Z',
    players: [
      { userId: 'u1', seat: 1, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
      { userId: 'u2', seat: 2, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    ],
    currentQIndex: 2,
    statePayload: state,
    currentQuestion: {
      qIndex: 2,
      kind: 'multipleChoice',
      questionId: 'question-1',
      correctIndex: 1,
      phaseKind: 'normal',
      phaseRound: 1,
      shooterSeat: null,
      attackerSeat: null,
      shownAt: new Date(SHOWN_AT_MS).toISOString(),
      deadlineAt: new Date(SHOWN_AT_MS + 10_000).toISOString(),
      questionDTO: {
        kind: 'multipleChoice',
        id: 'question-1',
        prompt: { en: 'Question?' },
        options: [
          { en: 'A' },
          { en: 'B' },
          { en: 'C' },
          { en: 'D' },
        ],
        categoryName: { en: 'Category' },
      },
      evaluation: {
        kind: 'multipleChoice',
        correctIndex: 1,
      },
      reveal: {
        kind: 'multipleChoice',
        correctIndex: 1,
      },
    },
    answers: {},
    revealAcks: {},
    clueReveals: {},
    ...overrides,
  };
}

function createSocket(userId: string, isAi = false): QuizballSocket {
  return {
    id: `socket-${userId}`,
    data: {
      user: { id: userId, role: 'user', is_ai: isAi },
    },
    emit: vi.fn(),
  } as unknown as QuizballSocket;
}

describe('handlePossessionQuestionRevealed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SHOWN_AT_MS + 500));
    vi.clearAllMocks();
    redisValues.clear();
    commitCachedRevealAckMock.mockResolvedValue('stored');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores an ack while the match is paused (no in-memory ack, no overlay write), then records one after resume', async () => {
    // An ack committed between the resume's overlay clean-up and the
    // re-dispatch would survive with pre-resume timing. The pause marker the
    // disconnect service sets is the same signal the resume path relies on.
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    redisValues.set(matchPauseKey(MATCH_ID), String(SHOWN_AT_MS + 200));

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks).toEqual({});
    expect(commitCachedRevealAckMock).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'match:question_revealed', matchId: MATCH_ID, userId: 'u1' }),
      expect.stringMatching(/paused/i)
    );

    // Resume clears the pause marker; the next ack is recorded normally.
    redisValues.delete(matchPauseKey(MATCH_ID));
    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 500 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledWith(cache, 'u1', SHOWN_AT_MS + 500);
  });

  it('does not record an ack the overlay rejected as fenced (resume in progress); the client re-acks later', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    commitCachedRevealAckMock.mockResolvedValueOnce('fenced');

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks).toEqual({});
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'match:question_revealed', matchId: MATCH_ID, userId: 'u1' }),
      expect.stringMatching(/fenced|resum/i)
    );

    // Fence gone: a fresh ack for the same question is recorded normally.
    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });
    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 500 });
  });

  it('stores the first reveal ack for the current player and question', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 500 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledWith(cache, 'u1', SHOWN_AT_MS + 500);
  });

  it('preserves a legitimate reveal that arrives well after the predicted playable time', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(SHOWN_AT_MS + 5_700));

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 5_700 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledWith(cache, 'u1', SHOWN_AT_MS + 5_700);
  });

  it('preserves a very late server-received ack instead of charging delivery delay', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(SHOWN_AT_MS + 12_000));

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 12_000 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledWith(cache, 'u1', SHOWN_AT_MS + 12_000);
  });

  it('preserves an ack that looks early when the dispatch replica clock is ahead', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(SHOWN_AT_MS - 5_300));

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS - 5_300 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledWith(cache, 'u1', SHOWN_AT_MS - 5_300);
  });

  it('is idempotent and ignores later acks from the same player', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });
    vi.setSystemTime(new Date(SHOWN_AT_MS + 900));
    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 500 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale ack from a previous question', async () => {
    const cache = makeCache({ revealAcks: { u1: { qIndex: 1, revealAtMs: SHOWN_AT_MS - 9_000 } } });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toEqual({ qIndex: 2, revealAtMs: SHOWN_AT_MS + 500 });
    expect(commitCachedRevealAckMock).toHaveBeenCalledTimes(1);
  });

  it('ignores acks for a non-current qIndex', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 1 });

    expect(cache.revealAcks?.u1).toBeUndefined();
    expect(commitCachedRevealAckMock).not.toHaveBeenCalled();
  });

  it('ignores AI users', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePossessionQuestionRevealed(createSocket('ai-1', true), { matchId: MATCH_ID, qIndex: 2 });

    expect(getMatchCacheOrRebuildMock).not.toHaveBeenCalled();
    expect(commitCachedRevealAckMock).not.toHaveBeenCalled();
  });

  it('ignores users who are not match players', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePossessionQuestionRevealed(createSocket('u3'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u3).toBeUndefined();
    expect(commitCachedRevealAckMock).not.toHaveBeenCalled();
  });

  it('ignores acks when the cache is missing or inactive', async () => {
    getMatchCacheOrRebuildMock.mockResolvedValue(null);
    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });
    expect(commitCachedRevealAckMock).not.toHaveBeenCalled();

    const inactive = makeCache({ status: 'completed' });
    getMatchCacheOrRebuildMock.mockResolvedValue(inactive);
    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });
    expect(inactive.revealAcks?.u1).toBeUndefined();
    expect(commitCachedRevealAckMock).not.toHaveBeenCalled();
  });

  it('rolls back the in-memory ack when the overlay write loses the race', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    commitCachedRevealAckMock.mockResolvedValue('duplicate');

    await handlePossessionQuestionRevealed(createSocket('u1'), { matchId: MATCH_ID, qIndex: 2 });

    expect(cache.revealAcks?.u1).toBeUndefined();
  });
});
