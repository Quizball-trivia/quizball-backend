import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const getLobbyByIdMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const listLobbyCategoryBansMock = vi.fn();
const insertLobbyCategoryBanMock = vi.fn();
const getLobbyCategoriesMock = vi.fn();
const createMatchFromLobbyMock = vi.fn();
const beginMatchForLobbyMock = vi.fn();

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    getById: (...args: unknown[]) => getLobbyByIdMock(...args),
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
    listLobbyCategoryBans: (...args: unknown[]) => listLobbyCategoryBansMock(...args),
    insertLobbyCategoryBan: (...args: unknown[]) => insertLobbyCategoryBanMock(...args),
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
  },
}));

vi.mock('../../src/realtime/services/match-realtime.service.js', () => ({
  beginMatchForLobby: (...args: unknown[]) => beginMatchForLobbyMock(...args),
}));

vi.mock('../../src/realtime/services/lobby-realtime.service.js', () => ({
  startDraft: vi.fn(),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => null,
}));

vi.mock('../../src/realtime/ai-ranked.constants.js', () => ({
  rankedAiLobbyKey: (lobbyId: string) => `ranked:ai:lobby:${lobbyId}`,
}));

function createIoMock() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as QuizballServer, emit };
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
    insertLobbyCategoryBanMock.mockImplementation(async (_lobbyId: string, userId: string, categoryId: string) => {
      bans.push({ user_id: userId, category_id: categoryId });
    });

    createMatchFromLobbyMock.mockResolvedValue({ match: { id: 'm1' } });
    beginMatchForLobbyMock.mockResolvedValue(undefined);
  });

  it('does not complete the draft after only one ban', async () => {
    const { draftRealtimeService } = await import('../../src/realtime/services/draft-realtime.service.js');
    const { io, emit } = createIoMock();
    const socket = createSocketMock('u1', 'l1');

    await draftRealtimeService.handleBan(io, socket, 'cat-a');

    expect(createMatchFromLobbyMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('draft:banned', {
      actorId: 'u1',
      categoryId: 'cat-a',
    });
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
      hostUserId: 'u1',
      categoryAId: 'cat-c',
      categoryBId: null,
    });
    expect(beginMatchForLobbyMock).toHaveBeenCalledWith(io, 'l1', 'm1');
  });
});
