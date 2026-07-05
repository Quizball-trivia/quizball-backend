import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import type { MatchAnswerAckPayload } from '../../src/realtime/socket.types.js';

const getMatchCacheOrRebuildMock = vi.hoisted(() => vi.fn());
const commitCachedAnswerMock = vi.hoisted(() => vi.fn());
const insertMatchAnswerIfMissingMock = vi.hoisted(() => vi.fn());
const updatePlayerTotalsMock = vi.hoisted(() => vi.fn());
const resolvePossessionRoundMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

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

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  fireAndForget: (_label: string, work: () => Promise<void>) => {
    void work();
  },
  resolvePossessionRound: (...args: unknown[]) => resolvePossessionRoundMock(...args),
}));

vi.mock('../../src/realtime/possession-answer-lock.js', () => ({
  emitMatchBusy: (socket: QuizballSocket) => {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry answer submission.',
    });
  },
  emitRedisUnavailable: (socket: QuizballSocket, questionLabel: string) => {
    socket.emit('error', {
      code: 'MATCH_UNAVAILABLE',
      message: `${questionLabel} questions require Redis-backed realtime state.`,
    });
  },
  isRedisAvailable: () => true,
  withAnswerLock: async <T>(
    _matchId: string,
    _lockSuffix: string,
    _onBusy: () => void,
    work: () => Promise<T>
  ) => work(),
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  answerCount: (cache: MatchCache) => Object.keys(cache.answers).length,
  buildAnswerPayload: vi.fn(),
  countdownAddFound: vi.fn(),
  countdownGetFound: vi.fn(async () => []),
  getCachedPlayer: (cache: MatchCache, userId: string) =>
    cache.players.find((player) => player.userId === userId) ?? null,
  getExpectedUserIds: (cache: MatchCache) => cache.players.map((player) => player.userId),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  commitCachedAnswer: (...args: unknown[]) => commitCachedAnswerMock(...args),
}));

import { handlePossessionAnswer } from '../../src/realtime/possession-answer-handlers.js';

const MATCH_ID = 'match-1';
const T = new Date('2026-07-04T12:00:00.000Z').getTime();

function makeCache(params: {
  shownAtMs: number;
  revealAtMs?: number;
  revealAckQIndex?: number;
}): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  state.currentQuestion = {
    qIndex: 3,
    phaseKind: 'normal',
    phaseRound: 1,
    shooterSeat: null,
    attackerSeat: null,
  };

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
    currentQIndex: 3,
    statePayload: state,
    currentQuestion: {
      qIndex: 3,
      kind: 'multipleChoice',
      questionId: 'question-1',
      correctIndex: 1,
      phaseKind: 'normal',
      phaseRound: 1,
      shooterSeat: null,
      attackerSeat: null,
      shownAt: new Date(params.shownAtMs).toISOString(),
      deadlineAt: new Date(params.shownAtMs + 10_000).toISOString(),
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
    revealAcks: params.revealAtMs === undefined
      ? {}
      : { u1: { qIndex: params.revealAckQIndex ?? 3, revealAtMs: params.revealAtMs } },
    clueReveals: {},
  };
}

function createIoMock(): QuizballServer {
  return {
    to: vi.fn(() => ({
      emit: vi.fn(),
    })),
  } as unknown as QuizballServer;
}

function createSocketMock(userId: string) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const roomEmitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const socket = {
    id: `socket-${userId}`,
    data: {
      user: { id: userId, role: 'user', is_ai: false },
    },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    to(room: string) {
      return {
        emit(event: string, payload?: unknown) {
          roomEmitted.push({ room, event, payload });
          return true;
        },
      };
    },
  } as unknown as QuizballSocket;

  return { socket, emitted, roomEmitted };
}

function answerAck(emitted: Array<{ event: string; payload: unknown }>): MatchAnswerAckPayload {
  const entry = emitted.find((item) => item.event === 'match:answer_ack');
  expect(entry).toBeDefined();
  return entry!.payload as MatchAnswerAckPayload;
}

describe('handlePossessionAnswer timing regression coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    commitCachedAnswerMock.mockResolvedValue(undefined);
    insertMatchAnswerIfMissingMock.mockResolvedValue(true);
    updatePlayerTotalsMock.mockResolvedValue(undefined);
    resolvePossessionRoundMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scores MCQ answers from the reveal ack when present', async () => {
    const cache = makeCache({ shownAtMs: T, revealAtMs: T + 1000 });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(T + 2400));
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionAnswer(createIoMock(), socket, {
      matchId: MATCH_ID,
      qIndex: 3,
      selectedIndex: 1,
      timeMs: 1400,
    });

    expect(cache.answers.u1).toMatchObject({
      timeMs: 1400,
      pointsEarned: 100,
    });
    expect(answerAck(emitted)).toMatchObject({
      pointsEarned: 100,
      myTotalPoints: 100,
    });
  });

  it('ignores a stale reveal ack from a previous question', async () => {
    const cache = makeCache({ shownAtMs: T, revealAtMs: T - 15_000, revealAckQIndex: 2 });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(T + 2400));
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionAnswer(createIoMock(), socket, {
      matchId: MATCH_ID,
      qIndex: 3,
      selectedIndex: 1,
      timeMs: 2400,
    });

    expect(cache.answers.u1).toMatchObject({
      timeMs: 2400,
      pointsEarned: 90,
    });
    expect(answerAck(emitted).pointsEarned).toBe(90);
  });

  it('uses client time for legacy clients when predicted elapsed is negative', async () => {
    const cache = makeCache({ shownAtMs: T + 3000 });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(T + 1400));
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionAnswer(createIoMock(), socket, {
      matchId: MATCH_ID,
      qIndex: 3,
      selectedIndex: 1,
      timeMs: 1400,
    });

    expect(cache.answers.u1).toMatchObject({
      timeMs: 1400,
      pointsEarned: 100,
    });
    expect(answerAck(emitted).pointsEarned).toBe(100);
  });

  it('caps legacy predicted elapsed to client time plus slack when over-penalized', async () => {
    const cache = makeCache({ shownAtMs: T });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    vi.setSystemTime(new Date(T + 4100));
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionAnswer(createIoMock(), socket, {
      matchId: MATCH_ID,
      qIndex: 3,
      selectedIndex: 1,
      timeMs: 900,
    });

    expect(cache.answers.u1).toMatchObject({
      timeMs: 2400,
      pointsEarned: 90,
    });
    expect(answerAck(emitted)).toMatchObject({
      pointsEarned: 90,
      myTotalPoints: 90,
    });
  });
});
