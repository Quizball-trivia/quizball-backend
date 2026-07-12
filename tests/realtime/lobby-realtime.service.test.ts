import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const getByIdMock = vi.fn();
const findOpenLobbyForUserMock = vi.fn();
const listOpenLobbiesForUserMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const listLobbyCategoryBansMock = vi.fn();
const clearLobbyCategoryBansMock = vi.fn();
const clearLobbyCategoriesMock = vi.fn();
const insertLobbyCategoriesMock = vi.fn();
const setLobbyStatusMock = vi.fn();
const deleteLobbyMock = vi.fn();
const buildLobbyStateMock = vi.fn();
const getLobbyCategoriesMock = vi.fn();
const selectRandomCategoriesMock = vi.fn();
const selectRandomRankedCategoriesMock = vi.fn();
const selectRankedCategoriesForDraftMock = vi.fn();
const cleanupLobbyMock = vi.fn();
const consumeRankedTicketsMock = vi.fn();
const emitStateMock = vi.fn();
const redisGetMock = vi.fn();
const redisSetMock = vi.fn();
const redisDelMock = vi.fn();
const getUserByIdMock = vi.fn();
const pauseDraftForDisconnectedPlayerMock = vi.fn();
const resumeDraftForReconnectedPlayerMock = vi.fn();
const resumeActiveDraftTimersMock = vi.fn();
const scheduleDraftAutoBanForCurrentTurnMock = vi.fn();
const isDraftPlayerMarkedDisconnectedMock = vi.fn();
const pauseDraftForDisconnectedPlayerAtStartMock = vi.fn();
const markDraftPlayerDisconnectedMock = vi.fn();

let redisClientMock: {
  get: typeof redisGetMock;
  set: typeof redisSetMock;
  del: typeof redisDelMock;
  isOpen?: boolean;
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
    findOpenLobbyForUser: (...args: unknown[]) => findOpenLobbyForUserMock(...args),
    listOpenLobbiesForUser: (...args: unknown[]) => listOpenLobbiesForUserMock(...args),
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
    listLobbyCategoryBans: (...args: unknown[]) => listLobbyCategoryBansMock(...args),
    clearLobbyCategoryBans: (...args: unknown[]) => clearLobbyCategoryBansMock(...args),
    clearLobbyCategories: (...args: unknown[]) => clearLobbyCategoriesMock(...args),
    insertLobbyCategories: (...args: unknown[]) => insertLobbyCategoriesMock(...args),
    setLobbyStatus: (...args: unknown[]) => setLobbyStatusMock(...args),
    deleteLobby: (...args: unknown[]) => deleteLobbyMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    buildLobbyState: (...args: unknown[]) => buildLobbyStateMock(...args),
    getLobbyCategories: (...args: unknown[]) => getLobbyCategoriesMock(...args),
    selectRandomCategories: (...args: unknown[]) => selectRandomCategoriesMock(...args),
    selectRandomRankedCategories: (...args: unknown[]) => selectRandomRankedCategoriesMock(...args),
    selectRankedCategoriesForDraft: (...args: unknown[]) => selectRankedCategoriesForDraftMock(...args),
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

vi.mock('../../src/realtime/services/draft-realtime.service.js', () => ({
  resumeActiveDraftTimers: (...args: unknown[]) => resumeActiveDraftTimersMock(...args),
  scheduleDraftAutoBanForCurrentTurn: (...args: unknown[]) => scheduleDraftAutoBanForCurrentTurnMock(...args),
  isDraftPlayerMarkedDisconnected: (...args: unknown[]) => isDraftPlayerMarkedDisconnectedMock(...args),
  pauseDraftForDisconnectedPlayerAtStart: (...args: unknown[]) => pauseDraftForDisconnectedPlayerAtStartMock(...args),
  markDraftPlayerDisconnected: (...args: unknown[]) => markDraftPlayerDisconnectedMock(...args),
  draftRealtimeService: {
    pauseDraftForDisconnectedPlayer: (...args: unknown[]) => pauseDraftForDisconnectedPlayerMock(...args),
    resumeDraftForReconnectedPlayer: (...args: unknown[]) => resumeDraftForReconnectedPlayerMock(...args),
  },
}));

function createSocket(userId: string, lobbyId: string | undefined = 'lobby-1') {
  return {
    id: `socket-${userId}`,
    data: {
      user: { id: userId },
      lobbyId,
      connectedAt: 1000,
    },
    leave: vi.fn(),
    join: vi.fn(),
    emit: vi.fn(),
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
  beforeEach(async () => {
    vi.clearAllMocks();
    isDraftPlayerMarkedDisconnectedMock.mockResolvedValue(false);
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(true);
    selectRandomCategoriesMock.mockResolvedValue([
      { id: 'cat-1', name: 'One' },
      { id: 'cat-2', name: 'Two' },
      { id: 'cat-3', name: 'Three' },
    ]);
    selectRandomRankedCategoriesMock.mockResolvedValue([
      { id: 'ranked-cat-1', name: 'Ranked One' },
      { id: 'ranked-cat-2', name: 'Ranked Two' },
      { id: 'ranked-cat-3', name: 'Ranked Three' },
    ]);
    selectRankedCategoriesForDraftMock.mockResolvedValue({
      categories: [
        { id: 'ranked-cat-1', name: 'Ranked One' },
        { id: 'ranked-cat-2', name: 'Ranked Two' },
        { id: 'ranked-cat-3', name: 'Ranked Three' },
      ],
      recentFilterApplied: true,
    });
    clearLobbyCategoryBansMock.mockResolvedValue(undefined);
    clearLobbyCategoriesMock.mockResolvedValue(undefined);
    findOpenLobbyForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([]);
    listLobbyCategoryBansMock.mockResolvedValue([]);
    buildLobbyStateMock.mockResolvedValue({ lobbyId: 'lobby-1', status: 'active', members: [] });
    getLobbyCategoriesMock.mockResolvedValue([
      { id: 'cat-1', name: 'One' },
      { id: 'cat-2', name: 'Two' },
      { id: 'cat-3', name: 'Three' },
    ]);
    insertLobbyCategoriesMock.mockResolvedValue(undefined);
    setLobbyStatusMock.mockResolvedValue(undefined);
    cleanupLobbyMock.mockResolvedValue(undefined);
    deleteLobbyMock.mockResolvedValue(undefined);
    emitStateMock.mockResolvedValue(undefined);
    resumeDraftForReconnectedPlayerMock.mockResolvedValue(undefined);
    resumeActiveDraftTimersMock.mockResolvedValue(undefined);
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    redisDelMock.mockResolvedValue(1);
    redisClientMock = null;
    const { resetDraftTurnStateForTests } = await import('../../src/realtime/draft-turn-state.js');
    resetDraftTurnStateForTests();
  });

  it('starts a human ranked draft without consuming tickets before match creation', async () => {
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
    redisClientMock = {
      get: redisGetMock,
      set: redisSetMock,
      del: redisDelMock,
      isOpen: true,
    };

    await startDraft(io, 'lobby-1');

    // Both humans' recents feed the candidate selection.
    expect(selectRankedCategoriesForDraftMock).toHaveBeenCalledWith({
      count: 3,
      userIds: ['u1', 'u2'],
    });
    expect(selectRandomCategoriesMock).not.toHaveBeenCalled();
    expect(consumeRankedTicketsMock).not.toHaveBeenCalled();
    expect(setLobbyStatusMock).toHaveBeenCalledWith('lobby-1', 'active');
    expect(roomEmit).toHaveBeenCalledWith('draft:start', expect.objectContaining({
      lobbyId: 'lobby-1',
      turnUserId: 'u1',
      forceAtMs: null,
      recentFilterApplied: true,
    }));
    expect(redisSetMock).toHaveBeenCalledWith(
      'draft:turn_state:lobby-1',
      JSON.stringify({
        firstActorUserId: 'u1',
        nextActorUserId: 'u1',
        aiUserId: null,
        participantUserIds: ['u1', 'u2'],
        banCount: 0,
      }),
      { EX: 600 }
    );
  });

  it('starts paused and emits the disconnect overlay when a member was already marked disconnected', async () => {
    const { io } = createIo();
    const { startDraft } = await import('../../src/realtime/services/lobby-realtime.service.js');
    getByIdMock.mockResolvedValue({
      id: 'lobby-1', mode: 'ranked', status: 'waiting', host_user_id: 'u1',
    });
    listMembersWithUserMock.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    isDraftPlayerMarkedDisconnectedMock.mockImplementation(async (_lobbyId: string, userId: string) => userId === 'u1');

    await startDraft(io, 'lobby-1');

    await vi.waitFor(() => {
      expect(pauseDraftForDisconnectedPlayerAtStartMock).toHaveBeenCalledWith(io, 'lobby-1', 'u1');
    });
    expect(scheduleDraftAutoBanForCurrentTurnMock).not.toHaveBeenCalled();
  });

  it('starts a ranked-vs-AI draft without consuming the human ticket before match creation', async () => {
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

    await startDraft(io, 'lobby-1');

    // Bot match: only the human's recents are considered.
    expect(selectRankedCategoriesForDraftMock).toHaveBeenCalledWith({
      count: 3,
      userIds: ['u1'],
    });
    expect(selectRandomCategoriesMock).not.toHaveBeenCalled();
    expect(consumeRankedTicketsMock).not.toHaveBeenCalled();
  });

  it('persists an AI host as first actor before emitting draft:start', async () => {
    const { io, roomEmit } = createIo();
    const { startDraft } = await import('../../src/realtime/services/lobby-realtime.service.js');
    const { readDraftTurnState } = await import('../../src/realtime/draft-turn-state.js');
    getByIdMock.mockResolvedValue({
      id: 'lobby-1',
      mode: 'ranked',
      status: 'waiting',
      host_user_id: 'ai-1',
    });
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'ai-1' },
    ]);
    getUserByIdMock.mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId === 'ai-1',
    }));

    await startDraft(io, 'lobby-1');

    expect(await readDraftTurnState('lobby-1')).toEqual({
      firstActorUserId: 'ai-1',
      nextActorUserId: 'ai-1',
      aiUserId: 'ai-1',
      participantUserIds: ['u1', 'ai-1'],
      banCount: 0,
    });
    expect(roomEmit).toHaveBeenCalledWith('draft:start', expect.objectContaining({
      turnUserId: 'ai-1',
    }));

    redisGetMock.mockResolvedValue('u1');
    getUserByIdMock.mockResolvedValue({ id: 'u1', is_ai: true });
    expect((await readDraftTurnState('lobby-1'))?.nextActorUserId).toBe('ai-1');
  });

  it('pauses an active draft on disconnect even when the socket lost its lobby id', async () => {
    const { io } = createIo();
    // The user's draft connection is gone — only the opponent/AI remain in the
    // lobby room — so the DB fallback must treat this as a real draft disconnect.
    (io.in as ReturnType<typeof vi.fn>).mockReturnValue({
      fetchSockets: vi.fn().mockResolvedValue([createSocket('u2'), createSocket('ai-1')]),
    });
    const { lobbyRealtimeService } = await import('../../src/realtime/services/lobby-realtime.service.js');
    const socket = createSocket('u1');
    socket.id = 'socket-1';
    socket.data.connectedAt = 1234;
    socket.data.lobbyId = undefined;
    const activeLobby = {
      id: 'lobby-1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    };
    findOpenLobbyForUserMock.mockResolvedValue(activeLobby);
    getByIdMock.mockResolvedValue(activeLobby);

    await lobbyRealtimeService.handleLobbyDisconnect(io, socket as never);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pauseDraftForDisconnectedPlayerMock).toHaveBeenCalledWith(io, 'lobby-1', 'u1', {
      ignoreSocketId: 'socket-1',
      disconnectedConnectedAt: 1234,
    });
    expect(findOpenLobbyForUserMock).toHaveBeenCalledWith('u1');
  });

  it('skips the draft pause when an unbound socket disconnects but the user still has a live socket in the draft room', async () => {
    const { io } = createIo(); // default mock: u1 still has a socket in lobby:lobby-1
    const { lobbyRealtimeService } = await import('../../src/realtime/services/lobby-realtime.service.js');
    const socket = createSocket('u1');
    socket.id = 'socket-1'; // unrelated tab — never bound to the lobby
    socket.data.lobbyId = undefined;
    const activeLobby = {
      id: 'lobby-1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    };
    findOpenLobbyForUserMock.mockResolvedValue(activeLobby);
    getByIdMock.mockResolvedValue(activeLobby);

    await lobbyRealtimeService.handleLobbyDisconnect(io, socket as never);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pauseDraftForDisconnectedPlayerMock).not.toHaveBeenCalled();
  });

  it('hydrates an active draft on socket connect without resuming disconnect grace', async () => {
    const { io } = createIo();
    const { lobbyRealtimeService } = await import('../../src/realtime/services/lobby-realtime.service.js');
    const socket = createSocket('u1', undefined);
    const activeLobby = {
      id: 'lobby-1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    };
    listOpenLobbiesForUserMock.mockResolvedValue([activeLobby]);
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);
    listLobbyCategoryBansMock.mockResolvedValue([
      { user_id: 'u1', category_id: 'cat-1' },
    ]);
    const { persistInitialDraftTurnState } = await import('../../src/realtime/draft-turn-state.js');
    await persistInitialDraftTurnState('lobby-1', {
      firstActorUserId: 'u1',
      nextActorUserId: 'u2',
      aiUserId: null,
      participantUserIds: ['u1', 'u2'],
      banCount: 1,
    });

    await lobbyRealtimeService.rejoinActiveDraftLobbyOnConnect(io, socket as never);

    expect(socket.emit).toHaveBeenCalledWith('lobby:state', expect.objectContaining({ lobbyId: 'lobby-1' }));
    expect(socket.emit).toHaveBeenCalledWith('draft:start', expect.objectContaining({
      lobbyId: 'lobby-1',
      turnUserId: 'u2',
    }));
    expect(socket.emit).toHaveBeenCalledWith('draft:banned', {
      actorId: 'u1',
      categoryId: 'cat-1',
      turnUserId: 'u2',
      forceAtMs: null,
    });
    expect(resumeDraftForReconnectedPlayerMock).not.toHaveBeenCalled();
    expect(resumeActiveDraftTimersMock).not.toHaveBeenCalled();
  });

  it('resumes draft grace only on explicit draft rejoin', async () => {
    const { io } = createIo();
    const { lobbyRealtimeService } = await import('../../src/realtime/services/lobby-realtime.service.js');
    const socket = createSocket('u1', undefined);
    const activeLobby = {
      id: 'lobby-1',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
    };
    listOpenLobbiesForUserMock.mockResolvedValue([activeLobby]);
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);
    const { persistInitialDraftTurnState } = await import('../../src/realtime/draft-turn-state.js');
    await persistInitialDraftTurnState('lobby-1', {
      firstActorUserId: 'u1',
      nextActorUserId: 'u1',
      aiUserId: null,
      participantUserIds: ['u1', 'u2'],
      banCount: 0,
    });

    await lobbyRealtimeService.rejoinActiveDraftLobbyOnConnect(io, socket as never, {
      resume: true,
      lobbyId: 'lobby-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeDraftForReconnectedPlayerMock).toHaveBeenCalledWith(io, 'lobby-1', 'u1');
    expect(resumeActiveDraftTimersMock).toHaveBeenCalledWith(io, 'lobby-1');
  });
});
