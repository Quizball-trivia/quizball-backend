import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const resolveRoundMock = vi.fn();
const sendMatchQuestionMock = vi.fn();
const resumePossessionMatchQuestionMock = vi.fn();
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
  async zRem(_key: string, _member: string): Promise<number> {
    return 0;
  },
  async eval(_script: string, payload: { keys: string[]; arguments: string[] }): Promise<number> {
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
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => {
  const getById = vi.fn(async (id: string) => ({
    id,
    nickname: id,
    avatar_url: null,
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
    emitPossessionStateToSocketMock.mockResolvedValue(undefined);
    emitPartyQuizStateToSocketMock.mockResolvedValue(undefined);
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
    insertGoalEventIfMissingMock.mockResolvedValue(null);
    incrementGoalsAndInsertEventIfMissingMock.mockResolvedValue({ inserted: true, player: null });
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
        graceMs: 60000,
        remainingReconnects: 2,
      })
    );

    const toCalls = (io.to as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(toCalls.some(([room]: [string]) => room === 'user:u2')).toBe(true);
  });

  it('S15 reload race: a fresh replacement socket does not suppress pause and gets resume countdown', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
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

      await matchRealtimeService.handleMatchDisconnect(io, oldSocket);

      expect(fakeRedisStore.values.has('match:disconnect:m1:u1')).toBe(false);
      expect(fakeRedisStore.values.has('match:pause:m1')).toBe(true);
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

  it('S15 party reload race: same-user sockets do not auto-resume party quiz disconnects', async () => {
    vi.useFakeTimers();
    try {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
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
          graceMs: 60000,
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
        graceMs: 60000,
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

  it('S15b: ranked leave settles as forfeit instead of abandoned when grace expires with no sockets left', async () => {
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

      expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
      expect(settleCompletedRankedMatchMock).toHaveBeenCalledWith('m1');
      expect(abandonMatchMock).not.toHaveBeenCalled();
    }
  });

  it('S15b1: ranked all-disconnected does NOT abandon when forfeit finalization is locked', async () => {
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
      // Simulate another resolver already holding the forfeit lock → finalize
      // returns completed:false. The grace handler must NOT fall through to abandon.
      fakeRedisStore.values.set('lock:match:m1:forfeit', 'someone-else');

      await resolveExpiredGraceWindow(io, 'm1', 'u1');

      expect(abandonMatchMock).not.toHaveBeenCalled();
      expect(completeMatchMock).not.toHaveBeenCalled();
    }
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

      await vi.advanceTimersByTimeAsync(5_000);

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
      await vi.advanceTimersByTimeAsync(5_000);

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
        graceMs: 42_000,
        remainingReconnects: 2,
      })
    );
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
        graceMs: 42_000,
        remainingReconnects: 2,
      })
    );
    expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
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
      current_q_index: 0,
      total_questions: 10,
      started_at: nowIso,
      lobby_id: 'l1',
      state_payload: {
        variant: 'ranked_sim',
        winnerDecisionMethod: null,
      },
    });

    await matchRealtimeService.handleMatchLeave(io, socket, 'm1');

    expect(completeMatchMock).toHaveBeenCalledWith('m1', 'u2');
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
        graceMs: 42_000,
        remainingReconnects: 1,
      })
    );
    expect(resumePossessionMatchQuestionMock).not.toHaveBeenCalled();
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
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
        graceMs: 60000,
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
        graceMs: 60000,
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

  // S22/S23 removed: covered the now-deleted DB-fallback path. The Redis-path
  // equivalents (scoring/timing) are exercised via tests/realtime/possession-match-flow.test.ts.

  it('S24: beginMatchForLobby emits countdown and delays first question by countdown', async () => {
    vi.useFakeTimers();
    try {
      const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();

      await beginMatchForLobby(io, 'l1', 'm1');

      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
      expect((io.to as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([room]: [string]) => room === 'match:m1')).toBe(true);

      // Countdown is 5s for both ranked and party-quiz variants now.
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
      const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');
      const io = createIoMock();

      await beginMatchForLobby(io, 'l1', 'm1', { countdownSec: 0, initialDevSkipTarget: 'penalty_ban' });

      // Advance past the (0s) countdown — the post-countdown work runs the dev
      // skip, NOT a normal question-0 dispatch.
      await vi.advanceTimersByTimeAsync(10);

      expect(devSkipToPossessionPhaseMock).toHaveBeenCalledWith(io, 'm1', 'penalty_ban');
      expect(sendMatchQuestionMock).not.toHaveBeenCalled();
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

      await vi.advanceTimersByTimeAsync(10000);
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
