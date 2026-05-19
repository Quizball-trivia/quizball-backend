import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getActiveMatchForUserMock = vi.fn();
const listOpenLobbiesForUserMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const abandonMatchMock = vi.fn();
const finalizeMatchAsForfeitMock = vi.fn();
const getActiveMatchForLobbyMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => null,
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listOpenLobbiesForUser: (...args: unknown[]) => listOpenLobbiesForUserMock(...args),
    getById: vi.fn(),
    removeMember: vi.fn(),
    countMembers: vi.fn(),
    deleteLobby: vi.fn(),
    listMembersWithUser: vi.fn(),
    setHostUser: vi.fn(),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    buildLobbyState: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getActiveMatchForUser: (...args: unknown[]) => getActiveMatchForUserMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    abandonMatch: (...args: unknown[]) => abandonMatchMock(...args),
    getActiveMatchForLobby: (...args: unknown[]) => getActiveMatchForLobbyMock(...args),
  },
}));

vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...args: unknown[]) => finalizeMatchAsForfeitMock(...args),
}));

describe('user-session-guard.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOpenLobbiesForUserMock.mockResolvedValue([]);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);
    abandonMatchMock.mockResolvedValue(false);
    getActiveMatchForLobbyMock.mockResolvedValue(null);
    finalizeMatchAsForfeitMock.mockResolvedValue({
      matchId: 'm1',
      winnerId: 'u2',
      resultVersion: 123,
      completed: true,
    });
  });

  it('finalizes stale ranked orphan matches as forfeit instead of abandoning them', async () => {
    const staleStartedAt = new Date(Date.now() - 91_000).toISOString();
    getActiveMatchForUserMock
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        started_at: staleStartedAt,
        lobby_id: 'l1',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null);

    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'm1',
        forfeitingUserId: 'u1',
        activeMatch: expect.objectContaining({ id: 'm1', mode: 'ranked' }),
      })
    );
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IDLE');
  });

  it('does not abandon ranked matches when forfeit finalization does not complete', async () => {
    const staleStartedAt = new Date(Date.now() - 91_000).toISOString();
    getActiveMatchForUserMock
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        started_at: staleStartedAt,
        lobby_id: 'l1',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null);
    finalizeMatchAsForfeitMock.mockResolvedValue({
      matchId: 'm1',
      winnerId: null,
      resultVersion: 456,
      completed: false,
    });

    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'm1',
        forfeitingUserId: 'u1',
        activeMatch: expect.objectContaining({ id: 'm1', mode: 'ranked' }),
      })
    );
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IDLE');
  });

  it('preserves active draft lobbies on reconnect before a match row exists', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([
      {
        id: 'draft-lobby',
        mode: 'ranked',
        status: 'active',
        host_user_id: 'u1',
        joined_at: new Date().toISOString(),
      },
    ]);

    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(getActiveMatchForLobbyMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IN_WAITING_LOBBY');
    expect(snapshot.waitingLobbyId).toBe('draft-lobby');
  });
});
