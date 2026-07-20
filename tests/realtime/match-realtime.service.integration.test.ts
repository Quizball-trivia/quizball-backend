import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const resolveRoundMock = vi.fn();
const sendMatchQuestionMock = vi.fn();
const deferPossessionQuestionTimerForPauseMock = vi.fn();
const resumePossessionMatchQuestionMock = vi.fn();
const ensurePossessionActiveTimersMock = vi.fn();
const resumePartyQuizQuestionMock = vi.fn();
const emitPossessionStateToSocketMock = vi.fn();
const emitPartyQuizStateToSocketMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const getLobbyByIdMock = vi.fn();
const createLobbyMock = vi.fn();
const addMemberMock = vi.fn();
const countMembersMock = vi.fn();
const updateLobbySettingsMock = vi.fn();
const setAllReadyMock = vi.fn();
const setLobbyStatusMock = vi.fn();
const removeMemberMock = vi.fn();
const removeMembersMock = vi.fn();
const prepareForLobbyEntryMock = vi.fn();

type FakeRedisStore = {
  values: Map<string, string>;
  ttls: Map<string, number>;
};

const fakeRedisStore: FakeRedisStore = {
  values: new Map(),
  ttls: new Map(),
};

const fakeRedis = {
  isOpen: false,
  async set(key: string, value: string, options?: { EX?: number; PX?: number; NX?: boolean }): Promise<'OK' | null> {
    if (options?.NX && fakeRedisStore.values.has(key)) {
      return null;
    }
    fakeRedisStore.values.set(key, value);
    const ttlSeconds = options?.EX ?? (options?.PX ? Math.ceil(options.PX / 1000) : null);
    if (ttlSeconds) {
      fakeRedisStore.ttls.set(key, ttlSeconds);
    } else {
      fakeRedisStore.ttls.delete(key);
    }
    return 'OK';
  },
  async mGet(keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => fakeRedisStore.values.get(key) ?? null);
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
  async ttl(key: string): Promise<number> {
    return fakeRedisStore.ttls.get(key) ?? -1;
  },
  async zScore(_key: string, _member: string): Promise<number | null> {
    // No persistent timers in this fake; tests don't exercise that path.
    return null;
  },
  async zAdd(_key: string, _entries: Array<{ score: number; value: string }>): Promise<number> {
    // Durable timer scheduling is a no-op here; resume/disconnect tests don't
    // assert on the realtime:timers zset.
    return 0;
  },
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (key: string, value: string, options?: { EX?: number; PX?: number; NX?: boolean }) => {
        ops.push(() => fakeRedis.set(key, value, options));
        return chain;
      },
      zAdd: (key: string, entries: Array<{ score: number; value: string }>) => {
        ops.push(() => fakeRedis.zAdd(key, entries));
        return chain;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op());
        return results;
      },
    };
    return chain;
  },
  async zRem(_key: string, _member: string): Promise<number> {
    return 0;
  },
  async eval(_script: string, payload: { keys: string[]; arguments: string[] }): Promise<number> {
    if (_script.includes('ZSCORE')) {
      // Scheduler cleanup script: no zset support in this fake → member is
      // never scheduled → delete the payload key (keys[1]).
      const payloadKey = payload.keys[1];
      if (payloadKey) fakeRedisStore.values.delete(payloadKey);
      return 1;
    }
    const key = payload.keys[0];
    const token = payload.arguments[0];
    if (!key || !token) return 0;
    if (fakeRedisStore.values.get(key) !== token) return 0;
    fakeRedisStore.values.delete(key);
    fakeRedisStore.ttls.delete(key);
    return 1;
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
const incrementGoalsAndInsertEventIfMissingMock = vi.fn();
const insertGoalEventIfMissingMock = vi.fn();
const listAnswersForQuestionMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const completeMatchMock = vi.fn();
const updatePlayerAvgTimeMock = vi.fn();
const setPlayerForfeitWinTotalsMock = vi.fn();
const setPlayerFinalTotalsMock = vi.fn();
const computeAvgTimesMock = vi.fn();
const abandonMatchMock = vi.fn();
const refundRankedTicketsMock = vi.fn();

const buildMatchQuestionPayloadMock = vi.fn();
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
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
    abandonMatch: (...args: unknown[]) => abandonMatchMock(...args),
    incrementGoalsAndInsertEventIfMissing: (...args: unknown[]) =>
      incrementGoalsAndInsertEventIfMissingMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
    updatePlayerGoalTotals: (...args: unknown[]) => updatePlayerGoalTotalsMock(...args),
    updatePlayerAvgTime: (...args: unknown[]) => updatePlayerAvgTimeMock(...args),
    setPlayerForfeitWinTotals: (...args: unknown[]) => setPlayerForfeitWinTotalsMock(...args),
    setPlayerFinalTotals: (...args: unknown[]) => setPlayerFinalTotalsMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {
    getAnswerForUser: (...args: unknown[]) => getAnswerForUserMock(...args),
    insertMatchAnswer: (...args: unknown[]) => insertMatchAnswerMock(...args),
    listAnswersForQuestion: (...args: unknown[]) => listAnswersForQuestionMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-questions.repo.js', () => ({
  matchQuestionsRepo: {
    getMatchQuestion: (...args: unknown[]) => getMatchQuestionMock(...args),
    getMatchQuestionTiming: (...args: unknown[]) => getMatchQuestionTimingMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-events.repo.js', () => ({
  matchEventsRepo: {
    insertGoalEventIfMissing: (...args: unknown[]) => insertGoalEventIfMissingMock(...args),
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
      // completeMatch moved from matches.repo to matches.service in the
      // layering-violation cleanup; tests still call it `completeMatchMock`
      // for continuity and assert call-site behavior, not implementation.
      completeMatch: (...args: unknown[]) => completeMatchMock(...args),
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
    removeMembers: (...args: unknown[]) => removeMembersMock(...args),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => {
  // ids starting with 'ai-' resolve as AI users so tests can model a
  // ranked-vs-AI opponent (whose synthetic presence exposed the reconnect_limit
  // forfeit bug that human-only mocks never hit).
  const getById = vi.fn(async (id: string) => ({
    id,
    nickname: id,
    avatar_url: null,
    is_ai: id.startsWith('ai-'),
  }));
  return {
    usersRepo: {
      getById,
      getByIds: vi.fn(async (ids: string[]) => {
        const usersById = new Map<string, Awaited<ReturnType<typeof getById>>>();
        for (const id of [...new Set(ids)]) {
          const user = await getById(id);
          if (user) usersById.set(id, user);
        }
        return usersById;
      }),
    },
  };
});

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    refundRankedTickets: (...args: unknown[]) => refundRankedTicketsMock(...args),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: (...args: unknown[]) => ensureProfileMock(...args),
    settleCompletedRankedMatch: (...args: unknown[]) => settleCompletedRankedMatchMock(...args),
    buildAiMatchContext: vi.fn(() => ({ aiAnchorRp: 1900 })),
    DEFAULT_AI_OPPONENT_RP: 1900,
  },
  parseRankedContext: vi.fn(() => ({ isPlacement: false, aiAnchorRp: 1900 })),
}));

vi.mock('../../src/modules/stats/stats.service.js', () => ({
  statsService: {
    getRecentFormForUser: vi.fn().mockResolvedValue([]),
    getRecentFormsForUsers: vi.fn(async (userIds: string[]) => new Map(
      userIds.map((userId) => [userId, []]),
    )),
  },
}));

vi.mock('../../src/modules/achievements/index.js', () => ({
  achievementsService: {
    listUnlockedForMatch: (...args: unknown[]) => listUnlockedForMatchMock(...args),
    evaluateForMatch: vi.fn(async () => ({})),
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

const devSkipToPossessionPhaseMock = vi.fn();
vi.mock('../../src/realtime/possession-dev-skip.js', () => ({
  devSkipToPossessionPhase: (...args: unknown[]) => devSkipToPossessionPhaseMock(...args),
}));

vi.mock('../../src/realtime/possession-match-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/possession-match-flow.js')>();
  return {
    ...actual,
    emitPossessionStateToSocket: (...args: unknown[]) => emitPossessionStateToSocketMock(...args),
    resumePossessionMatchQuestion: (...args: unknown[]) => resumePossessionMatchQuestionMock(...args),
    ensurePossessionActiveTimers: (...args: unknown[]) => ensurePossessionActiveTimersMock(...args),
    deferPossessionQuestionTimerForPause: (...args: unknown[]) => deferPossessionQuestionTimerForPauseMock(...args),
  };
});

vi.mock('../../src/realtime/party-quiz-match-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/party-quiz-match-flow.js')>();
  return {
    ...actual,
    emitPartyQuizStateToSocket: (...args: unknown[]) => emitPartyQuizStateToSocketMock(...args),
    resumePartyQuizQuestion: (...args: unknown[]) => resumePartyQuizQuestionMock(...args),
  };
});

function createIoMock(): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const inFn = vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) }));
  return {
    to,
    in: inFn,
  } as unknown as QuizballServer;
}

function createIoWithMatchSockets(matchId: string, userIds: string[]): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const sockets = userIds.map((userId) => ({
    id: `socket-${userId}`,
    data: {
      user: { id: userId, role: 'user' },
      matchId,
      connectedAt: Date.now() - 30_000,
    },
  }));
  const inFn = vi.fn((room: string) => ({
    fetchSockets: vi.fn(async () => (room === `match:${matchId}` ? sockets : [])),
    socketsJoin: vi.fn(async () => undefined),
  }));

  return {
    to,
    in: inFn,
  } as unknown as QuizballServer;
}

function createIoWithUserRooms(
  userSockets: Record<string, QuizballSocket[]>
): { io: QuizballServer; roomEmits: Map<string, ReturnType<typeof vi.fn>> } {
  const roomEmits = new Map<string, ReturnType<typeof vi.fn>>();
  const to = vi.fn((room: string) => {
    if (!roomEmits.has(room)) roomEmits.set(room, vi.fn());
    return { emit: roomEmits.get(room)! };
  });
  const inFn = vi.fn((room: string) => ({
    fetchSockets: vi.fn(async () =>
      room.startsWith('user:') ? userSockets[room.slice('user:'.length)] ?? [] : []
    ),
    socketsJoin: vi.fn(async () => undefined),
  }));
  return { io: { to, in: inFn } as unknown as QuizballServer, roomEmits };
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
    fakeRedisStore.ttls.clear();
    fakeRedis.isOpen = false;
    resolveRoundMock.mockResolvedValue(undefined);
    sendMatchQuestionMock.mockResolvedValue(undefined);
    resumePossessionMatchQuestionMock.mockResolvedValue(false);
    resumePartyQuizQuestionMock.mockResolvedValue(false);
    ensurePossessionActiveTimersMock.mockResolvedValue(true);
    emitPossessionStateToSocketMock.mockResolvedValue(undefined);
    emitPartyQuizStateToSocketMock.mockResolvedValue(undefined);
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1', nickname: 'u1', avatar_url: null },
      { user_id: 'u2', nickname: 'u2', avatar_url: null },
    ]);
    setLobbyStatusMock.mockResolvedValue(undefined);
    removeMemberMock.mockResolvedValue(undefined);
    removeMembersMock.mockResolvedValue(undefined);
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
    insertGoalEventIfMissingMock.mockResolvedValue(null);
    incrementGoalsAndInsertEventIfMissingMock.mockResolvedValue({ inserted: true, player: null });
    setMatchStatePayloadMock.mockResolvedValue(undefined);
    completeMatchMock.mockResolvedValue(undefined);
    updatePlayerAvgTimeMock.mockResolvedValue(undefined);
    setPlayerForfeitWinTotalsMock.mockResolvedValue(undefined);
    setPlayerFinalTotalsMock.mockResolvedValue(undefined);
    computeAvgTimesMock.mockResolvedValue(new Map());
    abandonMatchMock.mockResolvedValue(undefined);
    refundRankedTicketsMock.mockResolvedValue({ wallets: {} });
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

  it('re-emits kickoff UI-ready gate state to a reconnecting active socket', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const {
      acknowledgeMatchUiReady,
      clearMatchUiReadyGate,
      openMatchUiReadyGate,
    } = await import('../../src/realtime/match-ui-ready-gate.js');
    const io = createIoMock();
    const socket = createSocketMock('u1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 0,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', currentQuestion: null },
      ranked_context: null,
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 0, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 0, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);

    openMatchUiReadyGate({
      io,
      matchId: 'm1',
      phase: 'kickoff',
      waitingUserIds: ['u1', 'u2'],
      ceilingMs: 10_000,
      emitInitial: false,
      dispatch: vi.fn(),
    });
    acknowledgeMatchUiReady(io, 'u2', 'm1', 'kickoff');

    try {
      await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);

      expect(socket.join).toHaveBeenCalledWith('match:m1');
      expect(socket.emit).toHaveBeenCalledWith(
        'match:waiting_for_ready',
        expect.objectContaining({
          matchId: 'm1',
          phase: 'kickoff',
          readyCount: 1,
          totalCount: 2,
          readyUserIds: ['u2'],
          waitingUserIds: ['u1', 'u2'],
        })
      );
    } finally {
      clearMatchUiReadyGate('m1', 'kickoff');
    }
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
        remainingReconnects: 2,
      })
    );

    const toCalls = (io.to as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(toCalls.some(([room]: [string]) => room === 'user:u2')).toBe(true);
  });

  it('S15c: possession pause defers the question timeout backstop instead of cancelling it', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { cancelMatchQuestionTimer } = await import('../../src/realtime/match-flow.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    fakeRedis.isOpen = true;

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    // The paused round must KEEP a durable resolver: the question timer is
    // pushed back (90s backstop), never deleted. Cancelling it on pause is
    // what let matches freeze forever when the resume path was lost (prod
    // clue_chain freeze audit, Jun 2026).
    expect(deferPossessionQuestionTimerForPauseMock).toHaveBeenCalledWith('m1', 0, 90_000);
    expect(cancelMatchQuestionTimer).not.toHaveBeenCalled();
    expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
  });

  it('S15 safe-leave: match:leave while opponent is in grace does not self-forfeit', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { cancelMatchQuestionTimer } = await import('../../src/realtime/match-flow.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now() - 5_000));

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(fakeRedisStore.values.has('match:exit_pending:m1:u1')).toBe(true);
    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
    expect(fakeRedisStore.values.get('match:disconnect:m1:u2')).toBeTruthy();
    expect(socket.leave).toHaveBeenCalledWith('match:m1');
    expect(socket.data.matchId).toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalledWith('match:rejoin_available', expect.anything());
    expect(cancelMatchQuestionTimer).not.toHaveBeenCalled();
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S15 safe-leave: match:forfeit while opponent is in grace becomes an excused exit', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { cancelMatchQuestionTimer } = await import('../../src/realtime/match-flow.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now() - 5_000));

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(fakeRedisStore.values.has('match:exit_pending:m1:u1')).toBe(true);
    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
    expect(fakeRedisStore.values.get('match:disconnect:m1:u2')).toBeTruthy();
    expect(socket.leave).toHaveBeenCalledWith('match:m1');
    expect(socket.data.matchId).toBeUndefined();
    expect(cancelMatchQuestionTimer).not.toHaveBeenCalled();
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S15 reload race: a fresh replacement socket waits for resume UI ready before clearing disconnect', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const { recordMatchStagePresenceHeartbeat } =
        await import('../../src/realtime/services/match-stage-presence.service.js');
      const emit = vi.fn();
      const replacementSocket = {
        id: 'new-socket',
        data: {
          user: { id: 'u1', role: 'user' },
          matchId: 'm1',
          connectedAt: Date.now(),
        },
      };
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn((room: string) => ({
          fetchSockets: vi.fn(async () => (room === 'match:m1' ? [replacementSocket] : [])),
          socketsJoin: vi.fn(async () => undefined),
        })),
      } as unknown as QuizballServer;
      const oldSocket = createSocketMock('u1', 'm1') as QuizballSocket & { id: string };
      oldSocket.id = 'old-socket';
      oldSocket.data.connectedAt = Date.now() - 30_000;

      fakeRedis.isOpen = true;
      await recordMatchStagePresenceHeartbeat({
        matchId: 'm1',
        userId: 'u1',
        stageKey: 'question',
        socketId: 'new-socket',
      });

      await matchRealtimeService.handleMatchDisconnect(io, oldSocket);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
      expect(fakeRedisStore.values.has('match:grace:m1')).toBe(true);
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
      expect(emit).toHaveBeenCalledWith(
        'match:waiting_for_ready',
        expect.objectContaining({
          matchId: 'm1',
          phase: 'resume',
          readyCount: 0,
          totalCount: 2,
          readyUserIds: [],
          waitingUserIds: ['u1', 'u2'],
        })
      );

      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u2'), { matchId: 'm1' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
      expect(fakeRedisStore.values.has('match:grace:m1')).toBe(false);
      expect(emit).toHaveBeenCalledWith(
        'match:countdown',
        expect.objectContaining({
          matchId: 'm1',
          reason: 'resume',
          seconds: 5,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a recovered marker while keeping grace active for another disconnected player', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const { recordMatchStagePresenceHeartbeat } =
        await import('../../src/realtime/services/match-stage-presence.service.js');
      const emit = vi.fn();
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) })),
      } as unknown as QuizballServer;

      fakeRedis.isOpen = true;
      fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
      fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
      fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));
      fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now() - 5_000));

      await matchRealtimeService.resumePausedMatch(io, 'm1', 'u1');

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
      expect(fakeRedisStore.values.has('match:disconnect:m1:u2')).toBe(true);
      expect(fakeRedisStore.values.has('match:grace:m1')).toBe(true);
      expect(emit).toHaveBeenCalledWith(
        'match:opponent_disconnected',
        expect.objectContaining({ matchId: 'm1', opponentId: 'u2' })
      );

      await matchRealtimeService.resumePausedMatch(io, 'm1', 'u2');
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u2'), { matchId: 'm1' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u2')).toBe(false);
      expect(fakeRedisStore.values.has('match:grace:m1')).toBe(false);
      expect(emit).toHaveBeenCalledWith(
        'match:countdown',
        expect.objectContaining({ matchId: 'm1', reason: 'resume' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps grace active when another player disconnects while the resume UI-ready gate is open', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const { recordMatchStagePresenceHeartbeat } =
        await import('../../src/realtime/services/match-stage-presence.service.js');
      const emit = vi.fn();
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) })),
      } as unknown as QuizballServer;

      fakeRedis.isOpen = true;
      fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
      fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
      fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));

      await matchRealtimeService.resumePausedMatch(io, 'm1', 'u1');
      fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now()));
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u2'), { matchId: 'm1' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
      expect(fakeRedisStore.values.has('match:disconnect:m1:u2')).toBe(true);
      expect(fakeRedisStore.values.has('match:grace:m1')).toBe(true);
      expect(emit).not.toHaveBeenCalledWith(
        'match:countdown',
        expect.objectContaining({ matchId: 'm1', reason: 'resume' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not double-count the reconnect counter for one disconnect episode', async () => {
    // Regression: a single logical disconnect can drive the pause path more than
    // once (socket `disconnect` + `match:leave`). Each run used to increment the
    // reconnect counter, so two real disconnects forfeited a player after only 2
    // (limit is 3). With the match:disconnect marker as an episode guard, a
    // duplicate pause for the SAME episode must NOT re-increment.
    vi.useFakeTimers();
    try {
      const { pauseMatchForDisconnectedPlayer } = await import('../../src/realtime/services/match-disconnect.service.js');
      const emit = vi.fn();
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({
          fetchSockets: vi.fn(async () => []),
          socketsJoin: vi.fn(async () => undefined),
        })),
      } as unknown as QuizballServer;

      fakeRedis.isOpen = true;
      const countKey = 'match:reconnect_count:m1:u1';

      // First disconnect → increments to 1, sets the episode marker.
      await pauseMatchForDisconnectedPlayer(io, 'm1', 'u1', { ignoreSocketId: 'old' });
      expect(fakeRedisStore.values.get(countKey)).toBe('1');
      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);

      // Duplicate handler for the SAME episode (marker still present) → no bump.
      await pauseMatchForDisconnectedPlayer(io, 'm1', 'u1', { ignoreSocketId: 'old2' });
      expect(fakeRedisStore.values.get(countKey)).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a disconnect pause for a player with an excused exit pending', async () => {
    vi.useFakeTimers();
    try {
      const { pauseMatchForDisconnectedPlayer } = await import('../../src/realtime/services/match-disconnect.service.js');
      const emit = vi.fn();
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({
          fetchSockets: vi.fn(async () => []),
          socketsJoin: vi.fn(async () => undefined),
        })),
      } as unknown as QuizballServer;

      fakeRedis.isOpen = true;
      fakeRedisStore.values.set('match:exit_pending:m1:u1', JSON.stringify({ opponentId: 'u2' }));

      const result = await pauseMatchForDisconnectedPlayer(io, 'm1', 'u1', { ignoreSocketId: 'old' });

      expect(result).toEqual({
        graceMs: 30_000,
        remainingReconnects: 3,
        finalized: false,
      });
      expect(fakeRedisStore.values.has('match:reconnect_count:m1:u1')).toBe(false);
      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
      expect(emit).not.toHaveBeenCalledWith('match:opponent_disconnected', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15 reload race: an older same-user socket does not auto-resume a paused match', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const emit = vi.fn();
      const staleSocket = {
        id: 'stale-socket',
        data: {
          user: { id: 'u1', role: 'user' },
          matchId: 'm1',
          connectedAt: Date.now() - 30_000,
        },
      };
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn((room: string) => ({
          fetchSockets: vi.fn(async () => (room === 'match:m1' ? [staleSocket] : [])),
          socketsJoin: vi.fn(async () => undefined),
        })),
      } as unknown as QuizballServer;
      const disconnectingSocket = createSocketMock('u1', 'm1') as QuizballSocket & { id: string };
      disconnectingSocket.id = 'current-socket';
      disconnectingSocket.data.connectedAt = Date.now() - 5_000;

      fakeRedis.isOpen = true;

      await matchRealtimeService.handleMatchDisconnect(io, disconnectingSocket);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
      expect(fakeRedisStore.values.has('match:resume_countdown:m1')).toBe(false);
      expect(emit).toHaveBeenCalledWith(
        'match:opponent_disconnected',
        expect.objectContaining({
          matchId: 'm1',
          opponentId: 'u1',
          graceMs: 30_000,
        })
      );
      expect(emit).not.toHaveBeenCalledWith('match:countdown', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15 flapping: a zombie same-user socket aged past the skip threshold still arms pause and grace', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const emit = vi.fn();
      // Zombie left behind by an earlier skipped disconnect: in the room, aged >= 5s,
      // but its connection predates the socket that is disconnecting now.
      const zombieSocket = {
        id: 'zombie-socket',
        data: {
          user: { id: 'u1', role: 'user' },
          matchId: 'm1',
          connectedAt: Date.now() - 120_000,
        },
      };
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn((room: string) => ({
          fetchSockets: vi.fn(async () => (room === 'match:m1' ? [zombieSocket] : [])),
          socketsJoin: vi.fn(async () => undefined),
        })),
      } as unknown as QuizballServer;
      const flappingSocket = createSocketMock('u1', 'm1') as QuizballSocket & { id: string };
      flappingSocket.id = 'flapping-socket';
      flappingSocket.data.connectedAt = Date.now() - 10_000;

      fakeRedis.isOpen = true;

      await matchRealtimeService.handleMatchDisconnect(io, flappingSocket);

      // The pause must NOT be skipped: the only other same-user socket is older than
      // the disconnecting one, so it cannot prove the user is still present.
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
      expect(fakeRedisStore.values.has('match:resume_countdown:m1')).toBe(false);
      expect(emit).not.toHaveBeenCalledWith('match:countdown', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15 party reload race: same-user sockets do not auto-resume party quiz disconnects', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const { recordMatchStagePresenceHeartbeat } =
        await import('../../src/realtime/services/match-stage-presence.service.js');
      const emit = vi.fn();
      const replacementSocket = {
        id: 'new-socket',
        data: {
          user: { id: 'u1', role: 'user' },
          matchId: 'm1',
          connectedAt: Date.now(),
        },
      };
      const io = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn((room: string) => ({
          fetchSockets: vi.fn(async () => (room === 'match:m1' ? [replacementSocket] : [])),
          socketsJoin: vi.fn(async () => undefined),
        })),
      } as unknown as QuizballServer;
      const oldSocket = createSocketMock('u1', 'm1') as QuizballSocket & { id: string };
      oldSocket.id = 'old-socket';
      oldSocket.data.connectedAt = Date.now() - 30_000;

      fakeRedis.isOpen = true;
      await recordMatchStagePresenceHeartbeat({
        matchId: 'm1',
        userId: 'u1',
        stageKey: 'party_quiz',
        socketId: 'new-socket',
      });
      getMatchMock.mockResolvedValue({
        id: 'm1',
        mode: 'friendly',
        status: 'active',
        current_q_index: 2,
        total_questions: 10,
        started_at: new Date().toISOString(),
        lobby_id: 'l1',
        state_payload: {
          variant: 'friendly_party_quiz',
          currentQuestion: { qIndex: 2, correctIndex: 1 },
        },
      });
      listMatchPlayersMock.mockResolvedValue([
        { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
      ]);

      await matchRealtimeService.handleMatchDisconnect(io, oldSocket);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
      expect(fakeRedisStore.values.has('match:resume_countdown:m1')).toBe(false);
      expect(io.to).toHaveBeenCalledWith('user:u1');
      expect(emit).toHaveBeenCalledWith(
        'match:rejoin_available',
        expect.objectContaining({
          matchId: 'm1',
          variant: 'friendly_party_quiz',
          graceMs: 30000,
        })
      );
      expect(emit).not.toHaveBeenCalledWith('match:countdown', expect.anything());
      expect(resumePartyQuizQuestionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15a: match:leave rejects requested active matches where the socket user is not a participant', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u9');

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_NOT_ALLOWED' })
    );
    expect(socket.leave).not.toHaveBeenCalled();
    expect((io.to as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('user:u9');
  });

  it('S15a1: six-player party quiz leave pauses with shared grace and does not complete the match', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { cancelMatchQuestionTimer } = await import('../../src/realtime/match-flow.js');
    const io = createIoWithMatchSockets('m1', ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    const socket = createSocketMock('u1', 'm1');
    (socket as QuizballSocket & { id: string }).id = 'socket-u1';
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 2,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'friendly_party_quiz',
      },
    });
    listMatchPlayersMock.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        user_id: `u${index + 1}`,
        seat: index + 1,
        total_points: 100 - index,
        correct_answers: 1,
        goals: 0,
        penalty_goals: 0,
        avg_time_ms: null,
      }))
    );

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
    expect(fakeRedisStore.values.has('match:grace:m1')).toBe(true);
    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
    expect(cancelMatchQuestionTimer).toHaveBeenCalledWith('m1', 2);
    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(socket.leave).toHaveBeenCalledWith('match:m1');
    expect(socket.emit).toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.objectContaining({
        matchId: 'm1',
        graceMs: 30000,
      })
    );
  });

  it('S15a2: one party quiz disconnect expires, drops that player, and resumes with 3 active players', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoWithMatchSockets('m1', ['u2', 'u3', 'u4']);
      const socket = createSocketMock('u1', 'm1');
      const nowIso = new Date().toISOString();
      const activeMatch = {
        id: 'm1',
        mode: 'friendly',
        status: 'active',
        current_q_index: 2,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: {
          variant: 'friendly_party_quiz',
          currentQuestion: { qIndex: 2, correctIndex: 1 },
        },
      };

      fakeRedis.isOpen = true;
      getMatchMock.mockResolvedValue(activeMatch);
      listMatchPlayersMock.mockResolvedValue([
        { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u3', seat: 3, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u4', seat: 4, total_points: 50, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
      ]);

      await matchRealtimeService.handleMatchDisconnect(io, socket);
      expect(completeMatchMock).not.toHaveBeenCalled();

      vi.useRealTimers();
      const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
      await resolveExpiredGraceWindow(io, 'm1', 'u1');

      expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({
          droppedUserIds: ['u1'],
          answeredUserIds: [],
        }),
        2
      );
      expect(completeMatchMock).not.toHaveBeenCalled();
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(false);
      expect(resumePartyQuizQuestionMock).toHaveBeenCalledWith(io, 'm1', 2, expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15a3: three party quiz disconnects share one grace window, then the sole active player wins', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoWithMatchSockets('m1', ['u4']);
      const nowIso = new Date().toISOString();
      const activeMatch = {
        id: 'm1',
        mode: 'friendly',
        status: 'active',
        current_q_index: 2,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: {
          variant: 'friendly_party_quiz',
          currentQuestion: { qIndex: 2, correctIndex: 1 },
        },
      };
      const completedMatch = {
        ...activeMatch,
        status: 'completed',
        ended_at: new Date().toISOString(),
        winner_user_id: 'u4',
        state_payload: {
          variant: 'friendly_party_quiz',
          winnerDecisionMethod: 'forfeit',
          droppedUserIds: ['u1', 'u2', 'u3'],
        },
      };

      fakeRedis.isOpen = true;
      getMatchMock.mockResolvedValue(activeMatch).mockResolvedValueOnce(activeMatch);
      listMatchPlayersMock.mockResolvedValue([
        { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u3', seat: 3, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u4', seat: 4, total_points: 50, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
      ]);

      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u1', 'm1'));
      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u2', 'm1'));
      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u3', 'm1'));
      expect(fakeRedisStore.values.get('match:grace:m1')).toBeTruthy();

      getMatchMock.mockResolvedValue(completedMatch);
      getMatchMock.mockResolvedValueOnce(activeMatch).mockResolvedValueOnce(activeMatch);
      // The durable grace timer fires this on expiry. Run it under real timers so
      // the resolution's internal async (tracing/locks) isn't blocked by faked time.
      vi.useRealTimers();
      const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
      await resolveExpiredGraceWindow(io, 'm1', 'u1');

      expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({
          currentQuestion: null,
          answeredUserIds: [],
          droppedUserIds: ['u1', 'u2', 'u3'],
          winnerDecisionMethod: 'forfeit',
        }),
        2
      );
      expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15a4: all party quiz players disconnect, then highest current score wins after grace', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoWithMatchSockets('m1', []);
      const nowIso = new Date().toISOString();
      const activeMatch = {
        id: 'm1',
        mode: 'friendly',
        status: 'active',
        current_q_index: 2,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: {
          variant: 'friendly_party_quiz',
          currentQuestion: { qIndex: 2, correctIndex: 1 },
        },
      };
      const completedMatch = {
        ...activeMatch,
        status: 'completed',
        ended_at: new Date().toISOString(),
        winner_user_id: 'u2',
        state_payload: {
          variant: 'friendly_party_quiz',
          winnerDecisionMethod: 'total_points',
          droppedUserIds: ['u1', 'u2', 'u3', 'u4'],
        },
      };

      fakeRedis.isOpen = true;
      getMatchMock.mockResolvedValue(activeMatch);
      listMatchPlayersMock.mockResolvedValue([
        { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u2', seat: 2, total_points: 350, correct_answers: 4, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u3', seat: 3, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
        { user_id: 'u4', seat: 4, total_points: 50, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
      ]);

      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u1', 'm1'));
      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u2', 'm1'));
      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u3', 'm1'));
      await matchRealtimeService.handleMatchDisconnect(io, createSocketMock('u4', 'm1'));

      getMatchMock.mockResolvedValue(completedMatch);
      getMatchMock.mockResolvedValueOnce(activeMatch).mockResolvedValueOnce(activeMatch);
      // The durable grace timer fires this on expiry. Run it under real timers so
      // the resolution's internal async (tracing/locks) isn't blocked by faked time.
      vi.useRealTimers();
      const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
      await resolveExpiredGraceWindow(io, 'm1', 'u1');

      expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({
          currentQuestion: null,
          answeredUserIds: [],
          droppedUserIds: ['u1', 'u2', 'u3', 'u4'],
          winnerDecisionMethod: 'total_points',
        }),
        2
      );
      expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15a5: party quiz forfeit that leaves one active player emits pending win before results', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const roomEvents: Array<{ room: string; event: string; payload: unknown }> = [];
    const io = {
      to: vi.fn((room: string) => ({
        emit: (event: string, payload?: unknown) => {
          roomEvents.push({ room, event, payload });
        },
      })),
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) })),
    } as unknown as QuizballServer;
    const socket = createSocketMock('u1', 'm1');
    const activeMatch = {
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 2,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
      state_payload: {
        variant: 'friendly_party_quiz',
        currentQuestion: { qIndex: 2, correctIndex: 1 },
      },
    };

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue(activeMatch);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(roomEvents).toContainEqual({
      room: 'user:u2',
      event: 'match:forfeit_pending',
      payload: expect.objectContaining({
        matchId: 'm1',
        reason: 'opponent_forfeit',
      }),
    });
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
  });

  it('S15a6: party dropout merges the latest dropped state under the lock', async () => {
    const { applyPartyQuizDropouts } = await import('../../src/realtime/services/party-quiz-dropout.service.js');
    const roomEvents: Array<{ room: string; event: string; payload: unknown }> = [];
    const io = {
      to: vi.fn((room: string) => ({
        emit: (event: string, payload?: unknown) => {
          roomEvents.push({ room, event, payload });
        },
      })),
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) })),
    } as unknown as QuizballServer;
    const staleMatch = {
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 2,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
      state_payload: {
        variant: 'friendly_party_quiz',
        currentQuestion: { qIndex: 2, correctIndex: 1 },
        droppedUserIds: [],
      },
    };
    const latestMatch = {
      ...staleMatch,
      state_payload: {
        variant: 'friendly_party_quiz',
        currentQuestion: { qIndex: 2, correctIndex: 1 },
        droppedUserIds: ['u1'],
      },
    };
    const players = [
      { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u3', seat: 3, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u4', seat: 4, total_points: 50, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ];

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue(latestMatch);
    listMatchPlayersMock.mockResolvedValue(players);

    const result = await applyPartyQuizDropouts({
      io,
      match: staleMatch,
      players,
      droppedUserIds: ['u2'],
      reason: 'disconnect_timeout',
      resumeIfContinuing: false,
    });

    expect(result).toEqual({ completed: false, continued: true, activeCount: 2 });
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        droppedUserIds: ['u1', 'u2'],
      }),
      2
    );
    expect(roomEvents).toContainEqual({
      room: 'user:u2',
      event: 'match:party_dropout',
      payload: expect.objectContaining({ matchId: 'm1', reason: 'disconnect_timeout' }),
    });
  });

  it('S15a7: already-dropped party forfeit does not cancel the active question timer', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { cancelMatchQuestionTimer } = await import('../../src/realtime/match-flow.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const activeMatch = {
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 2,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
      state_payload: {
        variant: 'friendly_party_quiz',
        currentQuestion: { qIndex: 2, correctIndex: 1 },
        droppedUserIds: ['u1'],
      },
    };

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue(activeMatch);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u3', seat: 3, total_points: 200, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(cancelMatchQuestionTimer).not.toHaveBeenCalledWith('m1', 2);
    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S15b: ranked all-disconnected grace completes by existing points before forfeit/abandon', async () => {
    {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();
      const socket = createSocketMock('u1', 'm1');
      const nowIso = new Date().toISOString();

      fakeRedis.isOpen = true;
      getMatchMock.mockResolvedValue({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        current_q_index: 0,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: {
          variant: 'ranked_sim',
          winnerDecisionMethod: null,
        },
      });

      const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');

      await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

      fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now()));
      // The durable grace timer would fire this on expiry; invoke its handler
      // directly (real timers — no 60s wall-clock wait needed).
      await resolveExpiredGraceWindow(io, 'm1', 'u1');

      expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u1');
      expect(settleCompletedRankedMatchMock).toHaveBeenCalledWith('m1');
      expect(abandonMatchMock).not.toHaveBeenCalled();
    }
  });

  it('S15b2: a late grace timer no-ops after its disconnect marker was cleared', async () => {
    const io = createIoMock();
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 4,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 100, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 80, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);

    // The durable callback may already be dequeued when reconnect cleanup clears
    // its marker, so the handler itself must reject the resolved episode.
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 60_000));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    expect(ensurePossessionActiveTimersMock).not.toHaveBeenCalled();
    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(abandonMatchMock).not.toHaveBeenCalled();
  });

  it('S15b1: ranked all-disconnected does not abandon while shared completion lock is held', async () => {
    {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();
      const socket = createSocketMock('u1', 'm1');
      const nowIso = new Date().toISOString();

      fakeRedis.isOpen = true;
      getMatchMock.mockResolvedValue({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        current_q_index: 0,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
      });

      const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');

      await matchRealtimeService.handleMatchLeave(io, socket, 'm1');
      fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now()));
      // Simulate another resolver already holding the shared completion lock.
      // The grace handler must NOT fall through to abandon.
      fakeRedisStore.values.set('lock:match:m1:complete', 'someone-else');

      await resolveExpiredGraceWindow(io, 'm1', 'u1');

      expect(abandonMatchMock).not.toHaveBeenCalled();
      expect(completeMatchMock).not.toHaveBeenCalled();
    }
  });

  it('S15b3: grace expiry forfeits the absent player even when they lead on points', async () => {
    // u1 (200 pts, points leader) disconnected and never came back; u2 (100
    // pts) stayed connected the whole time. The absent player must ALWAYS
    // lose by forfeit — the progress-based decision must not hand the
    // disconnector a win on total points (the mid-penalty-shootout bug).
    const io = createIoWithMatchSockets('m1', ['u2']);
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 14,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 60_000));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    // Present player u2 wins by forfeit despite trailing on total points.
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
    expect(settleCompletedRankedMatchMock).toHaveBeenCalledWith('m1');
    expect(abandonMatchMock).not.toHaveBeenCalled();
  });

  it('S15b4: a fresh reconnect socket gets ONE deferral, then forfeits if it never rejoins', async () => {
    // Token-refresh reconnect storm: both players flapped (markers set), both
    // re-authenticated FRESH sockets (connectedAt AFTER the markers) but neither
    // completed the match:rejoin handshake. New contract: a genuine reconnect
    // is not forfeited on the first grace fire — it gets one bounded UI-ready
    // window (rejoin nudge + re-armed timer). If that window also lapses with
    // the markers still set, the next fire forfeits (zombie / never-rejoined).
    const markerMs = Date.now() - 60_000;
    const s1 = createSocketMock('u1');
    const s2 = createSocketMock('u2');
    s1.data.connectedAt = markerMs + 5_000; // reconnected AFTER the marker
    s2.data.connectedAt = markerMs + 5_000;
    const { io, roomEmits } = createIoWithUserRooms({ u1: [s1], u2: [s2] });
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 8,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    fakeRedisStore.values.set('match:grace:m1', String(markerMs));
    fakeRedisStore.values.set('match:pause:m1', String(markerMs));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(markerMs));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(markerMs));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');

    // First fire: DEFER. No terminal resolution; grace + extended flag survive.
    await resolveExpiredGraceWindow(io, 'm1', 'u1');
    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(fakeRedisStore.values.has('match:grace:m1')).toBe(true);
    expect(fakeRedisStore.values.has('match:grace_extended:m1')).toBe(true);
    // The deferred players were nudged to rejoin.
    const u1Emits = roomEmits.get('user:u1');
    expect(u1Emits).toBeDefined();
    expect(u1Emits!).toHaveBeenCalledWith('match:rejoin_available', expect.objectContaining({ matchId: 'm1' }));

    // Second fire (extended window lapsed, still no rejoin → markers intact):
    // now forfeit. No auto-resume into gameplay from generic sockets.
    await resolveExpiredGraceWindow(io, 'm1', 'u1');
    expect(s1.join).not.toHaveBeenCalledWith('match:m1');
    expect(s2.join).not.toHaveBeenCalledWith('match:m1');
    const allEmitCalls = [...roomEmits.values()].flatMap((emitFn) => emitFn.mock.calls);
    expect(allEmitCalls).not.toContainEqual([
      'match:countdown',
      expect.objectContaining({ matchId: 'm1', reason: 'resume' }),
    ]);
    expect(completeMatchMock.mock.calls.length + abandonMatchMock.mock.calls.length).toBe(1);
  });

  it('S15b4a: a reachable fresh socket that fails to rejoin is forfeited after the deferral window', async () => {
    // u1 reconnected (fresh socket) but its rejoin will fail; u2 likewise.
    // First fire defers; the second resolves terminally (no resume) because the
    // markers were never cleared by a successful rejoin.
    const markerMs = Date.now() - 60_000;
    const s1 = createSocketMock('u1');
    const s2 = createSocketMock('u2');
    s1.data.connectedAt = markerMs + 5_000;
    s2.data.connectedAt = markerMs + 5_000;
    (s1.join as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('socket gone');
    });
    const { io, roomEmits } = createIoWithUserRooms({ u1: [s1], u2: [s2] });
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 8,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    fakeRedisStore.values.set('match:grace:m1', String(markerMs));
    fakeRedisStore.values.set('match:pause:m1', String(markerMs));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(markerMs));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(markerMs));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');

    // First fire defers (no terminal resolution yet).
    await resolveExpiredGraceWindow(io, 'm1', 'u1');
    expect(completeMatchMock).not.toHaveBeenCalled();

    // Second fire resolves terminally; never a resume countdown.
    await resolveExpiredGraceWindow(io, 'm1', 'u1');
    expect(roomEmits.get('match:m1') ?? vi.fn()).not.toHaveBeenCalledWith(
      'match:countdown',
      expect.objectContaining({ reason: 'resume' })
    );
    expect(completeMatchMock).toHaveBeenCalled();
  });

  it('S15b4b: kickoff gate grace expiry gives a live reconnected socket one bounded extension', async () => {
    const markerMs = Date.now() - 60_000;
    const socket = createSocketMock('u1');
    socket.data.connectedAt = markerMs + 5_000;
    const { io, roomEmits } = createIoWithUserRooms({ u1: [socket] });
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 0,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', currentQuestion: null, winnerDecisionMethod: null },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 0, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 0, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);
    getMatchQuestionMock.mockResolvedValue(null);
    buildMatchQuestionPayloadMock.mockResolvedValue(null);
    abandonMatchMock.mockResolvedValue(true);
    fakeRedisStore.values.set('match:grace:m1', String(markerMs));
    fakeRedisStore.values.set('match:pause:m1', String(markerMs));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(markerMs));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');

    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(fakeRedisStore.values.has('match:grace:m1')).toBe(true);
    expect(fakeRedisStore.values.has('match:grace_extended:m1')).toBe(true);
    const userEmit = roomEmits.get('user:u1');
    expect(userEmit).toBeDefined();
    expect(userEmit!).toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.objectContaining({ matchId: 'm1', graceMs: 20_000 })
    );

    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    expect(abandonMatchMock).toHaveBeenCalledWith('m1');
    expect(fakeRedisStore.values.has('match:grace:m1')).toBe(false);
  });

  it('S15b4c: kickoff gate grace expiry with no live socket still abandons', async () => {
    const markerMs = Date.now() - 60_000;
    const { io } = createIoWithUserRooms({});
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 0,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', currentQuestion: null, winnerDecisionMethod: null },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 0, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 0, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);
    getMatchQuestionMock.mockResolvedValue(null);
    buildMatchQuestionPayloadMock.mockResolvedValue(null);
    abandonMatchMock.mockResolvedValue(true);
    fakeRedisStore.values.set('match:grace:m1', String(markerMs));
    fakeRedisStore.values.set('match:pause:m1', String(markerMs));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(markerMs));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    expect(fakeRedisStore.values.has('match:grace_extended:m1')).toBe(false);
    expect(abandonMatchMock).toHaveBeenCalledWith('m1');
  });

  it('S15b5: grace expiry forfeits the truly-gone player when the other is reachable via a user-room socket only', async () => {
    // u1 vanished entirely. u2's socket re-authenticated (user room) but never
    // re-entered the match room and has no presence key — previously u2 looked
    // absent too and the match fell into the progress fallback (points leader
    // u1 would win). u2 must be treated as present and win by forfeit.
    const s2 = createSocketMock('u2');
    const { io } = createIoWithUserRooms({ u2: [s2] });
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 8,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 60_000));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    // u2 (100 pts, trailing) wins by forfeit; u1's points lead is irrelevant.
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
    expect(abandonMatchMock).not.toHaveBeenCalled();
  });

  it('S15b6: grace expiry does NOT auto-resume for a zombie socket that predates the disconnect marker', async () => {
    // u1 left the match (match:leave) — their socket is still alive in the
    // menus, but it CONNECTED BEFORE the disconnect marker was written. That
    // is not a reconnect; u1 must still forfeit, not get yanked back in.
    const zombie = createSocketMock('u1');
    zombie.data.connectedAt = Date.now() - 300_000; // long before the marker
    const { io } = createIoWithUserRooms({ u1: [zombie], u2: [createSocketMock('u2')] });
    // u2 reachable via fresh user-room socket so the forfeit path can attribute the win.
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 8,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 60_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 60_000));

    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
    await resolveExpiredGraceWindow(io, 'm1', 'u1');

    // No resume: u1 forfeits, u2 wins.
    expect(zombie.join).not.toHaveBeenCalledWith('match:m1');
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
  });

  it('S15i: disconnect of a socket without a match binding still pauses the user active match (DB fallback)', async () => {
    // A reconnected socket that re-authenticated but never completed
    // match:rejoin has no socket.data.matchId. Its disconnect used to no-op
    // silently — no pause, no grace timer. The DB fallback must find the
    // user's active match and arm the pause flow.
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1'); // NOTE: no matchId bound
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    const activeMatch = {
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 4,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    };
    getActiveMatchForUserMock.mockResolvedValue(activeMatch);
    getMatchMock.mockResolvedValue(activeMatch);

    await matchRealtimeService.handleMatchDisconnect(io, socket);

    expect(getActiveMatchForUserMock).toHaveBeenCalledWith('u1');
    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
    expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
  });

  it('skips the active-match DB fallback for a socket still bound to a lobby', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1');
    socket.data.lobbyId = 'lobby-1';

    await matchRealtimeService.handleMatchDisconnect(io, socket);

    expect(getActiveMatchForUserMock).not.toHaveBeenCalled();
    expect(getMatchMock).not.toHaveBeenCalled();
  });

  it('S15i3: disconnect without a match binding never pauses a party-quiz match', async () => {
    // Party quiz has no stable-live-socket pause guard — a binding-less
    // menu/re-auth socket disconnect must not arm pause/grace for a live
    // N-player match.
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1'); // no matchId bound
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 2,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'friendly_party_quiz' },
    });

    await matchRealtimeService.handleMatchDisconnect(io, socket);

    expect(fakeRedisStore.values.has('match:pause:m1')).toBe(false);
    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
  });

  it('S15i1: disconnect without a match binding no-ops for users with no active match', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1');

    fakeRedis.isOpen = true;
    getActiveMatchForUserMock.mockResolvedValue(null);

    await matchRealtimeService.handleMatchDisconnect(io, socket);

    expect(fakeRedisStore.values.has('match:pause:m1')).toBe(false);
    expect(getMatchMock).not.toHaveBeenCalled();
  });

  it('S15i2: match disconnect retries a busy transition lock instead of dropping the pause', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
      const io = createIoMock();
      const socket = createSocketMock('u1', 'm1');
      const nowIso = new Date().toISOString();

      fakeRedis.isOpen = true;
      getMatchMock.mockResolvedValue({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        current_q_index: 4,
        total_questions: 12,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
      });

      // Lock busy on the first attempt, free on the second.
      const lockMock = userSessionGuardService.runWithUserTransitionLock as ReturnType<typeof vi.fn>;
      lockMock.mockResolvedValueOnce(false);

      const pending = matchRealtimeService.handleMatchDisconnect(io, socket);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(lockMock).toHaveBeenCalledTimes(2);
      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15d2: reconnect-limit exceeded forfeits the disconnector when the opponent is still present', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    // u2 still has a live match-room socket; u1 burns their 4th disconnect.
    const io = createIoWithMatchSockets('m1', ['u2']);
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '3');
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      // >= 2 rounds played → the normal forfeit penalty applies (not a no-contest cancel).
      current_q_index: 2,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    // u1 leads on points (200 vs 100) but must still lose by forfeit.
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
    expect(abandonMatchMock).not.toHaveBeenCalled();
  });

  it('S15d4: reconnect-limit exceeded vs an AI opponent forfeits the human even while they lead (the ranked-vs-AI bug)', async () => {
    // Reproduces the EXACT staging bug: tazi was matched vs an AI, disconnected
    // past the limit while leading 2-0, and WON on goals instead of forfeiting.
    // The AI opponent (ai-bot) has only synthetic presence and no match-room
    // socket; combined with the human's racing reconnect, the presence fork
    // could not isolate a single absent player and fell to complete-from-progress
    // → the leading limit-breaker won. The fix forfeits the known limit-breaker
    // directly regardless of presence or whether the opponent is an AI.
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');

    const u1UserRoomSocket = createSocketMock('u1'); // human reconnected: user-room socket only
    const emit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit })),
      in: vi.fn((room: string) => ({
        // No match-room sockets (AI has none; human only has a user-room socket).
        fetchSockets: vi.fn(async () => (room === 'user:u1' ? [u1UserRoomSocket] : [])),
        socketsJoin: vi.fn(async () => undefined),
      })),
    } as unknown as QuizballServer;
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    // Roster: human u1 (seat1) vs AI ai-bot (seat2).
    listMatchPlayersMock.mockResolvedValue([
      { match_id: 'm1', user_id: 'u1', seat: 1, total_points: 280, correct_answers: 4, avg_time_ms: null, goals: 2, penalty_goals: 0 },
      { match_id: 'm1', user_id: 'ai-bot', seat: 2, total_points: 170, correct_answers: 3, avg_time_ms: null, goals: 0, penalty_goals: 0 },
    ]);

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '4'); // 4th disconnect = limit exceeded (>3)
    fakeRedisStore.values.delete('match:disconnect:m1:u1');         // racing reconnect cleared the marker
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 8, // u1 leads 2-0 on goals
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    // u1 exceeded the limit → forfeit; the AI is the winner. Must NOT complete on
    // goals (which would hand the leading limit-breaker the win).
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'ai-bot');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
    expect(completeMatchMock).not.toHaveBeenCalledWith('m1', 'u1');
  });

  it('S15d5: reconnect-limit exceeded vs a HUMAN opponent still forfeits the limit-breaker (regression)', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoWithMatchSockets('m1', ['u2']); // human opponent present in the match room
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '4');
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 6,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
    expect(completeMatchMock).not.toHaveBeenCalledWith('m1', 'u1');
  });

  it('S15d3: ranked forfeit before 2 rounds cancels the match as a no-contest (abandon, no winner)', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoWithMatchSockets('m1', ['u2']);
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '3');
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      // Only 1 round played (index 1 < 2) → no-contest cancel, RP unchanged.
      current_q_index: 1,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    // Cancelled as a no-contest: abandoned, never completed with a winner.
    expect(abandonMatchMock).toHaveBeenCalledWith('m1');
    expect(completeMatchMock).not.toHaveBeenCalled();
    // TEST-E2: the early-forfeit no-contest refunds both humans' tickets.
    expect(refundRankedTicketsMock).toHaveBeenCalledWith(expect.arrayContaining(['u1', 'u2']));
  });

  it('S15c: rejoin resumes the active possession question instead of force-resolving it', async () => {
    vi.useFakeTimers();
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u1');
    const io = createIoWithUserSocket('u1', socket);
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));

    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });
    getMatchQuestionMock.mockResolvedValue({
      match_id: 'm1',
      q_index: 3,
    });
    resumePossessionMatchQuestionMock.mockResolvedValue(true);

    try {
      await matchRealtimeService.handleMatchRejoin(io, socket, 'm1');

      expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
      expect(resolveRoundMock).not.toHaveBeenCalled();
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u2'), { matchId: 'm1' });

      // The countdown completion is a durable realtime timer now (restart
      // proof) — fire its handler the way the scheduler would after 5s.
      const { completeResumeCountdown } = await import('../../src/realtime/services/match-disconnect.service.js');
      await completeResumeCountdown(io, 'm1', null);

      expect(resumePossessionMatchQuestionMock).toHaveBeenCalledWith(
        io,
        'm1',
        3,
        expect.any(Number)
      );
      expect(resolveRoundMock).not.toHaveBeenCalled();
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15c0: resume emits refreshed party question timing before clearing pause', async () => {
    vi.useFakeTimers();
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const events: string[] = [];
    const emit = vi.fn((event: string) => {
      if (event === 'match:question' || event === 'match:resume') {
        events.push(event);
      }
    });
    const io = {
      to: vi.fn(() => ({ emit })),
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []), socketsJoin: vi.fn(async () => undefined) })),
    } as unknown as QuizballServer;
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 3,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'friendly_party_quiz',
      },
      ranked_context: null,
    });
    getMatchQuestionMock.mockResolvedValue({
      match_id: 'm1',
      q_index: 3,
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 250, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ]);
    resumePartyQuizQuestionMock.mockImplementation(async () => {
      events.push('match:question');
      return true;
    });

    try {
      await matchRealtimeService.resumePausedMatch(io, 'm1', 'u1');
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await matchRealtimeService.handleResumeUiReady(io, createSocketMock('u2'), { matchId: 'm1' });
      // The countdown completion is a durable realtime timer now (restart
      // proof) — fire its handler the way the scheduler would after 5s.
      const { completeResumeCountdown } = await import('../../src/realtime/services/match-disconnect.service.js');
      await completeResumeCountdown(io, 'm1', Date.now() - 5_000);

      expect(resumePartyQuizQuestionMock).toHaveBeenCalledWith(
        io,
        'm1',
        3,
        expect.any(Number)
      );
      expect(events).toEqual(['match:question', 'match:resume']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S15c1: passive socket reconnect only offers rejoin and does not resume a paused match', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '1');
    fakeRedisStore.ttls.set('match:grace:m1', 42);

    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });

    await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);

    expect(socket.emit).toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.objectContaining({
        matchId: 'm1',
        graceMs: expect.any(Number),
        remainingReconnects: 2,
      })
    );
    const rejoinPayload = (socket.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === 'match:rejoin_available'
    )?.[1] as { graceMs?: number } | undefined;
    expect(rejoinPayload?.graceMs).toBeLessThanOrEqual(30_000);
    expect(socket.emit).not.toHaveBeenCalledWith('match:start', expect.anything());
    expect(socket.join).not.toHaveBeenCalledWith('match:m1');
    expect(socket.data.matchId).toBeUndefined();
    expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
  });

  it('S15c2: passive socket reconnect for remaining player keeps pause visible', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u2');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '1');
    fakeRedisStore.ttls.set('match:grace:m1', 42);

    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });

    await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);

    expect(socket.emit).toHaveBeenCalledWith('match:start', expect.objectContaining({ matchId: 'm1' }));
    expect(socket.emit).toHaveBeenCalledWith(
      'match:opponent_disconnected',
      expect.objectContaining({
        matchId: 'm1',
        opponentId: 'u1',
        graceMs: expect.any(Number),
        remainingReconnects: 2,
      })
    );
    const opponentDisconnectedPayload = (socket.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === 'match:opponent_disconnected'
    )?.[1] as { graceMs?: number } | undefined;
    expect(opponentDisconnectedPayload?.graceMs).toBeLessThanOrEqual(30_000);
    expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
  });

  it('S15c3: bare replacement match socket without stage presence still pauses', async () => {
    const { pauseMatchForDisconnectedPlayer } =
      await import('../../src/realtime/services/match-disconnect.service.js');
    const io = createIoWithMatchSockets('m1', ['u1']);
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
        phase: 'NORMAL_PLAY',
        currentQuestion: {
          qIndex: 3,
          phaseKind: 'normal',
          phaseRound: 3,
          shooterSeat: null,
          attackerSeat: null,
        },
      },
      ranked_context: null,
    });

    await pauseMatchForDisconnectedPlayer(io, 'm1', 'u1', {
      ignoreSocketId: 'old-socket',
      disconnectedConnectedAt: Date.now() - 60_000,
      autoResumeReplacementSocket: true,
    });

    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
    expect(deferPossessionQuestionTimerForPauseMock).toHaveBeenCalled();
  });

  it('S15c4: socket-scoped match UI presence can suppress a stale disconnect', async () => {
    const { pauseMatchForDisconnectedPlayer } =
      await import('../../src/realtime/services/match-disconnect.service.js');
    const { recordMatchStagePresenceHeartbeat } =
      await import('../../src/realtime/services/match-stage-presence.service.js');
    const io = createIoWithMatchSockets('m1', ['u1']);
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    await recordMatchStagePresenceHeartbeat({
      matchId: 'm1',
      userId: 'u1',
      stageKey: 'question',
      socketId: 'socket-u1',
    });
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
        phase: 'NORMAL_PLAY',
        currentQuestion: {
          qIndex: 3,
          phaseKind: 'normal',
          phaseRound: 3,
          shooterSeat: null,
          attackerSeat: null,
        },
      },
      ranked_context: null,
    });

    await pauseMatchForDisconnectedPlayer(io, 'm1', 'u1', {
      ignoreSocketId: 'old-socket',
      disconnectedConnectedAt: Date.now() - 60_000,
      autoResumeReplacementSocket: true,
    });

    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
    expect(deferPossessionQuestionTimerForPauseMock).not.toHaveBeenCalled();
  });

  it('S15d: fourth disconnect forfeits immediately without emitting rejoin_available', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:reconnect_count:m1:u1', '3');
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      // >= 2 rounds so this is a real forfeit (not an early no-contest cancel).
      current_q_index: 5,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
        winnerDecisionMethod: null,
      },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    // u1 is the leaver who exceeded the limit → u1 FORFEITS, the opponent (u2)
    // wins. The forfeiter must never be awarded the win — even though u1 leads on
    // points (200 vs 100), which previously let the progress branch hand u1 the
    // win (the reconnect_limit / progress bug this fix closes).
    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
    expect(completeMatchMock).not.toHaveBeenCalledWith('m1', 'u1');
    expect(socket.emit).not.toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.anything()
    );
  });

  it('S15e: rejoin while opponent is still disconnected keeps the match paused and reports remaining reconnects', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u1');
    const io = createIoWithUserSocket('u1', socket);
    const nowIso = new Date().toISOString();
    const userRoomEmit = vi.fn();
    (io.to as unknown as ReturnType<typeof vi.fn>).mockImplementation((room: string) => ({
      emit: room === 'user:u1' ? userRoomEmit : vi.fn(),
    }));

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:disconnect:m1:u1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now() - 4_000));
    fakeRedisStore.values.set('match:reconnect_count:m1:u2', '2');
    fakeRedisStore.ttls.set('match:grace:m1', 42);
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));

    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });

    await matchRealtimeService.handleMatchRejoin(io, socket, 'm1');

    expect(userRoomEmit).toHaveBeenCalledWith(
      'match:opponent_disconnected',
      expect.objectContaining({
        matchId: 'm1',
        opponentId: 'u2',
        graceMs: expect.any(Number),
        remainingReconnects: 1,
      })
    );
    const opponentDisconnectedPayload = userRoomEmit.mock.calls.find(
      ([event]) => event === 'match:opponent_disconnected'
    )?.[1] as { graceMs?: number } | undefined;
    expect(opponentDisconnectedPayload?.graceMs).toBeLessThanOrEqual(30_000);
    expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
  });

  it('S15e safe-leave: opponent rejoin converts an excused exit into normal grace for the leaver', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u2');
    const io = createIoWithUserSocket('u2', socket);
    const nowIso = new Date().toISOString();
    const roomEvents: Array<{ room: string; event: string; payload: unknown }> = [];
    (io.to as unknown as ReturnType<typeof vi.fn>).mockImplementation((room: string) => ({
      emit: (event: string, payload?: unknown) => {
        roomEvents.push({ room, event, payload });
      },
    }));

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 1_000));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now() - 5_000));
    fakeRedisStore.values.set('match:exit_pending:m1:u1', JSON.stringify({ opponentId: 'u2' }));

    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
      ranked_context: null,
    });

    await matchRealtimeService.handleMatchRejoin(io, socket, 'm1');

    expect(fakeRedisStore.values.has('match:disconnect:m1:u2')).toBe(false);
    expect(fakeRedisStore.values.has('match:exit_pending:m1:u1')).toBe(false);
    expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(true);
    expect(roomEvents).toContainEqual({
      room: 'user:u1',
      event: 'match:rejoin_available',
      payload: expect.objectContaining({ matchId: 'm1', graceMs: 30_000 }),
    });
    expect(roomEvents).toContainEqual({
      room: 'user:u2',
      event: 'match:opponent_disconnected',
      payload: expect.objectContaining({ matchId: 'm1', opponentId: 'u1' }),
    });
    expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
  });

  it('S15e safe-leave: grace expiry treats exit_pending as present and forfeits the original disconnector', async () => {
    const { resolveExpiredGraceWindow } = await import('../../src/realtime/services/match-disconnect.service.js');
    const io = createIoMock();
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now() - 65_000));
    fakeRedisStore.values.set('match:grace:m1', String(Date.now() - 65_000));
    fakeRedisStore.values.set('match:disconnect:m1:u2', String(Date.now() - 65_000));
    fakeRedisStore.values.set('match:exit_pending:m1:u1', JSON.stringify({ opponentId: 'u2' }));
    getMatchMock
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        current_q_index: 4,
        total_questions: 12,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: {
          variant: 'ranked_sim',
          winnerDecisionMethod: null,
        },
        ranked_context: null,
      })
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        current_q_index: 4,
        total_questions: 12,
        started_at: nowIso,
        lobby_id: 'l1',
        state_payload: {
          variant: 'ranked_sim',
          winnerDecisionMethod: null,
        },
        ranked_context: null,
      })
      .mockResolvedValue({
        id: 'm1',
        mode: 'ranked',
        status: 'completed',
        current_q_index: 4,
        total_questions: 12,
        started_at: nowIso,
        ended_at: nowIso,
        winner_user_id: 'u1',
        lobby_id: 'l1',
        state_payload: {
          variant: 'ranked_sim',
          winnerDecisionMethod: 'forfeit',
        },
        ranked_context: null,
      });

    await resolveExpiredGraceWindow(io, 'm1', 'u2');

    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u1');
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ winnerDecisionMethod: 'forfeit' })
    );
    expect(fakeRedisStore.values.has('match:disconnect:m1:u2')).toBe(false);
    expect(fakeRedisStore.values.has('match:exit_pending:m1:u1')).toBe(false);
  });

  it('S15f: leave during halftime still enters ranked pause/rejoin flow', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 6,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
        phase: 'HALFTIME',
      },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.objectContaining({
        matchId: 'm1',
        graceMs: 30000,
        remainingReconnects: 2,
      })
    );
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S15g: leave during penalties still enters ranked pause/rejoin flow', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 14,
      total_questions: 15,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
        phase: 'PENALTY_SHOOTOUT',
      },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'match:rejoin_available',
      expect.objectContaining({
        matchId: 'm1',
        graceMs: 30000,
        remainingReconnects: 2,
      })
    );
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('S15h: special ranked answer handlers reject submissions while the match is paused', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const countdownSocket = createSocketMock('u1', 'm1');
    const putInOrderSocket = createSocketMock('u1', 'm1');
    const cluesSocket = createSocketMock('u1', 'm1');
    const nowIso = new Date().toISOString();

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now()));
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      current_q_index: 3,
      total_questions: 12,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
      },
    });

    await matchRealtimeService.handleCountdownGuess(countdownSocket, {
      matchId: 'm1',
      qIndex: 3,
      guess: 'Henry',
    });
    await matchRealtimeService.handlePutInOrderAnswer(io, putInOrderSocket, {
      matchId: 'm1',
      qIndex: 4,
      orderedItemIds: ['a', 'b', 'c'],
      timeMs: 1200,
    });
    await matchRealtimeService.handleCluesAnswer(io, cluesSocket, {
      matchId: 'm1',
      qIndex: 5,
      guess: 'Didier Drogba',
      timeMs: 1400,
    });

    expect(countdownSocket.emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PAUSED',
      message: 'Match is paused. Please wait for your opponent to return.',
    });
    expect(putInOrderSocket.emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PAUSED',
      message: 'Match is paused. Please wait for your opponent to return.',
    });
    expect(cluesSocket.emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PAUSED',
      message: 'Match is paused. Please wait for your opponent to return.',
    });
  });

  it('S14: emits MATCH_UNAVAILABLE when Redis is down (no DB-fallback path)', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    await matchRealtimeService.handleAnswer(io, socket, {
      matchId: 'm1',
      qIndex: 0,
      selectedIndex: 1,
      timeMs: 500,
    });

    expect(insertMatchAnswerMock).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_UNAVAILABLE' })
    );
  });

  // S27/S28/S29 removed: 50-50 chance card feature retired.

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
        status: 'active',
        current_q_index: 4,
        total_questions: 10,
        started_at: nowIso,
        lobby_id: 'l1',
      })
      .mockResolvedValue({
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

    expect(setPlayerForfeitWinTotalsMock).not.toHaveBeenCalled();
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
    expect((io.to as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.arrayContaining(['match:m1', 'user:u1', 'user:u2'])
    );
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

  it('S21: match:forfeit replays final results when the requested match already completed', async () => {
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
      state_payload: { variant: 'friendly_possession', winnerDecisionMethod: 'goals' },
      ranked_context: null,
    });

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith(
      'match:final_results',
      expect.objectContaining({ matchId: 'm1', winnerId: 'u2' })
    );
    expect(completeMatchMock).not.toHaveBeenCalled();
  });

  it('match:forfeit returns a terminal abandoned reply when the requested match already died', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'abandoned',
      current_q_index: 5,
      total_questions: 10,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      winner_user_id: null,
      lobby_id: 'l1',
      state_payload: { variant: 'friendly_possession' },
      ranked_context: null,
    });

    await matchRealtimeService.handleMatchForfeit(io, socket, 'm1');

    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_ABANDONED',
      message: 'Match was abandoned due to disconnects.',
    });
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

  // S22/S23 removed: covered the now-deleted DB-fallback path. The Redis-path
  // equivalents (scoring/timing) are exercised via tests/realtime/possession-match-flow.test.ts.

  it('S24: beginMatchForLobby waits for kickoff UI-ready before countdown and first question', async () => {
    vi.useFakeTimers();
    try {
      const { beginMatchForLobby, matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();

      await beginMatchForLobby(io, 'l1', 'm1');

      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
      expect((io.to as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([room]: [string]) => room === 'match:m1')).toBe(true);

      await vi.advanceTimersByTimeAsync(4999);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await matchRealtimeService.handleKickoffUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await vi.advanceTimersByTimeAsync(1);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await matchRealtimeService.handleKickoffUiReady(io, createSocketMock('u2'), { matchId: 'm1' });
      await vi.advanceTimersByTimeAsync(4999);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sendMatchQuestionMock).toHaveBeenCalledWith(io, 'm1', 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S24b: beginMatchForLobby with initialDevSkipTarget skips to that phase and never dispatches normal question 0', async () => {
    vi.useFakeTimers();
    devSkipToPossessionPhaseMock.mockClear();
    try {
      const { beginMatchForLobby, matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();

      await beginMatchForLobby(io, 'l1', 'm1', { countdownSec: 0, initialDevSkipTarget: 'penalty_ban' });
      await matchRealtimeService.handleKickoffUiReady(io, createSocketMock('u1'), { matchId: 'm1' });
      await matchRealtimeService.handleKickoffUiReady(io, createSocketMock('u2'), { matchId: 'm1' });

      // Advance past the (0s) countdown — the post-countdown work runs the dev
      // skip, NOT a normal question-0 dispatch.
      await vi.advanceTimersByTimeAsync(10);

      expect(devSkipToPossessionPhaseMock).toHaveBeenCalledWith(io, 'm1', 'penalty_ban');
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S25: beginMatchForLobby falls back to match players when lobby membership is stale and force-starts after UI-ready timeout', async () => {
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

      await vi.advanceTimersByTimeAsync(9999);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4999);
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
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

  it('S29b: beginMatchForLobby prefers current socket countries over saved user countries', async () => {
    fakeRedis.isOpen = true;
    const { rememberCurrentCountry } = await import('../../src/realtime/session-country.js');
    const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();

    await rememberCurrentCountry('u1', 'MA');
    await rememberCurrentCountry('u2', 'GE');

    await beginMatchForLobby(io, 'l1', 'm1');

    const emitFns = (io.to as unknown as ReturnType<typeof vi.fn>).mock.results
      .map((result) => (result.value as { emit?: ReturnType<typeof vi.fn> } | undefined)?.emit)
      .filter((emit): emit is ReturnType<typeof vi.fn> => Boolean(emit));
    const emitCalls = emitFns.flatMap((emit) => emit.mock.calls).filter(([event]) => event === 'match:start');

    expect(emitCalls).toEqual(
      expect.arrayContaining([
        ['match:start', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u2', countryCode: 'GE' }) })],
        ['match:start', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u1', countryCode: 'MA' }) })],
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

  it('S32: a player who loses the rematch-creation lock re-checks and joins the lobby the holder publishes', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u2', 'rematch-match-3');
    const io = createIoWithUserSocket('u2', socket);

    getMatchMock.mockResolvedValue({
      id: 'rematch-match-3',
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
    listMembersWithUserMock.mockResolvedValue([]);
    getLobbyByIdMock.mockImplementation(async (lobbyId: string) => {
      if (lobbyId === 'rematch-lobby-3') {
        return {
          id: 'rematch-lobby-3',
          invite_code: 'RACE01',
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
      return null;
    });

    fakeRedis.isOpen = true;
    // The other player already holds the creation lock, so acquireLock fails here.
    fakeRedisStore.values.set('lock:rematch:rematch-match-3', 'other-player-token');
    // The lock holder publishes the lobby shortly after — during this player's
    // bounded re-check window (5 × 50ms), not before the first poll.
    setTimeout(() => {
      fakeRedisStore.values.set(
        'rematch:rematch-match-3',
        JSON.stringify({ lobbyId: 'rematch-lobby-3', createdAt: Date.now() })
      );
    }, 60);

    await matchRealtimeService.handlePlayAgain(io, socket, { matchId: 'rematch-match-3' });

    // It must NOT create a competing lobby (it lost the lock)...
    expect(createLobbyMock).not.toHaveBeenCalled();
    // ...and must NOT bail with the unavailable error — it joined the published lobby.
    expect(socket.emit).not.toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_PLAY_AGAIN_UNAVAILABLE' })
    );
    expect(addMemberMock).toHaveBeenCalledWith('rematch-lobby-3', 'u2', false);
    expect(socket.join).toHaveBeenCalledWith('lobby:rematch-lobby-3');
    expect(socket.data.lobbyId).toBe('rematch-lobby-3');
  });

  it('S33: a player who loses the lock still bails with MATCH_PLAY_AGAIN_UNAVAILABLE if no lobby is ever published', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const socket = createSocketMock('u2', 'rematch-match-4');
    const io = createIoWithUserSocket('u2', socket);

    getMatchMock.mockResolvedValue({
      id: 'rematch-match-4',
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
    getLobbyByIdMock.mockResolvedValue(null);

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('lock:rematch:rematch-match-4', 'other-player-token');

    await matchRealtimeService.handlePlayAgain(io, socket, { matchId: 'rematch-match-4' });

    expect(createLobbyMock).not.toHaveBeenCalled();
    expect(addMemberMock).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_PLAY_AGAIN_UNAVAILABLE' })
    );
  });

  it('S34: handleHalftimeBan rejects the ban while the match is paused', async () => {
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const io = createIoMock();
    const socket = createSocketMock('u1', 'm1');

    fakeRedis.isOpen = true;
    fakeRedisStore.values.set('match:pause:m1', String(Date.now()));
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'friendly',
      status: 'active',
      current_q_index: 3,
      total_questions: 10,
      started_at: new Date().toISOString(),
      lobby_id: 'l1',
      state_payload: { variant: 'friendly_possession' },
    });

    await matchRealtimeService.handleHalftimeBan(io, socket, { matchId: 'm1', categoryId: 'cat-a' });

    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PAUSED',
      message: 'Match is paused. Please wait for your opponent to return.',
    });
    // The pause guard must short-circuit before any active-match / mode checks.
    expect(socket.emit).not.toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_NOT_ACTIVE' })
    );
    expect(socket.emit).not.toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'MATCH_NOT_ALLOWED' })
    );
  });
});
