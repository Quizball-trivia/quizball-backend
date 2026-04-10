import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getByIdMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const clearLobbyCategoryBansMock = vi.fn();
const clearLobbyCategoriesMock = vi.fn();
const insertLobbyCategoriesMock = vi.fn();
const setLobbyStatusMock = vi.fn();
const deleteLobbyMock = vi.fn();
const selectRandomCategoriesMock = vi.fn();
const selectRandomRankedCategoriesMock = vi.fn();
const cleanupLobbyMock = vi.fn();
const consumeRankedTicketsMock = vi.fn();
const emitStateMock = vi.fn();
const redisGetMock = vi.fn();
const redisSetMock = vi.fn();
const redisDelMock = vi.fn();
const getUserByIdMock = vi.fn();

let redisClientMock: {
  get: typeof redisGetMock;
  set: typeof redisSetMock;
  del: typeof redisDelMock;
} | null = null;

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    getById: (...args: unknown[]) => getByIdMock(...args),
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
    clearLobbyCategoryBans: (...args: unknown[]) => clearLobbyCategoryBansMock(...args),
    clearLobbyCategories: (...args: unknown[]) => clearLobbyCategoriesMock(...args),
    insertLobbyCategories: (...args: unknown[]) => insertLobbyCategoriesMock(...args),
    setLobbyStatus: (...args: unknown[]) => setLobbyStatusMock(...args),
    deleteLobby: (...args: unknown[]) => deleteLobbyMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    selectRandomCategories: (...args: unknown[]) => selectRandomCategoriesMock(...args),
    selectRandomRankedCategories: (...args: unknown[]) => selectRandomRankedCategoriesMock(...args),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    consumeRankedTickets: (...args: unknown[]) => consumeRankedTicketsMock(...args),
  },
}));

vi.mock('../../src/realtime/services/warmup-realtime.service.js', () => ({
  warmupRealtimeService: {
    cleanupLobby: (...args: unknown[]) => cleanupLobbyMock(...args),
  },
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    emitState: (...args: unknown[]) => emitStateMock(...args),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redisClientMock,
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getUserByIdMock(...args),
  },
}));

function createSocket(userId: string) {
  return {
    data: {
      user: { id: userId },
      lobbyId: 'lobby-1',
    },
    leave: vi.fn(),
  };
}

function createIo() {
  const roomEmit = vi.fn();
  const userEmit = vi.fn();
  const lobbySockets = [createSocket('u1'), createSocket('u2'), createSocket('ai-1')];

  return {
    io: {
      to: vi.fn((room: string) => ({
        emit: room.startsWith('user:') ? userEmit : roomEmit,
      })),
      in: vi.fn(() => ({
        fetchSockets: vi.fn().mockResolvedValue(lobbySockets),
      })),
    } as unknown as QuizballServer,
    roomEmit,
    userEmit,
    lobbySockets,
  };
}

describe('lobbyRealtimeService.startDraft ranked tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(true);
    selectRandomCategoriesMock.mockResolvedValue([
      { id: 'cat-1', name: 'One' },
      { id: 'cat-2', name: 'Two' },
      { id: 'cat-3', name: 'Three' },
    ]);
    selectRandomRankedCategoriesMock.mockResolvedValue([
      { id: 'cat-1', name: 'One' },
      { id: 'cat-2', name: 'Two' },
      { id: 'cat-3', name: 'Three' },
    ]);
    clearLobbyCategoryBansMock.mockResolvedValue(undefined);
    clearLobbyCategoriesMock.mockResolvedValue(undefined);
    insertLobbyCategoriesMock.mockResolvedValue(undefined);
    setLobbyStatusMock.mockResolvedValue(undefined);
    cleanupLobbyMock.mockResolvedValue(undefined);
    deleteLobbyMock.mockResolvedValue(undefined);
    emitStateMock.mockResolvedValue(undefined);
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    redisDelMock.mockResolvedValue(1);
    redisClientMock = null;
  });

  it('consumes tickets for both human players before starting a human ranked draft', async () => {
    const { io, roomEmit } = createIo();
    const { startDraft } = await import('../../src/realtime/services/lobby-realtime.service.js');

    getByIdMock.mockResolvedValue({
      id: 'lobby-1',
      mode: 'ranked',
      status: 'waiting',
      host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);
    consumeRankedTicketsMock.mockResolvedValue({
      wallets: {
        u1: { coins: 0, tickets: 9 },
        u2: { coins: 0, tickets: 8 },
      },
    });

    await startDraft(io, 'lobby-1');

    expect(consumeRankedTicketsMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(setLobbyStatusMock).toHaveBeenCalledWith('lobby-1', 'active');
    expect(roomEmit).toHaveBeenCalledWith('draft:start', expect.objectContaining({
      lobbyId: 'lobby-1',
      turnUserId: 'u1',
    }));
  });

  it('consumes tickets only for the human player in ranked-vs-AI drafts', async () => {
    const { io } = createIo();
    const { startDraft } = await import('../../src/realtime/services/lobby-realtime.service.js');

    getByIdMock.mockResolvedValue({
      id: 'lobby-1',
      mode: 'ranked',
      status: 'waiting',
      host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'ai-1' },
    ]);
    getUserByIdMock.mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId === 'ai-1',
    }));
    consumeRankedTicketsMock.mockResolvedValue({
      wallets: {
        u1: { coins: 0, tickets: 9 },
      },
    });

    await startDraft(io, 'lobby-1');

    expect(consumeRankedTicketsMock).toHaveBeenCalledWith(['u1']);
  });

  it('aborts ranked draft start cleanly when a player has no tickets', async () => {
    const { io, roomEmit, userEmit, lobbySockets } = createIo();
    const { startDraft } = await import('../../src/realtime/services/lobby-realtime.service.js');

    getByIdMock.mockResolvedValue({
      id: 'lobby-1',
      mode: 'ranked',
      status: 'waiting',
      host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);
    consumeRankedTicketsMock.mockResolvedValue(null);

    await startDraft(io, 'lobby-1');

    expect(deleteLobbyMock).toHaveBeenCalledWith('lobby-1');
    expect(roomEmit).not.toHaveBeenCalledWith('draft:start', expect.anything());
    expect(userEmit).toHaveBeenCalledWith('ranked:queue_left');
    expect(userEmit).toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'INSUFFICIENT_TICKETS',
    }));
    expect(emitStateMock).toHaveBeenCalledTimes(2);
    expect(lobbySockets.every((socket) => socket.data.lobbyId === undefined)).toBe(true);
  });
});
