import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

// ── Mocks ──

const getMatchMock = vi.fn();
const getActiveMatchForUserMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const listUnlockedForMatchMock = vi.fn();
const getMatchOutcomeMock = vi.fn();
const settleCompletedRankedMatchMock = vi.fn();
const awardCompletedMatchXpMock = vi.fn();

type FakeRedisStore = { values: Map<string, string> };
const fakeRedisStore: FakeRedisStore = { values: new Map() };
const fakeRedis = {
  isOpen: true,
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
};

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/core/tracing.js', () => ({
  withSpan: vi.fn(async (_name: string, _attrs: unknown, fn: (span: unknown) => Promise<unknown>) =>
    fn({ setAttribute: vi.fn(), setAttributes: vi.fn() })
  ),
}));

vi.mock('../../src/core/metrics.js', () => ({
  appMetrics: new Proxy({}, { get: () => ({ add: vi.fn(), record: vi.fn() }) }),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => fakeRedis,
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    getActiveMatchForUser: (...args: unknown[]) => getActiveMatchForUserMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  resolveMatchVariant: (statePayload: unknown, mode: string) => {
    const candidate = statePayload as { variant?: string } | null;
    if (candidate?.variant === 'friendly_party_quiz') return 'friendly_party_quiz';
    return mode === 'ranked' ? 'ranked_sim' : 'friendly_possession';
  },
  createInitialPossessionState: vi.fn(),
  createInitialPartyQuizState: vi.fn(),
  POSSESSION_QUESTIONS_PER_HALF: 6,
  matchesService: {
    buildMatchQuestionPayload: vi.fn(),
    computeAvgTimes: vi.fn(),
    abandonMatch: vi.fn(),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    getMatchOutcome: (...args: unknown[]) => getMatchOutcomeMock(...args),
    settleCompletedRankedMatch: (...args: unknown[]) => settleCompletedRankedMatchMock(...args),
    ensureProfile: vi.fn(async (userId: string) => ({
      user_id: userId,
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'placed',
      placement_played: 3,
      placement_required: 3,
    })),
    buildAiMatchContext: vi.fn(() => ({ aiAnchorRp: 1900 })),
    DEFAULT_AI_OPPONENT_RP: 1900,
  },
}));

vi.mock('../../src/modules/progression/progression.service.js', () => ({
  progressionService: {
    awardCompletedMatchXp: (...args: unknown[]) => awardCompletedMatchXpMock(...args),
  },
}));

vi.mock('../../src/modules/achievements/index.js', () => ({
  achievementsService: {
    listUnlockedForMatch: (...args: unknown[]) => listUnlockedForMatchMock(...args),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: vi.fn(async (id: string) => ({ id, nickname: id, avatar_url: null })),
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
}));

vi.mock('../../src/realtime/possession-match-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/possession-match-flow.js')>();
  return {
    ...actual,
    emitPossessionStateToSocket: vi.fn(),
    resumePossessionMatchQuestion: vi.fn(),
  };
});

vi.mock('../../src/realtime/party-quiz-match-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/party-quiz-match-flow.js')>();
  return {
    ...actual,
    emitPartyQuizStateToSocket: vi.fn(),
    resumePartyQuizQuestion: vi.fn(),
  };
});

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    getById: vi.fn(),
    createLobby: vi.fn(),
    addMember: vi.fn(),
    countMembers: vi.fn(),
    updateLobbySettings: vi.fn(),
    setAllReady: vi.fn(),
    listMembersWithUser: vi.fn(),
    setLobbyStatus: vi.fn(),
    removeMember: vi.fn(),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    consumeChanceCardForMatch: vi.fn(),
  },
}));

// ── Helpers ──

function createSocketMock(userId: string): QuizballSocket {
  return {
    data: { user: { id: userId, role: 'user' } },
    emit: vi.fn(),
    leave: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as unknown as QuizballSocket;
}

const COMPLETED_RANKED_MATCH = {
  id: 'm1',
  mode: 'ranked',
  status: 'completed',
  winner_user_id: 'u2',
  started_at: new Date(Date.now() - 120000).toISOString(),
  ended_at: new Date().toISOString(),
  total_questions: 12,
  current_q_index: 11,
  state_payload: { winnerDecisionMethod: 'goals' },
  is_dev: false,
};

const COMPLETED_FRIENDLY_MATCH = {
  ...COMPLETED_RANKED_MATCH,
  id: 'm2',
  mode: 'friendly',
  state_payload: { variant: 'friendly_possession', winnerDecisionMethod: 'goals' },
};

const PLAYERS = [
  { user_id: 'u1', seat: 1, total_points: 100, correct_answers: 5, avg_time_ms: 3000, goals: 1, penalty_goals: 0 },
  { user_id: 'u2', seat: 2, total_points: 200, correct_answers: 8, avg_time_ms: 2500, goals: 3, penalty_goals: 0 },
];

const RANKED_OUTCOME = {
  isPlacement: false,
  byUserId: {
    u1: { userId: 'u1', oldRp: 100, newRp: 77, deltaRp: -23, oldTier: 'Academy', newTier: 'Academy', placementStatus: 'placed' as const, placementPlayed: 3, placementRequired: 3, isPlacement: false },
    u2: { userId: 'u2', oldRp: 100, newRp: 125, deltaRp: 25, oldTier: 'Academy', newTier: 'Academy', placementStatus: 'placed' as const, placementPlayed: 3, placementRequired: 3, isPlacement: false },
  },
};

// ── Tests ──

describe('match completion recovery on replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedisStore.values.clear();
    listUnlockedForMatchMock.mockResolvedValue({});
    listMatchPlayersMock.mockResolvedValue(PLAYERS);
    getActiveMatchForUserMock.mockResolvedValue(null);
    awardCompletedMatchXpMock.mockResolvedValue(undefined);
  });

  describe('ranked settlement recovery', () => {
    it('retries ranked settlement when getMatchOutcome returns null on replay', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      // Simulate: match completed but settlement never ran (disconnect scenario).
      // First getMatchOutcome call (recovery check) returns null; after settlement
      // the second call (inside buildFinalResultsPayload) returns the outcome.
      getMatchMock.mockResolvedValue(COMPLETED_RANKED_MATCH);
      getMatchOutcomeMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(RANKED_OUTCOME);
      settleCompletedRankedMatchMock.mockResolvedValue(RANKED_OUTCOME);
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm1', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(getMatchOutcomeMock).toHaveBeenCalledTimes(2);
      expect(settleCompletedRankedMatchMock).toHaveBeenCalledWith('m1');
      expect(socket.emit).toHaveBeenCalledWith('match:final_results', expect.objectContaining({
        matchId: 'm1',
        rankedOutcome: RANKED_OUTCOME,
      }));
    });

    it('does not retry settlement when getMatchOutcome already has data', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      getMatchMock.mockResolvedValue(COMPLETED_RANKED_MATCH);
      getMatchOutcomeMock.mockResolvedValue(RANKED_OUTCOME);
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm1', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(getMatchOutcomeMock).toHaveBeenCalledWith('m1');
      expect(settleCompletedRankedMatchMock).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('match:final_results', expect.objectContaining({
        rankedOutcome: RANKED_OUTCOME,
      }));
    });

    it('still emits final results even if settlement recovery fails', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      getMatchMock.mockResolvedValue(COMPLETED_RANKED_MATCH);
      getMatchOutcomeMock.mockResolvedValue(null);
      settleCompletedRankedMatchMock.mockRejectedValue(new Error('DB down'));
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm1', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(settleCompletedRankedMatchMock).toHaveBeenCalledWith('m1');
      expect(socket.emit).toHaveBeenCalledWith('match:final_results', expect.objectContaining({
        matchId: 'm1',
      }));
    });
  });

  describe('XP award recovery', () => {
    it('retries XP award on replay for ranked matches', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      getMatchMock.mockResolvedValue(COMPLETED_RANKED_MATCH);
      getMatchOutcomeMock.mockResolvedValue(RANKED_OUTCOME);
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm1', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(awardCompletedMatchXpMock).toHaveBeenCalledWith('m1');
    });

    it('retries XP award on replay for friendly matches', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      getMatchMock.mockResolvedValue(COMPLETED_FRIENDLY_MATCH);
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm2', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(awardCompletedMatchXpMock).toHaveBeenCalledWith('m2');
      expect(getMatchOutcomeMock).not.toHaveBeenCalled();
      expect(settleCompletedRankedMatchMock).not.toHaveBeenCalled();
    });

    it('still emits final results even if XP award retry fails', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      getMatchMock.mockResolvedValue(COMPLETED_FRIENDLY_MATCH);
      awardCompletedMatchXpMock.mockRejectedValue(new Error('DB down'));
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm2', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(awardCompletedMatchXpMock).toHaveBeenCalledWith('m2');
      expect(socket.emit).toHaveBeenCalledWith('match:final_results', expect.objectContaining({
        matchId: 'm2',
      }));
    });

    it('does not attempt ranked settlement for non-ranked matches', async () => {
      const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
      const socket = createSocketMock('u1');

      getMatchMock.mockResolvedValue(COMPLETED_FRIENDLY_MATCH);
      fakeRedisStore.values.set('user:last_match:u1', JSON.stringify({ matchId: 'm2', resultVersion: 1000 }));

      await matchRealtimeService.emitLastMatchResultIfAny({} as QuizballServer, socket);

      expect(getMatchOutcomeMock).not.toHaveBeenCalled();
      expect(settleCompletedRankedMatchMock).not.toHaveBeenCalled();
    });
  });
});
