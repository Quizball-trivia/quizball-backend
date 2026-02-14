import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const createUserMock = vi.fn();
const createLobbyMock = vi.fn();
const addMemberMock = vi.fn();
const selectRandomCategoriesMock = vi.fn();
const createMatchFromLobbyMock = vi.fn();
const beginMatchForLobbyMock = vi.fn();
const redisSetMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    create: (...args: unknown[]) => createUserMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    createLobby: (...args: unknown[]) => createLobbyMock(...args),
    addMember: (...args: unknown[]) => addMemberMock(...args),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    selectRandomCategories: (...args: unknown[]) => selectRandomCategoriesMock(...args),
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
    selectRandomCategoriesMock.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    createMatchFromLobbyMock.mockResolvedValue({ match: { id: 'match-1' } });
    beginMatchForLobbyMock.mockResolvedValue(undefined);
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
      expect.objectContaining({ countdownSec: 2 })
    );
  });
});
