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
const getUserByIdMock = vi.fn();
const ensureProfileMock = vi.fn();
const startDraftMock = vi.fn();
const startRankedAiForUserMock = vi.fn();
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
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    createLobby: (...args: unknown[]) => createLobbyMock(...args),
    addMember: (...args: unknown[]) => addMemberMock(...args),
    getById: (...args: unknown[]) => getLobbyByIdMock(...args),
    listOpenLobbiesForUser: (...args: unknown[]) => listOpenLobbiesForUserMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getActiveMatchForUser: (...args: unknown[]) => getActiveMatchForUserMock(...args),
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

function createIoMock(): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const socketsJoin = vi.fn().mockResolvedValue(undefined);
  const inFn = vi.fn((room: string) => {
    const userMatch = /^user:(.+)$/.exec(room);
    const userId = userMatch?.[1] ?? null;
    const fetchSockets = vi.fn().mockResolvedValue(
      userId && !absentUserIds.has(userId)
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

    redisMock = {
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
    startRankedAiForUserMock.mockResolvedValue(undefined);
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

  it('passes queued session country to AI fallback', async () => {
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
      playerCountryCode: 'MA',
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
      { err: fallbackPhaseError },
      'Ranked matchmaking fallback phase failed'
    );
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

    expect(startDraftMock).toHaveBeenCalledWith(io, 'lobby-1');
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
