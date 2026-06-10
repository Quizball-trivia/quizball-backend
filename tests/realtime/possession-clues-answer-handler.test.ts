import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import type { MatchAnswerAckPayload, MatchOpponentAnsweredPayload } from '../../src/realtime/socket.types.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { handlePossessionCluesAnswer } from '../../src/realtime/possession-answer-handlers.js';

const getMatchCacheOrRebuildMock = vi.hoisted(() => vi.fn());
const setMatchCacheMock = vi.hoisted(() => vi.fn());
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
  buildAnswerPayload: (answer: {
    questionKind: string;
    foundCount?: number;
    foundAnswerIds?: string[];
    submittedOrderIds?: string[];
    clueIndex?: number | null;
  }) => ({
    questionKind: answer.questionKind,
    foundCount: answer.foundCount ?? null,
    foundAnswerIds: answer.foundAnswerIds ?? null,
    submittedOrderIds: answer.submittedOrderIds ?? null,
    clueIndex: answer.clueIndex ?? null,
  }),
  countdownAddFound: vi.fn(),
  countdownGetFound: vi.fn(async () => []),
  getCachedPlayer: (cache: MatchCache, userId: string) =>
    cache.players.find((player) => player.userId === userId) ?? null,
  getExpectedUserIds: (cache: MatchCache) => cache.players.map((player) => player.userId),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
  setMatchCache: (...args: unknown[]) => setMatchCacheMock(...args),
  // Final-answer commits now write the small per-question overlay instead of
  // the full blob; tests assert against this mock where commit is expected.
  commitCachedAnswer: (...args: unknown[]) => commitCachedAnswerMock(...args),
}));

function makeCache(overrides: Partial<MatchCache> = {}): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  state.currentQuestion = {
    qIndex: 4,
    phaseKind: 'normal',
    phaseRound: 1,
    shooterSeat: null,
    attackerSeat: null,
  };

  const clues = [
    { type: 'text' as const, content: { en: 'Swiss goalkeeper' } },
    { type: 'text' as const, content: { en: 'Played for Dortmund' } },
    { type: 'text' as const, content: { en: 'Wore number 1' } },
    { type: 'text' as const, content: { en: 'Joined in 2015' } },
    { type: 'text' as const, content: { en: 'Left in 2022' } },
  ];

  return {
    matchId: 'match-1',
    status: 'active',
    mode: 'friendly',
    totalQuestions: 12,
    categoryAId: 'cat-1',
    categoryBId: null,
    startedAt: '2026-05-29T12:00:00.000Z',
    players: [
      {
        userId: 'u1',
        seat: 1,
        totalPoints: 40,
        correctAnswers: 0,
        goals: 0,
        penaltyGoals: 0,
        avgTimeMs: null,
      },
      {
        userId: 'u2',
        seat: 2,
        totalPoints: 20,
        correctAnswers: 0,
        goals: 0,
        penaltyGoals: 0,
        avgTimeMs: null,
      },
    ],
    currentQIndex: 4,
    statePayload: state,
    currentQuestion: {
      qIndex: 4,
      kind: 'clues',
      questionId: 'question-1',
      correctIndex: 0,
      phaseKind: 'normal',
      phaseRound: 1,
      shooterSeat: null,
      attackerSeat: null,
      shownAt: null,
      deadlineAt: null,
      questionDTO: {
        kind: 'clues',
        id: 'question-1',
        prompt: { en: 'Who Am I?' },
        clues,
        categoryName: { en: 'Dortmund' },
      },
      evaluation: {
        kind: 'clues',
        acceptedAnswers: ['Roman Burki'],
        displayAnswer: { en: 'Roman Burki' },
        clues,
      },
      reveal: {
        kind: 'clues',
        displayAnswer: { en: 'Roman Burki' },
      },
    },
    answers: {},
    clueReveals: {},
    ...overrides,
  };
}

function createIoMock() {
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
    data: {
      user: { id: userId, role: 'user' },
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

function findPayload<T>(emitted: Array<{ event: string; payload: unknown }>, event: string): T {
  const entry = emitted.find((item) => item.event === event);
  expect(entry).toBeDefined();
  return entry!.payload as T;
}

describe('handlePossessionCluesAnswer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMatchCacheMock.mockImplementation(async () => undefined);
    insertMatchAnswerIfMissingMock.mockResolvedValue(true);
    updatePlayerTotalsMock.mockResolvedValue(undefined);
    resolvePossessionRoundMock.mockResolvedValue(undefined);
  });

  it('persists a wrong clue guess as a final answer ack without emitting clues_guess_ack', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { socket, emitted, roomEmitted } = createSocketMock('u1');

    await handlePossessionCluesAnswer(createIoMock(), socket, {
      kind: 'guess',
      matchId: 'match-1',
      qIndex: 4,
      guess: 'wrong answer',
      timeMs: 12000,
    });

    expect(emitted.some((entry) => entry.event === 'match:clues_guess_ack')).toBe(false);
    expect(cache.answers.u1).toMatchObject({
      questionKind: 'clues',
      isCorrect: false,
      pointsEarned: 0,
      clueIndex: 1,
    });

    const ack = findPayload<MatchAnswerAckPayload>(emitted, 'match:answer_ack');
    expect(ack).toMatchObject({
      matchId: 'match-1',
      qIndex: 4,
      questionKind: 'clues',
      selectedIndex: null,
      isCorrect: false,
      myTotalPoints: 40,
      oppAnswered: false,
      pointsEarned: 0,
      clueIndex: 1,
      cluesDisplayAnswer: { en: 'Roman Burki' },
    });

    const opponentPayload = findPayload<MatchOpponentAnsweredPayload>(roomEmitted, 'match:opponent_answered');
    expect(opponentPayload).toMatchObject({
      matchId: 'match-1',
      qIndex: 4,
      questionKind: 'clues',
      pointsEarned: 0,
      isCorrect: false,
      selectedIndex: null,
    });
    expect(opponentPayload).not.toHaveProperty('cluesDisplayAnswer');
    expect(resolvePossessionRoundMock).not.toHaveBeenCalled();
  });

  it('scores a correct clue guess by server clue timing and includes display answer', async () => {
    const cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionCluesAnswer(createIoMock(), socket, {
      kind: 'guess',
      matchId: 'match-1',
      qIndex: 4,
      guess: 'Roman Burki',
      timeMs: 12000,
    });

    const ack = findPayload<MatchAnswerAckPayload>(emitted, 'match:answer_ack');
    expect(ack).toMatchObject({
      isCorrect: true,
      pointsEarned: 80,
      myTotalPoints: 120,
      clueIndex: 1,
      cluesDisplayAnswer: { en: 'Roman Burki' },
    });
    expect(cache.answers.u1).toMatchObject({
      isCorrect: true,
      pointsEarned: 80,
      clueIndex: 1,
    });
  });

  it('replays an existing clues answer ack with the display answer and does not score twice', async () => {
    const cache = makeCache({
      answers: {
        u1: {
          userId: 'u1',
          questionKind: 'clues',
          selectedIndex: null,
          isCorrect: true,
          timeMs: 12000,
          pointsEarned: 80,
          phaseKind: 'normal',
          phaseRound: 1,
          shooterSeat: null,
          answeredAt: '2026-05-29T12:00:12.000Z',
          clueIndex: 1,
        },
      },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionCluesAnswer(createIoMock(), socket, {
      kind: 'guess',
      matchId: 'match-1',
      qIndex: 4,
      guess: 'Roman Burki',
      timeMs: 2000,
    });

    expect(setMatchCacheMock).not.toHaveBeenCalled();
    expect(insertMatchAnswerIfMissingMock).not.toHaveBeenCalled();
    const ack = findPayload<MatchAnswerAckPayload>(emitted, 'match:answer_ack');
    expect(ack).toMatchObject({
      isCorrect: true,
      pointsEarned: 80,
      myTotalPoints: 120,
      clueIndex: 1,
      cluesDisplayAnswer: { en: 'Roman Burki' },
    });
  });

  it('resolves the round when both players have submitted final clues answers', async () => {
    const cache = makeCache({
      answers: {
        u2: {
          userId: 'u2',
          questionKind: 'clues',
          selectedIndex: null,
          isCorrect: false,
          timeMs: 50000,
          pointsEarned: 0,
          phaseKind: 'normal',
          phaseRound: 1,
          shooterSeat: null,
          answeredAt: '2026-05-29T12:00:50.000Z',
          clueIndex: 4,
        },
      },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    const io = createIoMock();
    const { socket, emitted } = createSocketMock('u1');

    await handlePossessionCluesAnswer(io, socket, {
      kind: 'guess',
      matchId: 'match-1',
      qIndex: 4,
      guess: 'Roman Burki',
      timeMs: 1000,
    });

    const ack = findPayload<MatchAnswerAckPayload>(emitted, 'match:answer_ack');
    expect(ack.oppAnswered).toBe(true);
    expect(resolvePossessionRoundMock).toHaveBeenCalledWith(io, 'match-1', 4, false);
  });
});
