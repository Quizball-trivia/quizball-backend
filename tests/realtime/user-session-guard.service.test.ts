import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getActiveMatchForUserMock = vi.fn();
const getActiveMatchesForUsersMock = vi.fn();
const listOpenLobbiesForUserMock = vi.fn();
const listOpenLobbiesForUsersMock = vi.fn();
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
const deleteLobbyMock = vi.fn();
const countMembersMock = vi.fn();
const listMembersWithUserMock = vi.fn();
const resolveMatchReplayEvidenceMock = vi.fn();

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
    listOpenLobbiesForUsers: (...args: unknown[]) => listOpenLobbiesForUsersMock(...args),
    getById: vi.fn(),
    removeMember: (...args: unknown[]) => removeMemberMock(...args),
    countMembers: (...args: unknown[]) => countMembersMock(...args),
    deleteLobby: (...args: unknown[]) => deleteLobbyMock(...args),
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
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
    getActiveMatchesForUsers: (...args: unknown[]) => getActiveMatchesForUsersMock(...args),
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

vi.mock('../../src/realtime/services/match-presence.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-presence.service.js')>();
  return { ...actual, resolveMatchPresence: (...args: unknown[]) => resolveMatchPresenceMock(...args) };
});

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: (...args: unknown[]) => buildFinalResultsPayloadMock(...args),
  emitFinalResultsToMatchParticipants: (...args: unknown[]) => emitFinalResultsMock(...args),
}));

vi.mock('../../src/realtime/services/match-terminal.service.js', () => ({
  abandonMatchWithCompleteLock: (...args: unknown[]) => abandonMatchWithCompleteLockMock(...args),
}));

vi.mock('../../src/realtime/services/match-entry.service.js', () => ({
  resolveMatchReplayEvidence: (...args: unknown[]) => resolveMatchReplayEvidenceMock(...args),
}));

// Build the playerStates the real resolver returns so the AI-forfeit guard
// (canForfeitToPresentPlayers) sees production-shaped data. aiUserIds marks bots.
function presenceFor(
  present: Array<{ user_id: string }>,
  absent: Array<{ user_id: string }>,
  aiUserIds: string[] = []
) {
  const ai = new Set(aiUserIds);
  return {
    playerStates: [
      ...present.map((p) => ({
        player: p, userId: p.user_id, present: true, absent: false,
        reasons: ai.has(p.user_id) ? ['ai'] : ['room_socket'],
      })),
      ...absent.map((p) => ({
        player: p, userId: p.user_id, present: false, absent: true, reasons: ['disconnect_key'],
      })),
    ],
    presentPlayers: present,
    absentPlayers: absent,
    roomSocketUserIds: present.filter((p) => !ai.has(p.user_id)).map((p) => p.user_id),
    presenceKeyUserIds: [],
    disconnectKeyUserIds: absent.map((p) => p.user_id),
    exitPendingUserIds: [],
    matchSocketCount: present.length,
  };
}

describe('user-session-guard.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOpenLobbiesForUserMock.mockResolvedValue([]);
    listOpenLobbiesForUsersMock.mockResolvedValue(new Map());
    getActiveMatchesForUsersMock.mockResolvedValue(new Map());
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
    ]);
    abandonMatchMock.mockResolvedValue(false);
    getActiveMatchForLobbyMock.mockResolvedValue(null);
    removeMemberMock.mockResolvedValue(undefined);
    deleteLobbyMock.mockResolvedValue(undefined);
    countMembersMock.mockResolvedValue(0);
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'u1', is_ai: false },
      { user_id: 'u2', is_ai: false },
    ]);
    resolveMatchReplayEvidenceMock.mockResolvedValue({
      isParticipant: true,
      hasEnteredMarker: false,
      hasRecordedActivity: false,
      allowed: false,
    });
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
    resolveMatchPresenceMock.mockResolvedValue(presenceFor([], []));
    buildFinalResultsPayloadMock.mockResolvedValue({ matchId: 'm1', resultVersion: 123 });
    emitFinalResultsMock.mockResolvedValue(undefined);
    abandonMatchWithCompleteLockMock.mockResolvedValue({ abandoned: true });
  });

  it('resolves multiple session states with one batched match query and one batched lobby query', async () => {
    getActiveMatchesForUsersMock.mockResolvedValue(new Map([['u2', {
      id: 'match-u2',
      mode: 'ranked',
      status: 'active',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      lobby_id: 'active-lobby-u2',
      state_payload: { variant: 'ranked_sim' },
    }]]));
    listOpenLobbiesForUsersMock.mockResolvedValue(new Map([
      ['u1', [{ id: 'waiting-u1', status: 'waiting', joined_at: new Date().toISOString() }]],
      ['u2', []],
    ]));

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshots = await userSessionGuardService.resolveStates(['u1', 'u2', 'u1']);

    expect(getActiveMatchesForUsersMock).toHaveBeenCalledOnce();
    expect(getActiveMatchesForUsersMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(listOpenLobbiesForUsersMock).toHaveBeenCalledOnce();
    expect(listOpenLobbiesForUsersMock).toHaveBeenCalledWith(['u1', 'u2']);
    expect(getActiveMatchForUserMock).not.toHaveBeenCalled();
    expect(listOpenLobbiesForUserMock).not.toHaveBeenCalled();
    expect(snapshots.get('u1')).toMatchObject({
      state: 'IN_WAITING_LOBBY',
      waitingLobbyId: 'waiting-u1',
    });
    expect(snapshots.get('u2')).toMatchObject({
      state: 'IN_ACTIVE_MATCH',
      activeMatchId: 'match-u2',
    });
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
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([{ user_id: 'u1' }], [{ user_id: 'u2' }])
    );

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

  it('uses one session-context read for an idle ranked queue join', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([]);

    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'idle-user');

    expect(result).toMatchObject({ ok: true, snapshot: { state: 'IDLE' } });
    expect(getActiveMatchForUserMock).toHaveBeenCalledTimes(1);
    expect(listOpenLobbiesForUserMock).toHaveBeenCalledTimes(1);
  });

  it('uses one session-context read for a clean lobby entry', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([]);

    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForLobbyEntry(io, 'idle-user');

    expect(result).toMatchObject({ ok: true, snapshot: { state: 'IDLE' } });
    expect(getActiveMatchForUserMock).toHaveBeenCalledTimes(1);
    expect(listOpenLobbiesForUserMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads once after clean connect preparation to observe a concurrent lobby join', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const joinedAfterCleanupStarted = {
      id: 'fresh-lobby',
      mode: 'friendly',
      status: 'waiting',
      host_user_id: 'host',
      joined_at: new Date(Date.now() + 10_000).toISOString(),
    };
    listOpenLobbiesForUserMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([joinedAfterCleanupStarted]);

    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'idle-user');

    expect(getActiveMatchForUserMock).toHaveBeenCalledTimes(2);
    expect(listOpenLobbiesForUserMock).toHaveBeenCalledTimes(2);
    expect(removeMemberMock).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      state: 'IN_WAITING_LOBBY',
      waitingLobbyId: 'fresh-lobby',
    });
  });

  it('closes an active ranked pre-match lobby on queue leave when no match row exists', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const activeLobby = {
      id: 'draft-lobby',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
      joined_at: new Date().toISOString(),
    };
    listOpenLobbiesForUserMock
      .mockResolvedValueOnce([activeLobby])
      .mockResolvedValue([]);
    getActiveMatchForLobbyMock.mockResolvedValue(null);
    const lobbySocket = {
      leave: vi.fn(),
      data: { lobbyId: 'draft-lobby', user: { id: 'u1' } },
    };
    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => [lobbySocket]),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.cleanupRankedQueueArtifacts(io, 'u1');

    expect(deleteLobbyMock).toHaveBeenCalledWith('draft-lobby');
    expect(lobbySocket.leave).toHaveBeenCalledWith('lobby:draft-lobby');
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
    expect(snapshot.state).toBe('IDLE');
  });

  it('does not close an active ranked lobby when its match has entered evidence', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const activeLobby = {
      id: 'draft-lobby',
      mode: 'ranked',
      status: 'active',
      host_user_id: 'u1',
      joined_at: new Date().toISOString(),
    };
    listOpenLobbiesForUserMock.mockResolvedValue([activeLobby]);
    getActiveMatchForLobbyMock.mockResolvedValue({
      id: 'm-started',
      mode: 'ranked',
      status: 'active',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    resolveMatchReplayEvidenceMock.mockResolvedValue({
      isParticipant: true,
      hasEnteredMarker: true,
      hasRecordedActivity: false,
      allowed: true,
    });
    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => []),
      })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    await userSessionGuardService.cleanupRankedQueueArtifacts(io, 'u1');

    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
    expect(deleteLobbyMock).not.toHaveBeenCalled();
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
