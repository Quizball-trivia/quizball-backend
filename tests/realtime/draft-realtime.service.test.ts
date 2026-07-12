import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const getLobbyByIdMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const listLobbyCategoryBansMock = vi.fn();
const insertLobbyCategoryBanMock = vi.fn();
const getLobbyCategoriesMock = vi.fn();
const deleteLobbyMock = vi.fn();
const createMatchFromLobbyMock = vi.fn();
const abandonMatchMock = vi.fn();
const beginMatchForLobbyMock = vi.fn();
const pauseMatchForDisconnectedPlayerMock = vi.fn();
const finalizeMatchAsForfeitMock = vi.fn();
const buildFinalResultsPayloadMock = vi.fn();
const emitFinalResultsToMatchParticipantsMock = vi.fn();
const getUserByIdMock = vi.fn();
const consumeRankedTicketsMock = vi.fn();
const refundRankedTicketsMock = vi.fn();
const abortRankedDraftStartForTicketsMock = vi.fn();
const redisGetMock = vi.fn();
const redisSetMock = vi.fn();
const redisExistsMock = vi.fn();
const redisDelMock = vi.fn();
const redisGetDelMock = vi.fn();
const redisEvalMock = vi.fn();
let redisClientMock: {
  get: typeof redisGetMock;
  set: typeof redisSetMock;
  exists: typeof redisExistsMock;
  del: typeof redisDelMock;
  getDel: typeof redisGetDelMock;
  eval?: typeof redisEvalMock;
  isOpen?: boolean;
  zRem?: ReturnType<typeof vi.fn>;
  zAdd?: ReturnType<typeof vi.fn>;
  zScore?: ReturnType<typeof vi.fn>;
} | null = null;

const scheduleRealtimeTimerMock = vi.fn();
const cancelRealtimeTimerMock = vi.fn();

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    getById: (...args: unknown[]) => getLobbyByIdMock(...args),
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
    listLobbyCategoryBans: (...args: unknown[]) => listLobbyCategoryBansMock(...args),
    insertLobbyCategoryBan: (...args: unknown[]) => insertLobbyCategoryBanMock(...args),
    deleteLobby: (...args: unknown[]) => deleteLobbyMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    getLobbyCategories: (...args: unknown[]) => getLobbyCategoriesMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    createMatchFromLobby: (...args: unknown[]) => createMatchFromLobbyMock(...args),
    abandonMatch: (...args: unknown[]) => abandonMatchMock(...args),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    consumeRankedTickets: (...args: unknown[]) => consumeRankedTicketsMock(...args),
    refundRankedTickets: (...args: unknown[]) => refundRankedTicketsMock(...args),
  },
}));

vi.mock('../../src/realtime/services/match-realtime.service.js', () => ({
  beginMatchForLobby: (...args: unknown[]) => beginMatchForLobbyMock(...args),
  matchRealtimeService: {
    pauseMatchForDisconnectedPlayer: (...args: unknown[]) => pauseMatchForDisconnectedPlayerMock(...args),
  },
}));

vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...args: unknown[]) => finalizeMatchAsForfeitMock(...args),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: (...args: unknown[]) => buildFinalResultsPayloadMock(...args),
  emitFinalResultsToMatchParticipants: (...args: unknown[]) => emitFinalResultsToMatchParticipantsMock(...args),
}));

vi.mock('../../src/realtime/services/lobby-realtime.service.js', () => ({
  startDraft: vi.fn(),
}));

vi.mock('../../src/realtime/services/lobby-draft-start.service.js', () => ({
  abortRankedDraftStartForTickets: (...args: unknown[]) => abortRankedDraftStartForTicketsMock(...args),
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    emitState: vi.fn(async () => ({
      state: 'IDLE',
      activeMatchId: null,
      waitingLobbyId: null,
      queueSearchId: null,
      openLobbyIds: [],
      resolvedAt: new Date().toISOString(),
    })),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redisClientMock,
}));

// Keep the real scheduler (other tests start/stop it with fake timers). Spy on
// the two scheduling entrypoints the grace path uses, but delegate to the real
// implementation by default so the existing AI-/auto-ban timer tests still fire.
let realScheduleRealtimeTimer: (...args: unknown[]) => unknown = async () => {};
let realCancelRealtimeTimer: (...args: unknown[]) => unknown = async () => {};
vi.mock('../../src/realtime/realtime-timer-scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/realtime-timer-scheduler.js')>();
  realScheduleRealtimeTimer = actual.scheduleRealtimeTimer as (...a: unknown[]) => unknown;
  realCancelRealtimeTimer = actual.cancelRealtimeTimer as (...a: unknown[]) => unknown;
  return {
    ...actual,
    scheduleRealtimeTimer: (...args: unknown[]) => scheduleRealtimeTimerMock(...args),
    cancelRealtimeTimer: (...args: unknown[]) => cancelRealtimeTimerMock(...args),
  };
});

vi.mock('../../src/realtime/ai-ranked.constants.js', () => ({
  rankedAiLobbyKey: (lobbyId: string) => `ranked:ai:lobby:${lobbyId}`,
  rankedAiMatchKey: (matchId: string) => `ranked:ai:match:${matchId}`,
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getUserByIdMock(...args),
    getByIds: async (ids: string[]) => {
      const usersById = new Map<string, Awaited<ReturnType<typeof getUserByIdMock>>>();
      for (const id of [...new Set(ids)]) {
        const user = await getUserByIdMock(id);
        if (user) usersById.set(id, user);
      }
      return usersById;
    },
  },
}));

function createIoMock() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const fetchSockets = vi.fn(async () => [
    { id: 'socket-u1', data: { user: { id: 'u1' }, lobbyId: 'l1' }, leave: vi.fn() },
    { id: 'socket-u2', data: { user: { id: 'u2' }, lobbyId: 'l1' }, leave: vi.fn() },
  ]);
  const inMock = vi.fn(() => ({ fetchSockets }));
  return { io: { to, in: inMock } as unknown as QuizballServer, emit, fetchSockets };
}

function createSocketMock(userId: string, lobbyId: string): QuizballSocket {
  return {
    data: {
      user: { id: userId },
      lobbyId,
    },
    emit: vi.fn(),
  } as unknown as QuizballSocket;
}

describe('draftRealtimeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisClientMock = null;
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    redisExistsMock.mockResolvedValue(0);
    redisDelMock.mockResolvedValue(1);
    redisGetDelMock.mockResolvedValue(null);
    redisEvalMock.mockResolvedValue(1);
    // Delegate to the real scheduler by default so existing timer-driven tests
    // still fire; individual grace tests just read the spy's call args.
    scheduleRealtimeTimerMock.mockImplementation((...args: unknown[]) => realScheduleRealtimeTimer(...args));
    cancelRealtimeTimerMock.mockImplementation((...args: unknown[]) => realCancelRealtimeTimer(...args));
    pauseMatchForDisconnectedPlayerMock.mockResolvedValue({ finalized: false, graceMs: 60_000, remainingReconnects: 2 });

    const bans: Array<{ user_id: string; category_id: string }> = [];

    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'friendly',
      status: 'active',
      host_user_id: 'u1',
    });

    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);

    getLobbyCategoriesMock.mockResolvedValue([
      { id: 'cat-a', name: 'A', icon: null },
      { id: 'cat-b', name: 'B', icon: null },
      { id: 'cat-c', name: 'C', icon: null },
    ]);

    listLobbyCategoryBansMock.mockImplementation(async () => bans.slice());
    insertLobbyCategoryBanMock.mockImplementation(async (lobbyId: string, userId: string, categoryId: string) => {
      // Mirror the real repo: idempotent on both unique constraints and always
      // returns the surviving ban row. If this user already banned, return
      // theirs; otherwise if the category is already banned by anyone, return
      // that row; otherwise insert and return the new ban.
      const existing = bans.find((b) => b.user_id === userId);
      if (existing) return { lobby_id: lobbyId, user_id: userId, category_id: existing.category_id };
      const foreign = bans.find((b) => b.category_id === categoryId);
      if (foreign) return { lobby_id: lobbyId, user_id: foreign.user_id, category_id: categoryId };
      bans.push({ user_id: userId, category_id: categoryId });
      return { lobby_id: lobbyId, user_id: userId, category_id: categoryId };
    });

    getUserByIdMock.mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId.startsWith('ai-'),
    }));

    consumeRankedTicketsMock.mockResolvedValue({
      wallets: {
        u1: { coins: 0, tickets: 9 },
        u2: { coins: 0, tickets: 9 },
      },
    });
    refundRankedTicketsMock.mockResolvedValue({
      wallets: {
        u1: { coins: 0, tickets: 10 },
        u2: { coins: 0, tickets: 10 },
      },
    });
    abortRankedDraftStartForTicketsMock.mockResolvedValue(undefined);
    deleteLobbyMock.mockResolvedValue(undefined);
    createMatchFromLobbyMock.mockResolvedValue({ match: { id: 'm1' } });
    abandonMatchMock.mockResolvedValue(undefined);
    beginMatchForLobbyMock.mockResolvedValue(undefined);
    finalizeMatchAsForfeitMock.mockResolvedValue({
      matchId: 'm1',
      winnerId: 'u2',
      resultVersion: 123,
      completed: true,
    });
    buildFinalResultsPayloadMock.mockResolvedValue({ matchId: 'm1', resultVersion: 123 });
    emitFinalResultsToMatchParticipantsMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { resetDraftRuntimeState } = await import('../../src/realtime/services/draft-realtime.service.js');
    resetDraftRuntimeState();
    vi.useRealTimers();
  });

  it('does not complete the draft after only one ban', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    const socket = createSocketMock('u1', 'l1');

    await draftRealtimeService.handleBan(io, socket, 'cat-a');

    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('draft:banned', expect.objectContaining({
      actorId: 'u1',
      categoryId: 'cat-a',
      forceAtMs: null,
    }));
    expect(emit).not.toHaveBeenCalledWith('draft:complete', expect.anything());
  });

  it('completes draft after two bans and creates match with one half category', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    expect(emit).toHaveBeenCalledWith('draft:complete', { halfOneCategoryId: 'cat-c' });
    expect(createMatchFromLobbyMock).toHaveBeenCalledWith({
      lobbyId: 'l1',
      mode: 'friendly',
      variant: 'ranked_sim',
      hostUserId: 'u1',
      categoryAId: 'cat-c',
      categoryBId: null,
    });
    expect(beginMatchForLobbyMock).toHaveBeenCalledWith(io, 'l1', 'm1');
  });

  it('retries ticket consume inline on transient wallet CAS conflicts and still creates the match', async () => {
    const { AppError, ErrorCode } = await import('../../src/core/errors.js');
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();

    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    const casConflict = () => new AppError(
      'Ticket state changed during update; retry the request',
      409,
      ErrorCode.CONFLICT,
      { userId: 'u1', operation: 'consume', attempts: 6 }
    );
    // Two transient conflicts, then success — the inline retry must absorb
    // them instead of throwing out to the auto-ban watchdog (~16s stall).
    consumeRankedTicketsMock
      .mockRejectedValueOnce(casConflict())
      .mockRejectedValueOnce(casConflict())
      .mockResolvedValue({ wallets: { u1: { coins: 0, tickets: 4 }, u2: { coins: 0, tickets: 4 } } });

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    expect(consumeRankedTicketsMock).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledWith('draft:complete', { halfOneCategoryId: 'cat-c' });
    expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the inline retry budget and lets recovery re-arm (no match created)', async () => {
    const { AppError, ErrorCode } = await import('../../src/core/errors.js');
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();

    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    consumeRankedTicketsMock.mockRejectedValue(new AppError(
      'Ticket state changed during update; retry the request',
      409,
      ErrorCode.CONFLICT,
      { userId: 'u1', operation: 'consume', attempts: 6 }
    ));

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    // initial + 3 retries, then the throw is contained by completion recovery.
    expect(consumeRankedTicketsMock).toHaveBeenCalledTimes(4);
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
  });

  it('consumes ranked tickets only after the ranked draft is complete', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();

    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    expect(consumeRankedTicketsMock).not.toHaveBeenCalled();
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();

    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    expect(consumeRankedTicketsMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(emit).toHaveBeenCalledWith('draft:complete', { halfOneCategoryId: 'cat-c' });
    expect(createMatchFromLobbyMock).toHaveBeenCalledWith({
      lobbyId: 'l1',
      mode: 'ranked',
      variant: 'ranked_sim',
      hostUserId: 'u1',
      categoryAId: 'cat-c',
      categoryBId: null,
    });
    expect(beginMatchForLobbyMock).toHaveBeenCalledWith(io, 'l1', 'm1');
  });

  it('aborts a ranked draft before consuming tickets when a human cancelled before match creation', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();

    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    redisClientMock = {
      get: vi.fn(async (key: string) => (key === 'ranked:mm:cancel:u1' ? '1' : null)),
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    expect(consumeRankedTicketsMock).not.toHaveBeenCalled();
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(beginMatchForLobbyMock).not.toHaveBeenCalled();
    expect(deleteLobbyMock).toHaveBeenCalledWith('l1');
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
  });

  it('does not complete the ranked draft or create a match when ticket consumption fails', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    const lobby = {
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    };
    getLobbyByIdMock.mockResolvedValue(lobby);
    consumeRankedTicketsMock.mockResolvedValue(null);

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    expect(consumeRankedTicketsMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(emit).not.toHaveBeenCalledWith('draft:complete', expect.anything());
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(beginMatchForLobbyMock).not.toHaveBeenCalled();
    expect(abortRankedDraftStartForTicketsMock).toHaveBeenCalledWith(io, lobby, ['u1', 'u2']);
  });

  it('refunds ranked tickets when match creation fails after consumption', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    createMatchFromLobbyMock.mockRejectedValueOnce(new Error('match create failed'));

    await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
    await draftRealtimeService.handleBan(io, createSocketMock('u2', 'l1'), 'cat-b');

    expect(consumeRankedTicketsMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(beginMatchForLobbyMock).not.toHaveBeenCalled();
  });

  it('waits for draft:ui_ready before arming the human auto-ban deadline', async () => {
    const { scheduleDraftAutoBanForCurrentTurn } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };
    redisExistsMock.mockResolvedValue(0);

    try {
      await scheduleDraftAutoBanForCurrentTurn(io, 'l1');

      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(110_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: true,
          forceAtMs: 110_000,
          turnUserId: 'u1',
          banCount: 0,
        }
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('arms the normal human auto-ban deadline after draft:ui_ready', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(200_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    wireStatefulRedis(['draft:ui_ready:l1:u2:0']);

    try {
      await draftRealtimeService.handleUiReady(io, createSocketMock('u1', 'l1'), {
        lobbyId: 'l1',
        turnUserId: 'u1',
        banCount: 0,
      });

      expect(redisSetMock).toHaveBeenCalledWith('draft:ui_ready:l1:u1:0', '200000', { EX: 600 });
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(216_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: undefined,
          forceAtMs: 216_000,
          turnUserId: 'u1',
          banCount: 0,
        }
      );
      expect(emit).toHaveBeenCalledWith('draft:begin', {
        lobbyId: 'l1',
        turnUserId: 'u1',
        forceAtMs: 216_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('gives a late ui_ready its full auto-ban window when the force timer is already firing', async () => {
    const { runDraftAutoBan } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(144_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    wireStatefulRedis([
      'draft:ui_ready:l1:u1:0',
      'draft:ui_ready:l1:u2:0',
      'draft:ui_ready_deadline:l1:0',
    ]);

    try {
      await runDraftAutoBan(io, 'l1', {
        requireUiReady: true,
        forceAtMs: 145_000,
        turnUserId: 'u1',
        banCount: 0,
      });

      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(160_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: undefined,
          forceAtMs: 160_000,
          turnUserId: 'u1',
          banCount: 0,
        }
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('re-anchors a stale force timer when a committed ban has advanced the turn', async () => {
    const { runDraftAutoBan } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(140_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    listLobbyCategoryBansMock.mockResolvedValue([
      { user_id: 'u1', category_id: 'cat-a' },
    ]);
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };
    redisExistsMock.mockResolvedValue(0);

    try {
      await runDraftAutoBan(io, 'l1', {
        requireUiReady: true,
        forceAtMs: 145_000,
        turnUserId: 'u1',
        banCount: 0,
      });

      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(150_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: true,
          forceAtMs: 150_000,
          turnUserId: 'u2',
          banCount: 1,
        }
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('re-anchors the current turn force deadline when a paused draft resumes', async () => {
    const { resumeActiveDraftTimers } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(500_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    cancelRealtimeTimerMock.mockResolvedValue(undefined);
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };
    redisExistsMock.mockResolvedValue(0);

    try {
      await resumeActiveDraftTimers(io, 'l1', { restartTimers: true });

      expect(cancelRealtimeTimerMock).toHaveBeenCalledWith('draft_auto_ban', 'l1');
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(510_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: true,
          forceAtMs: 510_000,
          turnUserId: 'u1',
          banCount: 0,
        }
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('accepts draft:ui_ready from the non-actor because every human must pass the gate', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    wireStatefulRedis();

    await draftRealtimeService.handleUiReady(io, createSocketMock('u2', 'l1'), {
      lobbyId: 'l1',
      turnUserId: 'u1',
      banCount: 0,
    });

    expect(redisSetMock).toHaveBeenCalledWith('draft:ui_ready:l1:u2:0', expect.any(String), { EX: 600 });
    expect(emit).toHaveBeenCalledWith('draft:waiting_for_ready', expect.objectContaining({
      lobbyId: 'l1',
      readyUserIds: ['u2'],
      waitingUserIds: ['u1'],
    }));
  });

  it('re-arms instead of auto-banning when a UI-ready gated timer fires before its force deadline', async () => {
    const { runDraftAutoBan } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(300_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };
    redisExistsMock.mockResolvedValue(0);

    try {
      await runDraftAutoBan(io, 'l1', { requireUiReady: true, forceAtMs: 310_000 });

      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(310_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: true,
          forceAtMs: 310_000,
          turnUserId: 'u1',
          banCount: 0,
        }
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('schedules the ranked-human UI-ready force deadline when run without an existing deadline', async () => {
    const { runDraftAutoBan } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(300_000);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };
    redisExistsMock.mockResolvedValue(0);
    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'ai-1' },
    ]);

    try {
      await runDraftAutoBan(io, 'l1');

      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(deleteLobbyMock).not.toHaveBeenCalled();
      expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
      expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
        'draft_auto_ban',
        'l1',
        new Date(310_000),
        {
          kind: 'draft_auto_ban',
          lobbyId: 'l1',
          requireUiReady: true,
          forceAtMs: 310_000,
          turnUserId: 'u1',
          banCount: 0,
        }
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('aborts a ranked draft instead of force-auto-banning a human without draft:ui_ready', async () => {
    const { runDraftAutoBan } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(320_000);
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      isOpen: true,
    };
    redisExistsMock.mockResolvedValue(0);
    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'ai-1' },
    ]);

    try {
      await runDraftAutoBan(io, 'l1', { requireUiReady: true, forceAtMs: 310_000 });

      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
      expect(beginMatchForLobbyMock).not.toHaveBeenCalled();
      expect(deleteLobbyMock).toHaveBeenCalledWith('l1');
      expect(redisDelMock).toHaveBeenCalledWith([
        'ranked:ai:lobby:l1',
        'draft:absent_after_grace:l1:u1',
      ]);
      expect(emit).toHaveBeenCalledWith('ranked:queue_left');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('auto-bans for ranked AI even when redis AI key is missing', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { draftRealtimeService, runDraftAutoBan, runRankedAiDraftBan } = await import('../../src/realtime/services/draft-realtime.service.js');
      const { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      const { io } = createIoMock();
      stopRealtimeTimerScheduler();
      startRealtimeTimerScheduler(io, {
        draft_ai_ban: async (server, payload) => {
          if (payload.kind === 'draft_ai_ban') await runRankedAiDraftBan(server, payload.lobbyId, payload.aiUserId);
        },
        draft_auto_ban: async (server, payload) => {
          if (payload.kind === 'draft_auto_ban') await runDraftAutoBan(server, payload.lobbyId);
        },
      });

      getLobbyByIdMock.mockResolvedValue({
        id: 'l1',
        mode: 'ranked',
        status: 'active',
        host_user_id: 'u1',
      });
      listMembersWithUserMock.mockResolvedValue([
        { user_id: 'u1' },
        { user_id: 'ai-1' },
      ]);

      await draftRealtimeService.handleBan(io, createSocketMock('u1', 'l1'), 'cat-a');
      await vi.advanceTimersByTimeAsync(800);

      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'u1', 'cat-a');
      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'ai-1', expect.any(String));
      expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
      expect(beginMatchForLobbyMock).toHaveBeenCalledWith(io, 'l1', 'm1');
    } finally {
      const { stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      stopRealtimeTimerScheduler();
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('uses the fast AI ban timer after the human draft ban times out in ranked-vs-AI', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const {
        runDraftAutoBan,
        runRankedAiDraftBan,
        scheduleDraftAutoBan,
      } = await import('../../src/realtime/services/draft-realtime.service.js');
      const { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      const { io } = createIoMock();
      stopRealtimeTimerScheduler();
      startRealtimeTimerScheduler(io, {
        draft_ai_ban: async (server, payload) => {
          if (payload.kind === 'draft_ai_ban') await runRankedAiDraftBan(server, payload.lobbyId, payload.aiUserId);
        },
        draft_auto_ban: async (server, payload) => {
          if (payload.kind === 'draft_auto_ban') await runDraftAutoBan(server, payload.lobbyId);
        },
      });

      getLobbyByIdMock.mockResolvedValue({
        id: 'l1',
        mode: 'ranked',
        status: 'active',
        host_user_id: 'u1',
      });
      listMembersWithUserMock.mockResolvedValue([
        { user_id: 'u1' },
        { user_id: 'ai-1' },
      ]);

      scheduleDraftAutoBan(io, 'l1');
      redisClientMock = {
        get: redisGetMock,
        set: redisSetMock,
        exists: redisExistsMock,
        del: redisDelMock,
        getDel: redisGetDelMock,
        isOpen: false,
      };
      await vi.advanceTimersByTimeAsync(16_000);

      expect(insertLobbyCategoryBanMock).toHaveBeenCalledTimes(1);
      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'u1', expect.any(String));
      expect(createMatchFromLobbyMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(700);

      expect(insertLobbyCategoryBanMock).toHaveBeenCalledTimes(2);
      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'ai-1', expect.any(String));
      expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
      expect(beginMatchForLobbyMock).toHaveBeenCalledWith(io, 'l1', 'm1');
    } finally {
      const { stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      stopRealtimeTimerScheduler();
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('recovers (does not dead-end) when the AI ban fires with no prior human ban', async () => {
    // Regression: if the human ban failed to land, runRankedAiDraftBan used to
    // see bans.length !== 1 and `return` with no reschedule, freezing the draft
    // on "preparing match" forever. It must now fall back to auto-ban recovery.
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { runDraftAutoBan, runRankedAiDraftBan } = await import('../../src/realtime/services/draft-realtime.service.js');
      const { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      const { io } = createIoMock();
      stopRealtimeTimerScheduler();
      startRealtimeTimerScheduler(io, {
        draft_ai_ban: async (server, payload) => {
          if (payload.kind === 'draft_ai_ban') await runRankedAiDraftBan(server, payload.lobbyId, payload.aiUserId);
        },
        draft_auto_ban: async (server, payload) => {
          if (payload.kind === 'draft_auto_ban') await runDraftAutoBan(server, payload.lobbyId);
        },
      });

      getLobbyByIdMock.mockResolvedValue({
        id: 'l1',
        mode: 'ranked',
        status: 'active',
        host_user_id: 'u1',
      });
      listMembersWithUserMock.mockResolvedValue([
        { user_id: 'u1' },
        { user_id: 'ai-1' },
      ]);

      // Simulate the broken state: AI ban runs but NO human ban exists yet.
      await runRankedAiDraftBan(io, 'l1', 'ai-1');
      redisClientMock = {
        get: redisGetMock,
        set: redisSetMock,
        exists: redisExistsMock,
        del: redisDelMock,
        getDel: redisGetDelMock,
        isOpen: false,
      };

      // It must not have dead-ended: auto-ban recovery should fire and drive the
      // draft to completion (both bans applied, match created).
      await vi.advanceTimersByTimeAsync(16_000);
      await vi.advanceTimersByTimeAsync(700);

      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'u1', expect.any(String));
      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'ai-1', expect.any(String));
      expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
    } finally {
      const { stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      stopRealtimeTimerScheduler();
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('enforces human first ban in ranked-vs-AI even when AI is host', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { draftRealtimeService, runDraftAutoBan, runRankedAiDraftBan } = await import('../../src/realtime/services/draft-realtime.service.js');
      const { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      const { io } = createIoMock();
      stopRealtimeTimerScheduler();
      startRealtimeTimerScheduler(io, {
        draft_ai_ban: async (server, payload) => {
          if (payload.kind === 'draft_ai_ban') await runRankedAiDraftBan(server, payload.lobbyId, payload.aiUserId);
        },
        draft_auto_ban: async (server, payload) => {
          if (payload.kind === 'draft_auto_ban') await runDraftAutoBan(server, payload.lobbyId);
        },
      });
      const aiSocket = createSocketMock('ai-1', 'l1');
      const userSocket = createSocketMock('u1', 'l1');

      getLobbyByIdMock.mockResolvedValue({
        id: 'l1',
        mode: 'ranked',
        status: 'active',
        host_user_id: 'ai-1',
      });
      listMembersWithUserMock.mockResolvedValue([
        { user_id: 'u1' },
        { user_id: 'ai-1' },
      ]);

      await draftRealtimeService.handleBan(io, aiSocket, 'cat-a');
      expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
      expect(aiSocket.emit).toHaveBeenCalledWith('error', {
        code: 'NOT_YOUR_TURN',
        message: 'It is not your turn to ban',
      });

      await draftRealtimeService.handleBan(io, userSocket, 'cat-a');
      await vi.advanceTimersByTimeAsync(800);

      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'u1', 'cat-a');
      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'ai-1', expect.any(String));
      expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
    } finally {
      const { stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
      stopRealtimeTimerScheduler();
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('pauses active draft and notifies opponent when a draft player disconnects', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit, fetchSockets } = createIoMock();
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
    };
    fetchSockets.mockResolvedValue([]);

    await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, 'l1', 'u1');

    expect(redisSetMock).toHaveBeenCalledWith('draft:disconnect:l1:u1', expect.any(String), { EX: 600 });
    expect(redisSetMock).toHaveBeenCalledWith('draft:pause:l1', expect.any(String), { EX: 600 });
    expect(emit).toHaveBeenCalledWith('draft:opponent_disconnected', {
      lobbyId: 'l1',
      opponentId: 'u1',
      graceMs: 30_000,
    });
  });

  it('uses the UI-ready gate rather than socket liveness when a player has not arrived', async () => {
    vi.useFakeTimers();
    const { scheduleDraftAutoBanForCurrentTurn } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit, fetchSockets } = createIoMock();
    getLobbyByIdMock.mockResolvedValue({ id: 'l1', mode: 'ranked', status: 'active', host_user_id: 'u1' });
    wireStatefulRedis();
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    fetchSockets.mockResolvedValue([
      { id: 'socket-u2', data: { user: { id: 'u2' }, lobbyId: 'l1' }, leave: vi.fn() },
    ]);

    await scheduleDraftAutoBanForCurrentTurn(io, 'l1');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(redisSetMock).not.toHaveBeenCalledWith('draft:disconnect:l1:u1', expect.any(String), { EX: 600 });
    expect(redisSetMock).not.toHaveBeenCalledWith('draft:pause:l1', expect.any(String), { EX: 600 });
    expect(emit).toHaveBeenCalledWith('draft:waiting_for_ready', {
      lobbyId: 'l1',
      readyUserIds: [],
      waitingUserIds: ['u1', 'u2'],
      forceCancelAt: expect.any(String),
    });
    expect(emit).not.toHaveBeenCalledWith('draft:opponent_disconnected', expect.anything());
  });

  it('does not pause when the current player sends ui_ready within the initial tolerance', async () => {
    vi.useFakeTimers();
    const { draftRealtimeService, scheduleDraftAutoBanForCurrentTurn } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    wireStatefulRedis();
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);

    await scheduleDraftAutoBanForCurrentTurn(io, 'l1');
    await vi.advanceTimersByTimeAsync(2000);
    await draftRealtimeService.handleUiReady(io, createSocketMock('u1', 'l1'), {
      lobbyId: 'l1', turnUserId: 'u1', banCount: 0,
    });
    await vi.advanceTimersByTimeAsync(4000);

    expect(redisSetMock).not.toHaveBeenCalledWith('draft:pause:l1', expect.any(String), expect.anything());
    expect(emit).not.toHaveBeenCalledWith('draft:opponent_disconnected', expect.anything());
  });

  it('starts a fresh full turn when the initially absent player acks within the gate', async () => {
    vi.useFakeTimers();
    const { draftRealtimeService, scheduleDraftAutoBanForCurrentTurn } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    getLobbyByIdMock.mockResolvedValue({ id: 'l1', mode: 'ranked', status: 'active', host_user_id: 'u1' });
    wireStatefulRedis();
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    cancelRealtimeTimerMock.mockResolvedValue(undefined);

    await scheduleDraftAutoBanForCurrentTurn(io, 'l1');
    await draftRealtimeService.handleUiReady(io, createSocketMock('u2', 'l1'), {
      lobbyId: 'l1', turnUserId: 'u1', banCount: 0,
    });
    await vi.advanceTimersByTimeAsync(7000);
    const ackAtMs = Date.now();
    await draftRealtimeService.handleUiReady(io, createSocketMock('u1', 'l1'), {
      lobbyId: 'l1', turnUserId: 'u1', banCount: 0,
    });

    expect(emit).toHaveBeenCalledWith('draft:begin', {
      lobbyId: 'l1',
      turnUserId: 'u1',
      forceAtMs: ackAtMs + 16_000,
    });
    expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
      'draft_auto_ban',
      'l1',
      new Date(ackAtMs + 16_000),
      expect.objectContaining({
        kind: 'draft_auto_ban',
        lobbyId: 'l1',
        turnUserId: 'u1',
        banCount: 0,
      })
    );
  });

  it('aborts a ranked draft as no-contest when the ready gate expires', async () => {
    vi.useFakeTimers();
    const { runDraftAutoBan, scheduleDraftAutoBanForCurrentTurn } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    getLobbyByIdMock.mockResolvedValue({ id: 'l1', mode: 'ranked', status: 'active', host_user_id: 'u1' });
    wireStatefulRedis();
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);

    await scheduleDraftAutoBanForCurrentTurn(io, 'l1');
    await vi.advanceTimersByTimeAsync(10_000);
    await runDraftAutoBan(io, 'l1', {
      requireUiReady: true,
      forceAtMs: Date.now() - 1,
      turnUserId: 'u1',
      banCount: 0,
    });

    expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(deleteLobbyMock).toHaveBeenCalledWith('l1');
  });

  it('pauses draft when only an older same-user socket remains in the lobby room', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit, fetchSockets } = createIoMock();
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
    };
    fetchSockets.mockResolvedValue([
      { id: 'old-socket', data: { user: { id: 'u1' }, connectedAt: 1000 } },
      { id: 'opponent-socket', data: { user: { id: 'u2' }, connectedAt: 1500 } },
    ]);

    await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, 'l1', 'u1', {
      ignoreSocketId: 'active-socket',
      disconnectedConnectedAt: 2000,
    });

    expect(redisSetMock).toHaveBeenCalledWith('draft:disconnect:l1:u1', expect.any(String), { EX: 600 });
    expect(emit).toHaveBeenCalledWith('draft:opponent_disconnected', {
      lobbyId: 'l1',
      opponentId: 'u1',
      graceMs: 30_000,
    });
  });

  it('resumes the draft via presence re-check when an older live socket survives a ghost disconnect', async () => {
    vi.useFakeTimers();
    try {
      const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
      const { io, emit, fetchSockets } = createIoMock();
      wireStatefulRedis();
      // The dying socket is a short-lived ghost (connectedAt 2000); the user's
      // healthy MAIN socket (connectedAt 1000) stays in the lobby room.
      fetchSockets.mockResolvedValue([
        { id: 'old-main-socket', data: { user: { id: 'u1' }, connectedAt: 1000 } },
      ]);

      await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, 'l1', 'u1', {
        ignoreSocketId: 'ghost-socket',
        disconnectedConnectedAt: 2000,
      });

      // S15 guard intact: older socket cannot instantly prove presence,
      // so the pause + grace still arm and there is no immediate resume.
      expect(redisSetMock).toHaveBeenCalledWith('draft:disconnect:l1:u1', expect.any(String), { EX: 600 });
      expect(emit).not.toHaveBeenCalledWith('draft:resume', { lobbyId: 'l1' });

      // A zombie cannot outlive the ping timeout. The older socket is still
      // alive at the re-check → the disconnect was a ghost → resume.
      await vi.advanceTimersByTimeAsync(12_000);

      expect(emit).toHaveBeenCalledWith('draft:resume', { lobbyId: 'l1' });
      expect(redisDelMock).toHaveBeenCalledWith(['draft:pause:l1', 'draft:grace:l1']);
      expect(cancelRealtimeTimerMock).toHaveBeenCalledWith('draft_grace_expiry', 'l1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the draft paused when the older socket turns out to be a zombie (gone at re-check)', async () => {
    vi.useFakeTimers();
    try {
      const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
      const { io, emit, fetchSockets } = createIoMock();
      wireStatefulRedis();
      // Present at pause time, but dead (ping-timed-out) by the re-check.
      fetchSockets
        .mockResolvedValueOnce([
          { id: 'zombie-socket', data: { user: { id: 'u1' }, connectedAt: 1000 } },
        ])
        .mockResolvedValue([]);

      await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, 'l1', 'u1', {
        ignoreSocketId: 'active-socket',
        disconnectedConnectedAt: 2000,
      });

      await vi.advanceTimersByTimeAsync(12_000);

      // No live socket at re-check → no resume; grace continues to expiry.
      expect(emit).not.toHaveBeenCalledWith('draft:resume', { lobbyId: 'l1' });
      expect(cancelRealtimeTimerMock).not.toHaveBeenCalledWith('draft_grace_expiry', 'l1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms draft grace then resumes when a newer same-user replacement socket is already in the lobby room', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit, fetchSockets } = createIoMock();
    wireStatefulRedis();
    fetchSockets.mockResolvedValue([
      { id: 'replacement-socket', data: { user: { id: 'u1' }, connectedAt: 2500 } },
    ]);

    await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, 'l1', 'u1', {
      ignoreSocketId: 'active-socket',
      disconnectedConnectedAt: 2000,
    });

    expect(redisSetMock).toHaveBeenCalledWith('draft:disconnect:l1:u1', expect.any(String), { EX: 600 });
    expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
      'draft_grace_expiry',
      'l1',
      expect.any(Date),
      { kind: 'draft_grace_expiry', lobbyId: 'l1', disconnectedUserId: 'u1' }
    );
    expect(redisDelMock).toHaveBeenCalledWith(['draft:disconnect:l1:u1', 'draft:absent_after_grace:l1:u1']);
    expect(redisDelMock).toHaveBeenCalledWith(['draft:pause:l1', 'draft:grace:l1']);
    expect(cancelRealtimeTimerMock).toHaveBeenCalledWith('draft_grace_expiry', 'l1');
    expect(emit).toHaveBeenCalledWith('draft:resume', { lobbyId: 'l1' });
  });

  it('clears draft pause and resumes timers when the disconnected player reconnects', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
    };
    const existingKeys = new Set(['draft:disconnect:l1:u1']);
    redisExistsMock.mockImplementation(async (key: string) => (existingKeys.has(key) ? 1 : 0));
    redisDelMock.mockImplementation(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        existingKeys.delete(key);
      }
      return 1;
    });

    await draftRealtimeService.resumeDraftForReconnectedPlayer(io, 'l1', 'u1');

    expect(redisDelMock).toHaveBeenCalledWith(['draft:disconnect:l1:u1', 'draft:absent_after_grace:l1:u1']);
    expect(redisDelMock).toHaveBeenCalledWith(['draft:pause:l1', 'draft:grace:l1']);
    expect(emit).toHaveBeenCalledWith('draft:resume', { lobbyId: 'l1' });
  });

  // ── Fix B: durable draft disconnect-grace timer ──────────────────────────

  // Wire redisClientMock to a stateful in-memory key set with the semantics the
  // grace handler relies on: exists(), del(), and set() with NX (lock) / GETDEL.
  function wireStatefulRedis(initialKeys: string[] = []) {
    const keys = new Set(initialKeys);
    redisExistsMock.mockImplementation(async (key: string) => (keys.has(key) ? 1 : 0));
    redisDelMock.mockImplementation(async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) keys.delete(key);
      return 1;
    });
    redisSetMock.mockImplementation(async (key: string, _val: unknown, opts?: { NX?: boolean }) => {
      if (opts?.NX && keys.has(key)) return null; // NX fails when key already present
      keys.add(key);
      return 'OK';
    });
    redisGetDelMock.mockImplementation(async (key: string) => {
      const had = keys.has(key);
      keys.delete(key);
      return had ? '1' : null;
    });
    // Token-checked lock: acquireLock does SET key token NX PX; releaseLock runs
    // a Lua eval that deletes only if the stored token matches. Model both so the
    // grace processing lock exercises the real locks.ts path (client.isOpen true).
    const lockTokens = new Map<string, string>();
    redisSetMock.mockImplementation(async (key: string, val: unknown, opts?: { NX?: boolean }) => {
      if (opts?.NX && keys.has(key)) return null;
      keys.add(key);
      if (typeof val === 'string') lockTokens.set(key, val);
      return 'OK';
    });
    redisEvalMock.mockImplementation(async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
      const [key] = opts.keys;
      const [token] = opts.arguments;
      if (lockTokens.get(key) === token) {
        keys.delete(key);
        lockTokens.delete(key);
        return 1;
      }
      return 0;
    });
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      exists: redisExistsMock,
      del: redisDelMock,
      getDel: redisGetDelMock,
      eval: redisEvalMock,
      isOpen: true,
      // No-op sorted-set ops so the real cancelRealtimeTimer (delegated) doesn't
      // throw now that isOpen is true.
      zRem: vi.fn(async () => 0),
      zAdd: vi.fn(async () => 0),
      zScore: vi.fn(async () => null),
    };
    return keys;
  }

  it('schedules a durable grace-expiry timer (not setTimeout) when a draft player disconnects', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, fetchSockets } = createIoMock();
    wireStatefulRedis();
    fetchSockets.mockResolvedValue([]);

    await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, 'l1', 'u1');

    expect(scheduleRealtimeTimerMock).toHaveBeenCalledTimes(1);
    const [kind, key, dueAt, payload] = scheduleRealtimeTimerMock.mock.calls[0];
    expect(kind).toBe('draft_grace_expiry');
    expect(key).toBe('l1');
    expect(dueAt).toBeInstanceOf(Date);
    expect(payload).toEqual({ kind: 'draft_grace_expiry', lobbyId: 'l1', disconnectedUserId: 'u1' });
  });

  it('recovers a frozen draft on grace expiry by auto-banning for the absent actor', async () => {
    const { runDraftGraceExpiry } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      getLobbyByIdMock.mockResolvedValue({ id: 'l1', mode: 'friendly', status: 'active', host_user_id: 'u1' });
      // u1 already banned (seed the shared stateful bans array); u2 is the
      // disconnected actor whose turn it is.
      await insertLobbyCategoryBanMock('l1', 'u1', 'cat-a');
      // Pending recovery: grace marker + u2's disconnect marker present.
      const keys = wireStatefulRedis(['draft:grace:l1', 'draft:disconnect:l1:u2']);

      await runDraftGraceExpiry(io, 'l1', 'u2');

      // Auto-ban applied for the absent actor (u2), draft completes, and the
      // newly-created match is forfeited immediately instead of starting live play.
      expect(insertLobbyCategoryBanMock).toHaveBeenCalledWith('l1', 'u2', expect.any(String));
      expect(emit).toHaveBeenCalledWith('draft:complete', expect.anything());
      expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
      expect(beginMatchForLobbyMock).not.toHaveBeenCalled();
      expect(pauseMatchForDisconnectedPlayerMock).not.toHaveBeenCalled();
      expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(expect.objectContaining({
        matchId: 'm1',
        forfeitingUserId: 'u2',
      }));
      expect(emitFinalResultsToMatchParticipantsMock).toHaveBeenCalledWith(
        io,
        'm1',
        { matchId: 'm1', resultVersion: 123 }
      );
      // Pending markers cleared only after success; processing lock released.
      expect(keys.has('draft:grace:l1')).toBe(false);
      expect(keys.has('draft:grace:lock:l1')).toBe(false);
      expect(keys.has('draft:absent_after_grace:l1:u2')).toBe(false);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('aborts a ranked draft immediately on grace expiry when the absent actor is human', async () => {
    const { runDraftGraceExpiry } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    getLobbyByIdMock.mockResolvedValue({
      id: 'l1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'ai-1' },
    ]);
    wireStatefulRedis(['draft:grace:l1', 'draft:pause:l1', 'draft:disconnect:l1:u1']);

    await runDraftGraceExpiry(io, 'l1', 'u1');

    expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('draft:banned', expect.anything());
    expect(emit).not.toHaveBeenCalledWith('draft:complete', expect.anything());
    expect(consumeRankedTicketsMock).not.toHaveBeenCalled();
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(deleteLobbyMock).toHaveBeenCalledWith('l1');
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
  });

  it('is a noop on grace expiry if the player already reconnected (grace marker gone)', async () => {
    const { runDraftGraceExpiry } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    // Reconnect already cleared the grace marker → exists() returns 0.
    wireStatefulRedis([]);

    await runDraftGraceExpiry(io, 'l1', 'u1');

    expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    // Never even took the processing lock.
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('handles a duplicate grace-expiry firing exactly once (no duplicate ban/match)', async () => {
    const { runDraftGraceExpiry } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      getLobbyByIdMock.mockResolvedValue({ id: 'l1', mode: 'friendly', status: 'active', host_user_id: 'u1' });
      await insertLobbyCategoryBanMock('l1', 'u1', 'cat-a');
      insertLobbyCategoryBanMock.mockClear(); // ignore the seed ban below

      wireStatefulRedis(['draft:grace:l1', 'draft:disconnect:l1:u2']);

      // Fire the same expiry twice (e.g. two instances both polled it). The first
      // consumes the grace marker on success; the second finds it gone → noop.
      await runDraftGraceExpiry(io, 'l1', 'u2');
      await runDraftGraceExpiry(io, 'l1', 'u2');

      expect(insertLobbyCategoryBanMock).toHaveBeenCalledTimes(1);
      expect(createMatchFromLobbyMock).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('is a noop on grace expiry if the lobby/draft is already completed', async () => {
    const { runDraftGraceExpiry } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    // Grace pending, but the lobby is no longer active (draft already finished).
    getLobbyByIdMock.mockResolvedValue({ id: 'l1', mode: 'friendly', status: 'completed', host_user_id: 'u1' });
    const keys = wireStatefulRedis(['draft:grace:l1', 'draft:pause:l1']);

    await runDraftGraceExpiry(io, 'l1', 'u1');

    expect(insertLobbyCategoryBanMock).not.toHaveBeenCalled();
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('draft:complete', expect.anything());
    // Stale pause + grace markers cleaned up.
    expect(keys.has('draft:pause:l1')).toBe(false);
    expect(keys.has('draft:grace:l1')).toBe(false);
  });

  it('rethrows on transient failure and leaves the grace marker for retry', async () => {
    const { runDraftGraceExpiry } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    const keys = wireStatefulRedis(['draft:grace:l1', 'draft:disconnect:l1:u2']);
    // Transient DB blip during recovery.
    getLobbyByIdMock.mockRejectedValueOnce(new Error('db blip'));

    await expect(runDraftGraceExpiry(io, 'l1', 'u2')).rejects.toThrow('db blip');

    // Grace marker NOT consumed → the rescheduled timer can retry.
    expect(keys.has('draft:grace:l1')).toBe(true);
    // Processing lock released so the retry can re-acquire it.
    expect(keys.has('draft:grace:lock:l1')).toBe(false);
  });

  it('cancels the durable grace timer when a disconnected player reconnects before expiry', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io } = createIoMock();
    wireStatefulRedis(['draft:disconnect:l1:u1']);

    await draftRealtimeService.resumeDraftForReconnectedPlayer(io, 'l1', 'u1');

    expect(cancelRealtimeTimerMock).toHaveBeenCalledWith('draft_grace_expiry', 'l1');
  });
});
