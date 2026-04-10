import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const createUserMock = vi.fn();
const createLobbyMock = vi.fn();
const addMemberMock = vi.fn();
const removeMemberMock = vi.fn();
const deleteLobbyMock = vi.fn();
const selectRandomRankedCategoriesMock = vi.fn();
const createMatchFromLobbyMock = vi.fn();
const beginMatchForLobbyMock = vi.fn();
const redisSetMock = vi.fn();
const prepareForLobbyEntryMock = vi.fn();
const runWithUserTransitionLockMock = vi.fn();
const emitBlockedMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    create: (...args: unknown[]) => createUserMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    createLobby: (...args: unknown[]) => createLobbyMock(...args),
    addMember: (...args: unknown[]) => addMemberMock(...args),
    removeMember: (...args: unknown[]) => removeMemberMock(...args),
    deleteLobby: (...args: unknown[]) => deleteLobbyMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    selectRandomRankedCategories: (...args: unknown[]) => selectRandomRankedCategoriesMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    createMatchFromLobby: (...args: unknown[]) => createMatchFromLobbyMock(...args),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: false,
    set: (...args: unknown[]) => redisSetMock(...args),
  }),
}));

vi.mock('../../src/realtime/services/match-realtime.service.js', () => ({
  beginMatchForLobby: (...args: unknown[]) => beginMatchForLobbyMock(...args),
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    prepareForLobbyEntry: (...args: unknown[]) => prepareForLobbyEntryMock(...args),
    runWithUserTransitionLock: (...args: unknown[]) => runWithUserTransitionLockMock(...args),
    emitBlocked: (...args: unknown[]) => emitBlockedMock(...args),
  },
}));

vi.mock('../../src/realtime/ai-ranked.constants.js', () => ({
  rankedAiMatchKey: (matchId: string) => `ranked:ai:match:${matchId}`,
  generateRankedAiProfile: () => ({
    username: 'AI-Test',
    avatarUrl: null,
  }),
}));

describe('devRealtimeService.handleQuickMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createUserMock.mockResolvedValue({ id: 'ai-1' });
    createLobbyMock.mockResolvedValue({ id: 'lobby-1' });
    addMemberMock.mockResolvedValue(undefined);
    removeMemberMock.mockResolvedValue(undefined);
    deleteLobbyMock.mockResolvedValue(undefined);
    selectRandomRankedCategoriesMock.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    createMatchFromLobbyMock.mockResolvedValue({ match: { id: 'match-1' } });
    beginMatchForLobbyMock.mockResolvedValue(undefined);
    prepareForLobbyEntryMock.mockResolvedValue({
      ok: true,
      snapshot: {
        state: 'IDLE',
        activeMatchId: null,
        waitingLobbyId: null,
        queueSearchId: null,
      },
    });
    runWithUserTransitionLockMock.mockImplementation(async (_io, _socket, work) => {
      await work();
      return true;
    });
  });

  it('continues quick-match flow when Redis client exists but is closed', async () => {
    const { devRealtimeService } = await import('../../src/realtime/services/dev-realtime.service.js');
    const socket = {
      data: { user: { id: 'u1' } },
      join: vi.fn(),
      emit: vi.fn(),
    } as unknown as QuizballSocket;
    const io = {} as QuizballServer;

    await devRealtimeService.handleQuickMatch(io, socket);

    expect(redisSetMock).not.toHaveBeenCalled();
    expect(beginMatchForLobbyMock).toHaveBeenCalledWith(
      io,
      'lobby-1',
      'match-1',
      expect.objectContaining({ countdownSec: 0 })
    );
    expect(createMatchFromLobbyMock).toHaveBeenCalledWith(expect.objectContaining({
      categoryAId: 'c1',
      categoryBId: 'c2',
      isDev: true,
    }));

    expect(runWithUserTransitionLockMock).toHaveBeenCalledOnce();
    expect(prepareForLobbyEntryMock).toHaveBeenCalledWith(io, 'u1');
    expect(emitBlockedMock).not.toHaveBeenCalled();
  });

  it('cleans up the created lobby when ranked category selection cannot fill the match', async () => {
    const { devRealtimeService } = await import('../../src/realtime/services/dev-realtime.service.js');
    selectRandomRankedCategoriesMock.mockResolvedValue([{ id: 'c1' }]);

    const socket = {
      data: { user: { id: 'u1' } },
      join: vi.fn(),
      leave: vi.fn(),
      emit: vi.fn(),
    } as unknown as QuizballSocket;
    const io = {} as QuizballServer;

    await devRealtimeService.handleQuickMatch(io, socket);

    expect(removeMemberMock).toHaveBeenCalledTimes(2);
    expect(removeMemberMock).toHaveBeenCalledWith('lobby-1', 'u1');
    expect(removeMemberMock).toHaveBeenCalledWith('lobby-1', 'ai-1');
    expect(deleteLobbyMock).toHaveBeenCalledWith('lobby-1');
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-1');
    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(beginMatchForLobbyMock).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'DEV_ERROR',
      message: 'Not enough ranked categories with full coverage',
    });
  });
});
