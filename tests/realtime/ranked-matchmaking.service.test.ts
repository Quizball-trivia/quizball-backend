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
};

const createLobbyMock = vi.fn();
const addMemberMock = vi.fn();
const getLobbyByIdMock = vi.fn();
const buildLobbyStateMock = vi.fn();
const getUserByIdMock = vi.fn();
const startDraftMock = vi.fn();
const startRankedAiForUserMock = vi.fn();
const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();

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
});
