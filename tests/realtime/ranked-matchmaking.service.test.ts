import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { NotFoundError } from '../../src/core/errors.js';
import { logger } from '../../src/core/logger.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import {
  RANKED_MM_CANCEL_SEARCH_SCRIPT,
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_OLDEST_SCRIPT,
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
const ensureProfilesMock = vi.fn();
const startDraftMock = vi.fn();
const startRankedAiForUserMock = vi.fn();
const scheduleRealtimeTimerMock = vi.fn();
const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getWalletMock = vi.fn();

let redisMock: FakeRedis;

vi.mock('../../src/core/config.js', () => ({
  config: {
    RANKED_HUMAN_QUEUE_ENABLED: true,
  },
}));

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
    createLobbyWithMembers: (...args: unknown[]) => createLobbyMock(...args),
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
    ensureProfiles: (...args: unknown[]) => ensureProfilesMock(...args),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    getWallet: (...args: unknown[]) => getWalletMock(...args),
    getRankedTicketWallets: async (userIds: string[]) => {
      const entries: Array<readonly [string, unknown]> = [];
      for (const userId of userIds) {
        try {
          entries.push([userId, await getWalletMock(userId)] as const);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      return new Map(entries);
    },
  },
}));

vi.mock('../../src/modules/stats/stats.service.js', () => ({
  statsService: {
    getRecentFormForUser: vi.fn().mockResolvedValue([]),
    getRecentFormsForUsers: vi.fn(async (userIds: string[]) => new Map(
      userIds.map((userId) => [userId, []]),
    )),
  },
}));

vi.mock('../../src/realtime/services/lobby-realtime.service.js', () => ({
  startDraft: (...args: unknown[]) => startDraftMock(...args),
  startRankedAiForUser: (...args: unknown[]) => startRankedAiForUserMock(...args),
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: (...args: unknown[]) => scheduleRealtimeTimerMock(...args),
}));

// Users treated as having NO live socket (ghost searches). Anyone not listed is
// present by default — queued users normally have an authenticated socket.
const absentUserIds = new Set<string>();
/** lobbyId → sockets the io mock reports inside `lobby:<id>` (default: none). */
const lobbyRoomSockets = new Map<string, Array<{ id: string; leave: () => void; data: { user: { id: string }; lobbyId?: string; connectedAt?: number } }>>();

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
          ? [{ id: `sock-${userId}`, data: { user: { id: userId } } }]
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
    ensureProfilesMock.mockImplementation(async (userIds: string[]) => {
      const entries = await Promise.all(userIds.map(async (userId) => [
        userId,
        await ensureProfileMock(userId),
      ] as const));
      return new Map(entries);
    });
    getWalletMock.mockResolvedValue({ coins: 0, tickets: 1 });
    startDraftMock.mockResolvedValue(undefined);
    startRankedAiForUserMock.mockResolvedValue(true);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
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

  it('claims the oldest queued searches instead of random users', () => {
    expect(RANKED_MM_PAIR_TWO_OLDEST_SCRIPT).toContain("redis.call('ZRANGE', queueKey, 0, 1)");
    expect(RANKED_MM_PAIR_TWO_OLDEST_SCRIPT).not.toContain('ZRANDMEMBER');
  });

  // INC-2026-07-29 preventive action #4: matchmaking kept creating matches into
  // a pool that could not persist their results.
  describe('database write outage gate', () => {
    async function tripBreaker() {
      const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
      const error = new Error('cannot execute INSERT in a read-only transaction') as Error & {
        code: string;
      };
      error.code = '25006';
      readOnlyDbBreaker.recordError(error);
      return readOnlyDbBreaker;
    }

    afterEach(async () => {
      const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
      readOnlyDbBreaker.resetForTests();
    });

    it('creates no match while the pool is read-only, and claims nothing from the queue', async () => {
      const service = await loadService();
      const io = createIoMock();
      await tripBreaker();

      redisMock.eval.mockImplementation(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      });

      service.start(io);
      await vi.advanceTimersByTimeAsync(120);

      expect(createLobbyMock).not.toHaveBeenCalled();
      expect(startDraftMock).not.toHaveBeenCalled();
      expect(startRankedAiForUserMock).not.toHaveBeenCalled();
      // Queued players keep their place and their ticket: no claim script ran.
      expect(redisMock.eval).not.toHaveBeenCalled();
      service.stop();
    });

    it('resumes pairing on the first tick after recovery', async () => {
      const service = await loadService();
      const io = createIoMock();
      const breaker = await tripBreaker();

      // The pair can be claimed only once, mirroring the atomic Redis claim.
      let pairAvailable = true;
      redisMock.eval.mockImplementation(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT && pairAvailable) {
          pairAvailable = false;
          return ['s1', 'u1', 's2', 'u2'];
        }
        return [];
      });

      service.start(io);
      await vi.advanceTimersByTimeAsync(120);
      expect(createLobbyMock).not.toHaveBeenCalled();
      // Still unclaimed, because the gate returned before the claim script.
      expect(pairAvailable).toBe(true);

      breaker.resetForTests();
      await vi.advanceTimersByTimeAsync(120);

      expect(createLobbyMock).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('stops claiming further pairs when the breaker latches mid-tick', async () => {
      const service = await loadService();
      const io = createIoMock();
      const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');

      // Healthy at tick entry; the FIRST claim latches the breaker (as a
      // concurrent write failing with 25006 would), so no second claim may run.
      let claims = 0;
      redisMock.eval.mockImplementation(async (script: string) => {
        if (script !== RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
        claims += 1;
        const error = new Error('cannot execute INSERT in a read-only transaction') as Error & {
          code: string;
        };
        error.code = '25006';
        readOnlyDbBreaker.recordError(error);
        return [`s${claims}a`, `u${claims}a`, `s${claims}b`, `u${claims}b`];
      });

      service.start(io);
      await vi.advanceTimersByTimeAsync(120);

      expect(claims).toBe(1);
      service.stop();
    });

    it('refuses a queue join without spending a ticket while degraded', async () => {
      const service = await loadService();
      const io = createIoMock();
      await tripBreaker();
      const socket = createSocketMock('u9');

      await service.handleQueueJoin(io, socket as never, { source: 'mode_select' });

      // The ticket preflight is downstream of the gate, so nothing was consumed.
      expect(getWalletMock).not.toHaveBeenCalled();
      expect(redisMock.multi).not.toHaveBeenCalled();
      const emit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
      expect(emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'DB_WRITE_OUTAGE' })
      );
    });
  });

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
    expect(removeLobbyMemberMock).toHaveBeenCalledWith('stranded-auction', 'u1');
    expect(deleteLobbyMock).toHaveBeenCalledWith('stranded-auction');
    expect(redisMock.multi).toHaveBeenCalledTimes(1);
    expect(userEmit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    expect(userEmit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({ state: 'IN_QUEUE', waitingLobbyId: null })
    );
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
    const explicit = { source: 'mode_select', reason: 'initial' } as const;

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
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('stranded-hydrated', 'u1');
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

    it('preserves an idle lobby the player has kept open in a long-lived tab', async () => {
      // Solo host waiting 35 min for a friend, then Play Ranked from another
      // tab (or a reload re-emitting a stale mode_select intent): the tab that
      // has been in the lobby since before it went quiet is real life.
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('kept-open'));
      lobbyRoomSockets.set('kept-open', [
        { id: 'old-tab', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'kept-open', connectedAt: Date.now() - STALE_MS - 60_000 } },
        { id: 'new-tab', leave: vi.fn(), data: { user: { id: 'u1' }, lobbyId: 'kept-open', connectedAt: Date.now() - 1_000 } },
      ]);

      await service.handleQueueJoin(io, socket as never, explicit);

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
      expect(removeLobbyMemberMock).toHaveBeenCalledWith('stranded-auction', 'u1');
      expect(removeLobbyMemberMock).not.toHaveBeenCalledWith('stranded-auction', 'u2');
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

    it('preserves a fresh socketless lobby (reload window) on an explicit join', async () => {
      const service = await loadService();
      const io = createIoMock();
      const socket = createSocketMock('u1');
      installLobby(staleFriendlyLobby('fresh-wait', 0));

      await service.handleQueueJoin(io, socket as never, explicit);

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

  it('keeps a committed queue join successful when queue-size telemetry fails', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    redisMock.zCard.mockRejectedValueOnce(new Error('telemetry unavailable'));

    await service.handleQueueJoin(io, socket as never);

    const emit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(redisMock.multi).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('ranked:search_started', { durationMs: 10_000 });
    expect(emit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({ state: 'IN_QUEUE', queueSearchId: expect.any(String) })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', err: expect.any(Error) }),
      'Failed to read ranked queue size after join'
    );
    // One early session block plus one locked preparation; the old hot path
    // repeatedly resolved the same match/lobby state after queue commit.
    expect(getActiveMatchForUserMock).toHaveBeenCalledTimes(2);
    expect(listOpenLobbiesForUserMock).toHaveBeenCalledTimes(2);
  });

  it('marks users as pairing in-flight during human match handoff', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(redisMock.set).toHaveBeenCalledWith('ranked:mm:pairing:u1', '1', { EX: 30 });
    expect(redisMock.set).toHaveBeenCalledWith('ranked:mm:pairing:u2', '1', { EX: 30 });
    expect(redisMock.del).toHaveBeenCalledWith(['ranked:mm:pairing:u1', 'ranked:mm:pairing:u2']);
  });

  it('skips queue cleanup when a cross-replica socket already has a committed lobby assignment', async () => {
    const service = await loadService();
    const io = createIoMock();
    const socket = createSocketMock('u1');
    redisMock.get.mockImplementation(async (key: string) => (
      key === 'ranked:mm:assigned-lobby:u1' ? 'lobby-u1' : null
    ));

    await service.handleSocketDisconnect(io, socket as never);

    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalledWith(
      'ranked:mm:cancel:u1',
      expect.anything(),
      expect.anything()
    );
    expect(getActiveMatchForUserMock).not.toHaveBeenCalled();
    expect(listOpenLobbiesForUserMock).not.toHaveBeenCalled();
  });

  it('pairs one match when queue effectively has 2 users', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(1);
    expect(createLobbyMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostUserId: 'u1' }),
      [
        { userId: 'u1', isReady: true },
        { userId: 'u2', isReady: true },
      ],
    );
    expect(startRankedAiForUserMock).not.toHaveBeenCalled();
    expect(getLobbyByIdMock).not.toHaveBeenCalled();
    expect(buildLobbyStateMock).not.toHaveBeenCalled();
    const emit = (io.to as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledWith(
      'lobby:state',
      expect.objectContaining({
        lobbyId: 'lobby-u1',
        members: expect.arrayContaining([
          expect.objectContaining({ userId: 'u1', rankPoints: 1111, isReady: true }),
          expect.objectContaining({ userId: 'u2', rankPoints: 2222, isReady: true }),
        ]),
      })
    );
    expect(emit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({
        state: 'IN_WAITING_LOBBY',
        waitingLobbyId: 'lobby-u1',
        openLobbyIds: ['lobby-u1'],
      })
    );
  });

  it('does not start a match when a paired player has no live socket (ghost search)', async () => {
    const service = await loadService();
    absentUserIds.add('u2');
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
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
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s3', 'u3', 's4', 'u4'];
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
      if (script !== RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
    const emit = (io.to as unknown as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(io.to).toHaveBeenCalledWith('user:bad-user');
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
    expect(emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PREPARATION_FAILED',
      message: 'Match preparation failed. Please restart ranked matchmaking.',
      meta: {
        searchId: 'search-bad',
        source: 'ranked_ai_fallback',
      },
    });
  });

  it('runs human pairing when the fallback phase fails', async () => {
    const service = await loadService();
    const io = createIoMock();
    const fallbackPhaseError = new Error('fallback redis failed');

    redisMock.zRangeByScore.mockRejectedValueOnce(fallbackPhaseError);
    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);

    expect(createLobbyMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: fallbackPhaseError },
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
      if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) {
        pairClaims += 1;
        if (pairClaims === 1) return ['s1', 'u1', '', 's2', 'u2', ''];
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
      if (script !== RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
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
    expect(createLobbyMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostUserId: 'u3' }),
      expect.any(Array),
    );
    expect(logger.error).toHaveBeenCalledWith(
      { err: pairError, searchIdA: 's1', searchIdB: 's2', userAId: 'u1', userBId: 'u2' },
      'Ranked matchmaking pair failed for queued users'
    );
    const emit = (io.to as unknown as ReturnType<typeof vi.fn>)().emit as ReturnType<typeof vi.fn>;
    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(io.to).toHaveBeenCalledWith('user:u2');
    expect(emit.mock.calls.filter(([event]) => event === 'ranked:queue_left')).toHaveLength(2);
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
    expect(emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PREPARATION_FAILED',
      message: 'Match preparation failed. Please restart ranked matchmaking.',
      meta: {
        searchId: 's1',
        source: 'ranked_human_pair',
      },
    });
    expect(emit).toHaveBeenCalledWith('error', {
      code: 'MATCH_PREPARATION_FAILED',
      message: 'Match preparation failed. Please restart ranked matchmaking.',
      meta: {
        searchId: 's2',
        source: 'ranked_human_pair',
      },
    });
  });

  it('suppresses the terminal abort for a user whose pair failure struck after lobby commit', async () => {
    const service = await loadService();
    const io = createIoMock();
    const pairError = new Error('post-commit cleanup failed');

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
        return [];
      })
      .mockImplementation(async () => []);
    createLobbyMock.mockRejectedValueOnce(pairError);

    const { userSessionGuardService } = await import(
      '../../src/realtime/services/user-session-guard.service.js'
    );
    const clearSnapshot = {
      state: 'IDLE',
      activeMatchId: null,
      waitingLobbyId: null,
      queueSearchId: null,
    } as never;
    const committedSnapshot = {
      state: 'IN_WAITING_LOBBY',
      activeMatchId: null,
      waitingLobbyId: 'lobby-commit',
      queueSearchId: null,
    } as never;
    // First resolveStates call is the pre-pair preflight (must be clear so the
    // pair proceeds to the failing lobby create); later calls are the failure
    // notifier, which must see u1's committed lobby.
    const resolveStatesSpy = vi.spyOn(userSessionGuardService, 'resolveStates')
      .mockResolvedValueOnce(new Map([['u1', clearSnapshot], ['u2', clearSnapshot]]))
      .mockResolvedValue(new Map([['u1', committedSnapshot], ['u2', clearSnapshot]]));

    // Record the destination room per emit: the shared-emitter default mock
    // cannot prove WHICH user received the abort.
    const roomEvents: Array<{ room: string; event: string; payload?: unknown }> = [];
    (io.to as unknown as ReturnType<typeof vi.fn>).mockImplementation((room: string) => ({
      emit: (event: string, payload?: unknown) => {
        roomEvents.push({ room, event, payload });
      },
    }));

    try {
      service.start(io);
      await vi.advanceTimersByTimeAsync(120);

      expect(createLobbyMock).toHaveBeenCalledTimes(1);
      const abortErrors = roomEvents.filter(
        ({ event, payload }) =>
          event === 'error' &&
          (payload as { code?: string } | undefined)?.code === 'MATCH_PREPARATION_FAILED'
      );
      // u1 has a committed lobby: no contradictory abort. u2 is clear: aborted.
      expect(abortErrors).toHaveLength(1);
      expect(abortErrors[0]?.room).toBe('user:u2');
      expect((abortErrors[0]?.payload as { meta: { searchId: string } }).meta.searchId).toBe('s2');
      const queueLeft = roomEvents.filter(({ event }) => event === 'ranked:queue_left');
      expect(queueLeft).toHaveLength(1);
      expect(queueLeft[0]?.room).toBe('user:u2');
      expect(
        roomEvents.filter(({ room, event }) => room === 'user:u1' && (event === 'error' || event === 'ranked:queue_left'))
      ).toHaveLength(0);
    } finally {
      resolveStatesSpy.mockRestore();
      // Drop any unconsumed once-rejection so it cannot leak into later tests;
      // beforeEach reinstalls the default implementation.
      createLobbyMock.mockReset();
    }
  });

  it('keeps a bounded pool of pair starts full without over-claiming users', async () => {
    const service = await loadService();
    const io = createIoMock();
    let pairScriptCalls = 0;
    let releaseLobbyStarts!: () => void;
    const lobbyStartGate = new Promise<void>((resolve) => {
      releaseLobbyStarts = resolve;
    });

    redisMock.eval.mockImplementation(async (script: string) => {
      if (script !== RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
      pairScriptCalls += 1;
      if (pairScriptCalls > 10) return [];
      const userNumber = (pairScriptCalls - 1) * 2 + 1;
      return [
        `s${userNumber}`,
        `u${userNumber}`,
        `s${userNumber + 1}`,
        `u${userNumber + 1}`,
      ];
    });
    createLobbyMock.mockImplementation(async ({ hostUserId }: { hostUserId: string }) => {
      await lobbyStartGate;
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
    for (let i = 0; i < 100 && createLobbyMock.mock.calls.length < 6; i += 1) {
      await Promise.resolve();
    }

    // Six user pairs are atomically reserved and admitted. The remaining
    // pairs stay recoverable in the live queue until a worker slot is free.
    expect(pairScriptCalls).toBe(6);
    expect(createLobbyMock).toHaveBeenCalledTimes(6);

    releaseLobbyStarts();
    for (let i = 0; i < 1_000 && createLobbyMock.mock.calls.length < 10; i += 1) {
      await Promise.resolve();
    }
    expect(pairScriptCalls).toBe(11);
    expect(createLobbyMock).toHaveBeenCalledTimes(10);
  });

  it('skips human pair creation when either claimed user already has session state', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
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

  it('does not overlap local ticks while a previous tick is still running', async () => {
    const service = await loadService();
    const io = createIoMock();
    let pairScriptCalls = 0;
    let releasePairClaim!: () => void;
    const pairClaimGate = new Promise<void>((resolve) => {
      releasePairClaim = resolve;
    });
    redisMock.eval.mockImplementation(async (script: string) => {
      if (script !== RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return [];
      pairScriptCalls += 1;
      await pairClaimGate;
      return [];
    });

    service.start(io);
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(500);

    expect(pairScriptCalls).toBe(1);
    releasePairClaim();
    await Promise.resolve();
  });

  it('emits ranked:match_found with opponent RP from ensured profiles', async () => {
    const service = await loadService();
    const io = createIoMock();

    redisMock.eval
      .mockImplementationOnce(async (script: string) => {
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 's2', 'u2'];
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
        if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) return ['s1', 'u1', 'MA', 's2', 'u2', 'GE'];
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

  it('runRankedDraftStart defers DB-heavy draft work while the ranked queue is backlogged', async () => {
    const io = createIoMock();
    redisMock.get.mockResolvedValue(null);
    redisMock.zCard.mockResolvedValue(50);

    const mod = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    const before = Date.now();
    await mod.runRankedDraftStart(io, 'lobby-1', 'u1', 'u2');

    expect(getLobbyByIdMock).not.toHaveBeenCalled();
    expect(startDraftMock).not.toHaveBeenCalled();
    expect(scheduleRealtimeTimerMock).toHaveBeenCalledWith(
      'ranked_draft_start',
      'lobby-1',
      expect.any(Date),
      { kind: 'ranked_draft_start', lobbyId: 'lobby-1', userAId: 'u1', userBId: 'u2' }
    );
    const dueAt = scheduleRealtimeTimerMock.mock.calls[0]?.[2] as Date;
    expect(dueAt.getTime() - before).toBe(500);
  });

  it('runRankedDraftStart rethrows DB admission pressure for durable retry', async () => {
    const io = createIoMock();
    redisMock.get.mockResolvedValue(null);
    getLobbyByIdMock.mockResolvedValue(makeOpenLobby('lobby-1', 'waiting'));
    const { DbOverloadedError } = await import('../../src/db/admission.js');
    startDraftMock.mockRejectedValueOnce(new DbOverloadedError('queue_full'));

    const mod = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    await expect(mod.runRankedDraftStart(io, 'lobby-1', 'u1', 'u2')).rejects.toMatchObject({
      code: 'DB_OVERLOADED',
      reason: 'queue_full',
    });
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
});
