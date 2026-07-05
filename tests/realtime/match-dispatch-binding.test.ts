import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const getMatchCacheOrRebuildMock = vi.hoisted(() => vi.fn());
const handlePossessionAnswerMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => null, // no pause key checks in these tests
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  handlePossessionAnswer: (...args: unknown[]) => handlePossessionAnswerMock(...args),
  handlePossessionCluesAnswer: vi.fn(),
  handlePossessionCountdownGuess: vi.fn(),
  handlePossessionHalftimeBan: vi.fn(),
  handlePossessionPutInOrderAnswer: vi.fn(),
  handlePossessionQuestionRevealed: vi.fn(),
  handlePossessionReadyForNextQuestion: vi.fn(),
}));

vi.mock('../../src/realtime/party-quiz-match-flow.js', () => ({
  handlePartyQuizAnswer: vi.fn(),
  handlePartyQuizReadyForNextQuestion: vi.fn(),
}));

import { handleAnswer } from '../../src/realtime/services/match-question-dispatch.service.js';

const MATCH_ID = 'm-bind-1';

function createCache(): MatchCache {
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
      { userId: 'u1', seat: 1, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
      { userId: 'u2', seat: 2, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    ],
    currentQIndex: 2,
    statePayload: state,
    currentQuestion: null,
    answers: {},
  };
}

function createSocket(userId: string, matchId?: string): QuizballSocket {
  return {
    id: `socket-${userId}`,
    data: { user: { id: userId, role: 'user' }, matchId },
    emit: vi.fn(),
  } as unknown as QuizballSocket;
}

const io = {} as QuizballServer;

describe('dispatch gate heals the socket->match binding (silent-pause-bypass guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMatchCacheOrRebuildMock.mockResolvedValue(createCache());
  });

  it('repairs a participant socket that lost its matchId', async () => {
    const socket = createSocket('u1', undefined);

    await handleAnswer(io, socket, { matchId: MATCH_ID, qIndex: 2, answerIndex: 1, timeMs: 1000 });

    // The binding handleMatchDisconnect relies on is restored.
    expect(socket.data.matchId).toBe(MATCH_ID);
    expect(handlePossessionAnswerMock).toHaveBeenCalled();
  });

  it('does NOT bind a non-participant socket (multi-tab pause protection)', async () => {
    const socket = createSocket('intruder', undefined);

    await handleAnswer(io, socket, { matchId: MATCH_ID, qIndex: 2, answerIndex: 1, timeMs: 1000 });

    expect(socket.data.matchId).toBeUndefined();
  });

  it('leaves an already-correct binding untouched', async () => {
    const socket = createSocket('u1', MATCH_ID);

    await handleAnswer(io, socket, { matchId: MATCH_ID, qIndex: 2, answerIndex: 1, timeMs: 1000 });

    expect(socket.data.matchId).toBe(MATCH_ID);
  });
});
