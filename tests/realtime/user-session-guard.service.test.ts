import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getActiveMatchForUserMock = vi.fn();
const listOpenLobbiesForUserMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const abandonMatchMock = vi.fn();
const finalizeMatchAsForfeitMock = vi.fn();
const completePossessionMatchFromProgressMock = vi.fn();
const resolveMatchPresenceMock = vi.fn();
const buildFinalResultsPayloadMock = vi.fn();
const emitFinalResultsMock = vi.fn();
const abandonMatchWithCompleteLockMock = vi.fn();
const getActiveMatchForLobbyMock = vi.fn();
const removeMemberMock = vi.fn();

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
    removeMember: (...args: unknown[]) => removeMemberMock(...args),
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
    abandonMatch: (...args: unknown[]) => abandonMatchMock(...args),
    getActiveMatchForLobby: (...args: unknown[]) => getActiveMatchForLobbyMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
  },
}));

vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...args: unknown[]) => finalizeMatchAsForfeitMock(...args),
}));

vi.mock('../../src/realtime/possession-completion.js', () => ({
  completePossessionMatchFromProgress: (...args: unknown[]) => completePossessionMatchFromProgressMock(...args),
}));

vi.mock('../../src/realtime/services/match-presence.service.js', () => ({
  resolveMatchPresence: (...args: unknown[]) => resolveMatchPresenceMock(...args),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: (...args: unknown[]) => buildFinalResultsPayloadMock(...args),
  emitFinalResultsToMatchParticipants: (...args: unknown[]) => emitFinalResultsMock(...args),
}));

vi.mock('../../src/realtime/services/match-terminal.service.js', () => ({
  abandonMatchWithCompleteLock: (...args: unknown[]) => abandonMatchWithCompleteLockMock(...args),
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
    removeMemberMock.mockResolvedValue(undefined);
    finalizeMatchAsForfeitMock.mockResolvedValue({
      matchId: 'm1',
      winnerId: 'u2',
      resultVersion: 123,
      completed: true,
    });
    completePossessionMatchFromProgressMock.mockResolvedValue({
      matchId: 'm1',
      winnerId: null,
      resultVersion: 123,
      completed: false,
      reason: 'undecidable',
    });
    resolveMatchPresenceMock.mockResolvedValue({
      presentPlayers: [],
      absentPlayers: [],
      roomSocketUserIds: [],
      presenceKeyUserIds: [],
      disconnectKeyUserIds: [],
      matchSocketCount: 0,
    });
    buildFinalResultsPayloadMock.mockResolvedValue({ matchId: 'm1', resultVersion: 123 });
    emitFinalResultsMock.mockResolvedValue(undefined);
    abandonMatchWithCompleteLockMock.mockResolvedValue({ abandoned: true });
  });

  it('completes stale ranked orphan matches from progress before any forfeit', async () => {
    const staleStartedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    getActiveMatchForUserMock
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        started_at: staleStartedAt,
        updated_at: staleStartedAt,
        lobby_id: 'l1',
        state_payload: { variant: 'ranked_sim', phase: 'NORMAL_PLAY' },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null);
    completePossessionMatchFromProgressMock.mockResolvedValue({
      matchId: 'm1',
      winnerId: 'u1',
      resultVersion: 123,
      completed: true,
      decisionBasis: 'goals',
    });

    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(completePossessionMatchFromProgressMock).toHaveBeenCalledWith(io, 'm1', 'session_guard_orphan');
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IDLE');
  });

  it('forfeits the absent opponent, not the connecting user, when progress is undecidable', async () => {
    const staleStartedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    getActiveMatchForUserMock
      .mockResolvedValueOnce({
        id: 'm1',
        mode: 'ranked',
        status: 'active',
        started_at: staleStartedAt,
        updated_at: staleStartedAt,
        lobby_id: 'l1',
        state_payload: { variant: 'ranked_sim', phase: 'NORMAL_PLAY' },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null);
    resolveMatchPresenceMock.mockResolvedValue({
      presentPlayers: [{ user_id: 'u1' }],
      absentPlayers: [{ user_id: 'u2' }],
      roomSocketUserIds: [],
      presenceKeyUserIds: [],
      disconnectKeyUserIds: ['u2'],
      matchSocketCount: 0,
    });

    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(resolveMatchPresenceMock).toHaveBeenCalledWith(
      io,
      'm1',
      expect.any(Array),
      expect.objectContaining({ connectingUserId: 'u1', staleCleanup: true })
    );
    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'm1',
        forfeitingUserId: 'u2',
        activeMatch: expect.objectContaining({ id: 'm1', mode: 'ranked' }),
      })
    );
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ forfeitingUserId: 'u1' })
    );
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IDLE');
  });

  it('does not forfeit an active ranked match while the user is reconnecting', async () => {
    const staleStartedAt = new Date(Date.now() - 91_000).toISOString();
    getActiveMatchForUserMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      started_at: staleStartedAt,
      lobby_id: 'l1',
    });

    const reconnectingSocket = { data: { user: { id: 'u1' } } };
    const io = {
      in: vi.fn((room: string) => ({
        fetchSockets: vi.fn(async () => (room === 'user:u1' ? [reconnectingSocket] : [])),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IN_ACTIVE_MATCH');
    expect(snapshot.activeMatchId).toBe('m1');
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

  it('blocks ranked queue join while an active draft lobby is being rejoined', async () => {
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
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ACTIVE_MATCH');
    expect(result.message).toBe('You are already in an active draft');
    expect(result.snapshot.state).toBe('IN_WAITING_LOBBY');
    expect(result.snapshot.waitingLobbyId).toBe('draft-lobby');
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it('does not clean up a lobby membership created after connect cleanup started', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const joinedAfterCleanupStarted = new Date(Date.now() + 10_000).toISOString();
    const lateJoinedLobby = {
      id: 'fresh-lobby',
      mode: 'friendly',
      status: 'waiting',
      host_user_id: 'host',
      joined_at: joinedAfterCleanupStarted,
    };
    listOpenLobbiesForUserMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateJoinedLobby])
      .mockResolvedValueOnce([lateJoinedLobby]);

    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(removeMemberMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IN_WAITING_LOBBY');
    expect(snapshot.waitingLobbyId).toBe('fresh-lobby');
  });
});
