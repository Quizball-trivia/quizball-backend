import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import {
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_RANDOM_SCRIPT,
} from '../../src/realtime/lua/ranked-matchmaking.scripts.js';

type FakeRedis = {
  zRangeByScore: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  hGet: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
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

function createIoMock(): QuizballServer {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const socketsJoin = vi.fn().mockResolvedValue(undefined);
  const fetchSockets = vi.fn().mockResolvedValue([]);
  const inFn = vi.fn(() => ({
    socketsJoin,
    fetchSockets,
  }));

  return {
    to,
    in: inFn,
  } as unknown as QuizballServer;
}

async function loadService() {
  const module = await import('../../src/realtime/services/ranked-matchmaking.service.js');
  return module.rankedMatchmakingService;
}

describe('ranked-matchmaking.service queue behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    redisMock = {
      zRangeByScore: vi.fn().mockResolvedValue([]),
      eval: vi.fn().mockResolvedValue([]),
      hGet: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };

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
});
