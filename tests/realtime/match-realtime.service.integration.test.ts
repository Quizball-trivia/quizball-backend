import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const resolveRoundMock = vi.fn();

type FakeRedisStore = {
  values: Map<string, string>;
};

const fakeRedisStore: FakeRedisStore = {
  values: new Map(),
};

const fakeRedis = {
  async set(key: string, value: string): Promise<'OK'> {
    fakeRedisStore.values.set(key, value);
    return 'OK';
  },
  async get(key: string): Promise<string | null> {
    return fakeRedisStore.values.get(key) ?? null;
  },
  async del(keys: string | string[]): Promise<number> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    let removed = 0;
    for (const key of keyList) {
      if (fakeRedisStore.values.delete(key)) removed += 1;
    }
    return removed;
  },
  async exists(key: string): Promise<number> {
    return fakeRedisStore.values.has(key) ? 1 : 0;
  },
  async ttl(_key: string): Promise<number> {
    return 30;
  },
};

const getMatchMock = vi.fn();
const getActiveMatchForUserMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getAnswerForUserMock = vi.fn();
const getMatchQuestionTimingMock = vi.fn();
const insertMatchAnswerMock = vi.fn();
const updatePlayerTotalsMock = vi.fn();
const listAnswersForQuestionMock = vi.fn();
const completeMatchMock = vi.fn();
const updatePlayerAvgTimeMock = vi.fn();
const setPlayerForfeitWinTotalsMock = vi.fn();
const computeAvgTimesMock = vi.fn();
const abandonMatchMock = vi.fn();

const buildMatchQuestionPayloadMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => fakeRedis,
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    getActiveMatchForUser: (...args: unknown[]) => getActiveMatchForUserMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    getAnswerForUser: (...args: unknown[]) => getAnswerForUserMock(...args),
    getMatchQuestionTiming: (...args: unknown[]) => getMatchQuestionTimingMock(...args),
    insertMatchAnswer: (...args: unknown[]) => insertMatchAnswerMock(...args),
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
    listAnswersForQuestion: (...args: unknown[]) => listAnswersForQuestionMock(...args),
    completeMatch: (...args: unknown[]) => completeMatchMock(...args),
    updatePlayerAvgTime: (...args: unknown[]) => updatePlayerAvgTimeMock(...args),
    setPlayerForfeitWinTotals: (...args: unknown[]) => setPlayerForfeitWinTotalsMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    buildMatchQuestionPayload: (...args: unknown[]) => buildMatchQuestionPayloadMock(...args),
    computeAvgTimes: (...args: unknown[]) => computeAvgTimesMock(...args),
    abandonMatch: (...args: unknown[]) => abandonMatchMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listMembersWithUser: vi.fn(),
    setLobbyStatus: vi.fn(),
    removeMember: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: vi.fn(async (id: string) => ({
      id,
      nickname: id,
      avatar_url: null,
    })),
  },
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    runWithUserTransitionLock: vi.fn(async (_io: QuizballServer, _socket: QuizballSocket, work: () => Promise<void>) => {
      await work();
      return true;
    }),
    emitState: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/realtime/match-flow.js', () => ({
  QUESTION_TIME_MS: 10000,
  cancelMatchQuestionTimer: vi.fn(),
  resolveRound: (...args: unknown[]) => resolveRoundMock(...args),
  sendMatchQuestion: vi.fn(),
}));

function createIoMock(): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const inFn = vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) }));
  return {
    to,
    in: inFn,
  } as unknown as QuizballServer;
}

function createSocketMock(userId: string, matchId?: string): QuizballSocket {
  return {
    data: {
      user: { id: userId, role: 'user' },
      matchId,
    },
    emit: vi.fn(),
    leave: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as unknown as QuizballSocket;
}

describe('match-realtime.service high-risk integration behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedisStore.values.clear();
    resolveRoundMock.mockResolvedValue(undefined);

    getActiveMatchForUserMock.mockResolvedValue(null);
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 0,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', total_points: 200, correct_answers: 2 },
      { user_id: 'u2', total_points: 100, correct_answers: 1 },
    ]);
    getAnswerForUserMock.mockResolvedValue(null);
    getMatchQuestionTimingMock.mockResolvedValue({
      shown_at: new Date(Date.now() - 500).toISOString(),
      deadline_at: new Date(Date.now() + 9500).toISOString(),
    });
    insertMatchAnswerMock.mockResolvedValue(undefined);
    updatePlayerTotalsMock.mockResolvedValue({
      user_id: 'u1',
      total_points: 300,
      correct_answers: 3,
    });
    completeMatchMock.mockResolvedValue(undefined);
    updatePlayerAvgTimeMock.mockResolvedValue(undefined);
    setPlayerForfeitWinTotalsMock.mockResolvedValue(undefined);
    computeAvgTimesMock.mockResolvedValue(new Map());
    abandonMatchMock.mockResolvedValue(undefined);
    listAnswersForQuestionMock.mockResolvedValue([
      { user_id: 'u1', selected_index: 1, is_correct: true, points_earned: 100, time_ms: 1000 },
      { user_id: 'u2', selected_index: 2, is_correct: false, points_earned: 0, time_ms: 4000 },
    ]);
    buildMatchQuestionPayloadMock.mockResolvedValue({
      question: {
        id: 'q1',
        prompt: 'Test?',
        options: [{ index: 0, text: 'A' }, { index: 1, text: 'B' }],
        categoryName: 'General',
      },
      correctIndex: 1,
    });
  });

  it('S15: match:leave uses pause/grace flow and emits rejoin_available', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(socket.leave).toHaveBeenCalledWith('match:m1');
    expect(socket.emit).toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.objectContaining({
        matchId: 'm1',
        graceMs: 30000,
      })
    );

    const toCalls = (io.to as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(toCalls.some(([room]: [string]) => room === 'user:u2')).toBe(true);
  });

  it('S14: emits ack/opponent event after persisted answer and resolves when both answered', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const opponentEmitter = vi.fn();
    socket.to = vi.fn(() => ({ emit: opponentEmitter })) as unknown as QuizballSocket['to'];

    // First call checks duplicate for current user, second call checks opponent answered.
    getAnswerForUserMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      user_id: 'u2',
      selected_index: 2,
      is_correct: false,
      points_earned: 0,
      time_ms: 4000,
    });

    await matchRealtimeService.handleAnswer(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      selectedIndex: 1,
      timeMs: 500,
    });

    expect(insertMatchAnswerMock).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      'match:answer_ack',
      expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
        oppAnswered: true,
      })
    );
    expect(opponentEmitter).toHaveBeenCalledWith(
      'match:opponent_answered',
      expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
      })
    );
    expect(resolveRoundMock).toHaveBeenCalledWith(io, 'm1', 0, false);
  });

  it('S18: clears replay key only when matchId and version both match', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u1', undefined);
    const replayKey = 'user:last_match:u1';

    fakeRedisStore.values.set(
      replayKey,
      JSON.stringify({ matchId: 'm1', resultVersion: 12345 })
    );

    await matchRealtimeService.handleFinalResultsAck(socket, {
      matchId: 'm1',
      resultVersion: 99999,
    });
    expect(fakeRedisStore.values.has(replayKey)).toBe(true);

    await matchRealtimeService.handleFinalResultsAck(socket, {
      matchId: 'm1',
      resultVersion: 12345,
    });
    expect(fakeRedisStore.values.has(replayKey)).toBe(false);
  });

  it('S19: match:forfeit immediately finalizes the match and emits final results', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    getMatchMock
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'friendly',
        status: 'active',
        current_q_index: 4,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
      })
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'friendly',
        status: 'completed',
        current_q_index: 4,
        total_questions: 10,
        started_at: nowIso,
        ended_at: nowIso,
        winner_user_id: 'u2',
        lobby_id: 'l1',
      });

    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', total_points: 200, correct_answers: 2 },
      { user_id: 'u2', total_points: 100, correct_answers: 1 },
    ]);

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(setPlayerForfeitWinTotalsMock).toHaveBeenCalledWith('m1', 'u2', 1000, 10);
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(updatePlayerAvgTimeMock).toHaveBeenCalledWith('m1', 'u1', null);
    expect(updatePlayerAvgTimeMock).toHaveBeenCalledWith('m1', 'u2', null);
    expect(socket.leave).toHaveBeenCalledWith('match:m1');
    expect(socket.data.matchId).toBeUndefined();
    expect((io.to as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('match:m1');
  });

  it('S20: match:forfeit rejects non-participants', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u9', 'm1');

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_NOT_ALLOWED' })
    );
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S21: match:forfeit returns MATCH_NOT_ACTIVE when no active match exists', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'completed',
      current_q_index: 9,
      total_questions: 10,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      winner_user_id: 'u2',
      lobby_id: 'l1',
    });

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_NOT_ACTIVE' })
    );
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S22: leave after forfeit is rejected as inactive', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'completed',
      current_q_index: 9,
      total_questions: 10,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      winner_user_id: 'u2',
      lobby_id: 'l1',
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_NOT_ACTIVE' })
    );
  });

  it('S22: uses server-authoritative timing for points and persisted answer time', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    getMatchQuestionTimingMock.mockResolvedValue({
      shown_at: new Date(fixedNow - 2400).toISOString(),
      deadline_at: new Date(fixedNow + 7600).toISOString(),
    });

    await matchRealtimeService.handleAnswer(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      selectedIndex: 1,
      timeMs: 50,
    });

    expect(insertMatchAnswerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
        userId: 'u1',
        timeMs: 2400,
        pointsEarned: 80,
      })
    );

    dateNowSpy.mockRestore();
  });

  it('S23: logs discrepancy when client time differs from server time beyond tolerance', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { logger } = await import('../../src/core/logger.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const fixedNow = 1_700_000_010_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    getMatchQuestionTimingMock.mockResolvedValue({
      shown_at: new Date(fixedNow - 3000).toISOString(),
      deadline_at: new Date(fixedNow + 7000).toISOString(),
    });

    await matchRealtimeService.handleAnswer(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      selectedIndex: 1,
      timeMs: 100,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
        userId: 'u1',
        serverTimeMs: 3000,
        clientTimeMs: 100,
        diffMs: 2900,
      }),
      'Match answer timing discrepancy detected'
    );

    nowSpy.mockRestore();
  });
});
