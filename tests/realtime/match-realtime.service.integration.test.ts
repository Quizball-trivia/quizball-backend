import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const resolveRoundMock = vi.fn();
const sendMatchQuestionMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const getLobbyByIdMock = vi.fn();
const createLobbyMock = vi.fn();
const addMemberMock = vi.fn();
const countMembersMock = vi.fn();
const updateLobbySettingsMock = vi.fn();
const setAllReadyMock = vi.fn();
const setLobbyStatusMock = vi.fn();
const removeMemberMock = vi.fn();
const prepareForLobbyEntryMock = vi.fn();

type FakeRedisStore = {
  values: Map<string, string>;
};

const fakeRedisStore: FakeRedisStore = {
  values: new Map(),
};

const fakeRedis = {
  isOpen: false,
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
const getMatchQuestionMock = vi.fn();
const insertMatchAnswerMock = vi.fn();
const updatePlayerTotalsMock = vi.fn();
const updatePlayerGoalTotalsMock = vi.fn();
const listAnswersForQuestionMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const completeMatchMock = vi.fn();
const updatePlayerAvgTimeMock = vi.fn();
const setPlayerForfeitWinTotalsMock = vi.fn();
const setPlayerFinalTotalsMock = vi.fn();
const computeAvgTimesMock = vi.fn();
const abandonMatchMock = vi.fn();

const buildMatchQuestionPayloadMock = vi.fn();
const consumeChanceCardForMatchMock = vi.fn();
const ensureProfileMock = vi.fn();
const settleCompletedRankedMatchMock = vi.fn();
const listUnlockedForMatchMock = vi.fn();

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
    getMatchQuestion: (...args: unknown[]) => getMatchQuestionMock(...args),
    insertMatchAnswer: (...args: unknown[]) => insertMatchAnswerMock(...args),
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
    updatePlayerGoalTotals: (...args: unknown[]) => updatePlayerGoalTotalsMock(...args),
    listAnswersForQuestion: (...args: unknown[]) => listAnswersForQuestionMock(...args),
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
    completeMatch: (...args: unknown[]) => completeMatchMock(...args),
    updatePlayerAvgTime: (...args: unknown[]) => updatePlayerAvgTimeMock(...args),
    setPlayerForfeitWinTotals: (...args: unknown[]) => setPlayerForfeitWinTotalsMock(...args),
    setPlayerFinalTotals: (...args: unknown[]) => setPlayerFinalTotalsMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return {
    ...actual,
    matchesService: {
      ...actual.matchesService,
      buildMatchQuestionPayload: (...args: unknown[]) => buildMatchQuestionPayloadMock(...args),
      computeAvgTimes: (...args: unknown[]) => computeAvgTimesMock(...args),
      abandonMatch: (...args: unknown[]) => abandonMatchMock(...args),
    },
  };
});

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    getById: (...args: unknown[]) => getLobbyByIdMock(...args),
    createLobby: (...args: unknown[]) => createLobbyMock(...args),
    addMember: (...args: unknown[]) => addMemberMock(...args),
    countMembers: (...args: unknown[]) => countMembersMock(...args),
    updateLobbySettings: (...args: unknown[]) => updateLobbySettingsMock(...args),
    setAllReady: (...args: unknown[]) => setAllReadyMock(...args),
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
    setLobbyStatus: (...args: unknown[]) => setLobbyStatusMock(...args),
    removeMember: (...args: unknown[]) => removeMemberMock(...args),
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

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    consumeChanceCardForMatch: (...args: unknown[]) => consumeChanceCardForMatchMock(...args),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: (...args: unknown[]) => ensureProfileMock(...args),
    settleCompletedRankedMatch: (...args: unknown[]) => settleCompletedRankedMatchMock(...args),
    isPlacementRequired: vi.fn(() => false),
    buildPlacementAiContext: vi.fn(() => ({ aiAnchorRp: 1900 })),
    DEFAULT_AI_OPPONENT_RP: 1900,
  },
}));

vi.mock('../../src/modules/achievements/index.js', () => ({
  achievementsService: {
    listUnlockedForMatch: (...args: unknown[]) => listUnlockedForMatchMock(...args),
  },
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    runWithUserTransitionLock: vi.fn(async (_io: QuizballServer, _socket: QuizballSocket, work: () => Promise<void>) => {
      await work();
      return true;
    }),
    prepareForLobbyEntry: (...args: unknown[]) => prepareForLobbyEntryMock(...args),
    emitState: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/realtime/match-flow.js', () => ({
  QUESTION_TIME_MS: 10000,
  cancelMatchQuestionTimer: vi.fn(),
  resolveRound: (...args: unknown[]) => resolveRoundMock(...args),
  sendMatchQuestion: (...args: unknown[]) => sendMatchQuestionMock(...args),
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

function createIoWithUserSocket(userId: string, socket: QuizballSocket): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const inFn = vi.fn((room: string) => ({
    fetchSockets: vi.fn(async () => (room === `user:${userId}` ? [socket] : [])),
    socketsJoin: vi.fn(async (targetRoom: string) => {
      if (room === `user:${userId}`) {
        socket.join(targetRoom);
      }
    }),
  }));

  return {
    to,
    in: inFn,
  } as unknown as QuizballServer;
}

describe('match-realtime.service high-risk integration behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedisStore.values.clear();
    fakeRedis.isOpen = false;
    resolveRoundMock.mockResolvedValue(undefined);
    sendMatchQuestionMock.mockResolvedValue(undefined);
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1', nickname: 'u1', avatar_url: null },
      { user_id: 'u2', nickname: 'u2', avatar_url: null },
    ]);
    setLobbyStatusMock.mockResolvedValue(undefined);
    removeMemberMock.mockResolvedValue(undefined);
    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      invite_code: 'ROOM42',
      mode: 'friendly',
      game_mode: 'friendly_possession',
      friendly_random: false,
      friendly_category_a_id: 'cat-a',
      friendly_category_b_id: null,
      is_public: true,
      display_name: 'Original Lobby',
      host_user_id: 'u1',
      status: 'closed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    createLobbyMock.mockResolvedValue({
      id: 'rematch-lobby',
      invite_code: 'NEW123',
      mode: 'friendly',
      game_mode: 'friendly_possession',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
      is_public: true,
      display_name: 'Rematch Lobby',
      host_user_id: 'u1',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    addMemberMock.mockResolvedValue(undefined);
    countMembersMock.mockResolvedValue(1);
    updateLobbySettingsMock.mockResolvedValue(undefined);
    setAllReadyMock.mockResolvedValue(undefined);
    prepareForLobbyEntryMock.mockResolvedValue({
      ok: true,
      snapshot: {
        state: 'IDLE',
        activeMatchId: null,
        waitingLobbyId: null,
        queueSearchId: null,
        openLobbyIds: [],
        resolvedAt: new Date().toISOString(),
      },
    });

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
      { user_id: 'u1', seat: 1, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 100, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);
    getAnswerForUserMock.mockResolvedValue(null);
    getMatchQuestionTimingMock.mockResolvedValue({
      shown_at: new Date(Date.now() - 500).toISOString(),
      deadline_at: new Date(Date.now() + 9500).toISOString(),
    });
    getMatchQuestionMock.mockResolvedValue({
      match_id: 'm1',
      q_index: 0,
      question_id: 'q1',
      category_id: 'cat1',
      correct_index: 1,
      phase_kind: 'normal',
      phase_round: 1,
      shooter_seat: null,
      attacker_seat: null,
      shown_at: null,
      deadline_at: null,
    });
    insertMatchAnswerMock.mockResolvedValue(undefined);
    updatePlayerTotalsMock.mockResolvedValue({
      user_id: 'u1',
      total_points: 300,
      correct_answers: 3,
    });
    updatePlayerGoalTotalsMock.mockResolvedValue(undefined);
    setMatchStatePayloadMock.mockResolvedValue(undefined);
    completeMatchMock.mockResolvedValue(undefined);
    updatePlayerAvgTimeMock.mockResolvedValue(undefined);
    setPlayerForfeitWinTotalsMock.mockResolvedValue(undefined);
    setPlayerFinalTotalsMock.mockResolvedValue(undefined);
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
        options: [
          { index: 0, text: 'A' },
          { index: 1, text: 'B' },
          { index: 2, text: 'C' },
          { index: 3, text: 'D' },
        ],
        categoryName: 'General',
      },
      correctIndex: 1,
    });
    consumeChanceCardForMatchMock.mockResolvedValue({ remainingQuantity: 2 });
    ensureProfileMock.mockImplementation(async (userId: string) => ({
      user_id: userId,
      rp: userId === 'u1' ? 1111 : 2222,
      tier: 'Bench',
      placement_status: 'placed',
      placement_played: 3,
      placement_required: 3,
      placement_wins: 0,
      placement_seed_rp: null,
      placement_perf_sum: 0,
      placement_points_for_sum: 0,
      placement_points_against_sum: 0,
      current_win_streak: 0,
    }));
    settleCompletedRankedMatchMock.mockResolvedValue(null);
    listUnlockedForMatchMock.mockResolvedValue({});
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
  });

  it('S27: chance card use emits match:chance_card_applied and consumes once', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 0,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
    });

    await matchRealtimeService.handleChanceCardUse(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      clientActionId: 'action-12345678',
    });

    expect(consumeChanceCardForMatchMock).toHaveBeenCalledWith({
      userId: 'u1',
      matchId: 'm1',
      qIndex: 0,
      clientActionId: 'action-12345678',
    });
    expect(socket.emit).toHaveBeenCalledWith(
      'match:chance_card_applied',
      expect.objectContaining({
        matchId: 'm1',
        qIndex: 0,
        clientActionId: 'action-12345678',
        remainingQuantity: 2,
      })
    );
  });

  it('S28: duplicate chance card use for same user/question does not consume twice', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set(
      'match:cache:m1',
      JSON.stringify({
        matchId: 'm1',
        status: 'active',
        mode: 'ranked',
        totalQuestions: 10,
        categoryAId: 'cat1',
        categoryBId: 'cat2',
        startedAt: nowIso,
        players: [
          { userId: 'u1', seat: 1, totalPoints: 200, correctAnswers: 2, goals: 0, penaltyGoals: 0, avgTimeMs: null },
          { userId: 'u2', seat: 2, totalPoints: 100, correctAnswers: 1, goals: 0, penaltyGoals: 0, avgTimeMs: null },
        ],
        currentQIndex: 0,
        statePayload: {
          phase: 'NORMAL_PLAY',
          half: 1,
          possessionDiff: 0,
          kickOffSeat: 1,
          goals: { seat1: 0, seat2: 0 },
          penaltyGoals: { seat1: 0, seat2: 0 },
          normalQuestionsPerHalf: 6,
          normalQuestionsAnsweredInHalf: 0,
          normalQuestionsAnsweredTotal: 0,
          halftime: { deadlineAt: null, categoryOptions: [], bans: { seat1: null, seat2: null } },
          lastAttack: { attackerSeat: null },
          penalty: { round: 0, shooterSeat: 1, suddenDeath: false, kicksTaken: { seat1: 0, seat2: 0 } },
          currentQuestion: null,
          winnerDecisionMethod: null,
        },
        currentQuestion: {
          qIndex: 0,
          questionId: 'q1',
          correctIndex: 1,
          phaseKind: 'normal',
          phaseRound: 1,
          shooterSeat: null,
          attackerSeat: null,
          shownAt: null,
          deadlineAt: null,
          questionDTO: {
            id: 'q1',
            prompt: { en: 'Prompt' },
            options: [{ en: 'A' }, { en: 'B' }, { en: 'C' }, { en: 'D' }],
          },
        },
        answers: {},
        chanceCardUses: {},
      })
    );

    await matchRealtimeService.handleChanceCardUse(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      clientActionId: 'action-dup-1',
    });
    await matchRealtimeService.handleChanceCardUse(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      clientActionId: 'action-dup-2',
    });

    expect(consumeChanceCardForMatchMock).toHaveBeenCalledTimes(1);
    const chanceCardEmits = (socket.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => event === 'match:chance_card_applied'
    );
    expect(chanceCardEmits).toHaveLength(2);
    expect(chanceCardEmits[1]?.[1]).toEqual(
      expect.objectContaining({
        clientActionId: 'action-dup-1',
      })
    );
  });

  it('S29: emits CHANCE_CARD_NOT_AVAILABLE when user has no 50-50 cards', async () => {
    const { BadRequestError } = await import('../../src/core/errors.js');
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 0,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
    });
    consumeChanceCardForMatchMock.mockRejectedValue(new BadRequestError('No 50-50 cards available'));

    await matchRealtimeService.handleChanceCardUse(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      clientActionId: 'action-none-123',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        code: 'CHANCE_CARD_NOT_AVAILABLE',
      })
    );
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

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set(
      'match:cache:m1',
      JSON.stringify({
        matchId: 'm1',
        status: 'active',
        mode: 'friendly',
        totalQuestions: 10,
        categoryAId: 'cat1',
        categoryBId: 'cat2',
        startedAt: nowIso,
        players: [
          { userId: 'u1', seat: 1, totalPoints: 220, correctAnswers: 2, goals: 0, penaltyGoals: 0, avgTimeMs: null },
          { userId: 'u2', seat: 2, totalPoints: 140, correctAnswers: 1, goals: 0, penaltyGoals: 0, avgTimeMs: null },
        ],
        currentQIndex: 4,
        statePayload: {
          version: 1,
          phase: 'NORMAL_PLAY',
          half: 1,
          possessionDiff: 0,
          kickOffSeat: 1,
          goals: { seat1: 0, seat2: 0 },
          penaltyGoals: { seat1: 0, seat2: 0 },
          normalQuestionsPerHalf: 6,
          normalQuestionsAnsweredInHalf: 2,
          normalQuestionsAnsweredTotal: 2,
          lastAttack: { attackerSeat: null },
          halftime: { deadlineAt: null, categoryOptions: [], bans: { seat1: null, seat2: null } },
          penalty: { round: 0, shooterSeat: 1, suddenDeath: false, kicksTaken: { seat1: 0, seat2: 0 } },
          currentQuestion: null,
          winnerDecisionMethod: null,
        },
        currentQuestion: null,
        answers: {},
      })
    );

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
      { user_id: 'u1', seat: 1, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 100, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(setPlayerForfeitWinTotalsMock).toHaveBeenCalledWith('m1', 'u2', 1000, 10);
    expect(setPlayerFinalTotalsMock).toHaveBeenCalledTimes(2);
    expect(setPlayerFinalTotalsMock).toHaveBeenCalledWith(
      'm1',
      'u1',
      expect.objectContaining({ totalPoints: 220, correctAnswers: 2, goals: 0, penaltyGoals: 0 })
    );
    expect(setPlayerFinalTotalsMock).toHaveBeenCalledWith(
      'm1',
      'u2',
      expect.objectContaining({ totalPoints: 140, correctAnswers: 1, goals: 0, penaltyGoals: 0 })
    );
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(updatePlayerAvgTimeMock).toHaveBeenCalledWith('m1', 'u1', null);
    expect(updatePlayerAvgTimeMock).toHaveBeenCalledWith('m1', 'u2', null);
    expect(socket.leave).toHaveBeenCalledWith('match:m1');
    expect(socket.data.matchId).toBeUndefined();
    expect((io.to as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('match:m1');
  });

  it('S26: match:rejoin resolves seat/opponent from cache without roster DB read', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', undefined);
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set(
      'match:cache:m1',
      JSON.stringify({
        matchId: 'm1',
        status: 'active',
        mode: 'friendly',
        totalQuestions: 10,
        categoryAId: 'cat1',
        categoryBId: 'cat2',
        startedAt: nowIso,
        players: [
          { userId: 'u2', seat: 1, totalPoints: 300, correctAnswers: 3, goals: 0, penaltyGoals: 0, avgTimeMs: null },
          { userId: 'u1', seat: 2, totalPoints: 200, correctAnswers: 2, goals: 0, penaltyGoals: 0, avgTimeMs: null },
        ],
        currentQIndex: 3,
        statePayload: {
          version: 1,
          phase: 'NORMAL_PLAY',
          half: 1,
          possessionDiff: 20,
          kickOffSeat: 1,
          goals: { seat1: 0, seat2: 0 },
          penaltyGoals: { seat1: 0, seat2: 0 },
          normalQuestionsPerHalf: 6,
          normalQuestionsAnsweredInHalf: 3,
          normalQuestionsAnsweredTotal: 3,
          lastAttack: { attackerSeat: null },
          halftime: { deadlineAt: null, categoryOptions: [], bans: { seat1: null, seat2: null } },
          penalty: { round: 0, shooterSeat: 1, suddenDeath: false, kicksTaken: { seat1: 0, seat2: 0 } },
          currentQuestion: null,
          winnerDecisionMethod: null,
        },
        currentQuestion: null,
        answers: {},
      })
    );

    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 3,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
    });

    await matchRealtimeService.handleMatchRejoin(io, socket, 'm1');

    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'match:start',
      expect.objectContaining({
        matchId: 'm1',
        mySeat: 2,
        opponent: expect.objectContaining({ id: 'u2' }),
      })
    );
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

  it('S22: persists clamped client timing and awards points deterministically', async () => {
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
        timeMs: 50,
        pointsEarned: 100,
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

  it('S24: beginMatchForLobby emits countdown and delays first question by 5s', async () => {
    vi.useFakeTimers();
    try {
      const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();

      await beginMatchForLobby(io, 'l1', 'm1');

      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
      expect((io.to as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([room]: [string]) => room === 'match:m1')).toBe(true);

      await vi.advanceTimersByTimeAsync(4999);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sendMatchQuestionMock).toHaveBeenCalledWith(io, 'm1', 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S25: beginMatchForLobby falls back to match players when lobby membership is stale', async () => {
    vi.useFakeTimers();
    try {
      const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();

      listMembersWithUserMock.mockResolvedValueOnce([
        { user_id: 'u1', nickname: 'u1', avatar_url: null },
      ]);

      await beginMatchForLobby(io, 'l1', 'm1');

      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
      const toCalls = (io.to as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(toCalls.some(([room]: [string]) => room === 'user:u1')).toBe(true);
      expect(toCalls.some(([room]: [string]) => room === 'user:u2')).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);
      expect(sendMatchQuestionMock).toHaveBeenCalledWith(io, 'm1', 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S29: beginMatchForLobby ranked emits opponent RP from ensured profiles', async () => {
    const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();

    getMatchMock.mockResolvedValueOnce({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 0,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
    });

    await beginMatchForLobby(io, 'l1', 'm1');

    expect(ensureProfileMock).toHaveBeenCalledWith('u1');
    expect(ensureProfileMock).toHaveBeenCalledWith('u2');
    const toCalls = (io.to as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(toCalls).toContain('user:u1');
    expect(toCalls).toContain('user:u2');

    const emitFns = (io.to as unknown as ReturnType<typeof vi.fn>).mock.results
      .map((result) => (result.value as { emit?: ReturnType<typeof vi.fn> } | undefined)?.emit)
      .filter((emit): emit is ReturnType<typeof vi.fn> => Boolean(emit));
    const emitCalls = emitFns.flatMap((emit) => emit.mock.calls).filter(([event]) => event === 'match:start');
    expect(emitCalls).toEqual(
      expect.arrayContaining([
        ['match:start', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u2', rp: 2222 }) })],
        ['match:start', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u1', rp: 1111 }) })],
      ])
    );
  });

  it('S30: play again creates a new friendly lobby with reset category settings and carried visibility', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u1', 'rematch-match-1');
    const io = createIoWithUserSocket('u1', socket);
    const rematchMembers: Array<{
      user_id: string;
      nickname: string;
      avatar_url: string | null;
      is_ready: boolean;
      joined_at: string;
    }> = [];

    getMatchMock.mockResolvedValue({
      id: 'rematch-match-1',
      mode: 'friendly',
      status: 'completed',
      current_q_index: 9,
      total_questions: 10,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      winner_user_id: 'u1',
      lobby_id: 'l1',
      state_payload: { variant: 'friendly_possession' },
    });

    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 400, correct_answers: 4, goals: 2, penalty_goals: 0, avg_time_ms: 1200 },
      { user_id: 'u2', seat: 2, total_points: 300, correct_answers: 3, goals: 1, penalty_goals: 0, avg_time_ms: 1400 },
    ]);

    addMemberMock.mockImplementation(async (_lobbyId: string, userId: string) => {
      rematchMembers.push({
        user_id: userId,
        nickname: userId,
        avatar_url: null,
        is_ready: false,
        joined_at: new Date().toISOString(),
      });
      return undefined;
    });

    countMembersMock.mockImplementation(async () => rematchMembers.length);

    listMembersWithUserMock.mockImplementation(async (lobbyId: string) => {
      if (lobbyId === 'rematch-lobby') {
        return rematchMembers;
      }
      return [
        { user_id: 'u1', nickname: 'u1', avatar_url: null },
        { user_id: 'u2', nickname: 'u2', avatar_url: null },
      ];
    });

    getLobbyByIdMock.mockImplementation(async (lobbyId: string) => {
      if (lobbyId === 'rematch-lobby') {
        return {
          id: 'rematch-lobby',
          invite_code: 'NEW123',
          mode: 'friendly',
          game_mode: 'friendly_possession',
          friendly_random: true,
          friendly_category_a_id: null,
          friendly_category_b_id: null,
          is_public: true,
          display_name: 'Rematch Lobby',
          host_user_id: 'u1',
          status: 'waiting',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      return {
        id: 'l1',
        invite_code: 'ROOM42',
        mode: 'friendly',
        game_mode: 'friendly_party_quiz',
        friendly_random: false,
        friendly_category_a_id: 'cat-a',
        friendly_category_b_id: null,
        is_public: true,
        display_name: 'Original Lobby',
        host_user_id: 'u1',
        status: 'closed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    await matchRealtimeService.handlePlayAgain(io, socket, { matchId: 'rematch-match-1' });

    expect(createLobbyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'friendly',
        hostUserId: 'u1',
        isPublic: true,
        gameMode: 'friendly_possession',
        friendlyRandom: true,
        friendlyCategoryAId: null,
        friendlyCategoryBId: null,
      })
    );
    expect(addMemberMock).toHaveBeenCalledWith('rematch-lobby', 'u1', false);
    expect(socket.leave).toHaveBeenCalledWith('match:rematch-match-1');
    expect(socket.join).toHaveBeenCalledWith('lobby:rematch-lobby');
    expect(socket.data.matchId).toBeUndefined();
    expect(socket.data.lobbyId).toBe('rematch-lobby');

    const emitCalls = (io.to as unknown as ReturnType<typeof vi.fn>).mock.results
      .map((result) => (result.value as { emit: ReturnType<typeof vi.fn> }).emit.mock.calls)
      .flat();
    expect(emitCalls).toContainEqual([
      'lobby:state',
      expect.objectContaining({
        lobbyId: 'rematch-lobby',
        isPublic: true,
        settings: expect.objectContaining({
          friendlyRandom: true,
          friendlyCategoryAId: null,
          friendlyCategoryBId: null,
        }),
      }),
    ]);
  });

  it('S31: later play again joins the existing rematch lobby and forces party quiz when the third player joins', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const hostSocket = createSocketMock('u1', 'rematch-match-2');
    const thirdPlayerSocket = createSocketMock('u3', 'rematch-match-2');
    const hostIo = createIoWithUserSocket('u1', hostSocket);
    const thirdPlayerIo = createIoWithUserSocket('u3', thirdPlayerSocket);

    const rematchMembers = new Map<string, Array<{
      user_id: string;
      nickname: string;
      avatar_url: string | null;
      is_ready: boolean;
      joined_at: string;
    }>>();

    getMatchMock.mockResolvedValue({
      id: 'rematch-match-2',
      mode: 'friendly',
      status: 'completed',
      current_q_index: 9,
      total_questions: 10,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      winner_user_id: 'u1',
      lobby_id: 'l1',
      state_payload: { variant: 'friendly_party_quiz' },
    });

    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 500, correct_answers: 5, goals: 0, penalty_goals: 0, avg_time_ms: 1000 },
      { user_id: 'u2', seat: 2, total_points: 420, correct_answers: 4, goals: 0, penalty_goals: 0, avg_time_ms: 1200 },
      { user_id: 'u3', seat: 3, total_points: 390, correct_answers: 4, goals: 0, penalty_goals: 0, avg_time_ms: 1100 },
    ]);

    createLobbyMock.mockResolvedValue({
      id: 'rematch-lobby-2',
      invite_code: 'REPLAY',
      mode: 'friendly',
      game_mode: 'friendly_possession',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
      is_public: false,
      display_name: 'Rematch Lobby',
      host_user_id: 'u1',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    addMemberMock.mockImplementation(async (lobbyId: string, userId: string) => {
      const current = rematchMembers.get(lobbyId) ?? [];
      if (!current.some((member) => member.user_id === userId)) {
        current.push({
          user_id: userId,
          nickname: userId,
          avatar_url: null,
          is_ready: userId !== 'u3',
          joined_at: new Date().toISOString(),
        });
      }
      rematchMembers.set(lobbyId, current);
      return undefined;
    });

    countMembersMock.mockImplementation(async (lobbyId: string) => (rematchMembers.get(lobbyId) ?? []).length);

    listMembersWithUserMock.mockImplementation(async (lobbyId: string) => {
      if (lobbyId === 'rematch-lobby-2') {
        return rematchMembers.get(lobbyId) ?? [];
      }
      return [
        { user_id: 'u1', nickname: 'u1', avatar_url: null },
        { user_id: 'u2', nickname: 'u2', avatar_url: null },
        { user_id: 'u3', nickname: 'u3', avatar_url: null },
      ];
    });

    getLobbyByIdMock.mockImplementation(async (lobbyId: string) => {
      if (lobbyId === 'rematch-lobby-2') {
        return {
          id: 'rematch-lobby-2',
          invite_code: 'REPLAY',
          mode: 'friendly',
          game_mode: 'friendly_possession',
          friendly_random: true,
          friendly_category_a_id: null,
          friendly_category_b_id: null,
          is_public: false,
          display_name: 'Rematch Lobby',
          host_user_id: 'u1',
          status: 'waiting',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      return {
        id: 'l1',
        invite_code: 'ROOM42',
        mode: 'friendly',
        game_mode: 'friendly_party_quiz',
        friendly_random: true,
        friendly_category_a_id: null,
        friendly_category_b_id: null,
        is_public: false,
        display_name: 'Original Lobby',
        host_user_id: 'u1',
        status: 'closed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    await matchRealtimeService.handlePlayAgain(hostIo, hostSocket, { matchId: 'rematch-match-2' });
    rematchMembers.set('rematch-lobby-2', [
      { user_id: 'u1', nickname: 'u1', avatar_url: null, is_ready: true, joined_at: new Date(Date.now() - 2000).toISOString() },
      { user_id: 'u2', nickname: 'u2', avatar_url: null, is_ready: true, joined_at: new Date(Date.now() - 1000).toISOString() },
    ]);
    await matchRealtimeService.handlePlayAgain(thirdPlayerIo, thirdPlayerSocket, { matchId: 'rematch-match-2' });

    expect(createLobbyMock).toHaveBeenCalledTimes(1);
    expect(addMemberMock).toHaveBeenCalledWith('rematch-lobby-2', 'u3', false);
    expect(updateLobbySettingsMock).toHaveBeenCalledWith(
      'rematch-lobby-2',
      expect.objectContaining({ gameMode: 'friendly_party_quiz' })
    );
    expect(thirdPlayerSocket.join).toHaveBeenCalledWith('lobby:rematch-lobby-2');
    expect(thirdPlayerSocket.data.lobbyId).toBe('rematch-lobby-2');
  });
});
