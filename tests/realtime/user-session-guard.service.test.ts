import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const getActiveMatchForUserMock = vi.fn();
const getRedisClientMock = vi.fn(() => null);
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
const abortLobbyMock = vi.fn();
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
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}));

// Ranked pre-match lobby teardown + reservation release goes through the locked
// abort primitive.
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: {
    abortLobby: (...args: unknown[]) => abortLobbyMock(...args),
    releaseIfSettled: vi.fn().mockResolvedValue(undefined),
    releaseByMatch: vi.fn().mockResolvedValue(undefined),
  },
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
    getRedisClientMock.mockReturnValue(null);
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
    abortLobbyMock.mockResolvedValue({ aborted: true, botReleased: null, lobbyDeleted: true, removedMemberIds: [] });
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

  it('heals a stranded active friendly auction before queue join', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const openLobbies = [{
      id: 'stranded-auction',
      mode: 'friendly' as const,
      game_mode: 'auction' as const,
      status: 'active' as const,
      host_user_id: 'u1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }];
    listOpenLobbiesForUserMock.mockImplementation(async () => [...openLobbies]);
    removeMemberMock.mockImplementation(async () => {
      openLobbies.splice(0, openLobbies.length);
    });
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(result).toMatchObject({ ok: true, snapshot: { state: 'IDLE' } });
    expect(removeMemberMock).toHaveBeenCalledWith('stranded-auction', 'u1');
    expect(deleteLobbyMock).toHaveBeenCalledWith('stranded-auction');
  });

  it('blocks queue join when an old friendly auction still has live phase state', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([{
      id: 'live-auction-lobby',
      mode: 'friendly',
      game_mode: 'auction',
      status: 'active',
      host_user_id: 'u1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }]);
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
      get: vi.fn(async (key: string) => {
        if (key === 'auction:user:u1:match' || key === 'auction:user:u2:match') return 'auction-match';
        if (key === 'auction:match:auction-match') {
          return JSON.stringify({
            matchId: 'auction-match',
            origin: 'lobby',
            phase: 'bidding',
            seats: [
              { userId: 'u1', isBot: false, forfeited: false },
              { userId: 'u2', isBot: false, forfeited: false },
            ],
          });
        }
        return null;
      }),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(result).toMatchObject({
      ok: false,
      reason: 'ACTIVE_MATCH',
      snapshot: { state: 'IN_WAITING_LOBBY', waitingLobbyId: 'live-auction-lobby' },
    });
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an unparseable timestamp', 'not-a-timestamp'],
    ['the exact 30-minute boundary', 'boundary'],
  ])('keeps an active lobby live at %s', async (_caseName, updatedAt) => {
    const nowMs = Date.parse('2026-08-28T12:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([{
      id: 'conservative-lobby',
      mode: 'friendly',
      game_mode: 'auction',
      status: 'active',
      host_user_id: 'u1',
      updated_at: updatedAt === 'boundary'
        ? new Date(nowMs - 30 * 60_000).toISOString()
        : updatedAt,
      joined_at: new Date(nowMs - 31 * 60_000).toISOString(),
    }]);
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(result).toMatchObject({
      ok: false,
      reason: 'ACTIVE_MATCH',
      snapshot: { waitingLobbyId: 'conservative-lobby', primaryLobbyStatus: 'active' },
    });
    expect(removeMemberMock).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('preserves a lobby membership created while queue-join liveness is probed', async () => {
    const cleanupStartedAtMs = Date.parse('2026-08-28T12:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(cleanupStartedAtMs);
    const staleLobby = {
      id: 'stale-auction',
      mode: 'friendly',
      game_mode: 'auction',
      status: 'active',
      host_user_id: 'u1',
      updated_at: new Date(cleanupStartedAtMs - 31 * 60_000).toISOString(),
      joined_at: new Date(cleanupStartedAtMs - 31 * 60_000).toISOString(),
    };
    const freshLobby = {
      id: 'fresh-lobby',
      mode: 'friendly',
      game_mode: 'friendly_possession',
      status: 'waiting',
      host_user_id: 'other-user',
      updated_at: new Date(cleanupStartedAtMs + 1).toISOString(),
      joined_at: new Date(cleanupStartedAtMs + 1).toISOString(),
    };
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock
      .mockResolvedValueOnce([staleLobby])
      .mockResolvedValueOnce([staleLobby, freshLobby])
      .mockResolvedValueOnce([freshLobby])
      .mockResolvedValueOnce([freshLobby])
      .mockResolvedValueOnce([freshLobby]);
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(removeMemberMock).toHaveBeenCalledWith('stale-auction', 'u1');
    expect(removeMemberMock).not.toHaveBeenCalledWith('fresh-lobby', 'u1');
    expect(result).toMatchObject({ ok: false, snapshot: { waitingLobbyId: 'fresh-lobby' } });
    nowSpy.mockRestore();
  });

  it('heals a stranded lobby whose member is auctioning from a different lobby', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const openLobbies = [{
      id: 'stranded-cross-lobby',
      mode: 'friendly' as const,
      game_mode: 'auction' as const,
      status: 'active' as const,
      host_user_id: 'u1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }];
    listOpenLobbiesForUserMock.mockImplementation(async () => [...openLobbies]);
    removeMemberMock.mockImplementation(async () => {
      openLobbies.splice(0, openLobbies.length);
    });
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
      get: vi.fn(async (key: string) => {
        if (key === 'auction:user:u1:match' || key === 'auction:user:u2:match') return 'auction-match';
        if (key === 'auction:match:auction-match') {
          return JSON.stringify({
            matchId: 'auction-match',
            origin: 'lobby',
            sourceLobbyId: 'a-different-lobby',
            phase: 'bidding',
            seats: [
              { userId: 'u1', isBot: false, forfeited: false },
              { userId: 'u2', isBot: false, forfeited: false },
            ],
          });
        }
        return null;
      }),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(result).toMatchObject({ ok: true, snapshot: { state: 'IDLE' } });
    expect(removeMemberMock).toHaveBeenCalledWith('stranded-cross-lobby', 'u1');
  });

  it('keeps an active lobby live when its own auction is running', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([{
      id: 'own-lobby',
      mode: 'friendly',
      game_mode: 'auction',
      status: 'active',
      host_user_id: 'u1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }]);
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
      get: vi.fn(async (key: string) => {
        if (key === 'auction:user:u1:match' || key === 'auction:user:u2:match') return 'auction-match';
        if (key === 'auction:match:auction-match') {
          return JSON.stringify({
            matchId: 'auction-match',
            origin: 'lobby',
            sourceLobbyId: 'own-lobby',
            phase: 'bidding',
            seats: [
              { userId: 'u1', isBot: false, forfeited: false },
              { userId: 'u2', isBot: false, forfeited: false },
            ],
          });
        }
        return null;
      }),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'u1');

    expect(result).toMatchObject({ ok: false, reason: 'ACTIVE_MATCH' });
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it('heals a stranded active friendly auction during connect recovery', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const openLobbies = [{
      id: 'stranded-connect-auction',
      mode: 'friendly' as const,
      game_mode: 'auction' as const,
      status: 'active' as const,
      host_user_id: 'u1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }];
    listOpenLobbiesForUserMock.mockImplementation(async () => [...openLobbies]);
    removeMemberMock.mockImplementation(async () => {
      openLobbies.splice(0, openLobbies.length);
    });
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const snapshot = await userSessionGuardService.prepareForConnect(io, 'u1');

    expect(snapshot).toMatchObject({ state: 'IDLE', waitingLobbyId: null });
    expect(removeMemberMock).toHaveBeenCalledWith('stranded-connect-auction', 'u1');
    expect(deleteLobbyMock).toHaveBeenCalledWith('stranded-connect-auction');
  });

  it('heals a stranded active friendly auction before lobby entry', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const openLobbies = [{
      id: 'stranded-entry-auction',
      mode: 'friendly' as const,
      game_mode: 'auction' as const,
      status: 'active' as const,
      host_user_id: 'u1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      joined_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }];
    listOpenLobbiesForUserMock.mockImplementation(async () => [...openLobbies]);
    removeMemberMock.mockImplementation(async () => {
      openLobbies.splice(0, openLobbies.length);
    });
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      hGet: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      exists: vi.fn().mockResolvedValue(0),
    });
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForLobbyEntry(io, 'u1');

    expect(result).toMatchObject({ ok: true, snapshot: { state: 'IDLE' } });
    expect(removeMemberMock).toHaveBeenCalledWith('stranded-entry-auction', 'u1');
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

  it('cancels every stale queue before admitting a new queue search', async () => {
    const queueMaps = new Map<string, Map<string, string>>([
      ['ranked:mm:user', new Map([['multi-user', 'ranked-search']])],
      ['auction:mm:user', new Map([['multi-user', 'auction-search']])],
      ['football_grid:mm:user', new Map([['multi-user', 'grid-search']])],
    ]);
    const redis = {
      isOpen: true,
      hGet: vi.fn(async (key: string, field: string) => queueMaps.get(key)?.get(field) ?? null),
      exists: vi.fn(async () => 0),
      eval: vi.fn(async (script: string, input: { keys: string[]; arguments: string[] }) => {
        if (script.includes('local expectedSearchId')) {
          const userMap = queueMaps.get(input.keys[1]);
          if (userMap?.get(input.arguments[0]) === input.arguments[1]) {
            userMap.delete(input.arguments[0]);
          }
        } else {
          queueMaps.get(input.keys[2])?.delete(input.arguments[1]);
        }
        return 1;
      }),
    };
    getRedisClientMock.mockReturnValue(redis);
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([]);
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'multi-user', 'grid');

    expect(result).toMatchObject({ ok: true, snapshot: { state: 'IDLE', queueSearchId: null } });
    expect([...queueMaps.values()].every((map) => !map.has('multi-user'))).toBe(true);
  });

  it('preserves a replacement queue mapping that races stale cleanup', async () => {
    const queueMaps = new Map<string, Map<string, string>>([
      ['ranked:mm:user', new Map([['multi-user', 'ranked-search']])],
      ['auction:mm:user', new Map([['multi-user', 'auction-search-old']])],
      ['football_grid:mm:user', new Map()],
    ]);
    let auctionReads = 0;
    const redis = {
      isOpen: true,
      hGet: vi.fn(async (key: string, field: string) => {
        const current = queueMaps.get(key)?.get(field) ?? null;
        if (key === 'auction:mm:user') {
          auctionReads += 1;
          if (auctionReads === 2) {
            queueMaps.get(key)?.set(field, 'auction-search-new');
          }
        }
        return current;
      }),
      exists: vi.fn(async () => 0),
      eval: vi.fn(async (script: string, input: { keys: string[]; arguments: string[] }) => {
        if (script.includes('local expectedSearchId')) {
          const userMap = queueMaps.get(input.keys[1]);
          if (userMap?.get(input.arguments[0]) === input.arguments[1]) {
            userMap.delete(input.arguments[0]);
          }
        } else {
          queueMaps.get(input.keys[2])?.delete(input.arguments[1]);
        }
        return 1;
      }),
    };
    getRedisClientMock.mockReturnValue(redis);
    getActiveMatchForUserMock.mockResolvedValue(null);
    listOpenLobbiesForUserMock.mockResolvedValue([]);
    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForQueueJoin(io, 'multi-user', 'grid');

    expect(queueMaps.get('auction:mm:user')?.get('multi-user')).toBe('auction-search-new');
    expect(result).toMatchObject({
      ok: false,
      reason: 'QUEUE_UNAVAILABLE',
      snapshot: { queueSearchId: 'auction-search-new' },
    });
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

  it('preserves a lobby membership created during lobby-entry cleanup', async () => {
    getActiveMatchForUserMock.mockResolvedValue(null);
    const oldLobby = {
      id: 'old-lobby',
      mode: 'friendly',
      status: 'waiting',
      host_user_id: 'other-host',
      joined_at: new Date(Date.now() - 10_000).toISOString(),
    };
    const lateJoinedLobby = {
      id: 'fresh-lobby',
      mode: 'friendly',
      status: 'waiting',
      host_user_id: 'fresh-host',
      joined_at: new Date(Date.now() + 10_000).toISOString(),
    };
    listOpenLobbiesForUserMock
      .mockResolvedValueOnce([oldLobby])
      .mockResolvedValueOnce([oldLobby, lateJoinedLobby])
      .mockResolvedValueOnce([lateJoinedLobby]);

    const io = {
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    } as unknown as QuizballServer;

    const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');
    const result = await userSessionGuardService.prepareForLobbyEntry(io, 'idle-user');

    expect(removeMemberMock).toHaveBeenCalledOnce();
    expect(removeMemberMock).toHaveBeenCalledWith('old-lobby', 'idle-user');
    expect(result).toMatchObject({
      ok: true,
      snapshot: { state: 'IN_WAITING_LOBBY', waitingLobbyId: 'fresh-lobby' },
    });
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

    // The lobby teardown + reservation release now goes through the locked abort
    // primitive (which deletes the lobby inside its transaction).
    expect(abortLobbyMock).toHaveBeenCalledWith('draft-lobby', 'close_pre_match_lobby', { draftTeardown: true });
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
