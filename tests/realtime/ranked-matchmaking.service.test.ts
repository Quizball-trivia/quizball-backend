import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { NotFoundError } from '../../src/core/errors.js';
import { logger } from '../../src/core/logger.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import {
  RANKED_MM_CANCEL_SEARCH_SCRIPT,
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_RANDOM_SCRIPT,
} from '../../src/realtime/lua/ranked-matchmaking.scripts.js';

type FakeRedis = {
  isOpen: boolean;
  zRangeByScore: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  hGet: ReturnType<typeof vi.fn>;
  hGetAll: ReturnType<typeof vi.fn>;
  hDel: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  zCard: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
};

const createLobbyMock = vi.fn();
const addMemberMock = vi.fn();
const getLobbyByIdMock = vi.fn();
const buildLobbyStateMock = vi.fn();
const listOpenLobbiesForUserMock = vi.fn();
const getActiveMatchForUserMock = vi.fn();
const getActiveMatchForLobbyMock = vi.fn();
const removeLobbyMemberMock = vi.fn();
const restoreWaitingIdleSinceMock = vi.fn();
const deleteLobbyMock = vi.fn();
const countLobbyMembersMock = vi.fn();
const listLobbyMembersMock = vi.fn();
const getUserByIdMock = vi.fn();
const ensureProfileMock = vi.fn();
const startDraftMock = vi.fn();
const startRankedAiForUserMock = vi.fn();
const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getWalletMock = vi.fn();
const trackRankedQueueLeftMock = vi.fn();

let redisMock: FakeRedis;

vi.mock('../../src/core/analytics/game-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/analytics/game-events.js')>()),
  trackRankedQueueLeft: (...args: unknown[]) => trackRankedQueueLeftMock(...args),
}));
vi.mock('../../src/core/config.js', () => ({
  config: {
    RANKED_HUMAN_QUEUE_ENABLED: true,
    ROOM_GAMES_DISABLED: [],
  },
}));

// No live room seat (the session guard checks for one before any queue join).
vi.mock('../../src/modules/room/room.repo.js', () => ({ roomRepo: { liveMatchForUser: vi.fn(async () => null) } }));

const hasOpenSeriesForLobbyMock = vi.fn(async () => false);
vi.mock('../../src/modules/football-grid/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/modules/football-grid/index.js')>();
  return {
    ...original,
    footballGridRepo: {
      ...original.footballGridRepo,
      hasOpenSeriesForLobby: (...args: unknown[]) => hasOpenSeriesForLobbyMock(...args as []),
    },
  };
});

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redisMock,
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    createLobby: (...args: unknown[]) => createLobbyMock(...args),
    addMember: (...args: unknown[]) => addMemberMock(...args),
    getById: (...args: unknown[]) => getLobbyByIdMock(...args),
    listOpenLobbiesForUser: (...args: unknown[]) => listOpenLobbiesForUserMock(...args),
    listOpenLobbiesForUsers: async (userIds: string[]) => new Map(
      await Promise.all(userIds.map(async (userId) => [
        userId,
        await listOpenLobbiesForUserMock(userId),
      ] as const))
    ),
    removeMember: (...args: unknown[]) => removeLobbyMemberMock(...args),
    restoreWaitingIdleSince: (...args: unknown[]) => restoreWaitingIdleSinceMock(...args),
    deleteLobby: (...args: unknown[]) => deleteLobbyMock(...args),
    countMembers: (...args: unknown[]) => countLobbyMembersMock(...args),
    listMembersWithUser: (...args: unknown[]) => listLobbyMembersMock(...args),
    setHostUser: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getActiveMatchForUser: (...args: unknown[]) => getActiveMatchForUserMock(...args),
    getActiveMatchForLobby: (...args: unknown[]) => getActiveMatchForLobbyMock(...args),
    getActiveMatchesForUsers: async (userIds: string[]) => {
      const entries = await Promise.all(userIds.map(async (userId) => [
        userId,
        await getActiveMatchForUserMock(userId),
      ] as const));
      return new Map(entries.filter((entry) => entry[1]));
    },
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    buildLobbyState: (...args: unknown[]) => buildLobbyStateMock(...args),
  },
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

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: (...args: unknown[]) => ensureProfileMock(...args),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    getWallet: (...args: unknown[]) => getWalletMock(...args),
  },
}));

vi.mock('../../src/modules/stats/stats.service.js', () => ({
  statsService: {
    getRecentFormForUser: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/realtime/services/lobby-realtime.service.js', () => ({
  startDraft: (...args: unknown[]) => startDraftMock(...args),
  startRankedAiForUser: (...args: unknown[]) => startRankedAiForUserMock(...args),
}));

// Users treated as having NO live socket (ghost searches). Anyone not listed is
// present by default — queued users normally have an authenticated socket.
const absentUserIds = new Set<string>();
/** lobbyId → sockets the io mock reports inside `lobby:<id>` (default: none). */
const lobbyRoomSockets = new Map<string, Array<{ id: string; leave: () => void; data: { user: { id: string }; lobbyId?: string; connectedAt?: number } }>>();
/**
 * userId → sockets the io mock reports inside `user:<id>`. Unset users get one
 * phantom socket `socket-<userId>` — the SAME id createSocketMock mints, since
 * a disconnecting socket has already left its rooms in production and must not
 * read as a second tab of its own.
 */
const userRoomSockets = new Map<string, Array<{ id: string; data: { user: { id: string }; lobbyId?: string; matchId?: string } }>>();

function createIoMock(): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const socketsJoin = vi.fn().mockResolvedValue(undefined);
  const inFn = vi.fn((room: string) => {
    const userMatch = /^user:(.+)$/.exec(room);
    const userId = userMatch?.[1] ?? null;
    const lobbyMatch = /^lobby:(.+)$/.exec(room);
    const fetchSockets = vi.fn().mockResolvedValue(
      lobbyMatch
        ? (lobbyRoomSockets.get(lobbyMatch[1]!) ?? [])
        : userId && !absentUserIds.has(userId)
          ? (userRoomSockets.get(userId) ?? [{ id: `socket-${userId}`, data: { user: { id: userId } } }])
          : []
    );
    return { socketsJoin, fetchSockets };
  });

  return {
    to,
    in: inFn,
  } as unknown as QuizballServer;
}

function makeOpenLobby(id: string, status: 'waiting' | 'active' = 'waiting') {
  return {
    id,
    mode: 'ranked',
    status,
    host_user_id: 'u1',
    invite_code: null,
    display_name: null,
    is_public: false,
    game_mode: 'ranked_sim',
    friendly_random: true,
    friendly_category_a_id: null,
    friendly_category_b_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    joined_at: new Date().toISOString(),
  };
}

async function loadService() {
  const module = await import('../../src/realtime/services/ranked-matchmaking.service.js');
  return module.rankedMatchmakingService;
}

describe('ranked-matchmaking.service queue behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    absentUserIds.clear();
    lobbyRoomSockets.clear();
    userRoomSockets.clear();
    hasOpenSeriesForLobbyMock.mockResolvedValue(false);

    redisMock = {
      isOpen: true,
      zRangeByScore: vi.fn().mockResolvedValue([]),
      eval: vi.fn().mockResolvedValue([]),
      hGet: vi.fn().mockResolvedValue(null),
      hGetAll: vi.fn().mockResolvedValue({}),
      hDel: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      exists: vi.fn().mockResolvedValue(0),
      zCard: vi.fn().mockResolvedValue(1),
      multi: vi.fn(),
    };
    const multi = {
      hSet: vi.fn(() => multi),
      expire: vi.fn(() => multi),
      zAdd: vi.fn(() => multi),
      exec: vi.fn().mockResolvedValue([1]),
    };
    redisMock.multi.mockReturnValue(multi);

    acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
    releaseLockMock.mockResolvedValue(undefined);

    createLobbyMock.mockImplementation(async ({ hostUserId }: { hostUserId: string }) => ({
      id: `lobby-${hostUserId}`,
      mode: 'ranked',
      status: 'waiting',
      host_user_id: hostUserId,
      invite_code: null,
      display_name: null,
      is_public: false,
      game_mode: 'ranked_sim',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    addMemberMock.mockResolvedValue(undefined);
    listOpenLobbiesForUserMock.mockResolvedValue([]);
    getActiveMatchForUserMock.mockResolvedValue(null);
    getActiveMatchForLobbyMock.mockResolvedValue(null);
    removeLobbyMemberMock.mockResolvedValue(undefined);
    restoreWaitingIdleSinceMock.mockResolvedValue(undefined);
    deleteLobbyMock.mockResolvedValue(undefined);
    countLobbyMembersMock.mockResolvedValue(0);
    listLobbyMembersMock.mockResolvedValue([{ user_id: 'u1', is_ai: false }]);
    getLobbyByIdMock.mockImplementation(async (lobbyId: string) => ({
      id: lobbyId,
      mode: 'ranked',
      status: 'waiting',
      host_user_id: 'u1',
      invite_code: null,
      display_name: null,
      is_public: false,
      game_mode: 'ranked_sim',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    buildLobbyStateMock.mockResolvedValue({
      lobbyId: 'lobby',
      mode: 'ranked',
      status: 'waiting',
      inviteCode: null,
      displayName: null,
      hostUserId: 'u1',
      isPublic: false,
      settings: {
        gameMode: 'ranked_sim',
        friendlyRandom: true,
        friendlyCategoryAId: null,
        friendlyCategoryBId: null,
      },
      members: [],
    });
    getUserByIdMock.mockImplementation(async (userId: string) => ({
      id: userId,
      nickname: userId,
      avatar_url: null,
    }));
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
    getWalletMock.mockResolvedValue({ coins: 0, tickets: 1 });
    startDraftMock.mockResolvedValue(undefined);
    startRankedAiForUserMock.mockResolvedValue(true);
  });

  afterEach(async () => {
    const service = await loadService();
    service.stop();
    vi.useRealTimers();
  });

  function createSocketMock(userId: string) {
    return {
      id: `socket-${userId}`,
      connected: true,
      data: { user: { id: userId, role: 'user' } },
      emit: vi.fn(),
    };
  }

  it('ignores a queue join while the user is mid-draft instead of emitting INSUFFICIENT_TICKETS', async () => {
    // Reload-mid-draft regression (staging 2026-06-10): the client restores
    // into "searching" and re-emits queue_join, but the ticket was already
    // consumed at draft completion. The ticket preflight ran FIRST and
    // emitted a spurious "You need a ticket" error + ranked:queue_left on
    // top of a match that was starting fine. The session block must win.
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    listOpenLobbiesForUserMock.mockResolvedValue([makeOpenLobby('lobby-draft', 'active')]);
    getWalletMock.mockResolvedValue({ coins: 0, tickets: 0 });

    await service.handleQueueJoin(io, socket as never);

    const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(userEmit).not.toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'INSUFFICIENT_TICKETS' })
    );
    expect(userEmit).not.toHaveBeenCalledWith('ranked:queue_left');
    // No wallet preflight, no enqueue — authoritative state re-emitted instead.
    expect(getWalletMock).not.toHaveBeenCalled();
    expect(redisMock.multi).not.toHaveBeenCalled();
    expect(userEmit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({ waitingLobbyId: 'lobby-draft' })
    );
  });

  it('heals a stranded active friendly auction before joining the ranked queue', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    const openLobbies = [{
      ...makeOpenLobby('stranded-auction', 'active'),
      mode: 'friendly' as const,
      game_mode: 'auction' as const,
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }];
    listOpenLobbiesForUserMock.mockImplementation(async () => [...openLobbies]);
    removeLobbyMemberMock.mockImplementation(async () => {
      openLobbies.splice(0, openLobbies.length);
    });

    await service.handleQueueJoin(io, socket as never);

    const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(removeLobbyMemberMock).toHaveBeenCalledWith('stranded-auction', 'u1', expect.stringMatching(/^session_guard:/));
    expect(deleteLobbyMock).toHaveBeenCalledWith('stranded-auction', expect.stringMatching(/^session_guard:/));
    expect(redisMock.multi).toHaveBeenCalledTimes(1);
    expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
  });

  it('ignores a queue join while the user sits in a live waiting lobby instead of dissolving it', async () => {
    // A reload while in a lobby can make the client re-emit a stale
    // queue_join; that must never remove the user from a live lobby.
    const service = await loadService();
    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const prepareSpy = vi.spyOn(userSessionGuardService, 'prepareForQueueJoin');
    const io = createIoMock();
    const socket = createSocketMock('u1');
    listOpenLobbiesForUserMock.mockResolvedValue([makeOpenLobby('lobby-live-wait', 'waiting')]);

    await service.handleQueueJoin(io, socket as never);

    const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(deleteLobbyMock).not.toHaveBeenCalled();
    expect(redisMock.multi).not.toHaveBeenCalled();
    expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    expect(userEmit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({ state: 'IN_WAITING_LOBBY', waitingLobbyId: 'lobby-live-wait' })
    );
    prepareSpy.mockRestore();
  });

  it('tells the client it is blocked when the ignored join comes from a seat in a live room game', async () => {
    // Staging QA 2026-10-06: Aproximado in one tab, ranked in another. The join is ignored (correct), but a bare
    // session:state left the client "searching" forever. A live room seat is a definite refusal: say so.
    const service = await loadService();
    const { roomRepo } = await import('../../src/modules/room/room.repo.js');
    vi.mocked(roomRepo.liveMatchForUser).mockResolvedValue({ id: 'room-match', game: 'aproximado', lobby_id: 'room-lobby' } as never);
    try {
      const io = createIoMock();
      const socket = createSocketMock('u1');
      listOpenLobbiesForUserMock.mockResolvedValue([makeOpenLobby('room-lobby', 'active')]);
      lobbyRoomSockets.set('room-lobby', [{ id: 'friend', leave: vi.fn(), data: { user: { id: 'u2' }, lobbyId: 'room-lobby', connectedAt: Date.now() } }]);

      await service.handleQueueJoin(io, socket as never, { source: 'mode_select', reason: 'initial' });

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
      expect(socket.emit).toHaveBeenCalledWith('session:blocked', expect.objectContaining({
        reason: 'ACTIVE_MATCH',
        operation: 'ranked:queue_join',
        stateSnapshot: expect.objectContaining({ waitingLobbyId: 'room-lobby' }),
      }));
    } finally {
      vi.mocked(roomRepo.liveMatchForUser).mockResolvedValue(null);
    }
  });

  it('keeps the bare session:state (no blocked event) when the ignored join has no room seat', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    listOpenLobbiesForUserMock.mockResolvedValue([makeOpenLobby('lobby-live-wait', 'waiting')]);

    await service.handleQueueJoin(io, socket as never);

    expect(socket.emit).not.toHaveBeenCalledWith('session:blocked', expect.anything());
  });

  describe('abandoned waiting lobby heal on an explicit ranked join', () => {
    const STALE_MS = 31 * 60_000;
    function staleFriendlyLobby(id: string, ageMs = STALE_MS) {
      const at = new Date(Date.now() - ageMs).toISOString();
      return {
        ...makeOpenLobby(id, 'waiting'),
        mode: 'friendly' as const,
        game_mode: 'friendly_possession' as const,
        created_at: at,
        updated_at: at,
        joined_at: at,
      };
    }
    function installLobby(lobby: ReturnType<typeof staleFriendlyLobby>) {
      const open = [lobby];
      listOpenLobbiesForUserMock.mockImplementation(async () => [...open]);
      getLobbyByIdMock.mockImplementation(async (lobbyId: string) => (lobbyId === lobby.id ? lobby : null));
      removeLobbyMemberMock.mockImplementation(async () => { open.splice(0, open.length); });
    }
    const explicit = { source: 'mode_select', reason: 'initial', clientRequestId: 'click-1' } as const;
    const claimStore = new Map<string, string>();
    const CLAIM_KEY = 'ranked:explicit_join:u1:click-1';
    /**
     * The explicit-join claims live in Redis: back set NX / get / the stamp
     * compare-and-set script with a map so replays see earlier clicks.
     * `failSwap(n)` makes the n-th compare-and-set (1-based) throw before it
     * writes; `loseReply(n)` makes it throw after the write has landed.
     */
    function useClaimStore(options: { failSwap?: (call: number) => boolean; loseReply?: (call: number) => boolean } = {}) {
      const store = claimStore;
      let swapCalls = 0;
      redisMock.set.mockImplementation(async (key: string, value: string, opts?: { NX?: boolean; XX?: boolean }) => {
        if (opts?.NX && store.has(key)) return null;
        if (opts?.XX && !store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      });
      redisMock.get.mockImplementation(async (key: string) => store.get(key) ?? null);
      redisMock.eval.mockImplementation(async (script: string, evalOptions?: { keys?: string[]; arguments?: string[] }) => {
        if (!script.includes('KEEPTTL')) return [];
        swapCalls += 1;
        if (options.failSwap?.(swapCalls)) throw new Error('redis write failed');
        const [key] = evalOptions?.keys ?? [];
        const [expected, next] = evalOptions?.arguments ?? [];
        if (store.get(key) !== expected) return 0;
        store.set(key, next);
        if (options.loseReply?.(swapCalls)) throw new Error('redis reply lost');
        return 1;
      });
    }
    beforeEach(() => {
      claimStore.clear();
      useClaimStore();
    });

    it('heals a stranded lobby even though connect hydration re-attached the player\'s own socket', async () => {
      // The real prod path: the returning player's socket is back in the dead
      // lobby's room before they press Play Ranked. Their own socket must not
      // count as life, or the heal is unreachable.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('stranded-hydrated'));
      lobbyRoomSockets.set('stranded-hydrated', [{ id: 'own', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'stranded-hydrated', connectedAt: Date.now() - 1_500 } }]);

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(acquireLockMock).toHaveBeenCalledWith('lock:lobby:stranded-hydrated', expect.any(Number));
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('stranded-hydrated', 'u1', expect.stringMatching(/^session_guard:/));
      expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    });

    it('preserves the same stranded lobby on a reload re-emit (recovery source)', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('stranded-recovery'));
      lobbyRoomSockets.set('stranded-recovery', [{ id: 'own', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'stranded-recovery', connectedAt: Date.now() - 1_500 } }]);

      await service.handleQueueJoin(io, socket as never, { source: 'recovery', reason: 'recovery_retry' });

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
      expect(userEmit).toHaveBeenCalledWith(
        'session:state',
        expect.objectContaining({ state: 'IN_WAITING_LOBBY', waitingLobbyId: 'stranded-recovery' })
      );
    });

    it("preserves the player's long-lived-tab lobby on a recovery retry (only their explicit click outranks their own tabs)", async () => {
      // Solo host waiting 35 min for a friend: a recovery_retry re-emitted by
      // the client must not dissolve the lobby from under the tab that has
      // been sitting in it all along. (An explicit click does leave it — see
      // the own-tab test below.)
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('kept-open'));
      lobbyRoomSockets.set('kept-open', [
        { id: 'old-tab', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'kept-open', connectedAt: Date.now() - STALE_MS - 60_000 } },
        { id: 'new-tab', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'kept-open', connectedAt: Date.now() - 1_000 } },
      ]);

      await service.handleQueueJoin(io, socket as never, { source: 'mode_select', reason: 'recovery_retry' });

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    });

    it('heals a stranded auction lobby with a second member who is also gone (the Aug-28 prod shape)', async () => {
      // Only the requester leaves; the lobby's idle time is put back so the
      // other stranded member's own explicit click heals just the same.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      const lobby = { ...staleFriendlyLobby('stranded-auction'), game_mode: 'auction' as never };
      installLobby(lobby);
      listLobbyMembersMock.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
      countLobbyMembersMock.mockResolvedValue(1);

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('stranded-auction', 'u1', expect.stringMatching(/^session_guard:/));
      expect(removeLobbyMemberMock).not.toHaveBeenCalledWith('stranded-auction', 'u2', expect.stringMatching(/^session_guard:/));
      expect(restoreWaitingIdleSinceMock).toHaveBeenCalledWith('stranded-auction', lobby.updated_at);
      expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    });

    it('preserves the lobby on an automatic retry that still carries the original mode_select source', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('stranded-retry'));

      await service.handleQueueJoin(io, socket as never, { source: 'mode_select', reason: 'recovery_retry' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('treats a lobby deleted between the context read and the lock as healed', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      const lobby = staleFriendlyLobby('vanished');
      const open = [lobby];
      listOpenLobbiesForUserMock.mockImplementation(async () => [...open]);
      getLobbyByIdMock.mockImplementation(async () => { open.splice(0, open.length); return null; });

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    });

    it('preserves everything when one of two waiting lobbies is still live', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      const dead = staleFriendlyLobby('dead-one');
      const live = staleFriendlyLobby('live-one');
      const open = [dead, live];
      listOpenLobbiesForUserMock.mockImplementation(async () => [...open]);
      getLobbyByIdMock.mockImplementation(async (lobbyId: string) => open.find((l) => l.id === lobbyId) ?? null);
      removeLobbyMemberMock.mockImplementation(async (lobbyId: string) => {
        const index = open.findIndex((l) => l.id === lobbyId);
        if (index >= 0) open.splice(index, 1);
      });
      lobbyRoomSockets.set('live-one', [{ id: 'friend', leave: vi.fn(), data: { user: { id: 'u2' }, lobbyId: 'live-one' } }]);

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    });

    it('preserves an old lobby another member is still connected to', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('old-but-shared'));
      lobbyRoomSockets.set('old-but-shared', [{ id: 'friend', leave: vi.fn(), data: { user: { id: 'u2' }, lobbyId: 'old-but-shared' } }]);

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    });

    it('preserves a fresh socketless lobby (reload window) on a recovery re-emit', async () => {
      // Mid-reload the lobby's sockets are briefly gone; the automatic
      // re-emit carries no intent and must not leave the lobby, however it is
      // labelled. (An explicit click on the same lobby does leave it now.)
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('fresh-wait', 0));

      await service.handleQueueJoin(io, socket as never, { source: 'recovery', reason: 'retry' });

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    });

    it('preserves a ranked pairing lobby regardless of age', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby({ ...staleFriendlyLobby('pairing-lobby'), mode: 'ranked' as never, game_mode: 'ranked_sim' as never });

      await service.handleQueueJoin(io, socket as never, explicit);

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('preserves the lobby when the lobby lock is busy (a join or start is racing)', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('locked-lobby'));
      acquireLockMock.mockImplementation(async (key: string) =>
        key.startsWith('lock:lobby:') ? { acquired: false } : { acquired: true, token: 't1' });

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    });

    it('preserves the lobby when the locked re-read shows it moved on (status no longer waiting)', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      const lobby = staleFriendlyLobby('advanced-lobby');
      installLobby(lobby);
      getLobbyByIdMock.mockImplementation(async () => ({ ...lobby, status: 'active' }));

      await service.handleQueueJoin(io, socket as never, explicit);

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('leaves a fresh socketless waiting lobby on an explicit join (2026-11-17 alert: blocks within minutes of abandoning)', async () => {
      // The dominant prod shape behind the stranded-lobby alert: the player
      // abandons a just-made lobby (tab closed, nothing in its room) and taps
      // Play Ranked before the 30-minute stale window — their deliberate click
      // IS the intent to give the lobby up; age proves nothing.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('fresh-abandoned', 2 * 60_000));

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('fresh-abandoned', 'u1', expect.stringMatching(/^session_guard:/));
      expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    });

    it("leaves the lobby the player's own long-lived tab still sits in, on an explicit join", async () => {
      // SPA shape seen 2026-11-17 (one user blocked 9 times across 10 min):
      // the tab that created the lobby never emitted leave, so its socket has
      // been in the room since before the lobby went quiet, and no amount of
      // idle time ever healed it. The player's own deliberate click outranks
      // every socket of their own; only OTHER members' sockets are life.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('own-tab-held', 5 * 60_000));
      lobbyRoomSockets.set('own-tab-held', [
        { id: 'creator-tab', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'own-tab-held', connectedAt: Date.now() - 60 * 60_000 } },
      ]);

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('own-tab-held', 'u1', expect.stringMatching(/^session_guard:/));
      expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    });

    it('heals a CORRUPT_MULTI_STATE of two abandoned waiting lobbies on an explicit join', async () => {
      // Two stranded memberships at once resolve to CORRUPT_MULTI_STATE, which
      // used to skip the heal entirely (3 users/day in the alert). With no
      // active match and no queue search it is still only dead lobbies.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      const first = staleFriendlyLobby('corrupt-a', 4 * 60_000);
      const second = staleFriendlyLobby('corrupt-b', 90 * 60_000);
      const open = [first, second];
      listOpenLobbiesForUserMock.mockImplementation(async () => [...open]);
      getLobbyByIdMock.mockImplementation(async (lobbyId: string) => open.find((l) => l.id === lobbyId) ?? null);
      removeLobbyMemberMock.mockImplementation(async (lobbyId: string) => {
        const index = open.findIndex((l) => l.id === lobbyId);
        if (index >= 0) open.splice(index, 1);
      });

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('corrupt-a', 'u1', expect.stringMatching(/^session_guard:/));
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('corrupt-b', 'u1', expect.stringMatching(/^session_guard:/));
      expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    });

    it('still blocks a CORRUPT_MULTI_STATE that includes an active match, even on an explicit join', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('corrupt-with-match', 4 * 60_000));
      getActiveMatchForUserMock.mockResolvedValue({ id: 'live-match', mode: 'ranked', status: 'active', updated_at: new Date().toISOString() });

      await service.handleQueueJoin(io, socket as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
    });

    it('preserves a fresh lobby when an old explicit payload is replayed (CodeRabbit on #1006)', async () => {
      // A reload that re-sends a stored click intent looks exactly like the
      // click. The first sighting healed the player out of the old lobby; the
      // same clientRequestId minutes later must not pull them out of the fresh
      // lobby they have made since.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('abandoned-before-click', 2 * 60_000));
      await service.handleQueueJoin(io, socket as never, explicit);
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('abandoned-before-click', 'u1', expect.stringMatching(/^session_guard:/));

      removeLobbyMemberMock.mockClear();
      redisMock.eval.mockClear();
      vi.advanceTimersByTime(5 * 60_000);
      installLobby(staleFriendlyLobby('fresh-after-click', 60_000));
      const replayIo = createIoMock();
      await service.handleQueueJoin(replayIo, createSocketMock('u1') as never, explicit);

      const userEmit = (replayIo.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());
      expect(userEmit).toHaveBeenCalledWith(
        'session:state',
        expect.objectContaining({ state: 'IN_WAITING_LOBBY', waitingLobbyId: 'fresh-after-click' })
      );
    });

    it("still honours the same click's ack-timeout retry within the claim window", async () => {
      // The first attempt lost the lobby lock; the client's automatic retry of
      // the SAME click (same clientRequestId, seconds later) still heals.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('busy-then-free', 2 * 60_000));
      acquireLockMock.mockImplementation(async (key: string) => (
        key === 'lock:lobby:busy-then-free' ? { acquired: false } : { acquired: true, token: 't1' }
      ));
      const firstArrival = String(Date.now());
      await service.handleQueueJoin(io, socket as never, explicit);
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      // Nothing changed, so the click was handed back with its original arrival time.
      expect(claimStore.get(CLAIM_KEY)).toBe(firstArrival);

      acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
      vi.advanceTimersByTime(2_500);
      await service.handleQueueJoin(io, socket as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).toHaveBeenCalledWith('busy-then-free', 'u1', expect.stringMatching(/^session_guard:/));
    });

    it('preserves a fresh lobby when a click first seen while idle is replayed later (Codex on this PR)', async () => {
      // The click found nothing to heal, so it was admitted straight away; its
      // first arrival must still be recorded, or a later replay looks fresh.
      const service = await loadService();
      listOpenLobbiesForUserMock.mockResolvedValue([]);
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);

      vi.advanceTimersByTime(5 * 60_000);
      installLobby(staleFriendlyLobby('made-after-idle-click', 60_000));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('does not let a duplicate of an admitted click heal a lobby made right after it (Codex on this PR)', async () => {
      const service = await loadService();
      installLobby(staleFriendlyLobby('left-by-click', 2 * 60_000));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('left-by-click', 'u1', expect.stringMatching(/^session_guard:/));

      removeLobbyMemberMock.mockClear();
      vi.advanceTimersByTime(2_500);
      installLobby(staleFriendlyLobby('made-seconds-later', 1_000));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('consumes a click that resumes an existing search (Codex on this PR)', async () => {
      const service = await loadService();
      listOpenLobbiesForUserMock.mockResolvedValue([]);
      redisMock.hGet.mockImplementation(async (key: string) => (key === 'ranked:mm:user' ? 'search-running' : null));

      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);

      expect(claimStore.get(CLAIM_KEY)).toBe('0');
    });

    it('re-checks the claim under the user lock, so an attempt that waited behind an admitted one cannot heal (Codex on this PR)', async () => {
      // Attempt 2 passed the early claim check, then waited for the user lock
      // while attempt 1 was admitted and consumed the click.
      const service = await loadService();
      installLobby(staleFriendlyLobby('made-by-other-tab', 1_000));
      const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
      const lockSpy = vi.spyOn(userSessionGuardService, 'withUserSessionLock').mockImplementation(async (_userId, fn) => {
        claimStore.set(CLAIM_KEY, '0');
        return fn();
      });
      try {
        await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      } finally {
        lockSpy.mockRestore();
      }

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    function installLobbies(lobbies: Array<ReturnType<typeof staleFriendlyLobby>>) {
      const open = [...lobbies];
      listOpenLobbiesForUserMock.mockImplementation(async () => [...open]);
      getLobbyByIdMock.mockImplementation(async (lobbyId: string) => lobbies.find((lobby) => lobby.id === lobbyId) ?? null);
      removeLobbyMemberMock.mockImplementation(async (lobbyId: string) => {
        const index = open.findIndex((lobby) => lobby.id === lobbyId);
        if (index >= 0) open.splice(index, 1);
      });
    }

    it('heals nothing when the click cannot be marked spent, and keeps the lobby (CodeRabbit on this PR)', async () => {
      // A heal that goes ahead on an unconfirmed spend would leave the click
      // redeemable if the write failed afterwards. The spend is confirmed
      // first; without it the join degrades to the lobby-preserving block.
      const service = await loadService();
      let redisDown = true;
      useClaimStore({ failSwap: () => redisDown });
      installLobby(staleFriendlyLobby('spend-unconfirmed', 2 * 60_000));
      const io = createIoMock();

      await service.handleQueueJoin(io, createSocketMock('u1') as never, explicit);

      const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(userEmit).not.toHaveBeenCalledWith('ranked:search_started', expect.anything());

      // Nothing changed, so the same click may still be retried once Redis is back.
      redisDown = false;
      vi.advanceTimersByTime(2_500);
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('spend-unconfirmed', 'u1', expect.stringMatching(/^session_guard:/));
    });

    it('spends the click when the heal removed one lobby and then met a busy lock on the next (CodeRabbit on this PR)', async () => {
      const service = await loadService();
      installLobbies([staleFriendlyLobby('left-first', 2 * 60_000), staleFriendlyLobby('busy-second', 2 * 60_000)]);
      acquireLockMock.mockImplementation(async (key: string) => (
        key === 'lock:lobby:busy-second' ? { acquired: false } : { acquired: true, token: 't1' }
      ));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      expect(removeLobbyMemberMock).toHaveBeenCalledTimes(1);
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('left-first', 'u1', expect.stringMatching(/^session_guard:/));
      expect(claimStore.get(CLAIM_KEY)).toMatch(/^spent:/);

      // The player joins another lobby before the client's automatic retry.
      removeLobbyMemberMock.mockClear();
      acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
      vi.advanceTimersByTime(2_500);
      installLobby(staleFriendlyLobby('joined-in-between', 1_000));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('spends the click when the heal throws after it removed the membership (CodeRabbit on this PR)', async () => {
      const service = await loadService();
      installLobby(staleFriendlyLobby('left-then-threw', 2 * 60_000));
      restoreWaitingIdleSinceMock.mockRejectedValueOnce(new Error('restore failed'));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit).catch(() => undefined);
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('left-then-threw', 'u1', expect.stringMatching(/^session_guard:/));
      expect(claimStore.get(CLAIM_KEY)).toMatch(/^spent:/);

      removeLobbyMemberMock.mockClear();
      vi.advanceTimersByTime(2_500);
      installLobby(staleFriendlyLobby('joined-after-throw', 1_000));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('hands the click back with its original arrival time, so the 30s window still counts from the first arrival', async () => {
      const service = await loadService();
      installLobby(staleFriendlyLobby('busy-all-along', 2 * 60_000));
      acquireLockMock.mockImplementation(async (key: string) => (
        key === 'lock:lobby:busy-all-along' ? { acquired: false } : { acquired: true, token: 't1' }
      ));
      const firstArrival = String(Date.now());
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      expect(claimStore.get(CLAIM_KEY)).toBe(firstArrival);

      vi.advanceTimersByTime(30_001);
      acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('does not heal when another attempt spent the click between this one reading it and spending it (Codex on this PR)', async () => {
      // The user lock is a short lease: a paused attempt can lose it while a
      // second one reads the same stamp. The spend is a compare-and-set, so
      // only one of them wins.
      const service = await loadService();
      installLobby(staleFriendlyLobby('contended-click', 2 * 60_000));
      let reads = 0;
      const readStamp = redisMock.get.getMockImplementation() as (key: string) => Promise<string | null>;
      redisMock.get.mockImplementation(async (key: string) => {
        const value = await readStamp(key);
        if (key === CLAIM_KEY && ++reads === 1) claimStore.set(CLAIM_KEY, 'spent:other-replica');
        return value;
      });

      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(claimStore.get(CLAIM_KEY)).toBe('spent:other-replica');
    });

    it("never undoes another attempt's spend when handing a click back (Codex on this PR)", async () => {
      // This attempt spent the click, found the lobby lock busy and removed
      // nothing, but an overlapping attempt marked the click used meanwhile.
      // The hand-back only reverses its own spend.
      const service = await loadService();
      installLobby(staleFriendlyLobby('busy-while-contended', 2 * 60_000));
      acquireLockMock.mockImplementation(async (key: string) => {
        if (key !== 'lock:lobby:busy-while-contended') return { acquired: true, token: 't1' };
        claimStore.set(CLAIM_KEY, '0');
        return { acquired: false };
      });

      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(claimStore.get(CLAIM_KEY)).toBe('0');
    });

    it('keeps the click spent when a failed hand-back leaves it spent; the lobby stays safe (Codex on this PR)', async () => {
      const service = await loadService();
      useClaimStore({ failSwap: (call) => call === 2 });
      installLobby(staleFriendlyLobby('busy-then-refund-fails', 2 * 60_000));
      acquireLockMock.mockImplementation(async (key: string) => (
        key === 'lock:lobby:busy-then-refund-fails' ? { acquired: false } : { acquired: true, token: 't1' }
      ));
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      expect(claimStore.get(CLAIM_KEY)).toMatch(/^spent:/);

      acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
      vi.advanceTimersByTime(2_500);
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('keeps the click spent for any blocked outcome other than the heal reporting that it removed nothing (Codex on this PR)', async () => {
      // Preparation also cleans up open lobbies before it can refuse; only the
      // heal's own explicit "untouched" signal may hand the click back.
      const service = await loadService();
      installLobby(staleFriendlyLobby('cleaned-then-refused', 2 * 60_000));
      const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
      const prepareSpy = vi.spyOn(userSessionGuardService, 'prepareForQueueJoin').mockResolvedValue({
        ok: false,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active draft',
        snapshot: { state: 'IN_WAITING_LOBBY', activeMatchId: null, waitingLobbyId: 'cleaned-then-refused', primaryLobbyStatus: 'waiting', queueSearchId: null },
      } as never);
      try {
        await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      } finally {
        prepareSpy.mockRestore();
      }

      expect(claimStore.get(CLAIM_KEY)).toMatch(/^spent:/);
    });

    it('hands the click back when its spend landed but the reply was lost and nothing was removed (Codex on this PR)', async () => {
      const service = await loadService();
      useClaimStore({ loseReply: (call) => call === 1 });
      installLobby(staleFriendlyLobby('spend-reply-lost', 2 * 60_000));
      acquireLockMock.mockImplementation(async (key: string) => (
        key === 'lock:lobby:spend-reply-lost' ? { acquired: false } : { acquired: true, token: 't1' }
      ));
      const firstArrival = String(Date.now());
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
      expect(claimStore.get(CLAIM_KEY)).toBe(firstArrival);

      acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
      vi.advanceTimersByTime(2_500);
      await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, { ...explicit, reason: 'retry' });

      expect(removeLobbyMemberMock).toHaveBeenCalledWith('spend-reply-lost', 'u1', expect.stringMatching(/^session_guard:/));
    });

    it('marks the click used when its spend failed but preparation changed membership anyway (Codex on this PR)', async () => {
      // Without a confirmed spend the heal is off, but preparation still cleans
      // up abandoned active lobbies before it can refuse.
      const service = await loadService();
      useClaimStore({ failSwap: () => true });
      installLobby(staleFriendlyLobby('cleaned-after-failed-spend', 2 * 60_000));
      const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
      const prepareSpy = vi.spyOn(userSessionGuardService, 'prepareForQueueJoin').mockResolvedValue({
        ok: false,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in a room game',
        snapshot: { state: 'IN_WAITING_LOBBY', activeMatchId: null, waitingLobbyId: 'cleaned-after-failed-spend', primaryLobbyStatus: 'waiting', queueSearchId: null },
      } as never);
      try {
        await service.handleQueueJoin(createIoMock(), createSocketMock('u1') as never, explicit);
      } finally {
        prepareSpy.mockRestore();
      }

      expect(claimStore.get(CLAIM_KEY)).toBe('0');
    });

    it('preserves a fresh lobby on an explicit-shaped join that carries no clientRequestId', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('no-request-id', 2 * 60_000));

      await service.handleQueueJoin(io, socket as never, { source: 'mode_select', reason: 'initial' });

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });

    it('preserves a waiting football_grid lobby with an open series even on an explicit join', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby({ ...staleFriendlyLobby('grid-series', 2 * 60_000), game_mode: 'football_grid' as never });
      hasOpenSeriesForLobbyMock.mockResolvedValue(true);

      await service.handleQueueJoin(io, socket as never, explicit);

      expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    });
  });

  it('skips the active-lobby heal when the user session lock is held', async () => {
    const service = await loadService();
    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const prepareSpy = vi.spyOn(userSessionGuardService, 'prepareForQueueJoin');
    const io = createIoMock();
    const socket = createSocketMock('u1');
    listOpenLobbiesForUserMock.mockResolvedValue([{
      ...makeOpenLobby('locked-stale-auction', 'active'),
      mode: 'friendly' as const,
      game_mode: 'auction' as const,
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }]);
    acquireLockMock.mockResolvedValue({ acquired: false });

    await service.handleQueueJoin(io, socket as never);

    const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(acquireLockMock).toHaveBeenCalledWith('lock:user:session:u1', 4000);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(removeLobbyMemberMock).not.toHaveBeenCalled();
    expect(redisMock.multi).not.toHaveBeenCalled();
    expect(userEmit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({ waitingLobbyId: 'locked-stale-auction' })
    );
    prepareSpy.mockRestore();
  });

  it('still rejects an idle user with no tickets via INSUFFICIENT_TICKETS', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    getWalletMock.mockResolvedValue({ coins: 0, tickets: 0 });

    await service.handleQueueJoin(io, socket as never);

    const userEmit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(userEmit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'INSUFFICIENT_TICKETS' })
    );
    expect(redisMock.multi).not.toHaveBeenCalled();
  });

  it('debounces rapid queue joins so only one queued search is created', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    let debounceCalls = 0;
    redisMock.set.mockImplementation(async (key: string) => {
      if (key === 'ranked:mm:join_debounce:u1') {
        debounceCalls += 1;
        return debounceCalls === 1 ? 'OK' : null;
      }
      return 'OK';
    });

    await service.handleQueueJoin(io, socket as never);
    await service.handleQueueJoin(io, socket as never);
    await service.handleQueueJoin(io, socket as never);

    expect(redisMock.multi).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledWith('ranked:mm:join_debounce:u1', '1', { NX: true, EX: 2 });
  });

  it('marks users as pairing in-flight during human match handoff', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(redisMock.set).toHaveBeenCalledWith('ranked:mm:pairing:u1', '1', { EX: 30 });
    expect(redisMock.set).toHaveBeenCalledWith('ranked:mm:pairing:u2', '1', { EX: 30 });
    expect(redisMock.del).toHaveBeenCalledWith(['ranked:mm:pairing:u1', 'ranked:mm:pairing:u2']);
  });

  it('pairs one match when queue effectively has 2 users', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(1);
    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
  });

  it('does not start a match when a paired player has no live socket (ghost search)', async () => {
    const service = await loadService();
    absentUserIds.add('u2');
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).not.toHaveBeenCalled();
    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
  });

  it('re-queues the present player and tells the ghost the search ended', async () => {
    const service = await loadService();
    absentUserIds.add('u2');
    const io = createIoMock();

    redisMock.eval.mockImplementationOnce(async (script: string) => {
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
      return [];
    });
    redisMock.eval.mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    // Present player u1 is re-queued: a fresh search is mapped in the user hash.
    expect(redisMock.multi).toHaveBeenCalled();
    const multiInstance = redisMock.multi.mock.results.at(-1)?.value;
    expect(multiInstance.hSet).toHaveBeenCalledWith(
      'ranked:mm:user',
      'u1',
      expect.any(String)
    );
    // The present player gets a fresh search_started and the ghost is told the
    // search ended. (The io mock shares one emit spy across rooms, so we assert
    // both events fired rather than attributing them per user.)
    const emit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledWith(
      'ranked:search_started',
      expect.objectContaining({ durationMs: expect.any(Number) })
    );
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
  });

  it('does not tell the present player their search started when the re-queue exec fails', async () => {
    const service = await loadService();
    absentUserIds.add('u2');
    const io = createIoMock();

    redisMock.eval.mockImplementationOnce(async (script: string) => {
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
      return [];
    });
    redisMock.eval.mockImplementation(async () => []);

    const failingMulti = {
      hSet: vi.fn(() => failingMulti),
      expire: vi.fn(() => failingMulti),
      zAdd: vi.fn(() => failingMulti),
      exec: vi.fn().mockResolvedValue(null),
    };
    redisMock.multi.mockReturnValue(failingMulti);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    const emit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(emit).not.toHaveBeenCalledWith(
      'ranked:search_started',
      expect.anything()
    );
    expect(emit).toHaveBeenCalledWith('error', {
      code: 'RANKED_QUEUE_UNAVAILABLE',
      message: 'Ranked queue is unavailable, please retry',
    });
  });

  it('rechecks live sockets immediately before lobby creation', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval.mockImplementationOnce(async (script: string) => {
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
      return [];
    });
    redisMock.eval.mockImplementation(async () => []);
    getWalletMock.mockImplementation(async (userId: string) => {
      if (userId === 'u1') absentUserIds.add('u2');
      return { coins: 0, tickets: 1 };
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).not.toHaveBeenCalled();
    expect(redisMock.multi).toHaveBeenCalled();
    expect(io.in).toHaveBeenCalledWith('user:u1');
    expect(io.in).toHaveBeenCalledWith('user:u2');
    expect((io.in as ReturnType<typeof vi.fn>).mock.calls.filter(([room]) => room === 'user:u1')).toHaveLength(3);
    expect((io.in as ReturnType<typeof vi.fn>).mock.calls.filter(([room]) => room === 'user:u2')).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userAId: 'u1',
        userBId: 'u2',
        userAPresent: true,
        userBPresent: false,
      }),
      'Ranked human match creation skipped: a paired player has no live socket'
    );
    const emit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledWith(
      'ranked:search_started',
      expect.objectContaining({ durationMs: expect.any(Number) })
    );
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
  });

  it('pairs two matches when queue effectively has 4 users', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s3', 'u3', 's4', 'u4'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(2);
    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
  });

  it('pairs two matches and leaves one waiting when queue effectively has 5 users', async () => {
    const service = await loadService();
    const io = createIoMock();
    let pairScriptCalls = 0;

    redisMock.eval.mockImplementation(async (script: string) => {
      if (script !== RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      pairScriptCalls += 1;
      if (pairScriptCalls === 1) return ['s1', 'u1', 's2', 'u2'];
      if (pairScriptCalls === 2) return ['s3', 'u3', 's4', 'u4'];
      if (pairScriptCalls === 3) return ['s5', 'u5']; // left waiting (unmatched)
      return [];
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(2);
    expect(pairScriptCalls).toBe(3);
    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
  });

  it('falls back to AI when one queued user reaches deadline with no pair', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.zRangeByScore.mockResolvedValue(['search-1']);
    redisMock.eval.mockImplementation(async (script: string) => {
      if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) return ['u-fallback'];
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      return [];
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(startRankedAiForUserMock).toHaveBeenCalledTimes(1);
    expect(startRankedAiForUserMock).toHaveBeenCalledWith(io, 'u-fallback', {
      skipSearchEmit: true,
    });
  });

  it('does not reuse the human country for a persistent AI opponent', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.zRangeByScore.mockResolvedValue(['search-1']);
    redisMock.eval.mockImplementation(async (script: string) => {
      if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) return ['u-fallback', 'MA'];
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      return [];
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(startRankedAiForUserMock).toHaveBeenCalledWith(io, 'u-fallback', {
      skipSearchEmit: true,
    });
  });

  it('skips AI fallback without touching queue state when the claimed user has no live socket', async () => {
    const service = await loadService();
    const io = createIoMock();

    absentUserIds.add('u-fallback');
    redisMock.zRangeByScore.mockResolvedValue(['search-1']);
    redisMock.eval.mockImplementation(async (script: string) => {
      if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) return ['u-fallback'];
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      return [];
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
    expect(createLobbyMock).not.toHaveBeenCalled();
    // The claim script already cleaned the queue/map — a userId-based cancel or
    // cancel marker here would race a re-queue and hit the user's NEW search.
    expect(redisMock.set).not.toHaveBeenCalledWith('ranked:mm:cancel:u-fallback', '1', { EX: 30 });
    expect(redisMock.eval).not.toHaveBeenCalledWith(
      RANKED_MM_CANCEL_SEARCH_SCRIPT,
      expect.objectContaining({
        arguments: expect.arrayContaining(['u-fallback']),
      })
    );
    expect(io.to).toHaveBeenCalledWith('user:u-fallback');
  });

  it('skips AI fallback when the claimed user already has a ranked lobby', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.zRangeByScore.mockResolvedValue(['search-1']);
    redisMock.eval.mockImplementation(async (script: string) => {
      if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) return ['u-fallback'];
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      return [];
    });
    listOpenLobbiesForUserMock.mockImplementation(async (userId: string) => (
      userId === 'u-fallback' ? [makeOpenLobby('existing-lobby')] : []
    ));

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-fallback',
        session: expect.objectContaining({ waitingLobbyId: 'existing-lobby' }),
      }),
      'Ranked matchmaking fallback skipped because user already has session state'
    );
  });

  it('skips ghost fallback users and continues processing later due fallbacks', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.zRangeByScore.mockResolvedValue(['search-ghost', 'search-good']);
    redisMock.eval.mockImplementation(async (script: string, options?: { arguments?: string[] }) => {
      if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) {
        const searchId = options?.arguments?.[0];
        if (searchId === 'search-ghost') return ['ghost-user'];
        if (searchId === 'search-good') return ['good-user'];
      }
      if (script === RANKED_MM_CANCEL_SEARCH_SCRIPT) return [];
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      return [];
    });
    getWalletMock.mockImplementation(async (userId: string) => {
      if (userId === 'ghost-user') {
        throw new NotFoundError('User not found');
      }
      return { coins: 0, tickets: 1 };
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(startRankedAiForUserMock).toHaveBeenCalledTimes(1);
    expect(startRankedAiForUserMock).toHaveBeenCalledWith(io, 'good-user', {
      skipSearchEmit: true,
    });
    expect(redisMock.eval).toHaveBeenCalledWith(
      RANKED_MM_CANCEL_SEARCH_SCRIPT,
      expect.objectContaining({
        arguments: expect.arrayContaining(['ghost-user']),
      })
    );
    expect(io.to).toHaveBeenCalledWith('user:ghost-user');
  });

  it('continues fallback loop after one AI fallback fails', async () => {
    const service = await loadService();
    const io = createIoMock();
    const fallbackError = new Error('ai fallback failed');

    redisMock.zRangeByScore.mockResolvedValue(['search-bad', 'search-good']);
    redisMock.eval.mockImplementation(async (script: string, options?: { arguments?: string[] }) => {
      if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) {
        const searchId = options?.arguments?.[0];
        if (searchId === 'search-bad') return ['bad-user'];
        if (searchId === 'search-good') return ['good-user'];
      }
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      return [];
    });
    startRankedAiForUserMock.mockImplementation(async (_io: QuizballServer, userId: string) => {
      if (userId === 'bad-user') throw fallbackError;
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(startRankedAiForUserMock).toHaveBeenCalledTimes(2);
    expect(startRankedAiForUserMock).toHaveBeenCalledWith(io, 'bad-user', {
      skipSearchEmit: true,
    });
    expect(startRankedAiForUserMock).toHaveBeenCalledWith(io, 'good-user', {
      skipSearchEmit: true,
    });
    expect(logger.error).toHaveBeenCalledWith(
      { err: fallbackError, searchId: 'search-bad', userId: 'bad-user' },
      'Ranked matchmaking fallback failed for queued user'
    );
  });

  it('runs human pairing when the fallback phase fails', async () => {
    const service = await loadService();
    const io = createIoMock();
    const fallbackPhaseError = new Error('fallback redis failed');

    redisMock.zRangeByScore.mockRejectedValueOnce(fallbackPhaseError);
    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: fallbackPhaseError, pool: 'public' },
      'Ranked matchmaking fallback phase failed'
    );
  });

  it('defers expired fallbacks while an available human pair remains queued', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.zCard.mockResolvedValue(2);
    redisMock.zRangeByScore.mockResolvedValue(['expired-search']);
    let pairClaims = 0;
    redisMock.eval.mockImplementation(async (script: string) => {
      if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) {
        pairClaims += 1;
        if (pairClaims === 1) return ['s1', 'u1', 's2', 'u2'];
        return [];
      }
      return [];
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(1);
    expect(redisMock.zRangeByScore).not.toHaveBeenCalled();
    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
  });

  it('continues pair loop after one human pair fails', async () => {
    const service = await loadService();
    const io = createIoMock();
    const pairError = new Error('pair failed');
    let pairScriptCalls = 0;

    redisMock.eval.mockImplementation(async (script: string) => {
      if (script !== RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return [];
      pairScriptCalls += 1;
      if (pairScriptCalls === 1) return ['s1', 'u1', 's2', 'u2'];
      if (pairScriptCalls === 2) return ['s3', 'u3', 's4', 'u4'];
      return [];
    });
    createLobbyMock.mockImplementation(async ({ hostUserId }: { hostUserId: string }) => {
      if (hostUserId === 'u1') throw pairError;
      return {
        id: `lobby-${hostUserId}`,
        mode: 'ranked',
        status: 'waiting',
        host_user_id: hostUserId,
        invite_code: null,
        display_name: null,
        is_public: false,
        game_mode: 'ranked_sim',
        friendly_random: true,
        friendly_category_a_id: null,
        friendly_category_b_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(2);
    expect(createLobbyMock).toHaveBeenCalledWith(expect.objectContaining({ hostUserId: 'u3' }));
    expect(logger.error).toHaveBeenCalledWith(
      { err: pairError, searchIdA: 's1', searchIdB: 's2', userAId: 'u1', userBId: 'u2' },
      'Ranked matchmaking pair failed for queued users'
    );
  });

  it('skips human pair creation when either claimed user already has session state', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);
    listOpenLobbiesForUserMock.mockImplementation(async (userId: string) => (
      userId === 'u1' ? [makeOpenLobby('existing-lobby')] : []
    ));

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userAId: 'u1',
        userBId: 'u2',
        userASession: expect.objectContaining({ waitingLobbyId: 'existing-lobby' }),
      }),
      'Ranked human match creation skipped because a player already has session state'
    );
  });

  it('logs lock release failures without rejecting the tick', async () => {
    const service = await loadService();
    const io = createIoMock();
    const releaseError = new Error('release failed');

    releaseLockMock.mockRejectedValueOnce(releaseError);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(releaseLockMock).toHaveBeenCalledWith('ranked:mm:tick-lock', 't1');
    expect(logger.error).toHaveBeenCalledWith(
      { err: releaseError },
      'Ranked matchmaking tick lock release failed'
    );
  });

  it('emits ranked:match_found with opponent RP from ensured profiles', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(ensureProfileMock).toHaveBeenCalledWith('u1');
    expect(ensureProfileMock).toHaveBeenCalledWith('u2');

    const emitFns = (io.to as unknown as ReturnType<typeof vi.fn>).mock.results
      .map((result) => (result.value as { emit?: ReturnType<typeof vi.fn> } | undefined)?.emit)
      .filter((emit): emit is ReturnType<typeof vi.fn> => Boolean(emit));
    const matchFoundCalls = emitFns
      .flatMap((emit) => emit.mock.calls)
      .filter(([event]) => event === 'ranked:match_found');

    expect(matchFoundCalls).toEqual(
      expect.arrayContaining([
        ['ranked:match_found', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u2', rp: 2222 }) })],
        ['ranked:match_found', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u1', rp: 1111 }) })],
      ])
    );
  });

  it('uses queued session countries over saved user countries in human match_found payloads', async () => {
    const service = await loadService();
    const io = createIoMock();

    getUserByIdMock.mockImplementation(async (userId: string) => ({
      id: userId,
      nickname: userId,
      avatar_url: null,
      country: 'US',
    }));
    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_RANDOM_SCRIPT) return ['s1', 'u1', 'MA', 's2', 'u2', 'GE'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    const emitFns = (io.to as unknown as ReturnType<typeof vi.fn>).mock.results
      .map((result) => (result.value as { emit?: ReturnType<typeof vi.fn> } | undefined)?.emit)
      .filter((emit): emit is ReturnType<typeof vi.fn> => Boolean(emit));
    const matchFoundCalls = emitFns
      .flatMap((emit) => emit.mock.calls)
      .filter(([event]) => event === 'ranked:match_found');

    expect(matchFoundCalls).toEqual(
      expect.arrayContaining([
        ['ranked:match_found', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u2', countryCode: 'GE' }) })],
        ['ranked:match_found', expect.objectContaining({ opponent: expect.objectContaining({ id: 'u1', countryCode: 'MA' }) })],
      ])
    );
  });

  // ── runRankedDraftStart: durable replacement for the in-process 1.2s
  //    "match found" modal delay (a restart in that window used to leave a
  //    ranked lobby stuck in 'waiting' forever). The handler re-checks
  //    everything, so late/duplicate fires must be no-ops. ──
  it('runRankedDraftStart starts the draft for a waiting ranked lobby', async () => {
    const io = createIoMock();
    redisMock.get.mockResolvedValue(null);
    getLobbyByIdMock.mockResolvedValue(makeOpenLobby('lobby-1', 'waiting'));

    const mod = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    await mod.runRankedDraftStart(io, 'lobby-1', 'u1', 'u2');

    expect(startDraftMock).toHaveBeenCalledWith(io, 'lobby-1', { expectWaiting: true });
  });

  it('runRankedDraftStart skips when either player cancelled the search', async () => {
    const io = createIoMock();
    redisMock.get.mockImplementation(async (key: string) =>
      key.includes('u2') ? '1' : null
    );
    getLobbyByIdMock.mockResolvedValue(makeOpenLobby('lobby-1', 'waiting'));

    const mod = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    await mod.runRankedDraftStart(io, 'lobby-1', 'u1', 'u2');

    expect(startDraftMock).not.toHaveBeenCalled();
  });

  it('runRankedDraftStart no-ops when the lobby already left waiting (late/duplicate fire)', async () => {
    const io = createIoMock();
    redisMock.get.mockResolvedValue(null);
    getLobbyByIdMock.mockResolvedValue(makeOpenLobby('lobby-1', 'active'));

    const mod = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    await mod.runRankedDraftStart(io, 'lobby-1', 'u1', 'u2');

    expect(startDraftMock).not.toHaveBeenCalled();
  });

  // ── handleSocketDisconnect: the cancel marker must land even when the
  //    per-user transition lock is busy — previously NOTHING was written in
  //    that case and the 10s AI fallback could start a ranked match for an
  //    offline user. ──
  it('disconnect cleanup sets the cancel marker BEFORE attempting the transition lock', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');

    const pending = service.handleSocketDisconnect(io, socket as never);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;

    const cancelSetCall = redisMock.set.mock.calls.find(([key]) =>
      typeof key === 'string' && key.includes('cancel') && key.includes('u1')
    );
    expect(cancelSetCall).toBeTruthy();
    const cancelSetOrder = redisMock.set.mock.invocationCallOrder[
      redisMock.set.mock.calls.indexOf(cancelSetCall!)
    ];
    const firstLockOrder = acquireLockMock.mock.invocationCallOrder[0];
    expect(firstLockOrder).toBeGreaterThan(cancelSetOrder);
  });

  it('disconnect cleanup still sets the cancel marker when the transition lock never frees', async () => {
    acquireLockMock.mockResolvedValue({ acquired: false });
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');

    const pending = service.handleSocketDisconnect(io, socket as never);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    // Marker written despite the busy lock; the cancel SCRIPT never ran.
    const cancelSetCall = redisMock.set.mock.calls.find(([key]) =>
      typeof key === 'string' && key.includes('cancel') && key.includes('u1')
    );
    expect(cancelSetCall).toBeTruthy();
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it('disconnect of an old tab never cancels a search while another free tab is connected (PR #1006 review)', async () => {
    // The explicit-join heal can admit a search while an older tab of the
    // same user is still open; that tab's close must not tear the search
    // down. Only the last free socket cancels.
    const service = await loadService();
    const io = createIoMock();
    userRoomSockets.set('u1', [
      { id: 'socket-u1', data: { user: { id: 'u1' } } },
      { id: 'searching-tab', data: { user: { id: 'u1' } } },
    ]);

    await service.handleSocketDisconnect(io, createSocketMock('u1') as never);

    expect(redisMock.set.mock.calls.find(([key]) => typeof key === 'string' && key.includes('cancel') && key.includes('u1'))).toBeUndefined();
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(trackRankedQueueLeftMock).not.toHaveBeenCalled();
  });

  it('disconnect still cancels when the only other socket sits in a match or lobby', async () => {
    const service = await loadService();
    const io = createIoMock();
    userRoomSockets.set('u1', [
      { id: 'socket-u1', data: { user: { id: 'u1' } } },
      { id: 'match-tab', data: { user: { id: 'u1' }, matchId: 'm1' } },
      { id: 'lobby-tab', data: { user: { id: 'u1' }, lobbyId: 'l1' } },
    ]);

    await service.handleSocketDisconnect(io, createSocketMock('u1') as never);

    expect(redisMock.set.mock.calls.find(([key]) => typeof key === 'string' && key.includes('cancel') && key.includes('u1'))).toBeTruthy();
  });

  it('disconnect cleanup tracks a queue leave only when it removed a search', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval.mockResolvedValueOnce([]);
    await service.handleSocketDisconnect(io, createSocketMock('u1') as never);
    expect(trackRankedQueueLeftMock).not.toHaveBeenCalled();

    redisMock.eval.mockResolvedValueOnce(['search-abc12345']);
    await service.handleSocketDisconnect(io, createSocketMock('u2') as never);
    expect(trackRankedQueueLeftMock).toHaveBeenCalledTimes(1);
    expect(trackRankedQueueLeftMock).toHaveBeenCalledWith({
      userId: 'u2',
      source: 'disconnect_cleanup',
      searchFound: true,
      searchId: 'search-abc12345',
    });
  });
});
